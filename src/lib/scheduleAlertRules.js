/**
 * Schedule alert rule loading (#258).
 *
 * The single merge point that turns a server's `scheduleAlerts` config block
 * into the normalized rule list `scheduleAlerts.js` evaluates. `getRules` is
 * config-only; `mergeRules` (#262) adds the dashboard-created rules stored in
 * `payment_alert_rule`, and #261's enable/mute state plugs in through
 * `ruleState`, none of it changing the evaluation engine (see #258's
 * "Design impact" comment).
 *
 * This file has no I/O: it is pure data transformation over the config object
 * and the `schedules` array `getSchedules()` returns.
 */
'use strict';

const moment = require('moment-timezone');

const DEFAULT_GRACE_DAYS = 3;
const DEFAULT_EARLY_DAYS = 2;
const DEFAULT_STALE_AFTER_DAYS = 3;
const DEFAULT_PERIOD = 'occurrence';

/**
 * Slugify a schedule name or prefix into the default alert id.
 * Matches the `^[a-z0-9-]{1,64}$` pattern enforced by the config schema.
 *
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'alert').slice(0, 64);
}

/**
 * Derive an alert's stable id: the configured `id`, or a slug of `schedule`
 * / `schedulePrefix` when none is given.
 *
 * @param {Object} alert - a raw entry from `scheduleAlerts.alerts`
 * @returns {string}
 */
function deriveRuleId(alert) {
  if (alert.id) return alert.id;
  return slugify(alert.schedule || alert.schedulePrefix);
}

/**
 * Normalize one raw `scheduleAlerts.alerts[]` entry into the rule shape
 * `scheduleAlerts.js` consumes, applying block-level and built-in defaults.
 *
 * @param {Object} alert
 * @param {Object} block - the parent `scheduleAlerts` config block
 * @returns {Object}
 */
function normalizeRule(alert, block) {
  return {
    id: deriveRuleId(alert),
    schedule: alert.schedule || null,
    schedulePrefix: alert.schedulePrefix || null,
    graceDays: alert.graceDays != null ? alert.graceDays : DEFAULT_GRACE_DAYS,
    earlyDays: alert.earlyDays != null ? alert.earlyDays : DEFAULT_EARLY_DAYS,
    period: alert.period || DEFAULT_PERIOD,
    // undefined means "derive from the schedule's own amountOp" (#258:
    // "the default comes from the schedule"); resolved in scheduleAlerts.js
    // since only there is the schedule's amountOp known.
    amountTolerancePct: alert.amountTolerancePct,
    remindEveryDays: alert.remindEveryDays || 0,
    // undefined means "every configured channel"; resolved by the delivery
    // layer, which knows what channels notificationService has configured.
    channels: alert.channels || undefined,
    templates: { ...(block.templates || {}), ...(alert.templates || {}) },
    staleAfterDays: block.staleAfterDays != null ? block.staleAfterDays : DEFAULT_STALE_AFTER_DAYS,
    dateFormat: block.dateFormat || 'D MMM YYYY',
    locale: block.locale || 'en',
    digest: block.digest === true,
    // #261: `enabled: false` in config switches the rule off for good; the
    // dashboard cannot turn it back on (see ruleState).
    enabled: alert.enabled !== false
  };
}

/**
 * Return the normalized rule list for a server's `scheduleAlerts` block.
 *
 * @param {Object|null|undefined} scheduleAlerts - `server.scheduleAlerts`
 * @returns {Object[]} normalized rules, one per `alerts[]` entry (not yet
 *   expanded against actual schedules - see `expandRules`)
 */
function getRules(scheduleAlerts) {
  if (!scheduleAlerts || !Array.isArray(scheduleAlerts.alerts)) return [];
  return scheduleAlerts.alerts.map((alert) => normalizeRule(alert, scheduleAlerts));
}

/**
 * Merge config rules with the dashboard rules stored for a server (#262).
 * Pure: the caller reads the rows (`syncHistory.listRules`).
 *
 * Every entry keeps the normalized rule shape and adds `source`
 * (`'config'|'dashboard'`), `superseded`, the raw `definition` and `updatedAt`
 * (null for a config rule). A dashboard rule whose id equals a config rule's id
 * is `superseded: true`: config wins, and the stored row is kept (it becomes
 * active again if the config rule is removed) but must not be evaluated.
 * Compare ids with `deriveRuleId`, as every other lookup does.
 *
 * @param {Object[]} configRules - `getRules(block)`
 * @param {Array<{alertId:string, definition:Object, updatedAt:string}>} dashboardRows
 * @param {?Object} block - the server's `scheduleAlerts` block
 * @returns {Object[]} config rules first (config order), then dashboard rules
 *   in the order given
 */
function mergeRules(configRules, dashboardRows, block) {
  const rawConfig = block && Array.isArray(block.alerts) ? block.alerts : [];
  const configIds = new Set(configRules.map((rule) => rule.id));
  const merged = configRules.map((rule, index) => ({
    ...rule, source: 'config', superseded: false, definition: rawConfig[index] || null, updatedAt: null
  }));
  for (const row of dashboardRows || []) {
    const rule = normalizeRule(row.definition, block || {});
    merged.push({
      ...rule,
      source: 'dashboard',
      superseded: configIds.has(rule.id),
      definition: row.definition,
      updatedAt: row.updatedAt
    });
  }
  return merged;
}

/**
 * Startup check: every alert id must be unique within a server (AJV cannot
 * express key uniqueness across array items). Throws on the first collision
 * found, in `config.json` order, naming both colliding indices.
 *
 * @param {Object[]} servers - `config.servers`, each possibly with `scheduleAlerts`
 * @throws {Error} `scheduleAlerts.alerts: duplicate id "X" at alerts[i] and alerts[j] (server "name")`
 */
function checkUniqueIds(servers) {
  for (const server of servers || []) {
    const alerts = server.scheduleAlerts && Array.isArray(server.scheduleAlerts.alerts)
      ? server.scheduleAlerts.alerts
      : [];
    const seen = new Map(); // id -> first index seen at
    alerts.forEach((alert, index) => {
      const id = deriveRuleId(alert);
      if (seen.has(id)) {
        throw new Error(
          `scheduleAlerts.alerts: duplicate id "${id}" at alerts[${seen.get(id)}] and alerts[${index}] (server "${server.name}")`
        );
      }
      seen.set(id, index);
    });
  }
}

/**
 * Every schedule a rule's target (`schedulePrefix` first, else exact
 * `schedule`) names, completed ones included. Shared by `expandRules` and
 * `matchedScheduleIdsByRule` so "matched" means one thing everywhere.
 */
function ruleNameMatches(rule, schedules) {
  if (rule.schedulePrefix) {
    return (schedules || []).filter((s) => typeof s.name === 'string' && s.name.startsWith(rule.schedulePrefix));
  }
  if (rule.schedule) return (schedules || []).filter((s) => s.name === rule.schedule);
  return [];
}

/**
 * #373: rule id -> Set of the schedule ids its CURRENT target names (completed
 * ones included, since a completed schedule is still bound to the rule).
 * Delivery uses it to tell an open `missing` whose schedule the rule no longer
 * targets (the target was edited) from one that is still tracked.
 */
function matchedScheduleIdsByRule(rules, schedules) {
  return new Map((rules || []).map((rule) => [rule.id, new Set(ruleNameMatches(rule, schedules).map((s) => s.id))]));
}

/**
 * Expand each rule against the schedules Actual currently has, matching
 * `schedule` by exact name and `schedulePrefix` by name prefix. A rule that
 * matches nothing expands to one `unmatched: true` binding (the caller emits
 * one `ruleUnmatched` event for it, per #258); a `schedulePrefix` rule that
 * matches N schedules expands to N bindings sharing the rule's `alertId` and
 * carrying distinct `scheduleId`s.
 *
 * @param {Object[]} rules - normalized rules from `getRules`
 * @param {Array<{id:string,name:string}>} schedules - from `getSchedules()`
 * @returns {Object[]} bindings: `{ ...rule, scheduleId, scheduleName, schedule, unmatched }`
 */
function expandRules(rules, schedules) {
  const bindings = [];
  for (const rule of rules) {
    // A completed schedule (schedule.completed === true) is excluded from
    // matching entirely (#295 review, H4): Actual keeps a completed schedule
    // around (e.g. it reached its endOccurrences/endDate) but stops expecting
    // new occurrences of it, so evaluating it here only ever produced a
    // false "missing" for an occurrence nobody expects anymore.
    //
    // `rawMatches` (name only) is kept separate from `matches` (name and
    // active) so a rule can tell apart two different non-match reasons
    // (#295 review round 2, M2): a genuine name mismatch (`rawMatches` is
    // empty) still gets one `unmatched: true` binding, which the caller
    // turns into a `ruleUnmatched` event - but a rule whose name DID match,
    // just only against a completed schedule, produces no binding at all
    // and no event. Before this, a one-off schedule that Actual marks
    // completed the day after it is paid (or any fully-completed recurring
    // schedule) fell into the `matches.length === 0` branch and was treated
    // as a name mismatch, firing a daily `ruleUnmatched` for a rule that was
    // actually working fine.
    const isActive = (s) => s.completed !== true;
    const rawMatches = ruleNameMatches(rule, schedules);
    const matches = rawMatches.filter(isActive);

    // #326: a COMPLETED ONE-OFF schedule (`date` is a plain date string, not a
    // recurrence object) is still bound, flagged `completedOneOff`, so the
    // caller can close an open `missing` for it with a `resolved`. It is never
    // evaluated for new alerts (evaluate() only reports it back); a completed
    // recurring schedule stays excluded exactly as before.
    for (const s of rawMatches) {
      if (!isActive(s) && typeof s.date === 'string') {
        bindings.push({ ...rule, scheduleId: s.id, scheduleName: s.name, schedule: s, unmatched: false, completedOneOff: true });
      }
    }

    if (matches.length === 0) {
      if (rawMatches.length === 0) {
        bindings.push({ ...rule, scheduleId: null, scheduleName: null, schedule: null, unmatched: true });
      }
      continue;
    }

    for (const match of matches) {
      bindings.push({ ...rule, scheduleId: match.id, scheduleName: match.name, schedule: match, unmatched: false });
    }
  }
  return bindings;
}

/**
 * The instant a mute ends: the start of the calendar day after `mutedUntil`
 * in `timezone` (a mute lasts through the whole `mutedUntil` day). (#261)
 *
 * @param {string} mutedUntil - `YYYY-MM-DD`
 * @param {string} timezone - IANA name
 * @returns {Date}
 */
function muteEndsAt(mutedUntil, timezone) {
  return moment.tz(mutedUntil, 'YYYY-MM-DD', timezone || 'UTC').add(1, 'day').startOf('day').toDate();
}

/**
 * The effective state of one rule (#261). Precedence: config `enabled: false`
 * wins over a dashboard override, which wins over the default (enabled, not
 * muted). `mutedUntil`, `mutedFrom` and `reason` keep being returned after the
 * mute has ended until the summary is sent or expires (`muteEndDue`).
 *
 * @param {Object} args
 * @param {{enabled?: boolean}} args.rule - a normalized rule
 * @param {?{enabled: boolean, mutedFrom: ?string, mutedUntil: ?string, reason: ?string}} args.override
 * @param {Date} args.now
 * @param {string} args.timezone
 * @returns {{enabled: boolean, muted: boolean, mutedFrom: ?string, mutedUntil: ?string, reason: ?string, lockedByConfig: boolean, muteEndDue: boolean}}
 */
function ruleState({ rule, override, now, timezone }) {
  const lockedByConfig = rule && rule.enabled === false;
  const o = override || {};
  const mutedUntil = o.mutedUntil || null;
  const muted = mutedUntil !== null && now.getTime() < muteEndsAt(mutedUntil, timezone).getTime();
  return {
    enabled: !lockedByConfig && o.enabled !== false,
    muted,
    mutedFrom: mutedUntil ? (o.mutedFrom || null) : null,
    mutedUntil,
    reason: mutedUntil ? (o.reason || null) : null,
    lockedByConfig: Boolean(lockedByConfig),
    muteEndDue: mutedUntil !== null && !muted
  };
}

module.exports = {
  slugify,
  ruleState,
  muteEndsAt,
  deriveRuleId,
  getRules,
  mergeRules,
  normalizeRule,
  checkUniqueIds,
  expandRules,
  matchedScheduleIdsByRule,
  DEFAULT_GRACE_DAYS,
  DEFAULT_EARLY_DAYS,
  DEFAULT_STALE_AFTER_DAYS
};
