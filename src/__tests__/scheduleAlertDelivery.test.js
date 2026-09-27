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

/** In-memory stand-in for the schedule_alerts ledger (src/services/syncHistory.js). */
function makeFakeHistory() {
  return {
    rows: [],
    clock: '2026-01-10T00:00:00.000Z',
    async findLatestScheduleAlert({ server, alertId, scheduleId, occurrenceDate, event }) {
      const matches = this.rows.filter((r) =>
        r.server === server && r.alertId === alertId && r.scheduleId === scheduleId
        && r.occurrenceDate === occurrenceDate && r.event === event);
      return matches.length ? matches[matches.length - 1] : null;
    },
    async recordScheduleAlert({ server, alertId, scheduleId, occurrenceDate, event, delivery }) {
      this.rows.push({ server, alertId, scheduleId, occurrenceDate, event, delivery, recordedAt: this.clock });
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
    expect(history.rows).toHaveLength(1); // one ledger row per event, not per destination
  });

  test('if any destination fails, the whole event is withheld from the ledger for retry', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({
      webhooks: { slack: [{ name: 'a', url: 'https://slack/a', enabled: true }, { name: 'b', url: 'https://slack/b', enabled: true }] }
    });
    sender.result = (outputs) => (outputs.slack.url === 'https://slack/a' ? { slack: { success: false } } : { slack: { success: true } });

    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      now: '2026-01-10', server: 'Main', rules: rentRules({ channels: ['slack'] }), timezone: 'UTC', logger: quietLogger
    });

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(2); // both destinations were still attempted
    expect(history.rows).toHaveLength(0); // withheld, so the next sync retries it
  });

  test('a rule requesting a channel the sender has none configured for sends nothing but the event is still not attempted twice', async () => {
    const history = makeFakeHistory();
    const sender = makeFakeSender({}); // nothing configured

    const result = await deliver([missingEvent()], {
      evaluations: [rentEvaluation()], ruleState: enabledState, history, sender,
      now: '2026-01-10', server: 'Main', rules: rentRules({ channels: ['slack'] }), timezone: 'UTC', logger: quietLogger
    });

    expect(sender.calls).toHaveLength(0);
    expect(result).toEqual({ sent: 1, skipped: 0 });
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
