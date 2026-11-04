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

const { evaluate: evaluateWithDates, MAX_OCCURRENCES } = require('../lib/scheduleAlerts');
const { actualScheduleDates } = require('./helpers/actualScheduleDates');
const { getRules } = require('../lib/scheduleAlertRules');

const TZ = 'UTC';

/**
 * #298: evaluate() with each schedule's dates expanded by Actual itself
 * (`getScheduleDates`), as the sync step does. A test that passes its own
 * `occurrencesBySchedule` keeps it.
 */
async function evaluate(args) {
  if (Object.prototype.hasOwnProperty.call(args, 'occurrencesBySchedule')) return evaluateWithDates(args);
  const occurrencesBySchedule = await actualScheduleDates(args.schedules, args.now, args.timezone);
  return evaluateWithDates({ ...args, occurrencesBySchedule });
}

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
  test('no transaction, synced past the deadline and not stale -> missing', async () => {
    const { events, evaluations, warnings } = await evaluate({
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

  test('#296: an account never bank-synced (last_sync null) gives cannotCheck, never missing', async () => {
    const { events } = await evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: null })],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'stale', lastSync: null })]);
  });

  test('stale bank connection (last_sync more than staleAfterDays ago) -> cannotCheck, reason stale', async () => {
    const { events } = await evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-05') })], // 5 days before "now"
      now: '2026-01-10',
      timezone: TZ
    });

    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'stale', lastSync: '2026-01-05' })]);
  });

  test('#271 item 3: staleness boundary is strict (> not >=)', async () => {
    // staleAfterDays = 3. Exactly 3 days since last_sync must NOT be stale.
    const exactlyThree = await evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-07') })], // today - 3 days, but before deadline -> not-synced
      now: '2026-01-10',
      timezone: TZ
    });
    expect(exactlyThree.events[0]).toMatchObject({ event: 'cannotCheck', reason: 'not-synced' });

    const fourDays = await evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-06') })], // today - 4 days -> stale
      now: '2026-01-10',
      timezone: TZ
    });
    expect(fourDays.events[0]).toMatchObject({ event: 'cannotCheck', reason: 'stale' });
  });

  test('synced, but not yet past the deadline -> cannotCheck, reason not-synced', async () => {
    const { events } = await evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-07') })], // before deadline (Jan 8), not stale
      now: '2026-01-10',
      timezone: TZ
    });

    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'not-synced' })]);
  });

  test('occurrence not yet due (today within the grace period) -> no event, state upcoming', async () => {
    const { events, evaluations } = await evaluate({
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

  test('a future occurrence -> upcoming, no event', async () => {
    const { events, evaluations } = await evaluate({
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
  test('exact-amount transaction inside the on-time window -> received, no event', async () => {
    const { events, evaluations } = await evaluate({
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

  test('#271 item 2: with no next occurrence, the late window is open through "today"', async () => {
    // Deadline is Jan 8; the transaction lands well after it but the late
    // window has no next occurrence to be capped by, so it extends to "now".
    const { events, evaluations } = await evaluate({
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

  test('#296: an outgoing refund of the same size is not the incoming payment (sign must match)', async () => {
    const run = (amount) => evaluate({
      rules: rentRule({ amountTolerancePct: 0 }),
      schedules: [rentSchedule({ amount: 6000 })],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount, date: '2026-01-05', schedule: null }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect((await run(6000)).evaluations[0].state).toBe('received');
    expect((await run(-6000)).evaluations[0].state).toBe('missing');
    expect((await run(-6000)).events.map((e) => e.event)).not.toContain('resolved');
  });

  describe('#296 round 1 M1: the sign check holds in every fallback pass', () => {
    const run = (transactions) => evaluate({
      rules: rentRule({ amountTolerancePct: 0 }),
      schedules: [rentSchedule({ amount: 6000, amountOp: 'is', date: '2026-01-05' })],
      transactions,
      accounts: [account({ last_sync: epochMs('2026-01-14') })],
      now: '2026-01-14',
      timezone: TZ
    });
    const tx = (id, amount, date, schedule = null) => ({ id, account: 'acc1', payee: 'pay1', amount, date, schedule });

    test('(a) only an opposite-sign transaction in the late window -> missing', async () => {
      const { events, evaluations } = await run([tx('t1', -6000, '2026-01-10')]);
      expect(evaluations[0].state).toBe('missing');
      expect(events.map((e) => e.event)).toContain('missing');
    });

    test('(b) opposite sign in the on-time window plus a right-sign payment later -> late', async () => {
      const { evaluations } = await run([tx('t1', -6000, '2026-01-04'), tx('t2', 6000, '2026-01-10')]);
      expect(evaluations[0].state).toBe('late');
    });

    test('(c) a LINKED opposite-sign transaction stays authoritative (Actual\'s link wins)', async () => {
      const { evaluations } = await run([tx('t1', -6000, '2026-01-10', 's1')]);
      expect(evaluations[0].state).toBe('late');
    });
  });

  test('a transaction linked via transaction.schedule counts regardless of amount', async () => {
    const { evaluations } = await evaluate({
      rules: rentRule(),
      schedules: [rentSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -1, date: '2026-01-05', schedule: 's1' }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('received');
  });

  test('an unlinked transaction with the wrong amount -> wrongAmount event with the correct difference', async () => {
    const { events } = await evaluate({
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

  test('isapprox amount tolerance defaults to 7.5% and is inclusive at the boundary', async () => {
    const schedule = rentSchedule({ amountOp: 'isapprox' });
    const atBoundary = await evaluate({
      rules: rentRule(),
      schedules: [schedule],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -46250, date: '2026-01-05', schedule: null }], // exactly 7.5% under
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(atBoundary.evaluations[0].state).toBe('received');

    const beyondBoundary = await evaluate({
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
  test('a rule matching no schedule -> ruleUnmatched event, no evaluation entry', async () => {
    const { events, evaluations } = await evaluate({
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

  test('a schedulePrefix rule expands into one independent evaluation per matching schedule', async () => {
    const schedules = [
      rentSchedule({ id: 's1', name: 'Utilities - Gas', account: 'acc1', payee: 'pay1' }),
      rentSchedule({ id: 's2', name: 'Utilities - Electric', account: 'acc1', payee: 'pay2' })
    ];
    const { events, evaluations } = await evaluate({
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
  test('graceDays + earlyDays >= the shortest interval -> the rule is skipped with a warning and a cannotCheck event', async () => {
    const weeklySchedule = rentSchedule({
      date: { start: '2026-01-05', frequency: 'weekly' } // 7-day interval
    });
    const { events, evaluations, warnings } = await evaluate({
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

  test('graceDays + earlyDays strictly less than the interval -> no warning', async () => {
    const weeklySchedule = rentSchedule({ date: { start: '2026-01-05', frequency: 'weekly' } });
    const { warnings } = await evaluate({
      rules: rentRule({ graceDays: 2, earlyDays: 2 }), // 4 < 7
      schedules: [weeklySchedule],
      transactions: [],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(warnings).toEqual([]);
  });

  test('graceDays + earlyDays exactly equal to the shortest interval also trips the guard (boundary is >=, not >)', async () => {
    const weeklySchedule = rentSchedule({ date: { start: '2026-01-05', frequency: 'weekly' } }); // 7-day interval
    const { events, warnings } = await evaluate({
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
  test('each occurrence carries date, deadline, state, receivedDate and receivedAmount', async () => {
    const { evaluations } = await evaluate({
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

  test('occurrences is capped at MAX_OCCURRENCES, keeping the most recent', async () => {
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
    const { evaluations } = await evaluate({
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
  test('an on_date endMode schedule does not throw and its cadenceText uses a valid date-fns format', async () => {
    const schedule = rentSchedule({
      date: { start: '2026-01-05', frequency: 'monthly', endMode: 'on_date', endDate: '2026-06-01' }
    });
    const { evaluations, warnings } = await evaluate({
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

  test('a schedule that throws during evaluation does not block other rules', async () => {
    const goodSchedule = rentSchedule({ id: 's1', name: 'Rent' });
    const badSchedule = rentSchedule({ id: 's2', name: 'Broken', date: { start: '2026-01-05', frequency: 'bogus' } });
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rent', schedule: 'Rent', graceDays: 3, earlyDays: 2 },
        { id: 'broken', schedule: 'Broken', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { events, evaluations, warnings } = await evaluate({
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
  test('an occurrence strictly before schedule.next_date is treated as skipped, not missing', async () => {
    const schedule = rentSchedule({ next_date: '2026-01-06' }); // occurrence Jan 5 was skipped in Actual
    const { events, evaluations } = await evaluate({
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

  test('without next_date, the same occurrence is still reported missing as before', async () => {
    const schedule = rentSchedule();
    const { events, evaluations } = await evaluate({
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
  test('a later occurrence being linked (advancing next_date) does not hide an earlier genuinely missed occurrence', async () => {
    // Monthly on the 1st: January was never paid; a February payment posted
    // and linked to the schedule, so Actual advanced next_date to 1 March -
    // NOT because January was explicitly skipped.
    const schedule = rentSchedule({
      date: { start: '2026-01-01', frequency: 'monthly' },
      next_date: '2026-03-01'
    });
    const { evaluations } = await evaluate({
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

  test('next_date advancing with no intervening linked payment at all is still a genuine skip', async () => {
    const schedule = rentSchedule({
      date: { start: '2026-01-01', frequency: 'monthly' },
      next_date: '2026-02-01' // Actual's own "Skip next date" on January, no transaction involved
    });
    const { evaluations } = await evaluate({
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

describe('evaluate: #297 F1 (remember the skip decision)', () => {
  const monthly = (nextDate) => rentSchedule({ date: { start: '2026-01-01', frequency: 'monthly' }, next_date: nextDate });

  test('a skip inferred for the first time is reported as a skipDecision so the caller can persist it', async () => {
    const { evaluations, skipDecisions, events } = await evaluate({
      rules: rentRule(),
      schedules: [monthly('2026-02-01')],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-20') })],
      now: '2026-01-25',
      timezone: TZ
    });
    expect(evaluations[0].occurrences.find((o) => o.date === '2026-01-01').state).toBe('skipped');
    expect(events).toEqual([]);
    expect(skipDecisions).toEqual([{ alertId: 'rent', scheduleId: 's1', occurrence: '2026-01-01' }]);
  });

  test('January skipped, February paid and linked: with the remembered skip, January stays skipped (no false missing)', async () => {
    // next_date is now 2026-03-01 and the February payment sits between January's deadline
    // and next_date - indistinguishable from a real miss without the remembered decision.
    const { evaluations, events, skipDecisions } = await evaluate({
      rules: rentRule(),
      schedules: [monthly('2026-03-01')],
      transactions: [{ id: 'feb', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-02-01', schedule: 's1' }],
      accounts: [account({ last_sync: epochMs('2026-02-09') })],
      skips: ['s1|2026-01-01'],
      now: '2026-02-10',
      timezone: TZ
    });
    expect(evaluations[0].occurrences.find((o) => o.date === '2026-01-01').state).toBe('skipped');
    expect(events).toEqual([]);
    expect(skipDecisions).toEqual([]); // already remembered, nothing new to persist
  });

  test('a remembered skip is scoped to its schedule and occurrence', async () => {
    const { evaluations } = await evaluate({
      rules: rentRule(),
      schedules: [monthly('2026-03-01')],
      transactions: [{ id: 'feb', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-02-01', schedule: 's1' }],
      accounts: [account({ last_sync: epochMs('2026-02-09') })],
      skips: ['other|2026-01-01', 's1|2025-12-01'],
      now: '2026-02-10',
      timezone: TZ
    });
    expect(evaluations[0].occurrences.find((o) => o.date === '2026-01-01').state).toBe('missing');
  });

  test('an intervening linked payment with no remembered skip is not recorded as a skip decision', async () => {
    const { skipDecisions } = await evaluate({
      rules: rentRule(),
      schedules: [monthly('2026-03-01')],
      transactions: [{ id: 'feb', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-02-01', schedule: 's1' }],
      accounts: [account({ last_sync: epochMs('2026-02-09') })],
      now: '2026-02-10',
      timezone: TZ
    });
    expect(skipDecisions).toEqual([]);
  });

  test('a remembered skip never hides an occurrence that a payment actually settled', async () => {
    const { evaluations } = await evaluate({
      rules: rentRule(),
      schedules: [monthly('2026-02-01')],
      transactions: [{ id: 'jan', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-01', schedule: 's1' }],
      accounts: [account({ last_sync: epochMs('2026-01-20') })],
      skips: ['s1|2026-01-01'],
      now: '2026-01-25',
      timezone: TZ
    });
    expect(evaluations[0].occurrences.find((o) => o.date === '2026-01-01').state).toBe('received');
  });
});

describe('evaluate: #297 F2 / F2b (linked payments take precedence over unlinked lookalikes)', () => {
  function sibling(id, name) {
    return rentSchedule({ id, name });
  }
  function twoRules() {
    return getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'a', schedule: 'Alpha', graceDays: 3, earlyDays: 0 },
        { id: 'b', schedule: 'Beta', graceDays: 3, earlyDays: 0 }
      ]
    });
  }

  test('F2: an unlinked exact-amount payment does not beat a payment linked to the schedule', async () => {
    // A and B share account+payee and amount. tA (-51000) is linked to A on 01-03 (inside Actual's
    // 2-day link tolerance, outside earlyDays 0); tB (-50000) is unlinked on 01-05.
    const { events, evaluations } = await evaluate({
      rules: twoRules(),
      schedules: [sibling('sA', 'Alpha'), sibling('sB', 'Beta')],
      transactions: [
        { id: 'tA', account: 'acc1', payee: 'pay1', amount: -51000, date: '2026-01-03', schedule: 'sA' },
        { id: 'tB', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: null }
      ],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events.filter((e) => e.event === 'missing')).toEqual([]);
    expect(evaluations.find((e) => e.alertId === 'a').occurrences[0].receivedDate).toBe('2026-01-03');
    expect(evaluations.find((e) => e.alertId === 'b').occurrences[0].receivedDate).toBe('2026-01-05');
  });

  test('F2b: pass 2 prefers a payment linked to the schedule over an earlier unlinked lookalike', async () => {
    // A due 01-05, B due 01-10. tB (unlinked) lands 01-10; tA (linked to A) lands 01-11, late for A.
    const { events, evaluations } = await evaluate({
      rules: twoRules(),
      schedules: [sibling('sA', 'Alpha'), rentSchedule({ id: 'sB', name: 'Beta', date: '2026-01-10' })],
      transactions: [
        { id: 'tB', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-10', schedule: null },
        { id: 'tA', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-11', schedule: 'sA' }
      ],
      accounts: [account({ last_sync: epochMs('2026-01-12') })],
      now: '2026-01-12',
      timezone: TZ
    });
    expect(events.filter((e) => e.event === 'missing')).toEqual([]);
    expect(evaluations.find((e) => e.alertId === 'a').occurrences[0]).toMatchObject({ state: 'late', receivedDate: '2026-01-11' });
    expect(evaluations.find((e) => e.alertId === 'b').occurrences[0]).toMatchObject({ state: 'received', receivedDate: '2026-01-10' });
  });
});

describe('evaluate: #297 round 1 M1 (the linked allowance does not steal an in-window exact-amount payment)', () => {
  test('a late linked January payment dated 01-31 does not beat February\'s own unlinked payment on 02-01', async () => {
    // Monthly on the 1st, grace 5, early 0. Jan was paid late on 01-31 (linked by hand, odd amount);
    // Feb was paid on time on 02-01 for the exact amount (unlinked). No sibling rule shares the payee.
    const schedule = rentSchedule({ date: { start: '2026-01-01', frequency: 'monthly' } });
    const { events, evaluations } = await evaluate({
      rules: rentRule({ graceDays: 5, earlyDays: 0 }),
      schedules: [schedule],
      transactions: [
        { id: 'tJan', account: 'acc1', payee: 'pay1', amount: -52500, date: '2026-01-31', schedule: 's1' },
        { id: 'tFeb', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-02-01', schedule: null }
      ],
      accounts: [account({ last_sync: epochMs('2026-02-15') })],
      now: '2026-02-15',
      timezone: TZ
    });
    expect(events.filter((e) => e.event === 'missing')).toEqual([]);
    const byDate = Object.fromEntries(evaluations[0].occurrences.map((o) => [o.date, o]));
    expect(byDate['2026-01-01']).toMatchObject({ state: 'late', receivedDate: '2026-01-31' });
    expect(byDate['2026-02-01']).toMatchObject({ state: 'received', receivedDate: '2026-02-01' });
  });
});

describe('evaluate: R2-M4 (next_date boundary)', () => {
  test('next_date equal to the unpaid occurrence date is not "before" it -> missing, not skipped', async () => {
    const schedule = rentSchedule({ next_date: '2026-01-05' }); // equal to the occurrence date itself
    const { evaluations } = await evaluate({
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

  test('an amount within the isbetween range -> received, not wrongAmount', async () => {
    const { evaluations } = await evaluate({
      rules: rentRule({ amountTolerancePct: 0 }),
      schedules: [isbetweenSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: null }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('received');
  });

  test('an amount outside the isbetween range -> wrongAmount', async () => {
    const { evaluations } = await evaluate({
      rules: rentRule({ amountTolerancePct: 0 }),
      schedules: [isbetweenSchedule()],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -30000, date: '2026-01-05', schedule: null }],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(evaluations[0].state).toBe('wrongAmount');
  });

  test('the range bounds are order-independent (num1 may be the larger or smaller bound)', async () => {
    const { evaluations } = await evaluate({
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
  test('within one on-time window, a within-tolerance candidate is preferred over an earlier wrong-amount one', async () => {
    const { evaluations } = await evaluate({
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

  test('a transaction linked to a different schedule is not also claimed via account+payee matching', async () => {
    const scheduleA = rentSchedule({ id: 'sA', name: 'Rent A' });
    const scheduleB = rentSchedule({ id: 'sB', name: 'Rent B' }); // same account+payee as A
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rentA', schedule: 'Rent A', graceDays: 3, earlyDays: 2 },
        { id: 'rentB', schedule: 'Rent B', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = await evaluate({
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

  test('an unlinked transaction shared by two schedules with the same account+payee settles only one of them', async () => {
    const scheduleA = rentSchedule({ id: 'sA', name: 'Rent A' });
    const scheduleB = rentSchedule({ id: 'sB', name: 'Rent B' }); // same account+payee as A
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rentA', schedule: 'Rent A', graceDays: 3, earlyDays: 2 },
        { id: 'rentB', schedule: 'Rent B', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = await evaluate({
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
  test('a transaction linked 2 days early counts as received even when earlyDays is 0', async () => {
    const { evaluations } = await evaluate({
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

  test('an unlinked transaction 2 days early is still excluded when earlyDays is 0 (the widened window is link-specific)', async () => {
    const { evaluations } = await evaluate({
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
  test('a linked payment settles every rule bound to the same schedule, not just the first', async () => {
    const schedule = rentSchedule(); // name 'Rent', id 's1'
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rentExact', schedule: 'Rent', graceDays: 3, earlyDays: 2 },
        { id: 'rentPrefix', schedulePrefix: 'Re', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = await evaluate({
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
  test("pass 1: an unlinked payment correctly amounted for a sibling schedule is not grabbed by this schedule's wrong-amount fallback", async () => {
    const rent = rentSchedule({ id: 'sRent', name: 'Rent', amount: -50000 });
    const parking = rentSchedule({ id: 'sParking', name: 'Parking', amount: -8000 });
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rent', schedule: 'Rent', graceDays: 3, earlyDays: 2 },
        { id: 'parking', schedule: 'Parking', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = await evaluate({
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

  test("pass 2: a sibling schedule's correctly-amounted late payment is not grabbed by this schedule either", async () => {
    const rent = rentSchedule({ id: 'sRent', name: 'Rent', amount: -50000 });
    const parking = rentSchedule({ id: 'sParking', name: 'Parking', amount: -8000 });
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rent', schedule: 'Rent', graceDays: 3, earlyDays: 2 },
        { id: 'parking', schedule: 'Parking', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = await evaluate({
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

describe('evaluate: R2-M3 / #297 F4 / round 1 M2 (overlap guard and the linked-early window)', () => {
  // R2-M3: the linked +/-2 day allowance counts towards the overlap guard, so a
  // weekly schedule with graceDays 5 (5 + 2 >= 7) is rejected: its on-time window
  // would swallow the next occurrence's early linked payment (#297 round 1, M2).
  // #297 F4: the allowance only applies while the interval is longer than the
  // allowance itself, so a daily schedule (interval 1) is not rejected for good.
  // For such short intervals the linked early start is clamped to the day after
  // the previous occurrence's deadline.
  test('weekly, graceDays 5, earlyDays 0 is an interval violation (cannotCheck + one warning)', async () => {
    const schedule = rentSchedule({ date: { start: '2026-01-05', frequency: 'weekly' } }); // 7-day interval
    const { events, warnings } = await evaluate({
      rules: rentRule({ graceDays: 5, earlyDays: 0 }),
      schedules: [schedule],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-20') })],
      now: '2026-01-21',
      timezone: TZ
    });
    expect(warnings).toHaveLength(1);
    // #297 round 2 L-b: the operator's own earlyDays (0), not the effective 2.
    expect(warnings[0].message).toMatch(/graceDays \(5\) \+ earlyDays \(0, raised to the 2-day linked-payment allowance\) >= /);
    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'interval-violation' })]);
  });

  test('M2 scenario: a missed 01-05 and a linked early 01-10 payment for 01-12 produce no received/skipped and no skip decision', async () => {
    const schedule = rentSchedule({ date: { start: '2026-01-05', frequency: 'weekly' }, next_date: '2026-01-19' });
    const result = await evaluate({
      rules: rentRule({ graceDays: 5, earlyDays: 0 }),
      schedules: [schedule],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-10', schedule: 's1' }],
      accounts: [account({ last_sync: epochMs('2026-01-18') })],
      now: '2026-01-18',
      timezone: TZ
    });
    expect(result.skipDecisions).toEqual([]);
    expect(result.events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'interval-violation' })]);
  });

  test('weekly, graceDays 4, earlyDays 0 is evaluated (4 + 2 < 7)', async () => {
    const schedule = rentSchedule({ date: { start: '2026-01-05', frequency: 'weekly' } });
    const { events, warnings } = await evaluate({
      rules: rentRule({ graceDays: 4, earlyDays: 0 }),
      schedules: [schedule],
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-20') })],
      now: '2026-01-21',
      timezone: TZ
    });
    expect(warnings).toEqual([]);
    expect(events.some((e) => e.reason === 'interval-violation')).toBe(false);
  });

  test('a daily schedule with graceDays 0 and earlyDays 0 is evaluated, not rejected (#297 F4)', async () => {
    const schedule = rentSchedule({ date: { start: '2026-01-01', frequency: 'daily' } });
    const { events, warnings, evaluations } = await evaluate({
      rules: rentRule({ graceDays: 0, earlyDays: 0 }),
      schedules: [schedule],
      transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-09', schedule: 's1' }],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-10',
      timezone: TZ
    });
    expect(warnings).toEqual([]);
    expect(events.some((e) => e.reason === 'interval-violation')).toBe(false);
    expect(evaluations[0].state).not.toBe('cannotCheck');
  });

  test('daily: a second linked payment dated on the previous occurrence is not pulled forward onto the next one (clamp)', async () => {
    const schedule = rentSchedule({ date: { start: '2026-01-01', frequency: 'daily' } });
    const { evaluations } = await evaluate({
      rules: rentRule({ graceDays: 0, earlyDays: 0 }),
      schedules: [schedule],
      transactions: [
        { id: 't0', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-08', schedule: 's1' },
        { id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-08', schedule: 's1' }
      ],
      accounts: [account({ last_sync: epochMs('2026-01-09') })],
      now: '2026-01-09',
      timezone: TZ
    });
    const byDate = Object.fromEntries(evaluations[0].occurrences.map((o) => [o.date, o]));
    expect(byDate['2026-01-08'].state).toBe('received');
    expect(byDate['2026-01-09'].state).not.toBe('received');
  });
});

describe('evaluate: M13 (interval fallback for a one-off/yearly schedule)', () => {
  test('a one-off schedule well outside the old 30-day-derived window still fires missing under a large graceDays', async () => {
    const { evaluations } = await evaluate({
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

  test('(a) a payment on 2 Nov settles the 5 Oct occurrence as late', async () => {
    const { evaluations } = await evaluate({
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

  test('(b) a payment on 3 Nov settles the 5 Nov occurrence while 5 Oct stays missing', async () => {
    const { evaluations } = await evaluate({
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

  test('(c) #271 item 3 exact scenario: now 15 Oct, last_sync 12 Oct 08:00 (epoch-ms string), staleAfterDays 3 -> missing, not stale', async () => {
    const { events } = await evaluate({
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
  test('a transaction exactly earlyDays before the occurrence is inside the on-time window (inclusive boundary)', async () => {
    const { evaluations } = await evaluate({
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

  test('a transaction exactly on the deadline day is on time (inclusive boundary)', async () => {
    const { evaluations } = await evaluate({
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

  test('lastSync exactly on the deadline day is not "after" it -> cannotCheck (not-synced), not missing', async () => {
    const { events } = await evaluate({
      rules: rentRule({ earlyDays: 2, graceDays: 3 }),
      schedules: [rentSchedule({ date: '2026-01-05' })], // deadline = Jan 8
      transactions: [],
      accounts: [account({ last_sync: epochMs('2026-01-08') })], // same day as the deadline
      now: '2026-01-10',
      timezone: TZ
    });
    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'not-synced' })]);
  });

  test('the late window of one occurrence does not extend into the next occurrence\'s on-time window', async () => {
    // With earlyDays=2, the next occurrence's on-time window starts 2 days
    // before it; a transaction landing exactly on that day must settle the
    // NEXT occurrence only, never count as "late" for the previous one.
    const { evaluations } = await evaluate({
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

  test('pass 2 does not let one late-window transaction settle two different bindings\' occurrences', async () => {
    const scheduleA = rentSchedule({ id: 'sA', name: 'Rent A', date: '2026-01-05' });
    const scheduleB = rentSchedule({ id: 'sB', name: 'Rent B', date: '2026-01-05' }); // same account+payee
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rentA', schedule: 'Rent A', graceDays: 3, earlyDays: 2 },
        { id: 'rentB', schedule: 'Rent B', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = await evaluate({
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

  test('the same instant produces a different "today" (and therefore a different state) in Madrid vs UTC', async () => {
    const now = '2026-06-15T23:00:00Z'; // June 15 in UTC, already June 16 in Europe/Madrid (CEST, UTC+2)
    const schedule = rentSchedule({ date: '2026-06-13' }); // deadline = June 15 (graceDays 2)
    const rule = rentRule({ graceDays: 2, earlyDays: 0 });
    const lastSync = epochMs(now);

    const inUtc = await evaluate({
      rules: rule, schedules: [schedule], transactions: [],
      accounts: [account({ last_sync: lastSync })], now, timezone: 'UTC'
    });
    const inMadrid = await evaluate({
      rules: rule, schedules: [schedule], transactions: [],
      accounts: [account({ last_sync: lastSync })], now, timezone: 'Europe/Madrid'
    });

    expect(inUtc.evaluations[0].state).toBe('upcoming'); // "today" is still June 15, not past the deadline yet
    expect(inMadrid.evaluations[0].state).toBe('missing'); // "today" is already June 16 there, past the deadline
  });

  test('DST fall-back boundary (Europe/Madrid, clocks change 25 Oct 2026) does not distort the staleness day count', async () => {
    const { events } = await evaluate({
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

  test('DST spring-forward boundary (Europe/Madrid, clocks change 29 Mar 2026) does not distort the staleness day count', async () => {
    const { events } = await evaluate({
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

  test('mixed on-time and late occurrences resolve independently in one call', async () => {
    const { evaluations } = await evaluate({
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

describe('#296 round 2 L1: sign check inside the tolerance comparison', () => {
  test('an opposite-sign amount of the same size is not a better match for a sibling schedule', async () => {
    const tx = { id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: null };
    const rules = getRules({
      staleAfterDays: 3,
      alerts: [
        { id: 'rent', schedule: 'Rent', graceDays: 3, earlyDays: 2 },
        { id: 'dep', schedule: 'Deposit', graceDays: 3, earlyDays: 2 }
      ]
    });
    const { evaluations } = await evaluate({
      rules,
      schedules: [
        rentSchedule({ amount: -40000 }),
        rentSchedule({ id: 's2', name: 'Deposit', amount: 50000 })
      ],
      transactions: [tx],
      accounts: [account()],
      now: '2026-01-10',
      timezone: TZ
    });
    // Without the sign check in amountWithinTolerance, the Deposit's +50000
    // "fits" the -50000 payment and Rent becomes missing via betterMatchedElsewhere.
    expect(evaluations.find((e) => e.name === 'Rent').state).toBe('wrongAmount');
  });
});

describe('#296 round 2: sign compatibility edge cases', () => {
  const tx = (id, amount, date, schedule = null) => ({ id, account: 'acc1', payee: 'pay1', amount, date, schedule });
  const run = (scheduleOverrides, transactions, now, ruleOverrides = {}) => evaluate({
    rules: rentRule(ruleOverrides),
    schedules: [rentSchedule(scheduleOverrides)],
    transactions,
    accounts: [account({ last_sync: epochMs(now) })],
    now,
    timezone: TZ
  });

  test('M1: a zero-amount schedule still reports wrongAmount for a non-zero unlinked payment', async () => {
    for (const amountOp of ['is', 'isapprox']) {
      const { evaluations } = await run({ amount: 0, amountOp, date: '2026-01-05' }, [tx('t1', -1234, '2026-01-05')], '2026-01-10');
      expect(evaluations[0].state).toBe('wrongAmount');
    }
  });

  test('M2: a range of negative bounds ignores an unlinked positive refund (day 10 and day 5)', async () => {
    const range = { amountOp: 'isbetween', amount: { num1: -5000, num2: -7000 }, date: '2026-01-05' };
    expect((await run(range, [tx('t1', 6000, '2026-01-10')], '2026-01-14')).evaluations[0].state).toBe('missing');
    expect((await run(range, [tx('t1', 6000, '2026-01-05')], '2026-01-10')).evaluations[0].state).toBe('missing');
  });

  test('M2: a range spanning zero still matches a positive amount inside it', async () => {
    const range = { amountOp: 'isbetween', amount: { num1: -5000, num2: 5000 }, date: '2026-01-05' };
    expect((await run(range, [tx('t1', 3000, '2026-01-05')], '2026-01-10')).evaluations[0].state).toBe('received');
  });
});

describe('#298: occurrence dates come from Actual (getScheduleDates)', () => {
  const run = (scheduleOverrides, extra = {}) => evaluate({
    rules: rentRule(),
    schedules: [rentSchedule(scheduleOverrides)],
    transactions: [],
    accounts: [account({ last_sync: epochMs('2026-01-14') })],
    now: '2026-01-14',
    timezone: TZ,
    ...extra
  });

  test('skipWeekend "after" moves a Saturday occurrence to Monday, as Actual shows it', async () => {
    // 2026-01-10 is a Saturday.
    const { evaluations } = await run({
      date: { start: '2026-01-10', frequency: 'monthly', interval: 1, endMode: 'never', skipWeekend: true, weekendSolveMode: 'after' }
    });
    expect(evaluations[0].occurrences.map((o) => o.date)).toContain('2026-01-12');
    expect(evaluations[0].occurrences.map((o) => o.date)).not.toContain('2026-01-10');
  });

  test('skipWeekend without weekendSolveMode is cannotCheck (error), even on a weekday', async () => {
    // Actual rejects the whole config, so the schedule can never be checked.
    const { events, evaluations, warnings } = await run({
      date: { start: '2026-01-05', frequency: 'monthly', interval: 1, endMode: 'never', skipWeekend: true }
    });
    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', alertId: 'rent', reason: 'error' })]);
    expect(evaluations).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test('no dates read for a bound schedule is cannotCheck (error), never missing', async () => {
    const { events } = await run({}, { occurrencesBySchedule: {} });
    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'error' })]);
  });

  test('a failed read (stored Error) is cannotCheck (error); the warning carries the error, never its text or the schedule name (#450)', async () => {
    const boom = new Error('Cannot expand schedule date: boom');
    const { events, warnings } = await run({}, { occurrencesBySchedule: { s1: boom } });
    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'error' })]);
    // The message is logged as is, so it is fixed text; the rule id is a field.
    expect(warnings[0].message).toBe('Schedule alert rule threw during evaluation and was skipped');
    expect(warnings[0].message).not.toContain('Rent');
    expect(warnings[0].error).toBe(boom);
  });

  test('an invalid date string from Actual is cannotCheck (error)', async () => {
    const { events } = await run({}, { occurrencesBySchedule: { s1: ['2026-02-30'] } });
    expect(events).toEqual([expect.objectContaining({ event: 'cannotCheck', reason: 'error' })]);
  });

  test('duplicate and out-of-order dates are deduped and sorted', async () => {
    const { evaluations } = await run({}, { occurrencesBySchedule: { s1: ['2026-01-05', '2025-12-05', '2026-01-05'] } });
    expect(evaluations[0].occurrences.map((o) => o.date)).toEqual(['2025-12-05', '2026-01-05']);
  });
});

describe('#298: occurrenceWindow', () => {
  const { occurrenceWindow, OCCURRENCE_WINDOW_BEFORE_DAYS, OCCURRENCE_WINDOW_AFTER_DAYS } = require('../lib/scheduleAlerts');

  test('covers today - BEFORE to today + AFTER in the server timezone', () => {
    expect(OCCURRENCE_WINDOW_AFTER_DAYS).toBe(2 * OCCURRENCE_WINDOW_BEFORE_DAYS);
    const { start, end } = occurrenceWindow('2026-01-14T23:30:00Z', 'Europe/Madrid'); // already the 15th in Madrid
    expect(start).toBe(require('moment-timezone').tz('2026-01-15', 'Europe/Madrid').subtract(OCCURRENCE_WINDOW_BEFORE_DAYS, 'days').format('YYYY-MM-DD'));
    expect(end).toBe(require('moment-timezone').tz('2026-01-15', 'Europe/Madrid').add(OCCURRENCE_WINDOW_AFTER_DAYS, 'days').format('YYYY-MM-DD'));
  });
});
