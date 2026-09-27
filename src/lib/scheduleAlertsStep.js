/**
 * Missing-payment alert evaluation + delivery for one server, once per sync
 * (#258). Extracted out of src/syncService.js into its own module so this
 * step can be exercised directly by a Jest test (scheduleAlertsSync.test.js)
 * without booting syncService.js's module-scope side effects (config load,
 * SyncHistoryService/NotificationService construction, the scheduler).
 *
 * Every I/O dependency (api, syncHistory, notificationService, logger) is
 * injected; nothing here reads process-wide state, so it can run against
 * fakes or a real temp-file SyncHistoryService equally well.
 *
 * #295 review, M3/M5: this is split into two phases with two matching gates,
 * because they have different lifetimes with respect to the Actual session
 * and the (global, #265) sync queue:
 *   - `evaluateScheduleAlerts` / `maybeRunScheduleAlerts` only read from the
 *     open Actual session (getSchedules/aqlQuery) and run the pure
 *     `evaluate()`. This MUST run before syncService.js's runSyncBank shuts
 *     the session down.
 *   - `deliverScheduleAlerts` / `maybeDeliverScheduleAlerts` only touch
 *     syncHistory and notificationService, never `api`. This is called by
 *     runSyncBank AFTER the session is closed and after endTimer()/
 *     recordSync(), so a slow or dead notification destination neither
 *     inflates the sync's own durationMs nor holds the session open longer
 *     than the sync itself needed it. It is bounded by DELIVER_BUDGET_MS so
 *     it still cannot block the next queued server's sync indefinitely.
 * `runScheduleAlertsStep` composes both phases back to back (evaluate then
 * deliver, no gate, throws on either failing) and is kept only so this
 * file's own end-to-end tests do not need two calls; production code
 * (src/syncService.js) calls the gated `maybeRunScheduleAlerts` /
 * `maybeDeliverScheduleAlerts` pair instead, split across the session
 * boundary as described above.
 *
 * Both `maybeRunScheduleAlerts` and `maybeDeliverScheduleAlerts` swallow
 * their own errors (logged at WARN) so a schedule-alert failure never
 * changes the sync's own result (syncStatus, syncHistory.recordSync). That
 * contract is what scheduleAlertsSync.test.js asserts, satisfying
 * docs/plans/p1-v1-18-payment-alerts.md's "Fails if" guard for #271 item 10
 * ("a service-level test proving the sync result is unchanged when it
 * throws"). `evaluateScheduleAlerts`/`deliverScheduleAlerts` themselves throw
 * on failure; only the `maybe*` wrappers catch.
 */

const moment = require('moment-timezone');
const { getRules } = require('./scheduleAlertRules');
const { evaluate, MAX_LOOKBACK_DAYS, LINKED_EARLY_WINDOW_DAYS } = require('./scheduleAlerts');
const { deliver } = require('./scheduleAlertDelivery');
const { withTimeout } = require('./actualTimeouts');

// #295 review, M3: the deliver phase runs after the Actual session has
// already closed, so a hung request here cannot leave the session open, but
// it can still hold the (global) sync queue's tail if left unbounded. 30s
// comfortably covers a normal multi-channel send while guaranteeing the
// queue frees up for the next server even against a fully dead endpoint.
const DELIVER_BUDGET_MS = 30000;

/**
 * #261 (rule enable/mute) is not implemented yet: every rule is enabled and
 * never muted, so `scheduleAlertDelivery.deliver` behaves as if that feature
 * did not exist. #261 wires real per-rule state in without changing this
 * call site, per #258's "single merge point" design.
 * @returns {{enabled: boolean, mutedUntil: null}}
 */
function scheduleAlertRuleState() {
    return { enabled: true, mutedUntil: null };
}

/**
 * Read-side phase: fetch schedules/payees/accounts/transactions from the
 * still-open Actual session and run the pure `evaluate()`. No ledger or
 * notification I/O happens here.
 *
 * @param {Object} args
 * @param {Object} args.api - the timedActual-wrapped @actual-app/api instance
 *   (must expose getSchedules, aqlQuery, q)
 * @param {Object} args.server - this server's config block; `server.scheduleAlerts`
 *   is the raw config the caller is responsible for gating on before calling this
 * @param {string} args.serverName - server display name, recorded in the ledger key
 *   and used in message templates
 * @param {string} args.timezone - IANA timezone, e.g. "Europe/Madrid"
 *   (see resolveTimezone in src/syncService.js)
 * @param {Object} args.logger - server-scoped logger ({info, warn, ...})
 * @param {Date} [args.now] - injectable clock, defaults to `new Date()`
 * @returns {Promise<Object>} the evaluated result to pass to `deliverScheduleAlerts`
 */
async function evaluateScheduleAlerts({ api, server, serverName, timezone, now, logger }) {
    const scheduleAlertRules = getRules(server.scheduleAlerts);
    const alertNow = now || new Date();

    const rawSchedules = await api.getSchedules();

    // Payee/account names for message templates: getSchedules()
    // only returns ids (#258's "APIScheduleEntity shape" note).
    const { data: payees } = await api.aqlQuery(api.q('payees').select(['id', 'name']));
    // accounts is re-read here (rather than reusing an earlier bank-sync read)
    // because that read does not select last_sync, needed to tell "missing"
    // from "cannotCheck" (#271 item 10).
    const { data: accountsForAlerts } = await api.aqlQuery(
        api.q('accounts').filter({ tombstone: false }).select(['id', 'name', 'last_sync'])
    );
    const accountNameById = new Map(accountsForAlerts.map((a) => [a.id, a.name]));
    const payeeNameById = new Map((payees || []).map((p) => [p.id, p.name]));
    const hydratedSchedules = (rawSchedules || []).map((s) => ({
        ...s,
        accountName: s.account ? accountNameById.get(s.account) || null : null,
        payeeName: s.payee ? payeeNameById.get(s.payee) || null : null
    }));

    // #295 review, H3: the old fixed `MAX_LOOKBACK_DAYS` window took no
    // account of a rule's `earlyDays` (or the LINKED_EARLY_WINDOW_DAYS Actual
    // itself allows for a linked transaction, #295 review M12). A payment
    // made earlyDays before that fixed boundary was invisible to evaluate(),
    // which then had no way to avoid reporting the occurrence "missing" once
    // its own deadline passed - a false positive evaluate() could never
    // recover from since it never saw the transaction at all. Widening the
    // fetch window by the largest early margin any configured rule can use
    // fixes this at the source instead of inside evaluate().
    const maxEarlyDays = scheduleAlertRules.reduce(
        (max, rule) => Math.max(max, rule.earlyDays || 0),
        LINKED_EARLY_WINDOW_DAYS
    );
    const lookbackStart = moment.tz(alertNow, timezone)
        .subtract(MAX_LOOKBACK_DAYS + maxEarlyDays, 'days')
        .format('YYYY-MM-DD');
    const { data: alertTransactions } = await api.aqlQuery(
        api.q('transactions')
            .filter({ date: { $gte: lookbackStart }, tombstone: false })
            // #295 review, M4: the default `splits: 'inline'` explodes a
            // split parent transaction into its subtransactions, and only
            // the parent row carries the `schedule` link - so a scheduled
            // payment recorded as a split silently disappeared from
            // evaluate()'s candidates. `splits: 'none'` keeps the split
            // parent as a single row (schedule intact) and excludes the
            // exploded child rows instead (verified against the vendored
            // @actual-app/api query executor: 'none' filters
            // `parent_id IS NULL`, i.e. top-level rows only).
            .options({ splits: 'none' })
            .select(['id', 'account', 'payee', 'amount', 'date', 'schedule'])
    );

    const { events, evaluations, warnings } = evaluate({
        rules: scheduleAlertRules,
        schedules: hydratedSchedules,
        transactions: alertTransactions,
        accounts: accountsForAlerts,
        now: alertNow,
        timezone
    });

    for (const warning of warnings) {
        logger.warn(warning.message, { ruleId: warning.ruleId, scheduleId: warning.scheduleId });
    }

    return { events, evaluations, scheduleAlertRules, timezone, serverName, now: alertNow };
}

/**
 * Write-side phase: dedup/render/send/record against the ledger and the
 * notification channels. Touches no Actual API state, so it is safe to run
 * after the Actual session has been closed.
 *
 * @param {Object} evaluated - the result of `evaluateScheduleAlerts`
 * @param {Object} deps
 * @param {Object} deps.syncHistory - SyncHistoryService instance, or a stand-in
 *   exposing findLatestScheduleAlert/recordScheduleAlert with the same shape
 * @param {Object} deps.notificationService - object exposing
 *   sendTemplated(channelOutputs) with #257's contract
 * @param {Object} deps.logger - server-scoped logger ({info, warn, ...})
 * @returns {Promise<{events: number, sent: number, skipped: number}>}
 */
async function deliverScheduleAlerts(evaluated, { syncHistory, notificationService, logger }) {
    const { events, evaluations, scheduleAlertRules, timezone, serverName, now } = evaluated;
    const deliverResult = await deliver(events, {
        evaluations,
        ruleState: scheduleAlertRuleState,
        history: syncHistory,
        sender: notificationService,
        now,
        server: serverName,
        rules: scheduleAlertRules,
        timezone,
        logger
    });
    return { events: events.length, sent: deliverResult.sent, skipped: deliverResult.skipped };
}

/**
 * Combines both phases back to back. Kept for this file's own end-to-end
 * tests and any caller that does not need to split work across the Actual
 * session boundary; production code uses `maybeRunScheduleAlerts` /
 * `maybeDeliverScheduleAlerts` instead (see the module doc comment).
 * Throws on either phase failing - callers that want the #258 "never affect
 * the sync's own result" contract must use the `maybe*` wrappers.
 *
 * @returns {Promise<{events: number, sent: number, skipped: number}>}
 */
async function runScheduleAlertsStep({ api, server, serverName, timezone, syncHistory, notificationService, logger, now }) {
    const evaluated = await evaluateScheduleAlerts({ api, server, serverName, timezone, now, logger });
    return deliverScheduleAlerts(evaluated, { syncHistory, notificationService, logger });
}

/**
 * #295 review, M5: the gate ("does this server even have scheduleAlerts
 * configured?") and the catch ("never let a schedule-alert failure change
 * the sync's own result") used to exist only inside
 * scheduleAlertsSync.test.js's own `runSyncBankLike` helper, hand-copied from
 * syncService.js. A drift between the copy and the real code could go
 * undetected indefinitely. Exporting the gate itself so both syncService.js
 * and the test call the SAME function closes that gap.
 *
 * Must be called while the Actual session (`api`) is still open (#295
 * review, M3): this only runs the read side (getSchedules/queries/evaluate).
 *
 * @param {Object} server - this server's config block
 * @param {Object} deps - same shape as `evaluateScheduleAlerts`'s args, minus `server`
 * @returns {Promise<Object|null>} the evaluated result to pass to
 *   `maybeDeliverScheduleAlerts`, or null when there was nothing to evaluate
 *   (not configured, or evaluation itself failed - already logged here)
 */
async function maybeRunScheduleAlerts(server, { api, serverName, timezone, now, logger }) {
    if (!server.scheduleAlerts) return null;
    try {
        return await evaluateScheduleAlerts({ api, server, serverName, timezone, now, logger });
    } catch (scheduleAlertError) {
        logger.warn('Schedule alerts evaluation failed; sync result is unaffected', {
            error: scheduleAlertError.message
        });
        return null;
    }
}

/**
 * #295 review, M3: called by syncService.js AFTER the Actual session has
 * been shut down and AFTER endTimer()/recordSync(), so a slow or dead
 * notification destination neither inflates the sync's own durationMs nor
 * holds the session open. The whole phase is bounded by DELIVER_BUDGET_MS so
 * a hung request still releases the (global, #265) sync queue for the next
 * server in line instead of blocking it indefinitely - deliver() already
 * retries only the destinations that failed on the next sync (#295 review,
 * H5), so giving up here loses nothing but that one attempt.
 *
 * @param {Object|null} evaluated - result of `maybeRunScheduleAlerts`
 * @param {Object} deps - same shape as `deliverScheduleAlerts`'s deps
 * @returns {Promise<{events: number, sent: number, skipped: number}|null>}
 */
async function maybeDeliverScheduleAlerts(evaluated, { syncHistory, notificationService, logger }) {
    if (!evaluated) return null;
    try {
        const result = await withTimeout(
            deliverScheduleAlerts(evaluated, { syncHistory, notificationService, logger }),
            DELIVER_BUDGET_MS,
            'scheduleAlertsDeliver'
        );
        logger.info('Schedule alerts evaluated', result);
        return result;
    } catch (scheduleAlertError) {
        logger.warn('Schedule alerts delivery failed; sync result is unaffected', {
            error: scheduleAlertError.message
        });
        return null;
    }
}

module.exports = {
    runScheduleAlertsStep,
    evaluateScheduleAlerts,
    maybeRunScheduleAlerts,
    maybeDeliverScheduleAlerts
};
