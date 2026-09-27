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
 * This function throws on any failure - it does not swallow errors itself.
 * In production, src/syncService.js's runSyncBank wraps the call in a
 * try/catch so a schedule-alert failure is logged at WARN and never changes
 * the sync's own result (syncStatus, syncHistory.recordSync). That contract
 * is what scheduleAlertsSync.test.js asserts, satisfying
 * docs/plans/p1-v1-18-payment-alerts.md's "Fails if" guard for #271 item 10
 * ("a service-level test proving the sync result is unchanged when it
 * throws").
 */

const moment = require('moment-timezone');
const { getRules } = require('./scheduleAlertRules');
const { evaluate, MAX_LOOKBACK_DAYS } = require('./scheduleAlerts');
const { deliver } = require('./scheduleAlertDelivery');

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
 * @param {Object} args
 * @param {Object} args.api - the timedActual-wrapped @actual-app/api instance
 *   (must expose getSchedules, aqlQuery, q)
 * @param {Object} args.server - this server's config block; `server.scheduleAlerts`
 *   is the raw config the caller is responsible for gating on before calling this
 * @param {string} args.serverName - server display name, recorded in the ledger key
 *   and used in message templates
 * @param {string} args.timezone - IANA timezone, e.g. "Europe/Madrid"
 *   (see resolveTimezone in src/syncService.js)
 * @param {Object} args.syncHistory - SyncHistoryService instance, or a stand-in
 *   exposing findLatestScheduleAlert/recordScheduleAlert with the same shape
 * @param {Object} args.notificationService - object exposing
 *   sendTemplated(channelOutputs) with #257's contract
 * @param {Object} args.logger - server-scoped logger ({info, warn, ...})
 * @param {Date} [args.now] - injectable clock, defaults to `new Date()`
 * @returns {Promise<{events: number, sent: number, skipped: number}>}
 */
async function runScheduleAlertsStep({ api, server, serverName, timezone, syncHistory, notificationService, logger, now }) {
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

    const lookbackStart = moment.tz(alertNow, timezone)
        .subtract(MAX_LOOKBACK_DAYS, 'days')
        .format('YYYY-MM-DD');
    const { data: alertTransactions } = await api.aqlQuery(
        api.q('transactions')
            .filter({ date: { $gte: lookbackStart }, tombstone: false })
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

    const deliverResult = await deliver(events, {
        evaluations,
        ruleState: scheduleAlertRuleState,
        history: syncHistory,
        sender: notificationService,
        now: alertNow,
        server: serverName,
        rules: scheduleAlertRules,
        timezone,
        logger
    });

    return { events: events.length, sent: deliverResult.sent, skipped: deliverResult.skipped };
}

module.exports = { runScheduleAlertsStep };
