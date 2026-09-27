/**
 * Tests for missing-payment alert delivery (#258).
 *
 * `deliver()`'s collaborators (the sync-history ledger and the notification
 * sender) are faked here rather than using real SQLite/HTTP, since the goal
 * is to exercise de-duplication, reminders, resolved-event derivation, fan-out
 * and digest logic in isolation. A separate service-level test can wire the
 * real `SyncHistoryService` and `NotificationService` through `syncService.js`.
 */

const { deliver, DEFAULT_TEMPLATES, VARIABLES, ALL_CHANNELS } = require('../lib/scheduleAlertDelivery');
const { getRules } = require('../lib/scheduleAlertRules');
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
    async findLatestScheduleAlert({ server, alertId, scheduleId, occurrenceDate, event, channel }) {
      const filterChannel = channel !== undefined;
      const matches = this.rows.filter((r) =>
        r.server === server && r.alertId === alertId && r.scheduleId === scheduleId
        && r.occurrenceDate === occurrenceDate && r.event === event
        && (!filterChannel || r.channel === (channel ?? null)));
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

describe('deliver: rule state (#261 passthrough)', () => {
  test('a disabled rule is skipped entirely', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({ telegram: { enabled: true } });

    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: () => ({ enabled: false, mutedUntil: null }),
      history, sender, now: '2026-01-10', server: 'Main', rules: rentRules(), timezone: 'UTC', logger: quietLogger
    });

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(0);
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
    expect(history.rows).toHaveLength(2);
    expect(history.rows.map((r) => r.channel).sort()).toEqual(['slack:https://slack/a', 'slack:https://slack/b']);
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
    expect(history.rows[0].channel).toBe('slack:https://slack/b');

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
    expect(history.rows.map((r) => r.channel).sort()).toEqual(['slack:https://slack/a', 'slack:https://slack/b']);

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

    // Sync 3: still late/paid, no new missing alert since - resolved must not resend.
    const thirdResult = await deliver([], { ...baseArgs, evaluations: [lateEvaluation], now: '2026-01-12' });
    expect(thirdResult).toEqual({ sent: 0, skipped: 0 });
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
