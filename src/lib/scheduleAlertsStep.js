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
const { evaluate, skipKey, MAX_LOOKBACK_DAYS, LINKED_EARLY_WINDOW_DAYS } = require('./scheduleAlerts');
const { deliver } = require('./scheduleAlertDelivery');

// #295 review, M3: the deliver phase runs after the Actual session has
// already closed, so a hung request here cannot leave the session open, but
// it can still hold the (global) sync queue's tail if left unbounded. 30s
// comfortably covers a normal multi-channel send while guaranteeing the
// queue frees up for the next server even against a fully dead endpoint.
//
// #295 review round 2, M6: this budget used to be enforced with
// `withTimeout()` racing `deliverScheduleAlerts()` against a timer. Racing
// only stops AWAITING the real work; it does not stop the real work, which
// kept running in the background after the race "gave up" - so the sync
// queue moved on to the next server while sends and ledger writes for THIS
// server were still in flight, and if that next server's sync (or the next
// scheduled run of this one) started before the stragglers finished, the
// still-unrecorded events got sent again (verified: 3 of 4 destinations sent
// twice). The budget is now a `deadline` (epoch ms) passed into `deliver()`
// itself, which checks it cooperatively before STARTING each destination/
// channel send and never abandons one already started (see
// `scheduleAlertDelivery.js`'s `deliver`/`sendEvent` doc comments). That
// makes `deliverScheduleAlerts`'s own promise the only thing anyone needs to
// await: once it settles, nothing it started is still running.
const DELIVER_BUDGET_MS = 30000;

// #260: the closed list of error codes a failed evaluation may store and the
// dashboard may serve. Allowlist, not pass-through: other errors carry their
// own `code` (PHASE_TIMEOUT, ECONNRESET, ...) and the raw message stays in the
// log, so anything not listed here maps to the fallback `evaluation_failed`.
const PAYMENT_ERROR_CODES = ['rules_invalid', 'actual_read_failed', 'evaluation_failed'];

/**
 * Tag an error thrown by one stage of `evaluateScheduleAlerts` with `code`,
 * unless it already carries a code of its own (that code is then judged by
 * `paymentErrorCode`, so a PHASE_TIMEOUT or ECONNRESET falls back to
 * `evaluation_failed`, as #260 specifies).
 */
function tagError(error, code) {
    if (error && typeof error === 'object' && error.code === undefined) error.code = code;
    return error;
}

function paymentErrorCode(error) {
    const code = error && error.code;
    return PAYMENT_ERROR_CODES.includes(code) ? code : 'evaluation_failed';
}

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
 *   (see resolveTimezone in src/lib/timezone.js)
 * @param {Object} args.logger - server-scoped logger ({info, warn, ...})
 * @param {Date} [args.now] - injectable clock, defaults to `new Date()`
 * @param {Object} [args.syncHistory] - #297 F1: read-only use here, to load the
 *   remembered skip decisions (`listScheduleAlertSkips`); without it nothing is
 *   remembered and every skip is re-inferred from `next_date` each sync
 * @returns {Promise<Object>} the evaluated result to pass to `deliverScheduleAlerts`
 */
async function evaluateScheduleAlerts({ api, server, serverName, timezone, now, logger, syncHistory }) {
    let scheduleAlertRules;
    try {
        scheduleAlertRules = getRules(server.scheduleAlerts);
    } catch (error) {
        throw tagError(error, 'rules_invalid');
    }
    const alertNow = now || new Date();

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

    // #260: only the Actual reads are tagged `actual_read_failed`; anything
    // else thrown below (evaluate() itself included) stays untagged and maps
    // to the `evaluation_failed` fallback.
    let rawSchedules;
    let payees;
    let accountsForAlerts;
    let alertTransactions;
    try {
        rawSchedules = await api.getSchedules();

        // Payee/account names for message templates: getSchedules()
        // only returns ids (#258's "APIScheduleEntity shape" note).
        ({ data: payees } = await api.aqlQuery(api.q('payees').select(['id', 'name'])));
        // accounts is re-read here (rather than reusing an earlier bank-sync read)
        // because that read does not select last_sync, needed to tell "missing"
        // from "cannotCheck" (#271 item 10).
        ({ data: accountsForAlerts } = await api.aqlQuery(
            api.q('accounts').filter({ tombstone: false }).select(['id', 'name', 'last_sync'])
        ));
        ({ data: alertTransactions } = await api.aqlQuery(
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
        ));
    } catch (error) {
        throw tagError(error, 'actual_read_failed');
    }

    const accountNameById = new Map(accountsForAlerts.map((a) => [a.id, a.name]));
    const payeeNameById = new Map((payees || []).map((p) => [p.id, p.name]));
    const hydratedSchedules = (rawSchedules || []).map((s) => ({
        ...s,
        accountName: s.account ? accountNameById.get(s.account) || null : null,
        payeeName: s.payee ? payeeNameById.get(s.payee) || null : null
    }));

    // #297 F1: skip decisions remembered from earlier syncs. A failure to read
    // them degrades to re-inferring from next_date (the pre-#297 behaviour)
    // rather than losing this sync's whole evaluation.
    let skips = [];
    if (syncHistory && typeof syncHistory.listScheduleAlertSkips === 'function') {
        try {
            const rows = await syncHistory.listScheduleAlertSkips({ server: serverName });
            skips = rows.map((r) => skipKey(r.scheduleId, r.occurrenceDate));
        } catch (error) {
            logger.warn('Could not read remembered schedule skips; inferring from next_date only', { error: error.message });
        }
    }

    const { events, evaluations, warnings, skipDecisions, completedSchedules } = evaluate({
        rules: scheduleAlertRules,
        schedules: hydratedSchedules,
        transactions: alertTransactions,
        accounts: accountsForAlerts,
        now: alertNow,
        timezone,
        skips
    });

    for (const warning of warnings) {
        logger.warn(warning.message, { ruleId: warning.ruleId, scheduleId: warning.scheduleId });
    }

    // #356: every schedule id Actual still has (completed and unbound ones
    // too), so delivery can tell a deleted schedule from one that is merely
    // not bound. An empty or non-array list is not trusted as "everything was
    // deleted" (a transient empty read would otherwise close every open
    // `missing`), so it is reported as null and no deletion is inferred.
    const existingScheduleIds = Array.isArray(rawSchedules) && rawSchedules.length > 0
        ? new Set(rawSchedules.map((s) => s.id))
        : null;

    return { events, evaluations, warnings, skipDecisions, completedSchedules, existingScheduleIds, scheduleAlertRules, timezone, serverName, now: alertNow };
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
 * @param {number} [deps.deliverBudgetMs] - #295 review round 2, M6: overrides
 *   `DELIVER_BUDGET_MS` for this call; tests use a short value to exercise
 *   the deadline without a real 30s wait. Converted to an epoch-ms
 *   `deadline` right here, at the moment delivery actually starts, and
 *   passed straight into `deliver()`, which is the only place that checks it.
 * @returns {Promise<{events: number, sent: number, skipped: number}>}
 */
async function deliverScheduleAlerts(evaluated, { syncHistory, notificationService, logger, deliverBudgetMs }) {
    const { events, evaluations, skipDecisions, completedSchedules, existingScheduleIds, scheduleAlertRules, timezone, serverName, now } = evaluated;
    // #297 F1: persist newly inferred skips FIRST and independently of the
    // delivery budget and of delivery itself: a failed write only means the
    // skip is inferred again next sync, it must never block the alerts.
    for (const decision of skipDecisions || []) {
        try {
            await syncHistory.recordScheduleAlert({
                server: serverName, alertId: decision.alertId, scheduleId: decision.scheduleId,
                occurrenceDate: decision.occurrence, event: 'skipped', delivery: 'inferred'
            });
        } catch (error) {
            logger.warn('Could not record schedule skip decision; it will be inferred again next sync', {
                scheduleId: decision.scheduleId, occurrence: decision.occurrence, error: error.message
            });
        }
    }
    const deadline = Date.now() + (deliverBudgetMs != null ? deliverBudgetMs : DELIVER_BUDGET_MS);
    const deliverResult = await deliver(events, {
        evaluations,
        completedSchedules,
        existingScheduleIds,
        ruleState: scheduleAlertRuleState,
        history: syncHistory,
        sender: notificationService,
        now,
        server: serverName,
        rules: scheduleAlertRules,
        timezone,
        logger,
        deadline
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
    const evaluated = await evaluateScheduleAlerts({ api, server, serverName, timezone, now, logger, syncHistory });
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
 * @param {Object} [deps.outcome] - #260: filled in on failure
 *   (`failed = true`, `errorCode` from the closed list) so the caller can
 *   tell "failed" from "not configured", both of which return null
 * @returns {Promise<Object|null>} the evaluated result to pass to
 *   `maybeDeliverScheduleAlerts`, or null when there was nothing to evaluate
 *   (not configured, or evaluation itself failed - already logged here)
 */
async function maybeRunScheduleAlerts(server, { api, serverName, timezone, now, logger, syncHistory, outcome }) {
    if (!server.scheduleAlerts) return null;
    try {
        return await evaluateScheduleAlerts({ api, server, serverName, timezone, now, logger, syncHistory });
    } catch (scheduleAlertError) {
        if (outcome) {
            outcome.failed = true;
            outcome.errorCode = paymentErrorCode(scheduleAlertError);
        }
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
 * holds the session open.
 *
 * #295 review round 2, M6: the whole phase is bounded by DELIVER_BUDGET_MS,
 * but no longer by racing this call against an external timer - that race
 * only stopped US from awaiting `deliverScheduleAlerts()`, it did not stop
 * the sends and ledger writes still in flight inside it, so they kept
 * running after this function had already returned and the (global, #265)
 * sync queue had moved on. A concurrent or later sync could then see the
 * same still-undelivered events and send them again (verified: 3 of 4
 * destinations sent twice). The budget is now a cooperative `deadline`
 * `deliverScheduleAlerts` passes into `deliver()`, which only refuses to
 * START a new destination/channel send once it has passed and always awaits
 * one already started (see `scheduleAlertDelivery.js`'s `deliver` doc
 * comment). `deliverScheduleAlerts`'s promise is therefore always awaited
 * here to completion: once it settles, nothing it started is still running,
 * so nothing can continue after THIS function returns either. Anything not
 * yet attempted when the budget was hit is simply left for the ledger to
 * pick up next sync, same as any other still-undelivered event.
 *
 * @param {Object|null} evaluated - result of `maybeRunScheduleAlerts`
 * @param {Object} deps - same shape as `deliverScheduleAlerts`'s deps
 * @returns {Promise<{events: number, sent: number, skipped: number}|null>}
 */
async function maybeDeliverScheduleAlerts(evaluated, { syncHistory, notificationService, logger, deliverBudgetMs }) {
    if (!evaluated) return null;
    try {
        const result = await deliverScheduleAlerts(evaluated, { syncHistory, notificationService, logger, deliverBudgetMs });
        logger.info('Schedule alerts evaluated', result);
        return result;
    } catch (scheduleAlertError) {
        logger.warn('Schedule alerts delivery failed; sync result is unaffected', {
            error: scheduleAlertError.message
        });
        return null;
    }
}

/**
 * #260: persist the payment alert snapshot for the dashboard. Called by
 * syncService.js right after `maybeRunScheduleAlerts`, while the sync result
 * is still undecided; it can never change it (any throw is logged at WARN).
 * A no-op without `syncHistory`.
 *
 * @param {Object} server - this server's config block
 * @param {Object|null} evaluated - result of `maybeRunScheduleAlerts`
 * @param {Object} deps
 * @param {Object} [deps.syncHistory]
 * @param {string} deps.serverName
 * @param {Object} [deps.outcome] - the object passed to `maybeRunScheduleAlerts`
 * @param {Object} [deps.logger]
 */
function persistPaymentSnapshot(server, evaluated, { syncHistory, serverName, outcome, logger }) {
    if (!syncHistory) return;
    try {
        if (!server.scheduleAlerts) {
            syncHistory.deletePaymentSnapshot(serverName);
        } else if (outcome && outcome.failed) {
            syncHistory.recordPaymentRunFailure(serverName, outcome.errorCode);
        } else if (evaluated) {
            const evaluations = evaluated.evaluations || [];
            const evaluatedPairs = new Set(evaluations.map((e) => JSON.stringify([e.alertId, e.scheduleId])));
            // A warning with no evaluation for the same pair means the rule
            // threw inside evaluate(); its previous row is kept. An
            // interval-violation rule warns AND evaluates (cannotCheck), so it
            // is not errored.
            const seen = new Set();
            const erroredPairs = [];
            for (const w of evaluated.warnings || []) {
                const key = JSON.stringify([w.ruleId, w.scheduleId]);
                if (evaluatedPairs.has(key) || seen.has(key)) continue;
                seen.add(key);
                erroredPairs.push({ alertId: w.ruleId, scheduleId: w.scheduleId });
            }
            syncHistory.replacePaymentSnapshot(serverName, evaluations, { erroredPairs });
        }
    } catch (error) {
        if (logger && typeof logger.warn === 'function') {
            logger.warn('Failed to persist payment alert snapshot; sync result is unaffected', { error: error.message });
        }
    }
}

module.exports = {
    persistPaymentSnapshot,
    runScheduleAlertsStep,
    evaluateScheduleAlerts,
    maybeRunScheduleAlerts,
    maybeDeliverScheduleAlerts
};
