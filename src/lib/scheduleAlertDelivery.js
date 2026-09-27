/**
 * Missing-payment alert delivery (#258).
 *
 * `deliver()` takes the (pure) output of `scheduleAlerts.evaluate()` and:
 * - de-duplicates against the `schedule_alerts` ledger (`src/services/syncHistory.js`);
 * - derives `resolved` events, which `evaluate()` cannot: that needs alert
 *   history, and `evaluate()` has none by design;
 * - renders each surviving event with #257 (`src/lib/templateRenderer.js`),
 *   using only its public API;
 * - sends through `sender.sendTemplated` (`notificationService`'s public
 *   entry point), fanning out itself to every configured Slack/Discord/generic
 *   webhook (`sendTemplated` only accepts one URL per call);
 * - records exactly one `sent` row per successfully delivered event.
 *
 * Channel selection reads `sender.config` (the same shape `NotificationService`
 * itself is constructed with) rather than trusting `sendTemplated`'s own
 * per-channel "not configured" signal: Telegram's not-configured result
 * (`{ok:false, statusCode:null}`) is indistinguishable from a genuine network
 * failure with no response, and the two must not be treated alike (the first
 * is not a delivery failure and must not block the ledger write forever; the
 * second must not be recorded as delivered).
 *
 * `ruleState(alertId)` is a passthrough: in this ticket every rule is
 * `{ enabled: true, mutedUntil: null }` (#261 supplies real values without any
 * change here, per #258's "single merge point" design).
 *
 * `digest: true` (config block level, so every rule under it agrees) merges
 * every event this `deliver()` call would otherwise send individually into
 * one message per channel, sent once. Ledger rows are still written one per
 * event (dedup and reminders work exactly as in the non-digest case); only
 * the outgoing notification is merged. A digest sends to at most one
 * destination per channel type: merging *is* the point of digest, so when an
 * operator has several Slack/Discord/webhook endpoints configured, the first
 * enabled one of each type receives the combined message (fan-out to every
 * endpoint is preserved for the non-digest case in `sendEvent`).
 */
'use strict';

const moment = require('moment-timezone');
const { compileTemplateSet } = require('./templateRenderer');

/** Every channel key `deliver` can request from `sender.sendTemplated`. */
const ALL_CHANNELS = ['telegram', 'email', 'slack', 'discord', 'webhook', 'ntfy'];

/**
 * Each `sendTemplated` channel key to the `templateRenderer` channel mode(s)
 * it needs compiled/validated for (`email` needs both an HTML and a plain
 * text render).
 */
const CHANNEL_TO_MODES = {
  telegram: ['telegram'],
  email: ['email_html', 'email_text'],
  slack: ['slack'],
  discord: ['discord'],
  webhook: ['webhook'],
  ntfy: ['ntfy']
};

/** Every variable name a built-in or operator template may reference (see docs/SCHEDULE_ALERTS.md). */
const VARIABLES = [
  'name', 'payee', 'account', 'direction',
  'expected_amount', 'expected_date', 'deadline', 'grace_days',
  'period', 'cadence',
  'days_overdue', 'received_amount', 'received_date', 'difference',
  'last_sync', 'budget', 'alert_id',
  'expected_amount_raw', 'expected_date_raw', 'deadline_raw', 'days_overdue_raw',
  'received_amount_raw', 'received_date_raw', 'difference_raw', 'last_sync_raw'
];

/**
 * Built-in English messages (#258 "Default messages"). The `missing`
 * template folds the income and expense wording the issue gives as two
 * separate examples into one `{{#if (eq direction "expense")}}` branch, and
 * `resolved` folds in the #271 item 8 fix (a different branch when
 * `days_overdue` is 0, instead of "0 day(s) after the deadline").
 */
const DEFAULT_TEMPLATES = {
  missing: '{{#if (eq direction "expense")}}⚠️ {{name}} did not go out. {{expected_amount}} to {{payee}} from '
    + '{{account}} was due {{expected_date}}.{{else}}⚠️ {{name}} not received. Expected {{expected_amount}} '
    + 'from {{payee}} into {{account}} by {{deadline}} (for {{period}}, {{cadence}}). {{days_overdue}} day(s) overdue.{{/if}}',
  wrongAmount: '⚠️ {{name}}: received {{received_amount}} on {{received_date}}, expected {{expected_amount}} '
    + '(difference {{difference}}).',
  resolved: '✅ {{name}}: {{received_amount}} arrived {{received_date}}, {{#if (eq days_overdue 0)}}on time'
    + '{{else}}{{days_overdue}} day(s) after the deadline{{/if}}. Alert closed.',
  cannotCheck: '⏸️ Cannot check {{name}}: {{account}} has not synced since {{last_sync}} (deadline {{deadline}}). '
    + 'Check the bank connection.',
  ruleUnmatched: '❓ Payment alert "{{alert_id}}" matches no schedule in {{budget}}. Check the schedule name in Actual.'
};

/**
 * Format signed integer cents as a plain decimal string. Actual's API does
 * not expose a currency code alongside an amount, so no symbol is added; the
 * operator's own template can add one if every budget it covers shares a
 * currency.
 *
 * @param {?number} cents
 * @returns {?string}
 */
function formatAmount(cents) {
  if (cents == null) return null;
  return (cents / 100).toFixed(2);
}

/**
 * Format a `YYYY-MM-DD` calendar date in `dateFormat` (moment.js tokens, per
 * `scheduleAlerts.dateFormat` in the config block), or `null` through.
 *
 * @param {?string} isoDate
 * @param {string} dateFormat
 * @param {string} timezone
 * @returns {?string}
 */
function formatDate(isoDate, dateFormat, timezone) {
  if (!isoDate) return null;
  return moment.tz(isoDate, timezone).format(dateFormat);
}

/**
 * Build the Handlebars render context for one event, per the #258 variable
 * table. Every documented variable is always present (as `null` when it does
 * not apply to this event type), so a template can safely reference any of
 * them without an `{{#if}}` guard.
 *
 * @param {Object} event - one entry from `evaluate()`'s `events[]`, or a
 *   `resolved` event this module derived
 * @param {?Object} evaluation - the matching entry from `evaluations[]`, if any
 * @param {Object} rule - the normalized rule (`scheduleAlertRules.getRules`)
 * @param {Object} opts - `{ server, timezone }`
 * @returns {Object}
 */
function buildContext(event, evaluation, rule, { server, timezone }) {
  const dateFormat = rule.dateFormat || 'D MMM YYYY';
  const expectedAmount = event.expectedAmount != null ? event.expectedAmount : (evaluation ? evaluation.expectedAmount : null);
  const direction = expectedAmount != null && expectedAmount < 0 ? 'expense' : 'income';

  const occurrenceDate = event.occurrence || null;
  let periodDate = occurrenceDate;
  if (occurrenceDate && rule.period === 'next') {
    periodDate = moment.tz(occurrenceDate, timezone).add(1, 'month').format('YYYY-MM-DD');
  }

  const daysOverdue = event.daysOverdue != null ? event.daysOverdue : null;

  return {
    name: (evaluation && evaluation.name) || rule.scheduleName || rule.id,
    payee: evaluation ? evaluation.payee : null,
    account: evaluation ? evaluation.account : null,
    direction,
    expected_amount: formatAmount(expectedAmount),
    expected_amount_raw: expectedAmount,
    expected_date: formatDate(occurrenceDate, dateFormat, timezone),
    expected_date_raw: occurrenceDate,
    deadline: formatDate(event.deadline, dateFormat, timezone),
    deadline_raw: event.deadline || null,
    grace_days: rule.graceDays,
    period: periodDate ? moment.tz(periodDate, timezone).format('MMMM YYYY') : null,
    cadence: evaluation ? evaluation.cadenceText : null,
    days_overdue: daysOverdue,
    days_overdue_raw: daysOverdue,
    received_amount: formatAmount(event.receivedAmount),
    received_amount_raw: event.receivedAmount != null ? event.receivedAmount : null,
    received_date: formatDate(event.receivedDate, dateFormat, timezone),
    received_date_raw: event.receivedDate || null,
    difference: formatAmount(event.difference),
    difference_raw: event.difference != null ? event.difference : null,
    last_sync: formatDate(event.lastSync, dateFormat, timezone),
    last_sync_raw: event.lastSync || null,
    budget: server,
    alert_id: event.alertId
  };
}

/**
 * Every currently usable destination for one `sendTemplated` channel key,
 * read from `sender.config` (the same object `NotificationService` itself
 * holds). `telegram` / `email` / `ntfy` are single-destination and configured
 * as enabled or not; `slack` / `discord` / `webhook` (the generic webhook
 * list) can have several, each becoming its own `sendTemplated` call since
 * that API takes one URL per call.
 *
 * @param {string} channel
 * @param {{config?:Object}} sender
 * @returns {Object[]} zero or more targets (`{url}` for the webhook-style
 *   channels, `{}` for the others)
 */
function resolveTargets(channel, sender) {
  const cfg = (sender && sender.config) || {};
  switch (channel) {
    case 'telegram':
      return (cfg.telegram?.enabled || cfg.webhooks?.telegram?.length > 0) ? [{}] : [];
    case 'email':
      return cfg.email?.enabled ? [{}] : [];
    case 'ntfy':
      return (cfg.ntfy?.enabled && cfg.ntfy?.url) ? [{}] : [];
    case 'slack':
      return (cfg.webhooks?.slack || []).filter((w) => w.enabled !== false && w.url);
    case 'discord':
      return (cfg.webhooks?.discord || []).filter((w) => w.enabled !== false && w.url);
    case 'webhook':
      return (cfg.webhooks?.generic || []).filter((w) => w.enabled !== false && w.url);
    default:
      return [];
  }
}

/**
 * Resolve the channel list a rule sends to: its own `channels`, or every
 * channel `sendTemplated` knows about when unset ("defaults to every
 * configured channel"). Either way, a channel with no usable destination
 * (`resolveTargets` returns none) is dropped: requesting it would be a no-op
 * at best, or `sendTemplated`'s ambiguous not-configured result at worst (see
 * the module doc comment).
 *
 * @param {Object} rule
 * @param {{config?:Object}} sender
 * @returns {string[]}
 */
function resolveChannels(rule, sender) {
  const requested = rule.channels && rule.channels.length ? rule.channels : ALL_CHANNELS;
  return requested.filter((channel) => resolveTargets(channel, sender).length > 0);
}

/**
 * Build one `sendTemplated` channel entry for a single event and a single
 * destination.
 *
 * @param {{render:Function}} renderer
 * @param {string} key - template key (`missing`, `wrongAmount`, ...)
 * @param {Object} context
 * @param {string} channel
 * @param {Object} target - from `resolveTargets` (`{url}` or `{}`)
 * @param {string} name - the `alert_id`/schedule name, used for subject/title
 * @returns {Object} a partial `channelOutputs`, keyed by `channel`
 */
function buildChannelOutput(renderer, key, context, channel, target, name) {
  switch (channel) {
    case 'telegram': {
      const html = renderer.render(key, context, 'telegram');
      // No dedicated "telegram plain" mode: strip the small set of HTML tags
      // templateRenderer's telegram mode allows, so `plain` never carries markup.
      return { telegram: { html, plain: html.replace(/<\/?[a-z][a-z0-9]*[^>]*>/gi, '') } };
    }
    case 'email':
      return {
        email: {
          subject: `Actual-sync: ${name}`,
          text: renderer.render(key, context, 'email_text'),
          html: renderer.render(key, context, 'email_html')
        }
      };
    case 'slack':
      return { slack: { url: target.url, text: renderer.render(key, context, 'slack') } };
    case 'discord':
      return { discord: { url: target.url, text: renderer.render(key, context, 'discord') } };
    case 'webhook':
      return { webhook: { url: target.url, text: renderer.render(key, context, 'webhook') } };
    case 'ntfy':
      return { ntfy: { title: `Actual-sync: ${name}`, text: renderer.render(key, context, 'ntfy'), level: 'default' } };
    default:
      return {};
  }
}

/**
 * Whether a `sendTemplated` per-channel result counts as a success. `null`
 * (the channel was never attempted, e.g. email with no recipients) is not a
 * failure; a genuine failure never reaches this point unconfigured, since
 * `resolveChannels`/`resolveTargets` only request channels with a real
 * destination.
 *
 * @param {?Object} result
 * @returns {boolean}
 */
function channelSucceeded(result) {
  if (result == null) return true;
  if (result.success === false) return false;
  if (result.ok === false) return false;
  return true;
}

/**
 * Send one `channelOutputs` payload and interpret the result, logging (and
 * returning `false`) on any failure so the caller withholds the ledger row.
 *
 * @returns {Promise<boolean>}
 */
async function sendOnce(sender, channelOutputs, { server, alertId, event, occurrence, logger }) {
  try {
    const results = await sender.sendTemplated(channelOutputs);
    const ok = Object.values(results || {}).every(channelSucceeded);
    if (!ok) {
      logger.warn('Schedule alert send failed on at least one channel; ledger row withheld for retry', {
        server, alertId, event, occurrence
      });
    }
    return ok;
  } catch (error) {
    logger.warn('Schedule alert send threw; ledger row withheld for retry', {
      server, alertId, event, error: error.message
    });
    return false;
  }
}

/**
 * Render, send and record one event, fanning out to every destination of
 * every requested channel. Returns `true` only if every destination
 * succeeded (so the caller may record the ledger row); a single failed
 * destination withholds the row so the whole event retries next sync.
 *
 * @returns {Promise<boolean>}
 */
async function sendEvent({ event, evaluation, rule, sender, server, timezone, logger }) {
  const templates = { ...DEFAULT_TEMPLATES, ...(rule.templates || {}) };
  const channels = resolveChannels(rule, sender);
  if (channels.length === 0) return true; // nothing configured to send to; nothing to retry either

  const modes = channels.flatMap((channel) => CHANNEL_TO_MODES[channel] || []);
  const renderer = compileTemplateSet({ templates, variables: VARIABLES, channels: modes });
  const context = buildContext(event, evaluation, rule, { server, timezone });
  const name = context.name;

  let allOk = true;
  for (const channel of channels) {
    for (const target of resolveTargets(channel, sender)) {
      const channelOutputs = buildChannelOutput(renderer, event.event, context, channel, target, name);
      const ok = await sendOnce(sender, channelOutputs, {
        server, alertId: event.alertId, event: event.event, occurrence: event.occurrence, logger
      });
      if (!ok) allOk = false;
    }
  }
  return allOk;
}

/**
 * Build one channel's merged digest payload: every eligible event's own
 * render, in that channel's mode, joined under one header.
 */
function buildDigestOutput(channel, header, linesByMode, target, server) {
  switch (channel) {
    case 'telegram': {
      const html = `${header}\n\n${linesByMode.telegram.join('\n')}`;
      return { telegram: { html, plain: html.replace(/<\/?[a-z][a-z0-9]*[^>]*>/gi, '') } };
    }
    case 'email':
      return {
        email: {
          subject: `Actual-sync: payment alerts for ${server}`,
          text: `${header}\n\n${linesByMode.email_text.join('\n')}`,
          html: `<p>${header}</p><ul>${linesByMode.email_html.map((line) => `<li>${line}</li>`).join('')}</ul>`
        }
      };
    case 'slack':
      return { slack: { url: target.url, text: `${header}\n\n${linesByMode.slack.join('\n')}` } };
    case 'discord':
      return { discord: { url: target.url, text: `${header}\n\n${linesByMode.discord.join('\n')}` } };
    case 'webhook':
      return { webhook: { url: target.url, text: `${header}\n\n${linesByMode.webhook.join('\n')}` } };
    case 'ntfy':
      return { ntfy: { title: `Actual-sync: ${server}`, text: `${header}\n\n${linesByMode.ntfy.join('\n')}`, level: 'default' } };
    default:
      return {};
  }
}

/**
 * Send one batch of eligible events (already deduplicated and rule-state
 * filtered) as a single merged message per channel, for `digest: true`. See
 * the module doc comment for what "merged" means for a channel with several
 * configured destinations.
 *
 * @param {Array<{event:Object, evaluation:?Object, rule:Object}>} items
 * @returns {Promise<boolean>}
 */
async function sendDigestBatch(items, { sender, server, timezone, logger }) {
  const channelSet = new Set();
  for (const item of items) resolveChannels(item.rule, sender).forEach((channel) => channelSet.add(channel));
  const channels = Array.from(channelSet);
  if (channels.length === 0) return true;

  const modes = channels.flatMap((channel) => CHANNEL_TO_MODES[channel] || []);
  const linesByMode = {};
  for (const mode of modes) linesByMode[mode] = [];

  for (const item of items) {
    const templates = { ...DEFAULT_TEMPLATES, ...(item.rule.templates || {}) };
    const renderer = compileTemplateSet({ templates, variables: VARIABLES, channels: modes });
    const context = buildContext(item.event, item.evaluation, item.rule, { server, timezone });
    for (const mode of modes) linesByMode[mode].push(renderer.render(item.event.event, context, mode));
  }

  const header = `Actual-sync: ${items.length} payment alert(s) for ${server}`;
  let allOk = true;
  for (const channel of channels) {
    // Merging is the point of digest: one message per channel type, to its
    // first enabled destination (see the module doc comment).
    const target = resolveTargets(channel, sender)[0];
    const channelOutputs = buildDigestOutput(channel, header, linesByMode, target, server);
    const ok = await sendOnce(sender, channelOutputs, { server, alertId: 'digest', event: 'digest', occurrence: null, logger });
    if (!ok) allOk = false;
  }
  return allOk;
}

/**
 * Derive `resolved` events from `evaluations` + the ledger: every occurrence
 * now `received` or `late` that has a `sent` `missing` row and no `resolved`
 * row yet. `evaluate()` cannot do this itself - it has no alert history.
 *
 * @param {Object[]} evaluations
 * @param {Object} history
 * @param {string} server
 * @returns {Promise<Object[]>} synthesized `resolved` events, shaped like `evaluate()`'s AlertEvent
 */
async function deriveResolvedEvents(evaluations, history, server) {
  const resolved = [];
  for (const evaluation of evaluations) {
    for (const occ of evaluation.occurrences || []) {
      if (occ.state !== 'received' && occ.state !== 'late') continue;
      const missingRow = await history.findLatestScheduleAlert({
        server, alertId: evaluation.alertId, scheduleId: evaluation.scheduleId, occurrenceDate: occ.date, event: 'missing'
      });
      if (!missingRow) continue;
      const resolvedRow = await history.findLatestScheduleAlert({
        server, alertId: evaluation.alertId, scheduleId: evaluation.scheduleId, occurrenceDate: occ.date, event: 'resolved'
      });
      if (resolvedRow) continue;

      const daysOverdue = occ.receivedDate ? moment(occ.receivedDate).diff(moment(occ.deadline), 'days') : 0;
      resolved.push({
        event: 'resolved',
        alertId: evaluation.alertId,
        scheduleId: evaluation.scheduleId,
        occurrence: occ.date,
        deadline: occ.deadline,
        daysOverdue: Math.max(0, daysOverdue),
        receivedAmount: occ.receivedAmount,
        receivedDate: occ.receivedDate,
        expectedAmount: evaluation.expectedAmount
      });
    }
  }
  return resolved;
}

/**
 * Whether a new ledger row may be written for this event, given the ledger's
 * current state for its `(server, alertId, scheduleId, occurrence, event)`
 * key. Every event type gets at most one row ever, except `missing`, which
 * additionally allows a reminder once `rule.remindEveryDays` have passed
 * since the latest row (`ruleUnmatched`, whose `occurrence` is always
 * `null`, is deduplicated the same way: one row per rule per calendar day,
 * via `remindEveryDays: 1` applied by the caller).
 *
 * @returns {Promise<boolean>}
 */
async function mayRecord(event, rule, history, server, now) {
  const latest = await history.findLatestScheduleAlert({
    server, alertId: event.alertId, scheduleId: event.scheduleId, occurrenceDate: event.occurrence, event: event.event
  });
  if (!latest) return true;
  if (event.event !== 'missing' && event.event !== 'ruleUnmatched') return false;

  const remindEveryDays = event.event === 'ruleUnmatched' ? 1 : rule.remindEveryDays;
  if (!remindEveryDays) return false;
  const ageDays = moment(now).diff(moment(latest.recordedAt), 'days');
  return ageDays >= remindEveryDays;
}

/**
 * Deliver a batch of events (and the `resolved` events derived from
 * `evaluations` + the ledger).
 *
 * @param {Object[]} events - `evaluate()`'s `events[]`
 * @param {Object} opts
 * @param {Object[]} opts.evaluations - `evaluate()`'s `evaluations[]`
 * @param {(alertId:string) => {enabled:boolean, mutedUntil:?string}} opts.ruleState
 * @param {Object} opts.history - the `schedule_alerts` ledger (see `syncHistory.js`)
 * @param {{sendTemplated:Function, config?:Object}} opts.sender - `notificationService`'s public entry point
 * @param {Date|string} opts.now
 * @param {string} opts.server - server name (the `budget` template variable, and the ledger's `server` column)
 * @param {Object[]} opts.rules - normalized rules, keyed by `id`, for template/channel/period/digest config
 * @param {string} opts.timezone
 * @param {Object} [opts.logger] - `{ warn(message, meta) }`; defaults to a no-op
 * @returns {Promise<{sent: number, skipped: number}>}
 */
async function deliver(events, { evaluations, ruleState, history, sender, now, server, rules, timezone, logger }) {
  const log = logger || { warn() {} };
  const rulesById = new Map((rules || []).map((r) => [r.id, r]));
  let sent = 0;
  let skipped = 0;

  const resolvedEvents = await deriveResolvedEvents(evaluations || [], history, server);
  const allEvents = [...(events || []), ...resolvedEvents];

  const eligible = [];
  for (const event of allEvents) {
    const rule = rulesById.get(event.alertId);
    if (!rule) { skipped += 1; continue; }

    const state = ruleState(event.alertId) || { enabled: true, mutedUntil: null };
    if (!state.enabled) { skipped += 1; continue; }
    if (state.mutedUntil && moment(now).isBefore(moment(state.mutedUntil))) { skipped += 1; continue; }

    if (!(await mayRecord(event, rule, history, server, now))) { skipped += 1; continue; }

    const evaluation = (evaluations || []).find(
      (e) => e.alertId === event.alertId && e.scheduleId === event.scheduleId
    ) || null;

    eligible.push({ event, evaluation, rule });
  }

  // The block-level `digest` flag is copied onto every rule under it
  // (`scheduleAlertRules.normalizeRule`), so any rule having it means the
  // whole block does.
  const digestOn = (rules || []).some((r) => r.digest);

  if (digestOn) {
    if (eligible.length === 0) return { sent, skipped };
    const ok = await sendDigestBatch(eligible, { sender, server, timezone, logger: log });
    if (!ok) {
      skipped += eligible.length;
      return { sent, skipped };
    }
    for (const item of eligible) {
      await history.recordScheduleAlert({
        server, alertId: item.event.alertId, scheduleId: item.event.scheduleId,
        occurrenceDate: item.event.occurrence, event: item.event.event, delivery: 'sent'
      });
      sent += 1;
    }
    return { sent, skipped };
  }

  for (const item of eligible) {
    const ok = await sendEvent({
      event: item.event, evaluation: item.evaluation, rule: item.rule, sender, server, timezone, logger: log
    });
    if (!ok) { skipped += 1; continue; }

    await history.recordScheduleAlert({
      server, alertId: item.event.alertId, scheduleId: item.event.scheduleId,
      occurrenceDate: item.event.occurrence, event: item.event.event, delivery: 'sent'
    });
    sent += 1;
  }

  return { sent, skipped };
}

module.exports = { deliver, DEFAULT_TEMPLATES, VARIABLES, ALL_CHANNELS };
