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
 * - records one `sent` row per successfully delivered *destination* (#295
 *   review, H5), so a dead destination retries alone next sync instead of
 *   resending to every destination that already succeeded.
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
 *
 * #295 review, H5: the ledger is keyed per destination (`schedule_alerts.channel`,
 * e.g. `slack:#a1b2c3d4` - see `destinationKey`, which never stores the raw
 * webhook URL, #295 review round 2, M8), not just per event. Previously a
 * single `allOk` flag spanned every destination of every requested channel,
 * so one dead destination withheld the ledger row for the whole event and
 * every OTHER, already-succeeding destination resent it again next sync.
 * `dueDestinations()` now computes, per event, exactly which destinations
 * still need it (never sent, or a reminder is due) and `sendEvent`/
 * `sendDigestBatch` record a row for each destination as soon as it
 * succeeds, so a failing destination retries alone.
 */
'use strict';

const moment = require('moment-timezone');
const crypto = require('crypto');
const { compileTemplateSet } = require('./templateRenderer');

/** Every channel key `deliver` can request from `sender.sendTemplated`. */
const ALL_CHANNELS = ['telegram', 'email', 'slack', 'discord', 'webhook', 'ntfy'];

/**
 * A ledger-safe key identifying one destination (#295 review round 2, M8).
 * Previously this was `${channel}:${target.url}`, storing the full webhook
 * URL - a secret - in plain text in sync-history.db. This keys by the
 * operator's own `name` for the webhook when configured (stable and already
 * how they refer to it), or otherwise a short, non-reversible sha256 hash of
 * the URL, e.g. `slack:#a1b2c3d4`. A single-destination channel (telegram,
 * email, ntfy) has no URL at all and keys by the channel name alone, as
 * before.
 *
 * Trade-off: adding a webhook, renaming one, or rotating its URL (with no
 * name set) changes its key, which the ledger has never seen before, so any
 * currently-open alert is re-sent once to it before settling into the normal
 * per-destination dedup/reminder cycle. This is accepted: it is strictly
 * safer than either storing the secret or silently losing track of in-flight
 * alerts across a rename/rotation.
 *
 * @param {string} channel
 * @param {{name?:string, url?:string}} target
 * @returns {string}
 */
function destinationKey(channel, target) {
  if (!target.url) return channel;
  if (target.name) return `${channel}:#${target.name}`;
  const hash = crypto.createHash('sha256').update(target.url).digest('hex').slice(0, 8);
  return `${channel}:#${hash}`;
}

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
 * Whole calendar days between two instants in `timezone` (#295 review, M7).
 * A raw `moment(now).diff(moment(recordedAt), 'days')` counts full 24h
 * periods, so a row recorded at 23:00 and checked at 01:00 the "next" day is
 * 0 days apart by the clock but 2 calendar dates apart; with
 * `remindEveryDays: 1` this let a reminder skip a calendar day (fire roughly
 * every 2 days) or, depending on where the 24h boundary fell relative to the
 * sync schedule, fire twice in one day. Comparing `startOf('day')` in the
 * configured timezone instead makes "1 day" mean "the next calendar day",
 * matching how an operator reads `remindEveryDays`.
 *
 * @param {Date|string} now
 * @param {Date|string} recordedAt
 * @param {string} timezone
 * @returns {number}
 */
function calendarDaysBetween(now, recordedAt, timezone) {
  return moment.tz(now, timezone).startOf('day').diff(moment.tz(recordedAt, timezone).startOf('day'), 'days');
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
 * Every individual destination a rule can send to right now: one entry per
 * `(channel, target)` pair `resolveChannels`/`resolveTargets` expose. `key`
 * uniquely identifies the destination for the ledger (#295 review, H5): the
 * channel name alone for a single-destination channel, `channel:url` for a
 * webhook-style channel that can have several.
 *
 * @param {Object} rule
 * @param {{config?:Object}} sender
 * @returns {Array<{channel:string, target:Object, key:string}>}
 */
function destinationsForRule(rule, sender) {
  const destinations = [];
  for (const channel of resolveChannels(rule, sender)) {
    for (const target of resolveTargets(channel, sender)) {
      destinations.push({ channel, target, key: destinationKey(channel, target) });
    }
  }
  return destinations;
}

/**
 * The subset of a rule's destinations still due for one event: never sent to
 * that destination before (#295 review, H5), or, for `missing`/
 * `ruleUnmatched`, due for a reminder (`rule.remindEveryDays`, calendar-day
 * comparison per M7). Shared by `mayRecord` (the entry gate) and
 * `sendEvent`/`sendDigestBatch` (what actually gets attempted and recorded),
 * so the two can never disagree about what is due.
 *
 * @returns {Promise<Array<{channel:string, target:Object, key:string}>>}
 */
async function isDestinationDue(event, rule, destinationKey, history, server, now, timezone) {
  // #295 review round 2, M5: a `resolved` event is only meaningful for a
  // destination that actually received the original `missing` alert, and
  // must retry to any destination that has not YET recorded `resolved`,
  // independently of what other destinations already did. Both checks are
  // per-destination (`channel: destinationKey`), unlike `deriveResolvedEvents`'s
  // own coarse existence check, which only asks "does ANY channel need this".
  if (event.event === 'resolved') {
    const missingRow = await history.findLatestScheduleAlert({
      server, alertId: event.alertId, scheduleId: event.scheduleId,
      occurrenceDate: event.occurrence, event: 'missing', channel: destinationKey
    });
    if (!missingRow) return false; // this destination was never told it was missing
    const resolvedRow = await history.findLatestScheduleAlert({
      server, alertId: event.alertId, scheduleId: event.scheduleId,
      occurrenceDate: event.occurrence, event: 'resolved', channel: destinationKey
    });
    return !resolvedRow;
  }

  const latest = await history.findLatestScheduleAlert({
    server, alertId: event.alertId, scheduleId: event.scheduleId,
    occurrenceDate: event.occurrence, event: event.event, channel: destinationKey
  });
  if (!latest) return true;
  if (event.event !== 'missing' && event.event !== 'ruleUnmatched') return false; // one row per destination, ever
  const remindEveryDays = event.event === 'ruleUnmatched' ? 1 : rule.remindEveryDays;
  if (!remindEveryDays) return false;
  return calendarDaysBetween(now, latest.recordedAt, timezone) >= remindEveryDays;
}

async function dueDestinations(event, rule, sender, history, server, now, timezone) {
  const destinations = destinationsForRule(rule, sender);
  const due = [];
  for (const destination of destinations) {
    if (await isDestinationDue(event, rule, destination.key, history, server, now, timezone)) due.push(destination);
  }
  return due;
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
 * #295 review, M2: this `null`-is-success rule only stays safe because
 * `resolveChannels` already excludes a channel with zero usable
 * destinations, and `configLoader.js`'s startup validation additionally
 * rejects a rule whose explicit `channels` names none that are configured.
 * Without those two guards, a misconfigured "enabled but nothing to send to"
 * channel could reach here and be counted as delivered when nothing went
 * out; do not relax either guard without revisiting this function too.
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
 * Render, send and record one event, one destination at a time (#295 review,
 * H5): each destination is checked against the ledger independently, sent
 * to only if still due, and recorded the moment it succeeds. Returns `true`
 * if at least one destination was newly recorded (the event counts as
 * "sent" for `deliver()`'s summary); `false` if nothing due succeeded (the
 * event counts as "skipped" and every still-failing destination retries next
 * sync, without disturbing destinations that already succeeded).
 *
 * #295 review, M2: when a rule resolves to zero usable destinations at all
 * (e.g. its explicit `channels` names only unconfigured channels that
 * startup validation did not catch, or nothing is configured server-wide),
 * this WARNs once and records nothing, rather than the previous behavior of
 * silently returning success with nothing sent.
 *
 * #295 review, H6: rendering is wrapped per destination so one bad rule's
 * template (a syntax error `compileTemplateSet`'s startup validation missed,
 * or a runtime value it cannot render) only skips that destination/event, it
 * does not throw out of `deliver()`'s loop and block every other rule.
 *
 * @returns {Promise<boolean>}
 */
async function sendEvent({ event, evaluation, rule, sender, server, timezone, logger, history, now }) {
  try {
    const destinations = await dueDestinations(event, rule, sender, history, server, now, timezone);
    if (destinations.length === 0) {
      logger.warn('Schedule alert has no due/usable destination; nothing sent, no ledger row written', {
        server, alertId: event.alertId, event: event.event, occurrence: event.occurrence
      });
      return false;
    }

    const templates = { ...DEFAULT_TEMPLATES, ...(rule.templates || {}) };
    const channels = Array.from(new Set(destinations.map((d) => d.channel)));
    const modes = channels.flatMap((channel) => CHANNEL_TO_MODES[channel] || []);
    const context = buildContext(event, evaluation, rule, { server, timezone });

    let sentAny = false;
    for (const destination of destinations) {
      let ok = false;
      try {
        const renderer = compileTemplateSet({ templates, variables: VARIABLES, channels: modes });
        const channelOutputs = buildChannelOutput(renderer, event.event, context, destination.channel, destination.target, context.name);
        ok = await sendOnce(sender, channelOutputs, {
          server, alertId: event.alertId, event: event.event, occurrence: event.occurrence, logger
        });
      } catch (error) {
        logger.warn('Schedule alert render failed; destination skipped, will retry next sync', {
          server, alertId: event.alertId, event: event.event, channel: destination.channel, error: error.message
        });
      }
      if (ok) {
        await history.recordScheduleAlert({
          server, alertId: event.alertId, scheduleId: event.scheduleId, occurrenceDate: event.occurrence,
          event: event.event, delivery: 'sent', channel: destination.key
        });
        sentAny = true;
      }
    }
    return sentAny;
  } catch (error) {
    logger.warn('Schedule alert send threw; event skipped, will retry next sync', {
      server, alertId: event.alertId, event: event.event, error: error.message
    });
    return false;
  }
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
 * A stable key identifying one event's ledger row, independent of channel
 * (used only to report per-event sent/skipped back to `deliver()`; the
 * ledger row itself is additionally keyed per destination, see the module
 * doc comment).
 */
function eventKey(event) {
  return `${event.alertId}|${event.scheduleId}|${event.occurrence}|${event.event}`;
}

/**
 * Send one batch of eligible events (already deduplicated and rule-state
 * filtered) as a single merged message per channel, for `digest: true`.
 *
 * #295 review, M1: each rule's own `channels` restriction still applies in
 * digest mode. Previously the channel set was the UNION of every item's
 * channels and every channel received the full merged content regardless of
 * which rules actually allowed it, leaking a channel-restricted rule's
 * content onto channels its own config never named. Grouping by channel
 * first, then only including items that allow that channel, fixes this.
 *
 * #295 review, H5: a digest still sends to only its one primary destination
 * per channel type (merging *is* the point of digest - see the module doc
 * comment on `resolveTargets`), so the ledger is keyed by that single
 * destination too; only items still due for it are included, and an item
 * already delivered on this channel in a prior digest is not resent just
 * because another item in today's batch is still pending on it.
 *
 * #295 review, H6: one rule's bad template only drops that item from that
 * channel's digest (logged), it does not throw and lose the whole batch.
 *
 * @param {Array<{event:Object, evaluation:?Object, rule:Object}>} items
 * @returns {Promise<Set<string>>} the `eventKey()`s that got at least one
 *   newly-recorded destination this call
 */
async function sendDigestBatch(items, { sender, server, timezone, logger, history, now }) {
  const perChannelItems = new Map();
  for (const item of items) {
    for (const channel of resolveChannels(item.rule, sender)) {
      if (!perChannelItems.has(channel)) perChannelItems.set(channel, []);
      perChannelItems.get(channel).push(item);
    }
  }

  const sentKeys = new Set();

  for (const [channel, channelItems] of perChannelItems) {
    // Merging is the point of digest: one message per channel type, to its
    // first enabled destination (see the module doc comment).
    const target = resolveTargets(channel, sender)[0];
    if (!target) continue; // resolveChannels already guarantees this, defensive only
    const key = destinationKey(channel, target);

    const dueItems = [];
    for (const item of channelItems) {
      if (await isDestinationDue(item.event, item.rule, key, history, server, now, timezone)) dueItems.push(item);
    }
    if (dueItems.length === 0) continue;

    const modes = CHANNEL_TO_MODES[channel] || [];
    const linesByMode = {};
    for (const mode of modes) linesByMode[mode] = [];
    const rendered = [];
    for (const item of dueItems) {
      try {
        const templates = { ...DEFAULT_TEMPLATES, ...(item.rule.templates || {}) };
        const renderer = compileTemplateSet({ templates, variables: VARIABLES, channels: modes });
        const context = buildContext(item.event, item.evaluation, item.rule, { server, timezone });
        for (const mode of modes) linesByMode[mode].push(renderer.render(item.event.event, context, mode));
        rendered.push(item);
      } catch (error) {
        logger.warn('Schedule alert digest render failed for one item; item skipped', {
          server, alertId: item.event.alertId, event: item.event.event, channel, error: error.message
        });
      }
    }
    if (rendered.length === 0) continue;

    const header = `Actual-sync: ${rendered.length} payment alert(s) for ${server}`;
    const channelOutputs = buildDigestOutput(channel, header, linesByMode, target, server);
    const ok = await sendOnce(sender, channelOutputs, { server, alertId: 'digest', event: 'digest', occurrence: null, logger });
    if (!ok) continue; // H5: withhold only this channel's rows; other channels are unaffected

    for (const item of rendered) {
      await history.recordScheduleAlert({
        server, alertId: item.event.alertId, scheduleId: item.event.scheduleId,
        occurrenceDate: item.event.occurrence, event: item.event.event, delivery: 'sent',
        channel: key
      });
      sentKeys.add(eventKey(item.event));
    }
  }

  return sentKeys;
}

/**
 * Derive `resolved` events from `evaluations` + the ledger: every occurrence
 * now `received` or `late` that has a `sent` `missing` row on at least one
 * channel. `evaluate()` cannot do this itself - it has no alert history.
 *
 * This is only a coarse, cheap pre-filter ("has anybody, on any channel,
 * ever been told this was missing"), not the actual per-destination send
 * decision. It deliberately does NOT also check for an existing `resolved`
 * row (#295 review round 2, M5): that used to skip the whole occurrence the
 * moment ANY channel had recorded `resolved`, which meant a destination
 * whose own `resolved` send had failed was never retried, since the event
 * itself was never even synthesized again. The real, per-destination
 * "already resolved here, or never alerted here" decision now lives in
 * `isDestinationDue`, which `mayRecord`/`sendEvent`/`sendDigestBatch` all go
 * through before a destination is attempted or recorded.
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
 * Whether this event has at least one destination still worth attempting
 * (#295 review, H5: this is now per-destination, via `dueDestinations`, not
 * a single ledger row per event - see the module doc comment). Every event
 * type gets at most one row per destination ever, except `missing`, which
 * additionally allows a reminder once `rule.remindEveryDays` calendar days
 * (M7) have passed since that destination's latest row (`ruleUnmatched`,
 * whose `occurrence` is always `null`, is deduplicated the same way: one row
 * per rule per calendar day, via `remindEveryDays: 1` applied by the caller).
 *
 * @returns {Promise<boolean>}
 */
async function mayRecord(event, rule, sender, history, server, now, timezone) {
  const due = await dueDestinations(event, rule, sender, history, server, now, timezone);
  return due.length > 0;
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

    // #295 review, M2: a rule resolving to zero usable destinations at all
    // (not just "nothing due right now") gets one WARN and no ledger row,
    // rather than silently falling out of `mayRecord`'s dedup check the same
    // way an already-fully-delivered event does (which needs no WARN).
    if (destinationsForRule(rule, sender).length === 0) {
      log.warn('Schedule alert has no due/usable destination; nothing sent, no ledger row written', {
        server, alertId: event.alertId, event: event.event
      });
      skipped += 1;
      continue;
    }

    if (!(await mayRecord(event, rule, sender, history, server, now, timezone))) { skipped += 1; continue; }

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
    // #295 review, H5/M1: per-destination, per-channel-restriction accounting
    // now lives inside sendDigestBatch; it records its own ledger rows and
    // reports back which events got at least one of them.
    const sentKeys = await sendDigestBatch(eligible, { sender, server, timezone, logger: log, history, now });
    for (const item of eligible) {
      if (sentKeys.has(eventKey(item.event))) sent += 1; else skipped += 1;
    }
    return { sent, skipped };
  }

  for (const item of eligible) {
    const ok = await sendEvent({
      event: item.event, evaluation: item.evaluation, rule: item.rule, sender, server, timezone, logger: log, history, now
    });
    if (ok) sent += 1; else skipped += 1;
  }

  return { sent, skipped };
}

module.exports = {
  deliver, DEFAULT_TEMPLATES, VARIABLES, ALL_CHANNELS, CHANNEL_TO_MODES,
  resolveChannels, destinationKey
};
