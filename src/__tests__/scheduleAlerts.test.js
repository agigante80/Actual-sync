/**
 * Tests for the missing-payment detection engine (#258).
 *
 * `evaluate()` is pure, so every scenario below is a plain fixture: a fixed
 * `now`, one or more schedules, accounts and transactions, and an assertion
 * on the resulting `{ events, evaluations, warnings }`. Timezone is 'UTC'
 * throughout unless a test is specifically about timezone/DST behavior (see
 * the "M15" describe block below, which covers Europe/Madrid and the two
 * DST transition dates - #295 review, M15 removed the previous claim here
 * that DST was out of scope).
 *
 * `account.last_sync` fixtures use `epochMs(...)`, matching production
 * Actual's own epoch-millisecond string format, not a plain date string
 * (#295 review, H1).
 */

const { evaluate, MAX_OCCURRENCES } = require('../lib/scheduleAlerts');
const { getRules } = require('../lib/scheduleAlertRules');

const TZ = 'UTC';

/** Production `last_sync` is an epoch-millisecond string, not a date string (#295 review, H1). */
function epochMs(dateOrDateTimeStr) {
  return String(Date.parse(dateOrDateTimeStr));
}

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
  return { id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-09'), ...overrides };
}

describe('evaluate: missing / cannotCheck', () => {
  test('no transaction, synced past the deadline and not stale -> missing', () => {
    const { events, evaluations, warnings } = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
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
      accounts: [account({ last_sync: epochMs('2026-01-05') })], // 5 days before "now"
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
      accounts: [account({ last_sync: epochMs('2026-01-07') })], // today - 3 days, but before deadline -> not-synced
      now: '2026-01-10',
      timezone: TZ
    });
    expect(exactlyThree.events[0]).toMatchObject({ event: 'cannotCheck', reason: 'not-synced' });

    const fourDays = evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-06') })], // today - 4 days -> stale
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
      accounts: [account({ last_sync: epochMs('2026-01-07') })], // before deadline (Jan 8), not stale
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
      accounts: [account({ last_sync: epochMs('2026-01-06') })],
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
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
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
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
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
    // A plain daily schedule no longer works as this test's fixture: its
    // 1-day interval always trips the #295 review round 2, M3 overlap guard
    // now that the guard accounts for the linked-early window (graceDays(0)
    // + max(earlyDays(0), LINKED_EARLY_WINDOW_DAYS(2)) = 2 >= 1). A monthly
    // schedule with several same-month day-of-month patterns keeps the
    // shortest gap (3 days) safely above that guard while still producing
    // more than MAX_OCCURRENCES raw occurrences in the evaluation window, so
    // this test still exercises the actual truncation logic.
    const denseSchedule = rentSchedule({
      date: { start: '2025-01-01', frequency: 'monthly', patterns: [1, 4, 7, 10, 13, 16, 25].map((value) => ({ type: 'day', value })) }
    });
    const { evaluations } = evaluate({
      rules: rentRule({ graceDays: 0, earlyDays: 0 }),
      schedules: [denseSchedule],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
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

describe('evaluate: H2 (isolation and on_date cadence text)', () => {
  test('an on_date endMode schedule does not throw and its cadenceText uses a valid date-fns format', () => {
    const schedule = rentSchedule({
      date: { start: '2026-01-05', frequency: 'monthly', endMode: 'on_date', endDate: '2026-06-01' }
    });
    const { evaluations, warnings } = evaluate({
      rules: rentRule(),
      schedules: [schedule],
      transactions: [],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(warnings).toEqual([]);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].cadenceText).toBe('Every month on the 5th, until 1 Jun 2026');
  });

  test('a schedule that throws during evaluation does not block other rules', () => {
    const goodSchedule = rentSchedule({ id: 's1', name: 'Rent' });
    const badSchedule = rentSchedule({ id: 's2', name: 'Broken', date: { start: '2026-01-05', frequency: 'bogus' } });
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rent', schedule: 'Rent', graceDays: 3, earlyDays: 2 },
        { id: 'broken', schedule: 'Broken', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { events, evaluations, warnings } = evaluate({
      rules,
      schedules: [goodSchedule, badSchedule],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });

    expect(events).toContainEqual(expect.objectContaining({ event: 'missing', alertId: 'rent' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'cannotCheck', alertId: 'broken', reason: 'error' }));
    expect(evaluations).toHaveLength(1); // only the good rule produced an evaluation entry
    expect(evaluations[0].alertId).toBe('rent');
    expect(warnings.some((w) => w.ruleId === 'broken')).toBe(true);
  });
});

describe('evaluate: M9 (Actual "Skip next date")', () => {
  test('an occurrence strictly before schedule.next_date is treated as skipped, not missing', () => {
    const schedule = rentSchedule({ next_date: '2026-01-06' }); // occurrence Jan 5 was skipped in Actual
    const { events, evaluations } = evaluate({
      rules: rentRule(),
      schedules: [schedule],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events).toEqual([]);
    expect(evaluations[0].state).toBe('skipped');
  });

  test('without next_date, the same occurrence is still reported missing as before', () => {
    const schedule = rentSchedule();
    const { events, evaluations } = evaluate({
      rules: rentRule(),
      schedules: [schedule],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('missing');
    expect(events).toEqual([expect.objectContaining({ event: 'missing' })]);
  });
});

describe('evaluate: R2-H2 (next_date can advance from a later linked payment, not only an explicit skip)', () => {
  test('a later occurrence being linked (advancing next_date) does not hide an earlier genuinely missed occurrence', () => {
    // Monthly on the 1st: January was never paid; a February payment posted
    // and linked to the schedule, so Actual advanced next_date to 1 March -
    // NOT because January was explicitly skipped.
    const schedule = rentSchedule({
      date: { start: '2026-01-01', frequency: 'monthly' },
      next_date: '2026-03-01'
    });
    const { evaluations } = evaluate({
      rules: rentRule(),
      schedules: [schedule],
      transactions: [{ id: 'feb', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-02-01', schedule: 's1' }],
      accounts: [account({ last_sync: epochMs('2026-02-14') })],
      now: '2026-02-15',
      timezone: TZ
    });
    const jan = evaluations[0].occurrences.find((o) => o.date === '2026-01-01');
    expect(jan.state).toBe('missing'); // not silently "skipped"
  });

  test('next_date advancing with no intervening linked payment at all is still a genuine skip', () => {
    const schedule = rentSchedule({
      date: { start: '2026-01-01', frequency: 'monthly' },
      next_date: '2026-02-01' // Actual's own "Skip next date" on January, no transaction involved
    });
    const { evaluations } = evaluate({
      rules: rentRule(),
      schedules: [schedule],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-20') })],
      now: '2026-01-25',
      timezone: TZ
    });
    const jan = evaluations[0].occurrences.find((o) => o.date === '2026-01-01');
    expect(jan.state).toBe('skipped');
  });
});

describe('evaluate: R2-M4 (next_date boundary)', () => {
  test('next_date equal to the unpaid occurrence date is not "before" it -> missing, not skipped', () => {
    const schedule = rentSchedule({ next_date: '2026-01-05' }); // equal to the occurrence date itself
    const { evaluations } = evaluate({
      rules: rentRule(),
      schedules: [schedule],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('missing');
  });
});

describe('evaluate: M10 (isbetween amount range)', () => {
  function isbetweenSchedule(overrides = {}) {
    return rentSchedule({ amountOp: 'isbetween', amount: { num1: -55000, num2: -45000 }, ...overrides });
  }

  test('an amount within the isbetween range -> received, not wrongAmount', () => {
    const { evaluations } = evaluate({
      rules: rentRule({ amountTolerancePct: 0 }),
      schedules: [isbetweenSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: null }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('received');
  });

  test('an amount outside the isbetween range -> wrongAmount', () => {
    const { evaluations } = evaluate({
      rules: rentRule({ amountTolerancePct: 0 }),
      schedules: [isbetweenSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -30000, date: '2026-01-05', schedule: null }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('wrongAmount');
  });

  test('the range bounds are order-independent (num1 may be the larger or smaller bound)', () => {
    const { evaluations } = evaluate({
      rules: rentRule({ amountTolerancePct: 0 }),
      schedules: [isbetweenSchedule({ amount: { num1: -45000, num2: -55000 } })], // swapped
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: null }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('received');
  });
});

describe('evaluate: M11 (candidate priority + cross-binding sharing)', () => {
  test('within one on-time window, a within-tolerance candidate is preferred over an earlier wrong-amount one', () => {
    const { evaluations } = evaluate({
      rules: rentRule({ amountTolerancePct: 0, earlyDays: 5 }), // widen window so both candidates qualify
      schedules: [rentSchedule()],
      transactions: [
        { id: 'wrong', account: 'acc1', payee: 'pay1', amount: -1, date: '2026-01-01', schedule: null }, // earlier, wrong amount
        { id: 'right', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-03', schedule: null } // later, exact amount
      ],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('received');
    expect(evaluations[0].occurrences[0]).toMatchObject({ receivedDate: '2026-01-03', receivedAmount: -50000 });
  });

  test('a transaction linked to a different schedule is not also claimed via account+payee matching', () => {
    const scheduleA = rentSchedule({ id: 'sA', name: 'Rent A' });
    const scheduleB = rentSchedule({ id: 'sB', name: 'Rent B' }); // same account+payee as A
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rentA', schedule: 'Rent A', graceDays: 3, earlyDays: 2 },
        { id: 'rentB', schedule: 'Rent B', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = evaluate({
      rules,
      schedules: [scheduleA, scheduleB],
      // Linked to schedule A only; account+payee also matches schedule B.
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: 'sA' }],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    const byAlert = Object.fromEntries(evaluations.map((e) => [e.alertId, e]));
    expect(byAlert.rentA.state).toBe('received');
    expect(byAlert.rentB.state).toBe('missing'); // not silently marked received via the shared tx
  });

  test('an unlinked transaction shared by two schedules with the same account+payee settles only one of them', () => {
    const scheduleA = rentSchedule({ id: 'sA', name: 'Rent A' });
    const scheduleB = rentSchedule({ id: 'sB', name: 'Rent B' }); // same account+payee as A
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rentA', schedule: 'Rent A', graceDays: 3, earlyDays: 2 },
        { id: 'rentB', schedule: 'Rent B', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = evaluate({
      rules,
      schedules: [scheduleA, scheduleB],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: null }],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    const states = evaluations.map((e) => e.state).sort();
    // Exactly one of the two schedules is settled by the shared transaction;
    // the other still reports its occurrence unresolved (missing), instead
    // of both silently showing "received" from the one payment (#295
    // review, M11).
    expect(states).toEqual(['missing', 'received']);
  });
});

describe('evaluate: M12 (linked early window)', () => {
  test('a transaction linked 2 days early counts as received even when earlyDays is 0', () => {
    const { evaluations } = evaluate({
      rules: rentRule({ earlyDays: 0 }),
      schedules: [rentSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -1, date: '2026-01-03', schedule: 's1' }], // 2 days early, linked
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('received');
    expect(evaluations[0].occurrences[0]).toMatchObject({ receivedDate: '2026-01-03' });
  });

  test('an unlinked transaction 2 days early is still excluded when earlyDays is 0 (the widened window is link-specific)', () => {
    const { evaluations } = evaluate({
      rules: rentRule({ earlyDays: 0 }),
      schedules: [rentSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-03', schedule: null }], // 2 days early, unlinked
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('missing');
  });
});

describe('evaluate: R2-H1 (two rules bound to the same schedule share transaction claims)', () => {
  test('a linked payment settles every rule bound to the same schedule, not just the first', () => {
    const schedule = rentSchedule(); // name 'Rent', id 's1'
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rentExact', schedule: 'Rent', graceDays: 3, earlyDays: 2 },
        { id: 'rentPrefix', schedulePrefix: 'Re', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = evaluate({
      rules,
      schedules: [schedule],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: 's1' }],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    const byAlert = Object.fromEntries(evaluations.map((e) => [e.alertId, e]));
    expect(byAlert.rentExact.state).toBe('received');
    // Before the fix, the shared `globallyUsedTx` Set treated the transaction
    // as "already used" for every later binding regardless of which schedule
    // claimed it, so this second rule (bound to the SAME schedule) wrongly
    // reported the occurrence missing even though it was already settled.
    expect(byAlert.rentPrefix.state).toBe('received');
  });
});

describe("evaluate: R2-M1 (wrong-amount / late fallback must not steal a sibling schedule's payment)", () => {
  test("pass 1: an unlinked payment correctly amounted for a sibling schedule is not grabbed by this schedule's wrong-amount fallback", () => {
    const rent = rentSchedule({ id: 'sRent', name: 'Rent', amount: -50000 });
    const parking = rentSchedule({ id: 'sParking', name: 'Parking', amount: -8000 });
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rent', schedule: 'Rent', graceDays: 3, earlyDays: 2 },
        { id: 'parking', schedule: 'Parking', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = evaluate({
      rules,
      schedules: [rent, parking],
      // Unlinked; account+payee matches BOTH schedules, amount only matches Parking.
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -8000, date: '2026-01-05', schedule: null }],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    const byAlert = Object.fromEntries(evaluations.map((e) => [e.alertId, e]));
    expect(byAlert.parking.state).toBe('received');
    expect(byAlert.rent.state).toBe('missing'); // not stolen as a false wrongAmount
  });

  test("pass 2: a sibling schedule's correctly-amounted late payment is not grabbed by this schedule either", () => {
    const rent = rentSchedule({ id: 'sRent', name: 'Rent', amount: -50000 });
    const parking = rentSchedule({ id: 'sParking', name: 'Parking', amount: -8000 });
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rent', schedule: 'Rent', graceDays: 3, earlyDays: 2 },
        { id: 'parking', schedule: 'Parking', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = evaluate({
      rules,
      schedules: [rent, parking],
      // Late for both (after the shared 8 Jan deadline); amount only matches Parking.
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -8000, date: '2026-01-09', schedule: null }],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    const byAlert = Object.fromEntries(evaluations.map((e) => [e.alertId, e]));
    expect(byAlert.parking.state).toBe('late');
    expect(byAlert.rent.state).toBe('missing'); // not stolen by Rent's pass 2
  });
});

describe('evaluate: R2-M3 (overlap guard accounts for the linked-early window)', () => {
  test('graceDays + LINKED_EARLY_WINDOW_DAYS >= shortest interval trips the guard even when graceDays + earlyDays alone would not', () => {
    const schedule = rentSchedule({ date: { start: '2026-01-05', frequency: 'weekly' } }); // 7-day interval
    const { events, warnings } = evaluate({
      // 5 + 0 = 5 < 7 (old guard would NOT trip); 5 + max(0, 2) = 7 >= 7 (new guard trips).
      rules: rentRule({ graceDays: 5, earlyDays: 0 }),
      schedules: [schedule],
      // Linked, meant for the 12 Jan occurrence (2 days early); without the
      // widened guard this was wrongly claimed by the 5 Jan occurrence instead.
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-10', schedule: 's1' }],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-11',
      timezone: TZ
    });
    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'interval-violation' })]);
    expect(warnings).toHaveLength(1);
  });
});

describe('evaluate: M13 (interval fallback for a one-off/yearly schedule)', () => {
  test('a one-off schedule well outside the old 30-day-derived window still fires missing under a large graceDays', () => {
    const { evaluations } = evaluate({
      rules: rentRule({ graceDays: 60, earlyDays: 0 }),
      schedules: [rentSchedule({ date: '2026-01-21' })],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-04-01') })],
      now: '2026-04-01',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('missing');
  });
});

describe('evaluate: M14 (coordinator scenarios a/b/c)', () => {
  function monthlyRentSchedule(overrides = {}) {
    return rentSchedule({ date: { start: '2026-10-05', frequency: 'monthly' }, ...overrides });
  }

  test('(a) a payment on 2 Nov settles the 5 Oct occurrence as late', () => {
    const { evaluations } = evaluate({
      rules: rentRule(),
      schedules: [monthlyRentSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-11-02', schedule: null }],
      accounts: [account({ last_sync: epochMs('2026-11-09') })],
      now: '2026-11-10',
      timezone: TZ
    });
    const oct = evaluations[0].occurrences.find((o) => o.date === '2026-10-05');
    expect(oct).toMatchObject({ state: 'late', receivedDate: '2026-11-02' });
  });

  test('(b) a payment on 3 Nov settles the 5 Nov occurrence while 5 Oct stays missing', () => {
    const { evaluations } = evaluate({
      rules: rentRule(),
      schedules: [monthlyRentSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-11-03', schedule: null }],
      accounts: [account({ last_sync: epochMs('2026-11-09') })],
      now: '2026-11-10',
      timezone: TZ
    });
    const oct = evaluations[0].occurrences.find((o) => o.date === '2026-10-05');
    const nov = evaluations[0].occurrences.find((o) => o.date === '2026-11-05');
    expect(oct).toMatchObject({ state: 'missing' });
    expect(nov).toMatchObject({ state: 'received', receivedDate: '2026-11-03' });
  });

  test('(c) #271 item 3 exact scenario: now 15 Oct, last_sync 12 Oct 08:00 (epoch-ms string), staleAfterDays 3 -> missing, not stale', () => {
    const { events } = evaluate({
      rules: rentRule({ graceDays: 3, earlyDays: 2 }),
      schedules: [rentSchedule({ date: '2026-10-05' })],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-10-12T08:00:00Z') })],
      now: '2026-10-15',
      timezone: TZ
    });
    expect(events).toEqual([expect.objectContaining({ event: 'missing' })]);
  });
});

describe('evaluate: M15 (boundary and timezone mutants)', () => {
  test('a transaction exactly earlyDays before the occurrence is inside the on-time window (inclusive boundary)', () => {
    const { evaluations } = evaluate({
      rules: rentRule({ earlyDays: 2, graceDays: 3 }),
      schedules: [rentSchedule({ date: '2026-01-10' })],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-08', schedule: null }], // exactly earlyDays=2 before
      accounts: [account({ last_sync: epochMs('2026-01-14') })],
      now: '2026-01-14',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('received');
    expect(evaluations[0].occurrences[0]).toMatchObject({ receivedDate: '2026-01-08' });
  });

  test('a transaction exactly on the deadline day is on time (inclusive boundary)', () => {
    const { evaluations } = evaluate({
      rules: rentRule({ earlyDays: 2, graceDays: 3 }),
      schedules: [rentSchedule({ date: '2026-01-05' })], // deadline = Jan 8
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-08', schedule: null }],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('received');
    expect(evaluations[0].occurrences[0].receivedDate).toBe('2026-01-08');
  });

  test('lastSync exactly on the deadline day is not "after" it -> cannotCheck (not-synced), not missing', () => {
    const { events } = evaluate({
      rules: rentRule({ earlyDays: 2, graceDays: 3 }),
      schedules: [rentSchedule({ date: '2026-01-05' })], // deadline = Jan 8
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-08') })], // same day as the deadline
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'not-synced' })]);
  });

  test('the late window of one occurrence does not extend into the next occurrence\'s on-time window', () => {
    // With earlyDays=2, the next occurrence's on-time window starts 2 days
    // before it; a transaction landing exactly on that day must settle the
    // NEXT occurrence only, never count as "late" for the previous one.
    const { evaluations } = evaluate({
      rules: rentRule({ graceDays: 3, earlyDays: 2 }),
      schedules: [rentSchedule({ date: { start: '2026-10-05', frequency: 'monthly' } })],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-11-03', schedule: null }],
      accounts: [account({ last_sync: epochMs('2026-11-09') })],
      now: '2026-11-10',
      timezone: TZ
    });
    const oct = evaluations[0].occurrences.find((o) => o.date === '2026-10-05');
    const nov = evaluations[0].occurrences.find((o) => o.date === '2026-11-05');
    expect(oct.state).not.toBe('late');
    expect(nov).toMatchObject({ state: 'received', receivedDate: '2026-11-03' });
  });

  test('pass 2 does not let one late-window transaction settle two different bindings\' occurrences', () => {
    const scheduleA = rentSchedule({ id: 'sA', name: 'Rent A', date: '2026-01-05' });
    const scheduleB = rentSchedule({ id: 'sB', name: 'Rent B', date: '2026-01-05' }); // same account+payee
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rentA', schedule: 'Rent A', graceDays: 3, earlyDays: 2 },
        { id: 'rentB', schedule: 'Rent B', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = evaluate({
      rules,
      schedules: [scheduleA, scheduleB],
      // Lands after both deadlines (Jan 8), inside the open-ended late window.
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-09', schedule: null }],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    const states = evaluations.map((e) => e.state).sort();
    expect(states).toEqual(['late', 'missing']);
  });

  test('the same instant produces a different "today" (and therefore a different state) in Madrid vs UTC', () => {
    const now = '2026-06-15T23:00:00Z'; // June 15 in UTC, already June 16 in Europe/Madrid (CEST, UTC+2)
    const schedule = rentSchedule({ date: '2026-06-13' }); // deadline = June 15 (graceDays 2)
    const rule = rentRule({ graceDays: 2, earlyDays: 0 });
    const lastSync = epochMs(now);

    const inUtc = evaluate({
      rules: rule, schedules: [schedule], transactions: [],
      accounts: [account({ last_sync: lastSync })], now, timezone: 'UTC'
    });
    const inMadrid = evaluate({
      rules: rule, schedules: [schedule], transactions: [],
      accounts: [account({ last_sync: lastSync })], now, timezone: 'Europe/Madrid'
    });

    expect(inUtc.evaluations[0].state).toBe('upcoming'); // "today" is still June 15, not past the deadline yet
    expect(inMadrid.evaluations[0].state).toBe('missing'); // "today" is already June 16 there, past the deadline
  });

  test('DST fall-back boundary (Europe/Madrid, clocks change 25 Oct 2026) does not distort the staleness day count', () => {
    const { events } = evaluate({
      rules: rentRule({ graceDays: 1, earlyDays: 0 }),
      schedules: [rentSchedule({ date: '2026-10-20' })], // deadline Oct 21
      transactions: [],
      // Exactly 2 calendar days before "now", spanning the Oct 25 fall-back.
      accounts: [account({ last_sync: epochMs('2026-10-24T12:00:00Z') })],
      now: '2026-10-26T12:00:00Z',
      timezone: 'Europe/Madrid'
    });
    // staleAfterDays defaults to 3 on the block (see rentRule); 2 calendar
    // days must not be inflated to 3+ by the DST transition.
    expect(events).toEqual([expect.objectContaining({ event: 'missing' })]);
  });

  test('DST spring-forward boundary (Europe/Madrid, clocks change 29 Mar 2026) does not distort the staleness day count', () => {
    const { events } = evaluate({
      rules: rentRule({ graceDays: 1, earlyDays: 0 }),
      schedules: [rentSchedule({ date: '2026-03-24' })], // deadline Mar 25
      transactions: [],
      // Exactly 2 calendar days before "now", spanning the Mar 29 spring-forward.
      accounts: [account({ last_sync: epochMs('2026-03-28T12:00:00Z') })],
      now: '2026-03-30T12:00:00Z',
      timezone: 'Europe/Madrid'
    });
    expect(events).toEqual([expect.objectContaining({ event: 'missing' })]);
  });

  test('mixed on-time and late occurrences resolve independently in one call', () => {
    const { evaluations } = evaluate({
      rules: rentRule({ graceDays: 3, earlyDays: 2 }),
      schedules: [rentSchedule({ date: { start: '2026-10-05', frequency: 'monthly' } })],
      transactions: [
        { id: 'late-one', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-11-02', schedule: null }, // late for Oct
        { id: 'on-time', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-12-04', schedule: null } // on time for Dec
      ],
      accounts: [account({ last_sync: epochMs('2026-12-06') })],
      now: '2026-12-06',
      timezone: TZ
    });
    const oct = evaluations[0].occurrences.find((o) => o.date === '2026-10-05');
    const dec = evaluations[0].occurrences.find((o) => o.date === '2026-12-05');
    expect(oct).toMatchObject({ state: 'late', receivedDate: '2026-11-02' });
    expect(dec).toMatchObject({ state: 'received', receivedDate: '2026-12-04' });
  });
});
