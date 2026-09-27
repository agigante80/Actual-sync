/**
 * Schedule alert rule loading (#258).
 *
 * The single merge point that turns a server's `scheduleAlerts` config block
 * into the normalized rule list `scheduleAlerts.js` evaluates. In this ticket
 * the only source is `config.json`; #262 adds dashboard-created rules and
 * #261 adds enable/mute state, both by plugging into `getRules` /
 * `expandRules` rather than changing the evaluation engine (see #258's
 * "Design impact" comment).
 *
 * This file has no I/O: it is pure data transformation over the config object
 * and the `schedules` array `getSchedules()` returns.
 */
'use strict';

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
    digest: block.digest === true
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
    let matches;
    if (rule.schedulePrefix) {
      matches = (schedules || []).filter((s) => typeof s.name === 'string' && s.name.startsWith(rule.schedulePrefix));
    } else if (rule.schedule) {
      matches = (schedules || []).filter((s) => s.name === rule.schedule);
    } else {
      matches = [];
    }

    if (matches.length === 0) {
      bindings.push({ ...rule, scheduleId: null, scheduleName: null, schedule: null, unmatched: true });
      continue;
    }

    for (const match of matches) {
      bindings.push({ ...rule, scheduleId: match.id, scheduleName: match.name, schedule: match, unmatched: false });
    }
  }
  return bindings;
}

module.exports = {
  slugify,
  deriveRuleId,
  getRules,
  checkUniqueIds,
  expandRules,
  DEFAULT_GRACE_DAYS,
  DEFAULT_EARLY_DAYS,
  DEFAULT_STALE_AFTER_DAYS
};
