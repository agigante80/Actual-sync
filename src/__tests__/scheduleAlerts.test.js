/**
 * Tests for the missing-payment detection engine (#258).
 *
 * `evaluate()` is pure, so every scenario below is a plain fixture: a fixed
 * `now`, one or more schedules, accounts and transactions, and an assertion
 * on the resulting `{ events, evaluations, warnings }`. Timezone is 'UTC'
 * throughout to keep day-boundary arithmetic unambiguous; #266 (global
 * timezone) and DST-specific behavior are out of scope for this ticket.
 */

const { evaluate, MAX_OCCURRENCES } = require('../lib/scheduleAlerts');
const { getRules } = require('../lib/scheduleAlertRules');

const TZ = 'UTC';

function rentSchedule(overrides = {}) {
  return {
    id: 's1',
    name: 'Rent',
    account: 'acc1',
    accountName: 'Checking',
    payee: 'pay1',
    payeeName: 'Landlord',
    amount: -50000,
    amountOp: 'is',
    date: '2026-01-05',
    ...overrides
  };
}

function rentRule(overrides = {}) {
  return getRules({
    staleAfterDays: 3,
    alerts: [{ id: 'rent', schedule: 'Rent', graceDays: 3, earlyDays: 2, ...overrides }]
  });
}

function account(overrides = {}) {
  return { id: 'acc1', name: 'Checking', last_sync: '2026-01-09', ...overrides };
}

describe('evaluate: missing / cannotCheck', () => {
  test('no transaction, synced past the deadline and not stale -> missing', () => {
    const { events, evaluations, warnings } = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: '2026-01-09' })],
      now: '2026-01-10',
      timezone: TZ
    });

    expect(warnings).toEqual([]);
    expect(events).toEqual([{
      event: 'missing',
      alertId: 'rent',
      scheduleId: 's1',
      occurrence: '2026-01-05',
      deadline: '2026-01-08',
      daysOverdue: 2,
      expectedAmount: -50000
    }]);
    expect(evaluations[0].state).toBe('missing');
  });

  test('stale bank connection (last_sync more than staleAfterDays ago) -> cannotCheck, reason stale', () => {
    const { events } = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: '2026-01-05' })], // 5 days before "now"
      now: '2026-01-10',
      timezone: TZ
    });

    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'stale', lastSync: '2026-01-05' })]);
  });

  test('#271 item 3: staleness boundary is strict (> not >=)', () => {
    // staleAfterDays = 3. Exactly 3 days since last_sync must NOT be stale.
    const exactlyThree = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: '2026-01-07' })], // today - 3 days, but before deadline -> not-synced
      now: '2026-01-10',
      timezone: TZ
    });
    expect(exactlyThree.events[0]).toMatchObject({ event: 'cannotCheck', reason: 'not-synced' });

    const fourDays = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: '2026-01-06' })], // today - 4 days -> stale
      now: '2026-01-10',
      timezone: TZ
    });
    expect(fourDays.events[0]).toMatchObject({ event: 'cannotCheck', reason: 'stale' });
  });

  test('synced, but not yet past the deadline -> cannotCheck, reason not-synced', () => {
    const { events } = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: '2026-01-07' })], // before deadline (Jan 8), not stale
      now: '2026-01-10',
      timezone: TZ
    });

    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'not-synced' })]);
  });

  test('occurrence not yet due (today within the grace period) -> no event, state upcoming', () => {
    const { events, evaluations } = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: '2026-01-06' })],
      now: '2026-01-07', // deadline is Jan 8, still on time
      timezone: TZ
    });
    expect(events).toEqual([]);
    expect(evaluations[0].state).toBe('upcoming');
  });

  test('a future occurrence -> upcoming, no event', () => {
    const { events, evaluations } = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule({ date: '2026-02-05' })],
      transactions: [],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events).toEqual([]);
    expect(evaluations[0].state).toBe('upcoming');
  });
});

describe('evaluate: received / late / wrongAmount', () => {
  test('exact-amount transaction inside the on-time window -> received, no event', () => {
    const { events, evaluations } = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: null }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events).toEqual([]);
    expect(evaluations[0].state).toBe('received');
    expect(evaluations[0].occurrences[0]).toMatchObject({
      date: '2026-01-05', deadline: '2026-01-08', state: 'received', receivedDate: '2026-01-05', receivedAmount: -50000
    });
  });

  test('#271 item 2: with no next occurrence, the late window is open through "today"', () => {
    // Deadline is Jan 8; the transaction lands well after it but the late
    // window has no next occurrence to be capped by, so it extends to "now".
    const { events, evaluations } = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-09', schedule: null }],
      accounts: [account({ last_sync: '2026-01-09' })],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events).toEqual([]); // late is not a "problem" event; resolved is derived by the delivery layer
    expect(evaluations[0].state).toBe('late');
    expect(evaluations[0].occurrences[0]).toMatchObject({ state: 'late', receivedDate: '2026-01-09' });
  });

  test('a transaction linked via transaction.schedule counts regardless of amount', () => {
    const { evaluations } = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -1, date: '2026-01-05', schedule: 's1' }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('received');
  });

  test('an unlinked transaction with the wrong amount -> wrongAmount event with the correct difference', () => {
    const { events } = evaluate({
      rules: rentRule({ amountTolerancePct: 0 }),
      schedules: [rentSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -40000, date: '2026-01-05', schedule: null }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events).toEqual([{
      event: 'wrongAmount',
      alertId: 'rent',
      scheduleId: 's1',
      occurrence: '2026-01-05',
      deadline: '2026-01-08',
      expectedAmount: -50000,
      receivedAmount: -40000,
      receivedDate: '2026-01-05',
      difference: 10000,
      difference_raw: 10000
    }]);
  });

  test('isapprox amount tolerance defaults to 7.5% and is inclusive at the boundary', () => {
    const schedule = rentSchedule({ amountOp: 'isapprox' });
    const atBoundary = evaluate({
      rules: rentRule(),
      schedules: [schedule],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -46250, date: '2026-01-05', schedule: null }], // exactly 7.5% under
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(atBoundary.evaluations[0].state).toBe('received');

    const beyondBoundary = evaluate({
      rules: rentRule(),
      schedules: [schedule],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -46249, date: '2026-01-05', schedule: null }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(beyondBoundary.evaluations[0].state).toBe('wrongAmount');
  });
});

describe('evaluate: rule matching', () => {
  test('a rule matching no schedule -> ruleUnmatched event, no evaluation entry', () => {
    const { events, evaluations } = evaluate({
      rules: getRules({ alerts: [{ id: 'ghost', schedule: 'Does Not Exist' }] }),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events).toEqual([{ event: 'ruleUnmatched', alertId: 'ghost', scheduleId: null, occurrence: null, deadline: null }]);
    expect(evaluations).toEqual([]);
  });

  test('a schedulePrefix rule expands into one independent evaluation per matching schedule', () => {
    const schedules = [
      rentSchedule({ id: 's1', name: 'Utilities - Gas', account: 'acc1', payee: 'pay1' }),
      rentSchedule({ id: 's2', name: 'Utilities - Electric', account: 'acc1', payee: 'pay2' })
    ];
    const { events, evaluations } = evaluate({
      rules: getRules({ staleAfterDays: 3, alerts: [{ id: 'utilities', schedulePrefix: 'Utilities', graceDays: 3, earlyDays: 2 }] }),
      schedules,
      transactions: [],
      accounts: [account({ last_sync: '2026-01-09' })],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events.filter((e) => e.event === 'missing')).toHaveLength(2);
    expect(events.every((e) => e.alertId === 'utilities')).toBe(true);
    expect(new Set(events.map((e) => e.scheduleId))).toEqual(new Set(['s1', 's2']));
    expect(evaluations).toHaveLength(2);
  });
});

describe('evaluate: #271 item 1 (window overlap)', () => {
  test('graceDays + earlyDays >= the shortest interval -> the rule is skipped with a warning and a cannotCheck event', () => {
    const weeklySchedule = rentSchedule({
      date: { start: '2026-01-05', frequency: 'weekly' } // 7-day interval
    });
    const { events, evaluations, warnings } = evaluate({
      rules: rentRule({ graceDays: 5, earlyDays: 3 }), // 5 + 3 = 8 >= 7
      schedules: [weeklySchedule],
      transactions: [],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ ruleId: 'rent', scheduleId: 's1' });
    expect(warnings[0].message).toMatch(/graceDays \(5\) \+ earlyDays \(3\)/);

    expect(events).toEqual([{
      event: 'cannotCheck', alertId: 'rent', scheduleId: 's1', occurrence: null, deadline: null, reason: 'interval-violation'
    }]);
    expect(evaluations[0]).toMatchObject({ state: 'cannotCheck', occurrences: [] });
  });

  test('graceDays + earlyDays strictly less than the interval -> no warning', () => {
    const weeklySchedule = rentSchedule({ date: { start: '2026-01-05', frequency: 'weekly' } });
    const { warnings } = evaluate({
      rules: rentRule({ graceDays: 2, earlyDays: 2 }), // 4 < 7
      schedules: [weeklySchedule],
      transactions: [],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(warnings).toEqual([]);
  });

  test('graceDays + earlyDays exactly equal to the shortest interval also trips the guard (boundary is >=, not >)', () => {
    const weeklySchedule = rentSchedule({ date: { start: '2026-01-05', frequency: 'weekly' } }); // 7-day interval
    const { events, warnings } = evaluate({
      rules: rentRule({ graceDays: 4, earlyDays: 3 }), // 4 + 3 = 7 == 7
      schedules: [weeklySchedule],
      transactions: [],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(warnings).toHaveLength(1);
    expect(events).toEqual([{
      event: 'cannotCheck', alertId: 'rent', scheduleId: 's1', occurrence: null, deadline: null, reason: 'interval-violation'
    }]);
  });
});

describe('evaluate: #271 item 4 (occurrences shape) and MAX_OCCURRENCES', () => {
  test('each occurrence carries date, deadline, state, receivedDate and receivedAmount', () => {
    const { evaluations } = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: null }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    const occ = evaluations[0].occurrences[0];
    expect(Object.keys(occ).sort()).toEqual(['date', 'deadline', 'receivedAmount', 'receivedDate', 'state'].sort());
  });

  test('occurrences is capped at MAX_OCCURRENCES, keeping the most recent', () => {
    const dailySchedule = rentSchedule({ date: { start: '2025-12-01', frequency: 'daily' } });
    const { evaluations } = evaluate({
      rules: rentRule({ graceDays: 0, earlyDays: 0 }),
      schedules: [dailySchedule],
      transactions: [],
      accounts: [account({ last_sync: '2026-01-09' })],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].occurrences).toHaveLength(MAX_OCCURRENCES);
    const dates = evaluations[0].occurrences.map((o) => o.date);
    // Ascending, and the tail sits at or just after "now" (2026-01-10), not
    // back near the schedule's 2025-12-01 start - confirming MAX_OCCURRENCES
    // kept the most recent occurrences, not the earliest.
    expect(dates).toEqual([...dates].sort());
    expect(dates[dates.length - 1] >= '2026-01-10').toBe(true);
  });
});
