/**
 * Tests for missing-payment alert delivery (#258).
 *
 * `deliver()`'s collaborators (the sync-history ledger and the notification
 * sender) are faked here rather than using real SQLite/HTTP, since the goal
 * is to exercise de-duplication, reminders, resolved-event derivation, fan-out
 * and digest logic in isolation. A separate service-level test can wire the
 * real `SyncHistoryService` and `NotificationService` through `syncService.js`.
 */

const { deliver, DEFAULT_TEMPLATES, VARIABLES, ALL_CHANNELS, destinationKey } = require('../lib/scheduleAlertDelivery');
const { getRules, ruleState } = require('../lib/scheduleAlertRules');
const path = require('path');
const { SyncHistoryService } = require('../services/syncHistory');
const { createTempDir, cleanupTempDir } = require('./helpers/testHelpers');
const { compileTemplateSet } = require('../lib/templateRenderer');

/**
 * In-memory stand-in for the schedule_alerts ledger (src/services/syncHistory.js).
 * `channel` (#295 review, H5) mirrors the real service: when the caller
 * omits it, a lookup matches a row on ANY channel (used by
 * `deriveResolvedEvents`); when given, only a row for that exact destination
 * matches.
 */
function makeFakeHistory() {
  return {
    rows: [],
    clock: '2026-01-10T00:00:00.000Z',
    async findLatestScheduleAlert({ server, alertId, scheduleId, occurrenceDate, event, channel, delivery }) {
      const filterChannel = channel !== undefined;
      const matches = this.rows.filter((r) =>
        r.server === server && r.alertId === alertId && r.scheduleId === scheduleId
        && r.occurrenceDate === occurrenceDate && r.event === event
        && (!filterChannel || r.channel === (channel ?? null))
        && (delivery === undefined || r.delivery === delivery));
      return matches.length ? matches[matches.length - 1] : null;
    },
    async recordScheduleAlert({ server, alertId, scheduleId, occurrenceDate, event, delivery, channel }) {
      this.rows.push({ server, alertId, scheduleId, occurrenceDate, event, delivery, channel: channel ?? null, recordedAt: this.clock });
    }
  };
}

/** In-memory stand-in for notificationService: records config-driven sends. */
function makeFakeSender(config) {
  return {
    config,
    calls: [],
    result: null, // override per-test to simulate a channel failure
    async sendTemplated(channelOutputs) {
      this.calls.push(channelOutputs);
      if (this.result) return this.result(channelOutputs);
      const ok = {};
      for (const key of Object.keys(channelOutputs)) ok[key] = { success: true };
      return ok;
    }
  };
}

const quietLogger = { warn() {} };

function missingEvent(overrides = {}) {
  return {
    event: 'missing', alertId: 'rent', scheduleId: 's1', occurrence: '2026-01-05',
    deadline: '2026-01-08', daysOverdue: 2, expectedAmount: -50000, ...overrides
  };
}

function rentEvaluation(overrides = {}) {
  return {
    alertId: 'rent', scheduleId: 's1', name: 'Rent', cadenceText: null,
    account: 'Checking', payee: 'Landlord', expectedAmount: -50000,
    nextDate: null, deadline: '2026-01-08', state: 'missing',
    occurrences: [{ date: '2026-01-05', deadline: '2026-01-08', state: 'missing', receivedDate: null, receivedAmount: null }],
    ...overrides
  };
}

function rentRules(alertOverrides = {}, blockOverrides = {}) {
  return getRules({ ...blockOverrides, alerts: [{ id: 'rent', schedule: 'Rent', ...alertOverrides }] });
}

const enabledState = () => ({ enabled: true, mutedUntil: null });

describe('deliver: basic send + ledger', () => {
  test('sends through the only configured channel and records one ledger row', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });

    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()],
      ruleState: enabledState,
      history,
      sender,
      now: '2026-01-10',
      server: 'Main',
      rules: rentRules(),
      timezone: 'UTC',
      logger: quietLogger
    });

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].telegram.html).toMatch(/Rent/);
    expect(history.rows).toEqual([expect.objectContaining({
      server: 'Main', alertId: 'rent', scheduleId: 's1', occurrenceDate: '2026-01-05', event: 'missing', delivery: 'sent'
    })]);
  });

  test('a rule with no matching id in the rules list is skipped, not sent', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });

    const result = await deliver([missingEvent({ alertId: 'unknown-rule' })], {
      evaluations: [], ruleState: enabledState, history, sender, now: '2026-01-10',
      server: 'Main', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    });

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(0);
  });
});

describe('deliver: de-duplication and reminders', () => {
  test('the same missing event is not resent on the next sync (remindEveryDays unset)', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const args = {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      server: 'Main', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    };

    await deliver([missingEvent()], { ...args, now: '2026-01-10' });
    const second = await deliver([missingEvent()], { ...args, now: '2026-01-11' });

    expect(second).toEqual({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(1); // only the first call actually sent
  });

  test('remindEveryDays resends once the interval has passed, not before', async () => {
    // `now`/`history.clock` are full UTC instants throughout: `mayRecord`
    // diffs plain `moment(now)` against `moment(latest.recordedAt)` with no
    // explicit zone, so a bare 'YYYY-MM-DD' `now` would be parsed in the
    // *local* zone while `recordedAt` (syncHistory's `toISOString()`) is
    // always UTC - exactly the kind of mismatch this ticket's "injected
    // timezone in every test" rule exists to catch.
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const args = {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      server: 'Main', rules: rentRules({ remindEveryDays: 2 }), timezone: 'UTC', logger: quietLogger
    };

    history.clock = '2026-01-10T00:00:00.000Z';
    await deliver([missingEvent()], { ...args, now: '2026-01-10T00:00:00.000Z' });

    // One day later: reminder interval (2 days) has not elapsed yet.
    const tooSoon = await deliver([missingEvent()], { ...args, now: '2026-01-11T00:00:00.000Z' });
    expect(tooSoon).toEqual({ sent: 0, skipped: 1 });

    // Two days later: reminder interval elapsed, resend.
    const dueForReminder = await deliver([missingEvent()], { ...args, now: '2026-01-12T00:00:00.000Z' });
    expect(dueForReminder).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls).toHaveLength(2);
  });

  test('ruleUnmatched reminders use a fixed 1-day interval regardless of remindEveryDays', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const unmatchedEvent = { event: 'ruleUnmatched', alertId: 'rent', scheduleId: null, occurrence: null, deadline: null };
    const args = {
      evaluations: [], ruleState: enabledState, history, sender,
      server: 'Main', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    };

    history.clock = '2026-01-10T00:00:00.000Z';
    await deliver([unmatchedEvent], { ...args, now: '2026-01-10T00:00:00.000Z' });
    const nextDay = await deliver([unmatchedEvent], { ...args, now: '2026-01-11T00:00:00.000Z' });

    expect(nextDay).toEqual({ sent: 1, skipped: 0 });
  });
});

describe('deliver: rule state', () => {
  test('a disabled rule is skipped entirely', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });

    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: () => ({ enabled: false, mutedUntil: null }),
      history, sender, now: '2026-01-10', server: 'Main', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    });

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(0);
    expect(history.rows).toEqual([]); // #261: a disabled rule writes no ledger row
  });

  test('a rule muted until a future date is skipped', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });

    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: () => ({ enabled: true, mutedUntil: '2026-02-01' }),
      history, sender, now: '2026-01-10', server: 'Main', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    });

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(0);
    // #261: the event is remembered as muted, once, at the one destination.
    expect(history.rows).toEqual([expect.objectContaining({ event: 'missing', delivery: 'muted', channel: 'telegram' })]);
  });
});

describe('deliver: fan-out and partial failure', () => {
  test('fans out to every configured destination of a channel type', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      webhooks: { slack: [{ name: 'a', url: 'https://slack/a', enabled: true }, { name: 'b', url: 'https://slack/b', enabled: true }] }
    });

    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      now: '2026-01-10', server: 'Main', rules: rentRules({ channels: ['slack'] }), timezone: 'UTC', logger: quietLogger
    });

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls).toHaveLength(2);
    expect(sender.calls.map((c) => c.slack.url).sort()).toEqual(['https://slack/a', 'https://slack/b']);
    // #295 review, H5: the ledger is now keyed per destination, one row per
    // successfully delivered destination, not one row per event - see the
    // module doc comment and the "retry only the failed destination" test
    // below for why (a single shared row let one dead destination make every
    // other, already-succeeding destination resend on every sync).
    //
    // #295 review round 2, M8: the key is `channel:#name:hash`, never the raw
    // webhook URL (a secret) - see `destinationKey`.
    expect(history.rows).toHaveLength(2);
    expect(history.rows.map((r) => r.channel).sort()).toEqual([
      destinationKey('slack', { name: 'a', url: 'https://slack/a' }),
      destinationKey('slack', { name: 'b', url: 'https://slack/b' })
    ].sort());
  });

  test('a failed destination is withheld for retry without blocking the destination(s) that succeeded', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      webhooks: { slack: [{ name: 'a', url: 'https://slack/a', enabled: true }, { name: 'b', url: 'https://slack/b', enabled: true }] }
    });
    sender.result = (outputs) => (outputs.slack.url === 'https://slack/a' ? { slack: { success: false } } : { slack: { success: true } });
    const args = {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      server: 'Main', rules: rentRules({ channels: ['slack'] }), timezone: 'UTC', logger: quietLogger
    };

    // Sync 1: destination "a" fails, "b" succeeds. #295 review, H5: this must
    // count as sent (progress was made) and record only "b"'s row, not
    // withhold the whole event the way a single shared `allOk` flag used to.
    const result = await deliver([missingEvent()], { ...args, now: '2026-01-10' });
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls).toHaveLength(2);
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].channel).toBe(destinationKey('slack', { name: 'b', url: 'https://slack/b' })); // #295 review round 2, M8: keyed by name, never the URL

    // Sync 2: "a" is retried (it never got a ledger row); "b" must NOT be
    // resent, since it already has one. This is the exact bug H5 reports:
    // previously a dead "a" made "b" resend on every sync too.
    const second = await deliver([missingEvent()], { ...args, now: '2026-01-11' });
    expect(second).toEqual({ sent: 0, skipped: 1 }); // "a" still fails; still nothing new recorded
    expect(sender.calls).toHaveLength(3); // only "a" was attempted this time
    expect(sender.calls[2].slack.url).toBe('https://slack/a');

    // Sync 3: "a" now succeeds too.
    sender.result = null;
    const third = await deliver([missingEvent()], { ...args, now: '2026-01-12' });
    expect(third).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls).toHaveLength(4);
    expect(sender.calls[3].slack.url).toBe('https://slack/a');
    expect(history.rows).toHaveLength(2);
    expect(history.rows.map((r) => r.channel).sort()).toEqual([
      destinationKey('slack', { name: 'a', url: 'https://slack/a' }),
      destinationKey('slack', { name: 'b', url: 'https://slack/b' })
    ].sort());

    // Sync 4: both destinations already have a row and remindEveryDays is
    // unset - nothing left to attempt.
    const fourth = await deliver([missingEvent()], { ...args, now: '2026-01-13' });
    expect(fourth).toEqual({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(4);
  });

  test('#295 review, M2: a rule with zero usable destinations sends nothing, writes no ledger row, and WARNs', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({}); // nothing configured
    const warnings = [];
    const logger = { warn: (message, meta) => warnings.push({ message, meta }) };

    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      now: '2026-01-10', server: 'Main', rules: rentRules({ channels: ['slack'] }), timezone: 'UTC', logger
    });

    expect(sender.calls).toHaveLength(0);
    // Previously this counted as `sent` with nothing actually sent and no
    // ledger row - "delivered" for an event nobody could ever have received.
    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(history.rows).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/no due\/usable destination/);
  });

  test('a webhook destination with enabled:false is never sent to, even when another destination of the same type is enabled', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      webhooks: {
        generic: [
          { name: 'off', url: 'https://hooks/off', enabled: false },
          { name: 'on', url: 'https://hooks/on', enabled: true }
        ]
      }
    });

    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      now: '2026-01-10', server: 'Main', rules: rentRules({ channels: ['webhook'] }), timezone: 'UTC', logger: quietLogger
    });

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].webhook.url).toBe('https://hooks/on');
  });
});

describe('deliver: digest', () => {
  test('digest merges every eligible event into one message per channel, still one ledger row per event', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      webhooks: { slack: [{ name: 'a', url: 'https://slack/a', enabled: true }, { name: 'b', url: 'https://slack/b', enabled: true }] }
    });
    const rules = getRules({
      digest: true,
      alerts: [{ id: 'rent', schedule: 'Rent', channels: ['slack'] }, { id: 'salary', schedule: 'Salary', channels: ['slack'] }]
    });

    const events = [missingEvent(), missingEvent({ alertId: 'salary', scheduleId: 's2', expectedAmount: 300000 })];
    const evaluations = [rentEvaluation(), rentEvaluation({ alertId: 'salary', scheduleId: 's2', name: 'Salary', expectedAmount: 300000 })];

    const result = await deliver(events, {
      evaluations, ruleState: enabledState, history, sender, now: '2026-01-10', server: 'Main', rules, timezone: 'UTC', logger: quietLogger
    });

    expect(result).toEqual({ sent: 2, skipped: 0 });
    expect(sender.calls).toHaveLength(1); // merged into a single message
    expect(sender.calls[0].slack.url).toBe('https://slack/a'); // first configured destination only
    expect(sender.calls[0].slack.text).toMatch(/Rent/);
    expect(sender.calls[0].slack.text).toMatch(/Salary/);
    expect(history.rows).toHaveLength(2);
  });
});

describe('deliver: digest fits each capped channel (#294 review round 1, M1)', () => {
  const MANY = 40;

  function manyItems() {
    const events = [];
    const evaluations = [];
    for (let i = 0; i < MANY; i++) {
      const id = `a${i}`;
      events.push(missingEvent({ alertId: id, scheduleId: `s${i}` }));
      evaluations.push(rentEvaluation({ alertId: id, scheduleId: `s${i}`, name: `Schedule number ${i} with a longish name` }));
    }
    const rules = getRules({
      digest: true,
      alerts: events.map((e) => ({ id: e.alertId, schedule: 'Rent', channels: ['discord'] }))
    });
    return { events, evaluations, rules };
  }

  async function run(history, sender, now) {
    const { events, evaluations, rules } = manyItems();
    return deliver(events, {
      evaluations, ruleState: enabledState, history, sender, now, server: 'Main', rules, timezone: 'UTC', logger: quietLogger
    });
  }

  test('a 40-item Discord digest sends only the items that fit, records only those, and the next run sends the rest', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ webhooks: { discord: [{ name: 'd', url: 'https://discord/x', enabled: true }] } });

    const first = await run(history, sender, '2026-01-10');
    expect(sender.calls).toHaveLength(1);
    const text1 = sender.calls[0].discord.text;
    expect(text1.length).toBeLessThanOrEqual(2000);
    expect(text1).not.toMatch(/\u2026$/);
    expect(first.sent).toBeGreaterThan(0);
    expect(first.sent).toBeLessThan(MANY);
    expect(history.rows).toHaveLength(first.sent);
    // The header count matches what is actually in the message.
    expect(text1.split('\n')[0]).toContain(`${first.sent} payment alert(s)`);

    let total = first.sent;
    for (let i = 0; i < 10 && total < MANY; i++) {
      const next = await run(history, sender, '2026-01-10');
      expect(sender.calls[sender.calls.length - 1].discord.text.length).toBeLessThanOrEqual(2000);
      total += next.sent;
    }
    expect(total).toBe(MANY);
    expect(history.rows).toHaveLength(MANY);
    expect(new Set(history.rows.map((r) => r.alertId)).size).toBe(MANY);
  });

  test('daily reminders do not starve the deferred tail: all 40 alerts reach the ledger within a bounded number of days (#294 review round 2, H1)', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ webhooks: { discord: [{ name: 'd', url: 'https://discord/x', enabled: true }] } });
    const { events, evaluations } = manyItems();
    const rulesDaily = getRules({
      digest: true,
      alerts: events.map((e) => ({ id: e.alertId, schedule: 'Rent', channels: ['discord'], remindEveryDays: 1 }))
    });

    const MAX_DAYS = 6;
    for (let day = 0; day < MAX_DAYS; day++) {
      const instant = new Date(Date.UTC(2026, 0, 10 + day)).toISOString();
      history.clock = instant;
      await deliver(events, {
        evaluations, ruleState: enabledState, history, sender, now: instant, server: 'Main', rules: rulesDaily, timezone: 'UTC', logger: quietLogger
      });
      if (new Set(history.rows.map((r) => r.alertId)).size === MANY) break;
    }
    expect(new Set(history.rows.map((r) => r.alertId)).size).toBe(MANY);
  });

  test('once every alert has been sent, reminders rotate by oldest last send so every alert keeps getting reminded (#294 review round 3, L1)', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ webhooks: { discord: [{ name: 'd', url: 'https://discord/x', enabled: true }] } });
    const { events, evaluations } = manyItems();
    const rulesDaily = getRules({
      digest: true,
      alerts: events.map((e) => ({ id: e.alertId, schedule: 'Rent', channels: ['discord'], remindEveryDays: 1 }))
    });

    // Past the point where everything was sent once, only the oldest-sent
    // order lets the reminders reach every alert again.
    for (let day = 0; day < 16; day++) {
      const instant = new Date(Date.UTC(2026, 0, 10 + day)).toISOString();
      history.clock = instant;
      await deliver(events, {
        evaluations, ruleState: enabledState, history, sender, now: instant, server: 'Main', rules: rulesDaily, timezone: 'UTC', logger: quietLogger
      });
    }
    const perAlert = new Map();
    for (const r of history.rows) perAlert.set(r.alertId, (perAlert.get(r.alertId) || 0) + 1);
    expect(perAlert.size).toBe(MANY);
    expect(Math.min(...perAlert.values())).toBeGreaterThanOrEqual(3);
  });

  test('a 40-item Telegram digest also stays under 4096 in both html and plain, recording only what was sent', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const { events, evaluations } = manyItems();
    const rules = getRules({ digest: true, alerts: events.map((e) => ({ id: e.alertId, schedule: 'Rent', channels: ['telegram'] })) });
    const result = await deliver(events, {
      evaluations, ruleState: enabledState, history, sender, now: '2026-01-10', server: 'Main', rules, timezone: 'UTC', logger: quietLogger
    });
    expect(result.sent).toBeGreaterThan(0);
    expect(result.sent).toBeLessThan(MANY);
    expect(sender.calls[0].telegram.html.length).toBeLessThanOrEqual(4096);
    expect(sender.calls[0].telegram.plain.length).toBeLessThanOrEqual(4096);
    expect(history.rows).toHaveLength(result.sent);
  });

  test('a digest that fits entirely is unchanged: one message, every item recorded', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ webhooks: { slack: [{ name: 's', url: 'https://slack/x', enabled: true }] } });
    const { events, evaluations } = manyItems();
    const rules = getRules({ digest: true, alerts: events.map((e) => ({ id: e.alertId, schedule: 'Rent', channels: ['slack'] })) });
    const result = await deliver(events, {
      evaluations, ruleState: enabledState, history, sender, now: '2026-01-10', server: 'Main', rules, timezone: 'UTC', logger: quietLogger
    });
    expect(result.sent).toBe(MANY); // Slack's cap is 40000, so 40 lines all fit
    expect(sender.calls).toHaveLength(1);
  });

  test('a single oversized item is still sent alone (truncation is only the safety net)', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ webhooks: { discord: [{ name: 'd', url: 'https://discord/x', enabled: true }] } });
    const rules = getRules({
      digest: true,
      alerts: [{ id: 'rent', schedule: 'Rent', channels: ['discord'], templates: { missing: 'x'.repeat(2500) } }]
    });
    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender, now: '2026-01-10', server: 'Main', rules, timezone: 'UTC', logger: quietLogger
    });
    expect(result.sent).toBe(1);
    expect(history.rows).toHaveLength(1);
  });
});

describe('deliver: resolved events', () => {
  test('a late payment that had a missing alert produces a resolved event once, then never again', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const baseArgs = {
      ruleState: enabledState, history, sender, server: 'Main', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    };

    // Sync 1: the payment has not arrived yet -> missing event recorded.
    await deliver([missingEvent()], { ...baseArgs, evaluations: [rentEvaluation()], now: '2026-01-10' });
    expect(sender.calls).toHaveLength(1);

    // Sync 2: the payment arrived late. evaluate() itself emits no event for
    // a "late" occurrence (that is not evaluate()'s job); deliver() derives
    // "resolved" from the evaluations + the existing "missing" ledger row.
    const lateEvaluation = rentEvaluation({
      state: 'late',
      occurrences: [{ date: '2026-01-05', deadline: '2026-01-08', state: 'late', receivedDate: '2026-01-09', receivedAmount: -50000 }]
    });
    const resolvedResult = await deliver([], { ...baseArgs, evaluations: [lateEvaluation], now: '2026-01-11' });

    expect(resolvedResult).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls).toHaveLength(2);
    expect(sender.calls[1].telegram.html).toMatch(/arrived/);
    expect(history.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'missing', delivery: 'sent' }),
      expect.objectContaining({ event: 'resolved', delivery: 'sent' })
    ]));

    // Sync 3: still late/paid, no new missing alert since - resolved must not
    // resend. `deriveResolvedEvents` still synthesizes the event (#295 review
    // round 2, M5: its own pre-filter only asks "was `missing` ever recorded
    // on any channel", not "is `resolved` already fully delivered" - that
    // finer, per-destination check now lives in `isDestinationDue`), so this
    // is `skipped`, not simply absent, but nothing is sent again either way.
    const thirdResult = await deliver([], { ...baseArgs, evaluations: [lateEvaluation], now: '2026-01-12' });
    expect(thirdResult).toEqual({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(2);
  });

  // #271 item 8 / #295 review M14(d): the `resolved` template has a separate
  // "on time" branch for a 0-day-overdue payment, instead of the misleading
  // "0 day(s) after the deadline" the single-branch template used to render.
  test('a payment received exactly on the deadline renders the on-time resolved branch, not "0 day(s) after the deadline"', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const baseArgs = {
      ruleState: enabledState, history, sender, server: 'Main', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    };

    await deliver([missingEvent()], { ...baseArgs, evaluations: [rentEvaluation()], now: '2026-01-10' });

    const onTimeEvaluation = rentEvaluation({
      state: 'received',
      occurrences: [{ date: '2026-01-05', deadline: '2026-01-08', state: 'received', receivedDate: '2026-01-08', receivedAmount: -50000 }]
    });
    const result = await deliver([], { ...baseArgs, evaluations: [onTimeEvaluation], now: '2026-01-11' });

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls[1].telegram.html).toMatch(/on time/);
    expect(sender.calls[1].telegram.html).not.toMatch(/day\(s\) after the deadline/);
  });

  test('an on-time payment with no prior missing alert produces no resolved event', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });

    const receivedEvaluation = rentEvaluation({
      state: 'received',
      occurrences: [{ date: '2026-01-05', deadline: '2026-01-08', state: 'received', receivedDate: '2026-01-05', receivedAmount: -50000 }]
    });
    const result = await deliver([], {
      evaluations: [receivedEvaluation], ruleState: enabledState, history, sender,
      now: '2026-01-10', server: 'Main', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    });

    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(sender.calls).toHaveLength(0);
  });
});

describe('deliver: resolved is retried and gated per destination (#295 review round 2, M5)', () => {
  test('resolved is never sent to a destination that never received the original missing alert', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      webhooks: { slack: [{ name: 'a', url: 'https://slack/a', enabled: true }] }
    });
    const baseArgs = {
      ruleState: enabledState, history, sender, server: 'Main',
      rules: rentRules({ channels: ['slack'] }), timezone: 'UTC', logger: quietLogger
    };

    // Sync 1: missing sent only to "a" (the only destination configured then).
    await deliver([missingEvent()], { ...baseArgs, evaluations: [rentEvaluation()], now: '2026-01-10' });
    expect(sender.calls).toHaveLength(1);

    // A new destination "b" is added before the payment resolves.
    sender.config.webhooks.slack.push({ name: 'b', url: 'https://slack/b', enabled: true });

    const lateEvaluation = rentEvaluation({
      state: 'late',
      occurrences: [{ date: '2026-01-05', deadline: '2026-01-08', state: 'late', receivedDate: '2026-01-09', receivedAmount: -50000 }]
    });
    const result = await deliver([], { ...baseArgs, evaluations: [lateEvaluation], now: '2026-01-11' });

    expect(result).toEqual({ sent: 1, skipped: 0 });
    // Before the fix, `isDestinationDue`'s generic branch treated "b" as due
    // for `resolved` just because "b" had no `resolved` row yet, regardless
    // of whether "b" was ever told about the original `missing` alert.
    expect(sender.calls).toHaveLength(2); // only "a" gets "resolved"; "b" never got "missing"
    expect(sender.calls[1].slack.url).toBe('https://slack/a');
  });
});

describe('deliver: resolved retries per destination against the real ledger (#295 review round 2, M5)', () => {
  const { SyncHistoryService } = require('../services/syncHistory');
  const fs = require('fs');
  const path = require('path');
  const dbPath = path.join(__dirname, 'test-schedule-alert-delivery.db');
  let realHistory;

  beforeEach(() => {
    ['', '-wal', '-shm'].forEach((suffix) => {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    });
    realHistory = new SyncHistoryService({ dbPath, retentionDays: 30, loggerConfig: { level: 'ERROR' } });
  });

  afterEach(() => {
    realHistory.close();
    ['', '-wal', '-shm'].forEach((suffix) => {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    });
  });

  test('a resolved send that fails on one destination is retried there next sync, without resending to a destination that already succeeded', async () => {
    const sender = makeFakeSender({
      webhooks: { slack: [{ name: 'a', url: 'https://slack/a', enabled: true }, { name: 'b', url: 'https://slack/b', enabled: true }] }
    });
    const baseArgs = {
      ruleState: enabledState, history: realHistory, sender, server: 'Main',
      rules: rentRules({ channels: ['slack'] }), timezone: 'UTC', logger: quietLogger
    };

    // Sync 1: missing alert delivered to both slack destinations.
    await deliver([missingEvent()], { ...baseArgs, evaluations: [rentEvaluation()], now: '2026-01-10' });
    expect(sender.calls).toHaveLength(2);

    // Sync 2: the payment arrives late. Destination "a" succeeds sending
    // "resolved", "b" fails.
    sender.result = (outputs) => (outputs.slack.url === 'https://slack/b' ? { slack: { success: false } } : { slack: { success: true } });
    const lateEvaluation = rentEvaluation({
      state: 'late',
      occurrences: [{ date: '2026-01-05', deadline: '2026-01-08', state: 'late', receivedDate: '2026-01-09', receivedAmount: -50000 }]
    });
    const resolvedResult = await deliver([], { ...baseArgs, evaluations: [lateEvaluation], now: '2026-01-11' });
    expect(resolvedResult).toEqual({ sent: 1, skipped: 0 }); // "a" succeeded, so the event counts as sent
    expect(sender.calls).toHaveLength(4); // 2 missing + 2 resolved attempts

    // Sync 3: "b" must be retried for "resolved" (it never got a resolved
    // row); "a" must NOT be resent (it already has one). Before the fix,
    // `deriveResolvedEvents` skipped the whole occurrence once ANY channel
    // had a `resolved` row, so "b" would never be retried here.
    sender.result = null;
    const retryResult = await deliver([], { ...baseArgs, evaluations: [lateEvaluation], now: '2026-01-12' });
    expect(retryResult).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls).toHaveLength(5); // only "b" retried
    expect(sender.calls[4].slack.url).toBe('https://slack/b');

    // Sync 4: both destinations now have a resolved row - nothing left to send.
    const finalResult = await deliver([], { ...baseArgs, evaluations: [lateEvaluation], now: '2026-01-13' });
    expect(finalResult).toEqual({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(5);
  });
});

describe('deliver: Telegram digest header escapes the server name (#294 review round 2, L)', () => {
  test('a server name with & and < is escaped in the html header and left raw in the plain fallback', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const rules = getRules({ digest: true, alerts: [{ id: 'rent', schedule: 'Rent', channels: ['telegram'] }] });
    await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender, now: '2026-01-10', server: 'A&B <home>', rules, timezone: 'UTC', logger: quietLogger
    });
    const header = sender.calls[0].telegram.html.split('\n')[0];
    expect(header).toContain('A&amp;B &lt;home&gt;');
    expect(header).not.toContain('<home>');
    expect(sender.calls[0].telegram.plain.split('\n')[0]).toContain('A&B <home>');
  });

  test('the email digest html header escapes the server name; the text body keeps it raw', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ email: { enabled: true } });
    const rules = getRules({ digest: true, alerts: [{ id: 'rent', schedule: 'Rent', channels: ['email'] }] });
    await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender, now: '2026-01-10', server: 'A&B <home>', rules, timezone: 'UTC', logger: quietLogger
    });
    const { html, text } = sender.calls[0].email;
    expect(html).toContain('<p>Actual-sync: 1 payment alert(s) for A&amp;B &lt;home&gt;</p>');
    expect(html).not.toContain('<home>');
    expect(text.split('\n')[0]).toContain('A&B <home>');
  });

  test('the Slack digest header escapes the server name so <!channel> cannot ping (#294 review round 3, L2)', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ webhooks: { slack: [{ name: 'a', url: 'https://slack/a', enabled: true }] } });
    const rules = getRules({ digest: true, alerts: [{ id: 'rent', schedule: 'Rent', channels: ['slack'] }] });
    await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender, now: '2026-01-10', server: 'Main <!channel>', rules, timezone: 'UTC', logger: quietLogger
    });
    const out = JSON.stringify(sender.calls[0].slack);
    expect(out).toContain('Main &lt;!channel&gt;');
    expect(out).not.toContain('<!channel>');
  });
});

describe('deliver: digest respects each rule\'s own channel restriction (#295 review, M1)', () => {
  test('each channel receives only the lines from rules that allow it, not the union of every rule\'s channels', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      telegram: { enabled: true },
      webhooks: { slack: [{ name: 'a', url: 'https://slack/a', enabled: true }] }
    });
    const rules = getRules({
      digest: true,
      alerts: [
        { id: 'rent', schedule: 'Rent', channels: ['slack'] },
        { id: 'salary', schedule: 'Salary', channels: ['telegram'] }
      ]
    });
    const events = [missingEvent(), missingEvent({ alertId: 'salary', scheduleId: 's2', expectedAmount: 300000 })];
    const evaluations = [rentEvaluation(), rentEvaluation({ alertId: 'salary', scheduleId: 's2', name: 'Salary', expectedAmount: 300000 })];

    const result = await deliver(events, {
      evaluations, ruleState: enabledState, history, sender, now: '2026-01-10', server: 'Main', rules, timezone: 'UTC', logger: quietLogger
    });

    expect(result).toEqual({ sent: 2, skipped: 0 });
    expect(sender.calls).toHaveLength(2); // one merged message per channel, not per rule
    const slackCall = sender.calls.find((c) => c.slack);
    const telegramCall = sender.calls.find((c) => c.telegram);
    expect(slackCall.slack.text).toMatch(/Rent/);
    expect(slackCall.slack.text).not.toMatch(/Salary/); // salary is telegram-only
    expect(telegramCall.telegram.html).toMatch(/Salary/);
    expect(telegramCall.telegram.html).not.toMatch(/Rent/); // rent is slack-only
  });
});

describe('deliver: reminders compare calendar dates in the configured timezone (#295 review, M7)', () => {
  test('a reminder due by calendar date fires even when less than 24h have elapsed', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const args = {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      server: 'Main', rules: rentRules({ remindEveryDays: 1 }), timezone: 'Europe/Madrid', logger: quietLogger
    };

    // Recorded late on 10 Jan Madrid local time (23:30 local = 22:30 UTC, no DST in January).
    history.clock = '2026-01-10T22:30:00.000Z';
    await deliver([missingEvent()], { ...args, now: '2026-01-10T22:00:00.000Z' });

    // 1 hour later by the clock, but already 00:30 on 11 Jan Madrid local
    // time - a new calendar date, so `remindEveryDays: 1` must fire. A raw
    // `moment(now).diff(moment(recordedAt), 'days')` would still read 0.
    const nextCalendarDay = await deliver([missingEvent()], { ...args, now: '2026-01-10T23:30:00.000Z' });
    expect(nextCalendarDay).toEqual({ sent: 1, skipped: 0 });
  });

  test('a reminder does not fire twice for the same calendar date, even ~20 hours apart', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const args = {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      server: 'Main', rules: rentRules({ remindEveryDays: 1 }), timezone: 'Europe/Madrid', logger: quietLogger
    };

    // Recorded just after midnight on 10 Jan Madrid local time (00:30 local = 2026-01-09T23:30Z).
    history.clock = '2026-01-09T23:30:00.000Z';
    await deliver([missingEvent()], { ...args, now: '2026-01-09T23:00:00.000Z' });

    // ~20 hours later by the clock, but still 10 Jan Madrid local time (20:00 local).
    const sameCalendarDay = await deliver([missingEvent()], { ...args, now: '2026-01-10T19:00:00.000Z' });
    expect(sameCalendarDay).toEqual({ sent: 0, skipped: 1 });
  });
});

describe('deliver: duplicate webhook names (#297 F3)', () => {
  test('two webhooks sharing a name are tracked separately: the one that failed is retried, the other is not resent', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      webhooks: { slack: [{ name: 'alerts', url: 'https://slack/a', enabled: true }, { name: 'alerts', url: 'https://slack/b', enabled: true }] }
    });
    sender.result = (outputs) => (outputs.slack.url === 'https://slack/b' ? { slack: { success: false } } : { slack: { success: true } });
    const args = {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      server: 'Main', rules: rentRules({ channels: ['slack'] }), timezone: 'UTC', logger: quietLogger
    };

    await deliver([missingEvent()], { ...args, now: '2026-01-10' });
    expect(history.rows).toHaveLength(1); // only A succeeded

    sender.result = null;
    const second = await deliver([missingEvent()], { ...args, now: '2026-01-11' });
    expect(second).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls.map((c) => c.slack.url)).toEqual(['https://slack/a', 'https://slack/b', 'https://slack/b']);
    expect(new Set(history.rows.map((r) => r.channel)).size).toBe(2);
  });

  test('destinationKey differs for two targets with the same name but different URLs', () => {
    expect(destinationKey('slack', { name: 'alerts', url: 'https://slack/a' }))
      .not.toBe(destinationKey('slack', { name: 'alerts', url: 'https://slack/b' }));
  });
});

describe('deliver: a failing ledger lookup withholds only that event (#297 round 1, L1)', () => {
  // A lookup that cannot answer must never turn into "not recorded, send it"
  // (a resend on every sync while the ledger is unreadable), and must not take
  // the other events down with it: the one event is withheld, logged at WARN,
  // gets no ledger row, and is retried next sync.
  function setup(blockOverrides = {}) {
    const history = makeFakeHistory();
    const realFind = history.findLatestScheduleAlert.bind(history);
    history.findLatestScheduleAlert = async (key) => {
      if (key.alertId === 'broken') throw new Error('db locked');
      return realFind(key);
    };
    const sender = makeFakeSender({ webhooks: { slack: [{ name: 'ops', url: 'https://slack/a', enabled: true }] } });
    const warnings = [];
    const logger = { warn: (message, meta) => warnings.push({ message, meta }) };
    const rules = getRules({
      ...blockOverrides,
      alerts: [
        { id: 'broken', schedule: 'Rent', channels: ['slack'] },
        { id: 'rent', schedule: 'Rent', channels: ['slack'] }
      ]
    });
    return { history, sender, warnings, logger, rules };
  }

  test.each([['immediate', {}], ['digest', { digest: true }]])('%s: the failing event is withheld, the other is delivered', async (mode, block) => {
    const { history, sender, warnings, logger, rules } = setup(block);
    const result = await deliver([missingEvent({ alertId: 'broken' }), missingEvent()], {
      evaluations: [rentEvaluation({ alertId: 'broken' }), rentEvaluation()], ruleState: enabledState, history, sender,
      server: 'Main', rules, timezone: 'UTC', logger, now: '2026-01-10'
    });
    expect(result).toEqual({ sent: 1, skipped: 1 });
    expect(history.rows.map((r) => r.alertId)).toEqual(['rent']);
    expect(sender.calls).toHaveLength(1);
    expect(warnings.some((w) => /ledger lookup failed/i.test(w.message) && w.meta.alertId === 'broken')).toBe(true);
  });

  test('a failing lookup while deriving a resolved event skips only that occurrence', async () => {
    const { history, sender, warnings, logger, rules } = setup();
    history.rows.push({ server: 'Main', alertId: 'rent', scheduleId: 's1', occurrenceDate: '2026-01-05', event: 'missing', delivery: 'sent', channel: destinationKey('slack', { name: 'ops', url: 'https://slack/a' }), recordedAt: '2026-01-06T00:00:00.000Z' });
    const received = (alertId) => rentEvaluation({
      alertId, state: 'received',
      occurrences: [{ date: '2026-01-05', deadline: '2026-01-08', state: 'received', receivedDate: '2026-01-07', receivedAmount: -50000 }]
    });
    const result = await deliver([], {
      evaluations: [received('broken'), received('rent')], ruleState: enabledState, history, sender,
      server: 'Main', rules, timezone: 'UTC', logger, now: '2026-01-10'
    });
    expect(result.sent).toBe(1);
    expect(history.rows.filter((r) => r.event === 'resolved').map((r) => r.alertId)).toEqual(['rent']);
    expect(warnings.some((w) => /ledger lookup failed/i.test(w.message))).toBe(true);
  });
});

describe('deliver: digest guards each destination like immediate mode (#332)', () => {
  // A transient ledger error (for example SQLITE_BUSY) on one channel must
  // withhold only that channel, never reject deliver() and starve the others.
  const SALARY = { id: 'salary', schedule: 'Salary' };
  function setup(server, alerts = [{ id: 'rent', schedule: 'Rent', channels: ['slack', 'discord'] }]) {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      webhooks: {
        slack: [{ name: 'a', url: 'https://slack/a', enabled: true }],
        discord: [{ name: 'd', url: 'https://discord/x', enabled: true }]
      }
    });
    const warnings = [];
    const logger = { warn: (message, meta) => warnings.push({ message, meta }) };
    const rules = getRules({ digest: true, alerts });
    const events = alerts.map((a) => missingEvent({ alertId: a.id, scheduleId: `s-${a.id}` }));
    const evaluations = alerts.map((a) => rentEvaluation({ alertId: a.id, scheduleId: `s-${a.id}`, name: a.schedule }));
    const run = () => deliver(events, {
      evaluations, ruleState: enabledState, history, sender, server, rules,
      timezone: 'UTC', logger, now: '2026-01-10'
    });
    return { history, sender, warnings, run };
  }

  test('isDestinationDue throwing for one channel withholds only that channel, with a WARN', async () => {
    const { history, sender, warnings, run } = setup('guard-332-due');
    const realFind = history.findLatestScheduleAlert.bind(history);
    let armed = false;
    let discordReads = 0;
    history.findLatestScheduleAlert = async (key) => {
      // A one-off error: the mayRecord pre-check (first discord read) succeeds,
      // then the digest's own read of the discord destination (second) throws.
      if (String(key.channel).startsWith('discord')) {
        discordReads += 1;
        if (discordReads === 2) { armed = true; throw new Error('SQLITE_BUSY'); }
      }
      return realFind(key);
    };
    const result = await run();
    expect(armed).toBe(true);
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].slack).toBeDefined();
    expect(history.rows.map((r) => r.channel.split(':')[0])).toEqual(['slack']);
    const warn = warnings.find((w) => /ledger lookup failed/i.test(w.message));
    expect(warn).toBeDefined();
    expect(warn.meta).toMatchObject({ server: 'guard-332-due', channel: 'discord', error: 'SQLITE_BUSY' });
  });

  test('recordScheduleAlert throwing after a send does not stop the other channels, and WARNs that the row may be resent', async () => {
    const { history, sender, warnings, run } = setup('guard-332-record', [
      { id: 'rent', schedule: 'Rent', channels: ['slack'] },
      { id: 'salary', schedule: 'Salary', channels: ['discord'] }
    ]);
    const realRecord = history.recordScheduleAlert.bind(history);
    history.recordScheduleAlert = async (row) => {
      if (String(row.channel).startsWith('slack')) throw new Error('SQLITE_BUSY');
      return realRecord(row);
    };
    const result = await run();
    expect(sender.calls).toHaveLength(2); // both channels were sent to
    expect(result).toEqual({ sent: 1, skipped: 1 }); // the unrecorded slack item is not counted as sent
    expect(history.rows.map((r) => r.channel.split(':')[0])).toEqual(['discord']);
    const warn = warnings.find((w) => /ledger write failed/i.test(w.message));
    expect(warn).toBeDefined();
    expect(warn.message).toMatch(/resent next sync/i);
    expect(warn.meta).toMatchObject({ server: 'guard-332-record', channel: 'slack', alertId: 'rent', error: 'SQLITE_BUSY' });
  });

  test('a write failing for one item keeps processing the remaining items on the SAME channel', async () => {
    // Guards the loop: a `break` after the write-failure WARN would leave
    // salary unrecorded although the digest already went out.
    const { history, sender, warnings, run } = setup('guard-332-same-channel', [
      { id: 'rent', schedule: 'Rent', channels: ['slack'] },
      { ...SALARY, channels: ['slack'] }
    ]);
    const realRecord = history.recordScheduleAlert.bind(history);
    // Fail the FIRST write whichever item the digest orders first, so the
    // test cannot pass vacuously when the failing item happens to be last.
    let first = null;
    history.recordScheduleAlert = async (row) => {
      if (first === null) { first = row.alertId; throw new Error('SQLITE_BUSY'); }
      return realRecord(row);
    };
    const result = await run();
    expect(sender.calls).toHaveLength(1);
    expect(result).toEqual({ sent: 1, skipped: 1 });
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].alertId).not.toBe(first);
    expect(warnings.filter((w) => /ledger write failed/i.test(w.message))).toHaveLength(1);
  });

  test('a read failing on a later item withholds the whole channel instead of sending a partial digest', async () => {
    const { history, sender, run } = setup('guard-332-partial', [
      { id: 'rent', schedule: 'Rent', channels: ['discord'] },
      { ...SALARY, channels: ['discord'] }
    ]);
    const realFind = history.findLatestScheduleAlert.bind(history);
    let discordReads = 0;
    history.findLatestScheduleAlert = async (key) => {
      // 2 mayRecord reads, then the digest reads item 1 (3rd) and item 2 (4th).
      if (String(key.channel).startsWith('discord') && (discordReads += 1) === 4) throw new Error('SQLITE_BUSY');
      return realFind(key);
    };
    const result = await run();
    expect(discordReads).toBeGreaterThanOrEqual(4);
    expect(sender.calls).toHaveLength(0);
    expect(history.rows).toHaveLength(0);
    expect(result).toEqual({ sent: 0, skipped: 2 });
  });
});

describe('deliver: immediate mode survives a ledger write failure after a send (#332)', () => {
  test('a failing write for one destination does not stop the others and the event still counts as sent', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      telegram: { enabled: true },
      webhooks: {
        slack: [{ name: 'a', url: 'https://slack/a', enabled: true }],
        discord: [{ name: 'd', url: 'https://discord/x', enabled: true }]
      }
    });
    const warnings = [];
    const logger = { warn: (message, meta) => warnings.push({ message, meta }) };
    const realRecord = history.recordScheduleAlert.bind(history);
    history.recordScheduleAlert = async (row) => {
      if (String(row.channel).startsWith('slack')) throw new Error('SQLITE_BUSY');
      return realRecord(row);
    };
    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      now: '2026-01-10', server: 'imm-332',
      rules: rentRules({ channels: ['telegram', 'slack', 'discord'] }),
      timezone: 'UTC', logger
    });
    expect(sender.calls).toHaveLength(3);
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(history.rows.map((r) => r.channel.split(':')[0]).sort()).toEqual(['discord', 'telegram']);
    const warn = warnings.find((w) => /ledger write failed/i.test(w.message));
    expect(warn).toBeDefined();
    expect(warn.message).toMatch(/resent next sync/i);
    expect(warn.meta).toMatchObject({ server: 'imm-332', channel: 'slack', alertId: 'rent', error: 'SQLITE_BUSY' });
    expect(warnings.some((w) => /send threw/i.test(w.message))).toBe(false);
  });

  test('when every write fails the event is not counted as sent', async () => {
    const history = makeFakeHistory();
    history.recordScheduleAlert = async () => { throw new Error('SQLITE_BUSY'); };
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      now: '2026-01-10', server: 'imm-332b', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    });
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });
});

describe('destinationKey (#295 review round 2, M8)', () => {
  test('a named webhook target is keyed by its name plus a URL hash, never its URL', () => {
    const key = destinationKey('slack', { name: 'ops-alerts', url: 'https://hooks.example/services/T00/B00/secret' });
    expect(key).toMatch(/^slack:#ops-alerts:[0-9a-f]{8}$/);
    expect(key).not.toContain('hooks.example');
    expect(key).not.toContain('secret');
  });

  test('an unnamed webhook target is keyed by a short hash of its URL, and the key never contains the URL', () => {
    const url = 'https://hooks.example/services/T00/B00/another-secret-path';
    const key = destinationKey('slack', { url });
    expect(key).toMatch(/^slack:#:[0-9a-f]{8}$/);
    expect(key).not.toContain(url);
    expect(key).not.toContain('hooks.example');
    expect(key).not.toContain('secret');
  });

  test('the hash is stable for the same URL and different for a different URL', () => {
    const keyA1 = destinationKey('discord', { url: 'https://discord.example/webhooks/1/aaa' });
    const keyA2 = destinationKey('discord', { url: 'https://discord.example/webhooks/1/aaa' });
    const keyB = destinationKey('discord', { url: 'https://discord.example/webhooks/1/bbb' });
    expect(keyA1).toBe(keyA2);
    expect(keyA1).not.toBe(keyB);
  });

  test('a single-destination channel with no url is keyed by channel name alone', () => {
    expect(destinationKey('telegram', {})).toBe('telegram');
  });
});

describe('exported constants: DEFAULT_TEMPLATES / VARIABLES / ALL_CHANNELS', () => {
  // These three are read by config.schema.json's defaults, docs/SCHEDULE_ALERTS.md's
  // variable table, and an operator wanting to override only one built-in
  // message, so they are exported as public API even though nothing inside
  // this repo imports them (deliver() uses its own module-private copies).
  // These tests exist to keep that surface honest: every default template
  // must actually compile against the documented variable list, on every
  // channel `deliver()` can send to.
  test('ALL_CHANNELS matches sendTemplated\'s known channel keys', () => {
    expect(ALL_CHANNELS).toEqual(['telegram', 'email', 'slack', 'discord', 'webhook', 'ntfy']);
  });

  test('every DEFAULT_TEMPLATES entry compiles and renders on every channel mode', () => {
    const modes = ['telegram', 'email_html', 'email_text', 'slack', 'discord', 'webhook', 'ntfy'];
    const renderer = compileTemplateSet({ templates: DEFAULT_TEMPLATES, variables: VARIABLES, channels: modes });
    const context = Object.fromEntries(VARIABLES.map((v) => [v, v.endsWith('_raw') ? 0 : `test-${v}`]));

    for (const key of Object.keys(DEFAULT_TEMPLATES)) {
      for (const mode of modes) {
        expect(() => renderer.render(key, context, mode)).not.toThrow();
      }
    }
  });

  test('VARIABLES has no duplicates and covers every _raw counterpart', () => {
    expect(new Set(VARIABLES).size).toBe(VARIABLES.length);
    const rawSuffixed = VARIABLES.filter((v) => v.endsWith('_raw'));
    for (const raw of rawSuffixed) {
      expect(VARIABLES).toContain(raw.slice(0, -'_raw'.length));
    }
  });
});

describe('deliver: delivery budget starvation (#337, #338)', () => {
  // Virtual clock: `Date.now()` only moves when a fake send "takes time", so
  // the budget cutoff is deterministic instead of depending on real timers.
  let clock;
  let nowSpy;
  beforeEach(() => { clock = 1.8e12; nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock); });
  afterEach(() => { nowSpy.mockRestore(); });
  const sleep = async (ms) => { clock += ms; };

  test('a first channel that hangs past the budget every run does not starve the second channel in a digest (#337)', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      telegram: { enabled: true },
      webhooks: { discord: [{ name: 'd', url: 'https://discord/x', enabled: true }] }
    });
    sender.result = null;
    const original = sender.sendTemplated.bind(sender);
    sender.sendTemplated = async (outputs) => {
      if (outputs.telegram) {
        sender.calls.push(outputs);
        await sleep(60); // hangs until the 40ms budget is gone
        return { telegram: { success: false } };
      }
      return original(outputs);
    };
    const rules = rentRules({}, { digest: true });

    let discordRun = 0;
    for (let run = 1; run <= 3 && !discordRun; run += 1) {
      await deliver([missingEvent()], {
        evaluations: [rentEvaluation()], ruleState: enabledState, history, sender, now: '2026-01-10',
        server: 'starve-337', rules, timezone: 'UTC', logger: quietLogger, deadline: Date.now() + 40
      });
      if (history.rows.some((r) => String(r.channel).startsWith('discord'))) discordRun = run;
    }
    expect(discordRun).toBeGreaterThan(0);
    expect(discordRun).toBeLessThanOrEqual(2);
  });

  test('slow sends with remindEveryDays: 1 still reach every event within a bounded number of days in immediate mode (#338)', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const original = sender.sendTemplated.bind(sender);
    sender.sendTemplated = async (outputs) => { await sleep(25); return original(outputs); };
    const COUNT = 6;
    const ids = Array.from({ length: COUNT }, (_, i) => `r${i}`);
    const rules = getRules({ alerts: ids.map((id) => ({ id, schedule: 'Rent', remindEveryDays: 1 })) });
    const events = ids.map((id) => missingEvent({ alertId: id }));
    const evaluations = ids.map((id) => rentEvaluation({ alertId: id }));

    let day = 0;
    for (; day < 4; day += 1) {
      const instant = new Date(Date.UTC(2026, 0, 10 + day)).toISOString();
      history.clock = instant;
      await deliver(events, {
        evaluations, ruleState: enabledState, history, sender, now: instant, server: 'imm-338',
        rules, timezone: 'UTC', logger: quietLogger, deadline: Date.now() + 40
      });
      if (new Set(history.rows.map((r) => r.alertId)).size === COUNT) break;
    }
    expect(new Set(history.rows.map((r) => r.alertId)).size).toBe(COUNT);
  });

  test('a first destination that hangs past the budget every run does not starve the second destination in immediate mode (#337, M1)', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      telegram: { enabled: true },
      webhooks: { discord: [{ name: 'd', url: 'https://discord/x', enabled: true }] }
    });
    const original = sender.sendTemplated.bind(sender);
    sender.sendTemplated = async (outputs) => {
      if (outputs.telegram) {
        sender.calls.push(outputs);
        await sleep(60); // hangs until the 40ms budget is gone
        return { telegram: { success: false } };
      }
      return original(outputs);
    };
    const ids = ['a1', 'a2', 'a3'];
    const rules = getRules({ alerts: ids.map((id) => ({ id, schedule: 'Rent' })) });
    const events = ids.map((id) => missingEvent({ alertId: id }));
    const evaluations = ids.map((id) => rentEvaluation({ alertId: id }));

    // Every alert, not just the first, must get a Discord row: from run 3 on
    // each alert's only due destination is Telegram and nothing has a ledger
    // row for it, so only the attempt tie-break moves the next alert up.
    const withDiscord = () => new Set(
      history.rows.filter((r) => String(r.channel).startsWith('discord')).map((r) => r.alertId)
    );
    for (let run = 1; run <= 4 && withDiscord().size < ids.length; run += 1) {
      await deliver(events, {
        evaluations, ruleState: enabledState, history, sender, now: '2026-01-10',
        server: 'starve-337-imm', rules, timezone: 'UTC', logger: quietLogger, deadline: Date.now() + 40
      });
    }
    expect([...withDiscord()].sort()).toEqual(ids);
  });

  test('over many days, immediate-mode reminders rotate by oldest last send so every alert keeps getting reminded (#338, M2)', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const original = sender.sendTemplated.bind(sender);
    sender.sendTemplated = async (outputs) => { await sleep(25); return original(outputs); };
    const COUNT = 6;
    const ids = Array.from({ length: COUNT }, (_, i) => `r${i}`);
    const rules = getRules({ alerts: ids.map((id) => ({ id, schedule: 'Rent', remindEveryDays: 1 })) });
    const events = ids.map((id) => missingEvent({ alertId: id }));
    const evaluations = ids.map((id) => rentEvaluation({ alertId: id }));

    // Budget fits 2 sends a day. Past the first cycle, only the
    // oldest-sent-first order keeps reaching every alert.
    for (let day = 0; day < 12; day += 1) {
      const instant = new Date(Date.UTC(2026, 0, 10 + day)).toISOString();
      history.clock = instant;
      await deliver(events, {
        evaluations, ruleState: enabledState, history, sender, now: instant, server: 'imm-338-rot',
        rules, timezone: 'UTC', logger: quietLogger, deadline: Date.now() + 40
      });
    }
    const perAlert = new Map();
    for (const r of history.rows) perAlert.set(r.alertId, (perAlert.get(r.alertId) || 0) + 1);
    expect(perAlert.size).toBe(COUNT);
    expect(Math.min(...perAlert.values())).toBeGreaterThanOrEqual(3);
  });
});

describe('deliver: cannotCheck wording follows the reason (#296)', () => {
  async function renderCannotCheck(reason, extra = {}) {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });
    const event = {
      event: 'cannotCheck', alertId: 'rent', scheduleId: 's1', occurrence: null, deadline: null, reason, ...extra
    };
    await deliver([event], {
      evaluations: [rentEvaluation({ state: 'cannotCheck' })], ruleState: enabledState, history, sender,
      now: '2026-01-10', server: 'Main', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    });
    expect(sender.calls).toHaveLength(1);
    return sender.calls[0].telegram.html;
  }

  test.each([['stale'], ['not-synced']])('reason %s keeps the bank-connection wording', async (reason) => {
    const text = await renderCannotCheck(reason, { occurrence: '2026-01-05', deadline: '2026-01-08', lastSync: '2026-01-01' });
    expect(text).toMatch(/Check the bank connection/);
    expect(text).toMatch(/has not synced since/);
  });

  test('stale with a last sync date renders it; without one it says never synced', async () => {
    const withDate = await renderCannotCheck('not-synced', { occurrence: '2026-01-05', deadline: '2026-01-08', lastSync: '2026-01-01' });
    expect(withDate).toMatch(/has not synced since 1 Jan 2026 \(deadline /);
    const never = await renderCannotCheck('not-synced', { occurrence: '2026-01-05', deadline: '2026-01-08' });
    expect(never).toMatch(/has never synced \(deadline /);
    expect(never).not.toMatch(/synced since|\s{2}\(/);
  });

  test('interval-violation does not blame the bank connection and points at the rule', async () => {
    const text = await renderCannotCheck('interval-violation');
    expect(text).not.toMatch(/bank connection|synced since/);
    expect(text).toMatch(/Rent/);
    expect(text).toMatch(/graceDays/);
  });

  test('error does not blame the bank connection and points at the log', async () => {
    const text = await renderCannotCheck('error');
    expect(text).not.toMatch(/bank connection|synced since/);
    expect(text).toMatch(/Rent/);
    expect(text).toMatch(/log/i);
  });
});


describe('deliver: off, mute and mute end (#261)', () => {
  let history;
  let dbDir;
  let clock;
  let sender;
  let warns;
  const logger = { warn: (message, meta) => warns.push([message, meta]) };
  const TWO_SLACK = { webhooks: { slack: [
    { name: 'a', url: 'https://slack/a', enabled: true },
    { name: 'b', url: 'https://slack/b', enabled: true }
  ] } };
  const KEY_A = destinationKey('slack', { name: 'a', url: 'https://slack/a' });
  const KEY_B = destinationKey('slack', { name: 'b', url: 'https://slack/b' });

  beforeEach(() => {
    clock = new Date('2026-10-01T08:00:00.000Z');
    dbDir = createTempDir();
    history = new SyncHistoryService({
      dbPath: path.join(dbDir, 'h.db'), loggerConfig: { level: 'ERROR' }, now: () => new Date(clock)
    });
    sender = makeFakeSender(TWO_SLACK);
    warns = [];
  });

  afterEach(() => {
    history.close();
    cleanupTempDir(dbDir);
  });

  const at = (iso) => { clock = new Date(iso); };
  const slackRules = (alert = {}, block = {}) => rentRules({ channels: ['slack'], ...alert }, block);
  const miss = (date, extra = {}) => missingEvent({ occurrence: date, deadline: date, ...extra });
  const evalOf = (date, state = 'missing', extra = {}) => rentEvaluation({
    occurrences: [{ date, deadline: date, state, receivedDate: state === 'missing' ? null : date, receivedAmount: state === 'missing' ? null : -50000 }], ...extra
  });
  const run = (events, { evaluations = [], rules = slackRules(), tz = 'UTC', extra = {} } = {}) => {
    const now = new Date(clock);
    return deliver(events, {
      evaluations, history, sender, now, server: 'Main', rules, timezone: tz, logger,
      ruleState: (alertId) => ruleState({ rule: rules.find((r) => r.id === alertId), override: history.getOverride('Main', alertId), now, timezone: tz }),
      ...extra
    });
  };
  const setMute = (until, extra = {}) => history.setOverride({
    server: 'Main', alertId: 'rent', enabled: true, mutedFrom: '2026-10-01T08:00:00.000Z', mutedUntil: until, reason: 'vacant', ...extra
  });
  const rows = (where = '1=1') => history.db.prepare(`SELECT * FROM schedule_alerts WHERE ${where} ORDER BY id`).all();
  const summaries = () => sender.calls.filter((c) => /mute ended/.test(c.slack.text));

  describe('switched off', () => {
    test('zero messages and zero ledger rows; switched back on, one message and one sent row', async () => {
      history.setOverride({ server: 'Main', alertId: 'rent', enabled: false });
      at('2026-10-12T08:00:00.000Z');
      const off = await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      expect(off).toEqual({ sent: 0, skipped: 1 });
      expect(sender.calls).toHaveLength(0);
      expect(rows()).toEqual([]);

      history.deleteOverride('Main', 'rent');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      expect(sender.calls).toHaveLength(2); // two destinations
      expect(rows().map((r) => r.delivery)).toEqual(['sent', 'sent']);
    });

    test('a sent row, then off then on: nothing is resent', async () => {
      at('2026-10-12T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      sender.calls.length = 0;
      history.setOverride({ server: 'Main', alertId: 'rent', enabled: false });
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      history.deleteOverride('Main', 'rent');
      at('2026-10-13T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      expect(sender.calls).toHaveLength(0);
    });
  });

  describe('muted', () => {
    test('a missing event during a mute: zero messages, one muted row per destination', async () => {
      setMute('2026-10-20');
      at('2026-10-12T08:00:00.000Z');
      const result = await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      expect(result).toEqual({ sent: 0, skipped: 1 });
      expect(sender.calls).toHaveLength(0);
      expect(rows().map((r) => [r.delivery, r.channel, r.event])).toEqual([
        ['muted', KEY_A, 'missing'], ['muted', KEY_B, 'missing']
      ]);
    });

    test('running again during the mute writes nothing new', async () => {
      setMute('2026-10-20');
      at('2026-10-12T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      at('2026-10-13T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      expect(rows()).toHaveLength(2);
    });

    test('remindEveryDays: 3 over a 20-day mute still yields one muted row per destination and one summary each', async () => {
      const rules = slackRules({ remindEveryDays: 3 });
      setMute('2026-10-20');
      for (let day = 1; day <= 20; day += 1) {
        at(`2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`);
        await run([miss('2026-10-01')], { evaluations: [evalOf('2026-10-01')], rules });
      }
      expect(rows("delivery = 'muted'")).toHaveLength(2);
      expect(sender.calls).toHaveLength(0);
      at('2026-10-21T09:00:00.000Z');
      await run([miss('2026-10-01')], { evaluations: [evalOf('2026-10-01')], rules });
      expect(summaries()).toHaveLength(2);
      expect(summaries()[0].slack.text).toMatch(/1 event\(s\)/);
    });

    test('a latest muted row is never due again by a reminder, 5 days later during the mute', async () => {
      const rules = slackRules({ remindEveryDays: 3 });
      setMute('2026-10-30');
      at('2026-10-05T08:00:00.000Z');
      await run([miss('2026-10-05')], { evaluations: [evalOf('2026-10-05')], rules });
      at('2026-10-10T08:00:00.000Z');
      await run([miss('2026-10-05')], { evaluations: [evalOf('2026-10-05')], rules });
      expect(sender.calls).toHaveLength(0);
      expect(rows()).toHaveLength(2);
    });

    test('an event already sent before the mute is not muted again and counts nowhere', async () => {
      at('2026-10-02T08:00:00.000Z');
      await run([miss('2026-10-02')], { evaluations: [evalOf('2026-10-02')] });
      sender.calls.length = 0;
      setMute('2026-10-20', { mutedFrom: '2026-10-03T08:00:00.000Z' });
      at('2026-10-05T08:00:00.000Z');
      await run([miss('2026-10-02')], { evaluations: [evalOf('2026-10-02')] });
      expect(rows("delivery = 'muted'")).toEqual([]);
    });

    test('the mute lasts through the whole mutedUntil day in the configured zone', async () => {
      const stub = (until) => () => ({ enabled: true, mutedUntil: until });
      const common = { evaluations: [evalOf('2026-10-20')], rules: slackRules(), tz: 'Europe/Madrid' };
      at('2026-10-20T21:30:00.000Z'); // 23:30 in Madrid
      await run([miss('2026-10-20')], { ...common, extra: { ruleState: stub('2026-10-20') } });
      expect(sender.calls).toHaveLength(0);
      at('2026-10-20T22:00:00.000Z'); // midnight in Madrid: not muted
      await run([miss('2026-10-20')], { ...common, extra: { ruleState: stub('2026-10-20') } });
      // The event already has a muted row at both destinations, so it stays
      // suppressed; a new event is delivered.
      await run([miss('2026-10-19')], { ...common, extra: { ruleState: stub('2026-10-20') } });
      expect(sender.calls).toHaveLength(2);
    });
  });

  describe('mute end', () => {
    const muteDuring = async () => {
      setMute('2026-10-20');
      at('2026-10-12T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
    };

    test('each destination gets exactly one muteEnded message; rows, sent rows and cleared fields', async () => {
      await muteDuring();
      at('2026-10-21T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      expect(summaries()).toHaveLength(2);
      expect(sender.calls).toHaveLength(2); // no individual missing message besides the summaries
      const text = summaries()[0].slack.text;
      expect(text).toMatch(/Rent: mute ended \(1 Oct 2026 to 20 Oct 2026, "vacant"\)\. 1 event\(s\) while muted: missing for 12 Oct 2026;/);
      const ended = rows("event = 'muteEnded'");
      expect(ended.map((r) => [r.delivery, r.channel, r.schedule_id, r.occurrence_date])).toEqual([
        ['sent', KEY_A, null, '2026-10-20'], ['sent', KEY_B, null, '2026-10-20']
      ]);
      expect(rows("event = 'missing' AND delivery = 'sent'")).toHaveLength(2);
      expect(history.getOverride('Main', 'rent')).toBeNull();
    });

    test('running again the next day sends nothing', async () => {
      await muteDuring();
      at('2026-10-21T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      sender.calls.length = 0;
      at('2026-10-22T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      expect(sender.calls).toHaveLength(0);
    });

    test('with digest on and nothing else eligible, the summary is its own message', async () => {
      const rules = slackRules({}, { digest: true });
      setMute('2026-10-20');
      at('2026-10-12T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')], rules });
      at('2026-10-21T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-12')], rules });
      expect(summaries()).toHaveLength(2); // one per destination, never merged into a digest
      expect(sender.calls).toHaveLength(2);
      expect(history.getOverride('Main', 'rent')).toBeNull();
    });

    test('the summary counts distinct keys of all five kinds per destination', async () => {
      // Destination A was told 2026-10-02 was missing before the mute; B was not.
      at('2026-10-02T08:00:00.000Z');
      await history.recordScheduleAlert({ server: 'Main', alertId: 'rent', scheduleId: 's1', occurrenceDate: '2026-10-02', event: 'missing', delivery: 'sent', channel: KEY_A });
      setMute('2026-10-20', { mutedFrom: '2026-10-03T08:00:00.000Z' });
      at('2026-10-12T08:00:00.000Z');
      const evaluations = [rentEvaluation({ occurrences: [
        { date: '2026-10-02', deadline: '2026-10-05', state: 'received', receivedDate: '2026-10-08', receivedAmount: -50000 },
        { date: '2026-10-12', deadline: '2026-10-15', state: 'missing', receivedDate: null, receivedAmount: null }
      ] })];
      const events = [
        miss('2026-10-12'),
        { event: 'wrongAmount', alertId: 'rent', scheduleId: 's1', occurrence: '2026-10-13', deadline: '2026-10-14', receivedAmount: -1, receivedDate: '2026-10-13', difference: 1 },
        { event: 'cannotCheck', alertId: 'rent', scheduleId: 's1', occurrence: '2026-10-14', deadline: '2026-10-15', reason: 'stale' },
        { event: 'ruleUnmatched', alertId: 'rent', scheduleId: null, occurrence: null, deadline: null }
      ];
      await run(events, { evaluations });
      at('2026-10-21T08:00:00.000Z');
      await run([], { evaluations });
      const byUrl = Object.fromEntries(summaries().map((c) => [c.slack.url, c.slack.text]));
      expect(byUrl['https://slack/a']).toMatch(/5 event\(s\)/);
      expect(byUrl['https://slack/b']).toMatch(/4 event\(s\)/);
    });

    test('a muted missing at a never-told destination is dropped when the occurrence is received; no resolved, not counted', async () => {
      await muteDuring();
      at('2026-10-14T08:00:00.000Z');
      const paid = [evalOf('2026-10-12', 'received')];
      await run([], { evaluations: paid });
      expect(rows("delivery = 'muted'")).toEqual([]);
      at('2026-10-21T08:00:00.000Z');
      await run([], { evaluations: paid });
      expect(sender.calls).toHaveLength(0); // nothing to tell, no resolved
      expect(history.getOverride('Main', 'rent')).toBeNull();
    });

    test('a destination that was told earlier gets its resolved recorded as muted and counted', async () => {
      at('2026-10-02T08:00:00.000Z');
      await history.recordScheduleAlert({ server: 'Main', alertId: 'rent', scheduleId: 's1', occurrenceDate: '2026-10-02', event: 'missing', delivery: 'sent', channel: KEY_A });
      setMute('2026-10-20', { mutedFrom: '2026-10-03T08:00:00.000Z' });
      at('2026-10-10T08:00:00.000Z');
      const paid = [evalOf('2026-10-02', 'received')];
      await run([], { evaluations: paid });
      expect(sender.calls).toHaveLength(0);
      expect(rows("event = 'resolved'").map((r) => [r.delivery, r.channel])).toEqual([['muted', KEY_A]]);
      at('2026-10-21T08:00:00.000Z');
      await run([], { evaluations: paid });
      expect(summaries()).toHaveLength(1);
      expect(summaries()[0].slack.url).toBe('https://slack/a');
      expect(summaries()[0].slack.text).toMatch(/1 event\(s\)/);
      // The resolved was covered by the summary: not sent again afterwards.
      sender.calls.length = 0;
      at('2026-10-22T08:00:00.000Z');
      await run([], { evaluations: paid });
      expect(sender.calls).toHaveLength(0);
    });

    test('a destination with no sent missing row never gets a resolved after the mute', async () => {
      at('2026-10-25T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-12', 'received')] });
      expect(sender.calls).toHaveLength(0);
    });

    test('a muted row written just after midnight of the mute end still gets summarized (#261)', async () => {
      setMute('2026-10-20');
      // The evaluation started at 23:59:30 (still muted); its row is written at 00:00:10.
      at('2026-10-21T00:00:10.000Z');
      const started = new Date('2026-10-20T23:59:30.000Z');
      const rules = slackRules();
      await deliver([miss('2026-10-19')], {
        evaluations: [evalOf('2026-10-19')], history, sender, now: started, server: 'Main', rules, timezone: 'UTC', logger,
        ruleState: (alertId) => ruleState({ rule: rules[0], override: history.getOverride('Main', alertId), now: started, timezone: 'UTC' })
      });
      expect(rows("delivery = 'muted'")).toHaveLength(2);
      at('2026-10-21T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-19')] });
      expect(summaries()).toHaveLength(2);
    });

    test('a mute that ends with zero muted rows: no message, fields cleared', async () => {
      setMute('2026-10-20');
      at('2026-10-21T08:00:00.000Z');
      await run([], { evaluations: [] });
      expect(sender.calls).toHaveLength(0);
      expect(history.getOverride('Main', 'rent')).toBeNull();
    });

    test('a rule with zero usable destinations: fields cleared and a WARN', async () => {
      sender = makeFakeSender({});
      setMute('2026-10-20');
      at('2026-10-21T08:00:00.000Z');
      await run([], { evaluations: [] });
      expect(history.getOverride('Main', 'rent')).toBeNull();
      expect(warns.length).toBeGreaterThan(0);
    });

    test('partial failure: fields kept with a WARN, the next run sends only to the failed destination', async () => {
      await muteDuring();
      at('2026-10-21T08:00:00.000Z');
      sender.result = (o) => (o.slack.url === 'https://slack/b' ? { slack: { success: false } } : { slack: { success: true } });
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      expect(history.getOverride('Main', 'rent')).toMatchObject({ mutedUntil: '2026-10-20', reason: 'vacant' });
      expect(warns.length).toBeGreaterThan(0);
      expect(rows("event = 'muteEnded'").map((r) => r.channel)).toEqual([KEY_A]);
      sender.result = null;
      sender.calls.length = 0;
      at('2026-10-22T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')] });
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].slack.url).toBe('https://slack/b');
      expect(history.getOverride('Main', 'rent')).toBeNull();
    });

    test('a thrown send keeps the fields too', async () => {
      await muteDuring();
      at('2026-10-21T08:00:00.000Z');
      sender.result = () => { throw new Error('boom'); };
      await run([], { evaluations: [evalOf('2026-10-12')] });
      expect(history.getOverride('Main', 'rent').mutedUntil).toBe('2026-10-20');
    });

    test('a muted row left by a failed summary is never answered by a reminder', async () => {
      const rules = slackRules({ remindEveryDays: 3 });
      setMute('2026-10-20');
      at('2026-10-12T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')], rules });
      at('2026-10-21T08:00:00.000Z');
      sender.result = () => { throw new Error('boom'); };
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')], rules });
      sender.calls.length = 0;
      at('2026-10-25T08:00:00.000Z');
      // Summary fails again, so the muted row stays the latest; no individual reminder may go out.
      sender.result = () => { throw new Error('boom'); };
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')], rules });
      expect(sender.calls).toHaveLength(2); // the two summary attempts only, no reminder
      expect(rows("event = 'missing' AND delivery = 'sent'")).toEqual([]);
    });

    test('the delivery budget stops new summaries; the next run finishes them', async () => {
      await muteDuring();
      at('2026-10-21T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-12')], extra: { deadline: Date.now() - 1 } });
      expect(sender.calls).toHaveLength(0);
      expect(history.getOverride('Main', 'rent')).not.toBeNull();
      await run([], { evaluations: [evalOf('2026-10-12')] });
      expect(summaries()).toHaveLength(2);
    });

    test('while switched off the summary is deferred; switched on within 7 days it is sent once', async () => {
      await muteDuring();
      history.setOverride({ server: 'Main', alertId: 'rent', enabled: false, mutedFrom: '2026-10-01T08:00:00.000Z', mutedUntil: '2026-10-20', reason: 'vacant' });
      at('2026-10-22T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-12')] });
      expect(sender.calls).toHaveLength(0);
      expect(history.getOverride('Main', 'rent')).toMatchObject({ enabled: false, mutedUntil: '2026-10-20' });
      expect(rows("delivery = 'muted'")).toHaveLength(2);
      history.setOverride({ server: 'Main', alertId: 'rent', enabled: true, mutedFrom: '2026-10-01T08:00:00.000Z', mutedUntil: '2026-10-20', reason: 'vacant' });
      at('2026-10-23T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-12')] });
      expect(summaries()).toHaveLength(2);
      await run([], { evaluations: [evalOf('2026-10-12')] });
      expect(summaries()).toHaveLength(2);
    });

    test('config enabled false defers the summary; changed back within 7 days it is sent once', async () => {
      await muteDuring();
      const locked = slackRules({ enabled: false });
      at('2026-10-22T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-12')], rules: locked });
      expect(sender.calls).toHaveLength(0);
      expect(history.getOverride('Main', 'rent').mutedUntil).toBe('2026-10-20');
      at('2026-10-24T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-12')] });
      expect(summaries()).toHaveLength(2);
    });

    test('switched on after 7 days: no summary, reason, rows and fields already cleared with a WARN', async () => {
      await muteDuring();
      history.setOverride({ server: 'Main', alertId: 'rent', enabled: false, mutedFrom: '2026-10-01T08:00:00.000Z', mutedUntil: '2026-10-20', reason: 'vacant' });
      const expiryWarn = jest.spyOn(history.logger, 'warn').mockImplementation(() => {});
      at('2026-10-28T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-12')] });
      expect(history.getOverride('Main', 'rent')).toMatchObject({ enabled: false, mutedUntil: null, reason: null });
      expect(rows("delivery = 'muted'")).toEqual([]);
      expect(expiryWarn).toHaveBeenCalled();
      history.deleteOverride('Main', 'rent');
      at('2026-10-29T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-12')] });
      expect(summaries()).toHaveLength(0);
    });

    test('an orphaned override whose mute ended more than 7 days ago is expired by the phase', async () => {
      history.setOverride({ server: 'Main', alertId: 'old', enabled: true, mutedFrom: '2026-09-01T08:00:00.000Z', mutedUntil: '2026-09-10', reason: 'gone' });
      at('2026-10-01T08:00:00.000Z');
      await run([], { evaluations: [] });
      expect(history.getOverride('Main', 'old')).toBeNull();
    });

    test('an extension keeps the original muted_from, so the summary covers the whole period', async () => {
      setMute('2026-10-10');
      at('2026-10-05T08:00:00.000Z');
      await run([miss('2026-10-05')], { evaluations: [evalOf('2026-10-05')] });
      const stored = history.getOverride('Main', 'rent');
      history.setOverride({ ...stored, mutedUntil: '2026-10-20' });
      at('2026-10-15T08:00:00.000Z');
      await run([miss('2026-10-05'), miss('2026-10-14')], { evaluations: [evalOf('2026-10-05')] });
      at('2026-10-21T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-05')] });
      expect(history.getOverride('Main', 'rent')).toBeNull();
      expect(summaries()[0].slack.text).toMatch(/1 Oct 2026 to 20 Oct 2026.*2 event\(s\)/);
    });

    test('a reason with markup is escaped in the Telegram message', async () => {
      sender = makeFakeSender({ telegram: { enabled: true } });
      const rules = rentRules({ channels: ['telegram'] });
      setMute('2026-10-20', { reason: '<script>alert(1)</script> & <b>x</b>' });
      at('2026-10-12T08:00:00.000Z');
      await run([miss('2026-10-12')], { evaluations: [evalOf('2026-10-12')], rules });
      at('2026-10-21T08:00:00.000Z');
      await run([], { evaluations: [evalOf('2026-10-12')], rules });
      const html = sender.calls[0].telegram.html;
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    test('evaluate output is not changed by mute state: both muted and off rules still reach deliver', async () => {
      // deliver never mutates the events it is given
      const events = [miss('2026-10-12')];
      const copy = JSON.parse(JSON.stringify(events));
      setMute('2026-10-20');
      at('2026-10-12T08:00:00.000Z');
      await run(events, { evaluations: [evalOf('2026-10-12')] });
      expect(events).toEqual(copy);
    });
  });
});
