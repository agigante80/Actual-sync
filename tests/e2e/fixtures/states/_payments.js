/**
 * Building blocks for the Payments tab states (#341). Not a state itself.
 * All names are invented; nothing here is personal data.
 *
 * Minutes before FIXTURE_NOW (2026-01-15 12:00 UTC) for the times the specs
 * assert against, so a state and its spec agree on one set of numbers:
 *   AS_OF_MIN      2026-01-14 08:01:00  (a successful evaluation)
 *   FAILED_AT_MIN  2026-01-15 08:01:00  (a failed one)
 *   ALERT_MIN      2026-01-12 08:01:00  (the last alert sent)
 */
const AS_OF_MIN = 1679;
const FAILED_AT_MIN = 239;
const ALERT_MIN = 4559;

const CONFIGURED = { scheduleAlerts: {} };

/**
 * One evaluation as evaluate().evaluations returns it.
 * @param {string} id - alertId (and the base of the scheduleId)
 * @param {string} name
 * @param {string} state
 * @param {Object} [o] - overrides (expectedAmount, nextDate, deadline, occurrences, account, ...)
 */
function ev(id, name, state, o = {}) {
  return {
    alertId: id,
    scheduleId: `sched-${id}`,
    name,
    cadenceText: 'Every month on the 5th',
    account: 'Main',
    payee: 'Tenant',
    expectedAmount: 6000,
    nextDate: '2026-02-05',
    deadline: '2026-01-11',
    state,
    occurrences: o.occurrences || occurrences(state),
    ...o
  };
}

/** Six occurrences, newest first, ending in the given state. */
function occurrences(state) {
  const rows = [
    { date: '2025-12-05', deadline: '2025-12-11', state: 'received', receivedDate: '2025-12-05', receivedAmount: 6000 },
    { date: '2025-11-05', deadline: '2025-11-11', state: 'received', receivedDate: '2025-11-06', receivedAmount: 6000 },
    { date: '2025-10-05', deadline: '2025-10-11', state: 'late', receivedDate: '2025-10-14', receivedAmount: 6000 },
    { date: '2025-09-05', deadline: '2025-09-11', state: 'received', receivedDate: '2025-09-05', receivedAmount: 6000 },
    { date: '2025-08-05', deadline: '2025-08-11', state: 'received', receivedDate: '2025-08-05', receivedAmount: 6000 }
  ];
  const newest = {
    date: '2026-01-05', deadline: '2026-01-11', state, receivedDate: null, receivedAmount: null
  };
  if (state === 'received') { newest.receivedDate = '2026-01-05'; newest.receivedAmount = 6000; }
  if (state === 'late') { newest.receivedDate = '2026-01-14'; newest.receivedAmount = 6000; }
  if (state === 'wrongAmount') { newest.receivedDate = '2026-01-05'; newest.receivedAmount = 5500; }
  return [newest, ...rows];
}

/** Twelve schedules, two needing attention (one missing, one wrongAmount). */
function attentionEvaluations() {
  return [
    ev('parking-a', 'Rent - Parking', 'missing'),
    ev('salary', 'Salary', 'wrongAmount', {
      cadenceText: 'Every month on the last day', payee: 'Employer', expectedAmount: 250000,
      nextDate: '2026-01-31', deadline: '2026-02-03'
    }),
    ev('power', 'Electricity', 'received', {
      cadenceText: 'Every month on the 20th', payee: 'Power Co', expectedAmount: { num1: 5000, num2: 7000 },
      nextDate: '2026-02-20', deadline: '2026-02-25'
    }),
    ev('streaming', 'Streaming', 'skipped', {
      cadenceText: 'Every month on the 9th', payee: 'Stream Inc', expectedAmount: 1299,
      nextDate: '2026-02-09', deadline: '2026-02-12'
    }),
    ev('internet', 'Internet', 'late', {
      cadenceText: 'Every month on the 2nd', payee: 'Net Co', expectedAmount: 3990,
      nextDate: '2026-02-02', deadline: '2026-01-05'
    }),
    ev('water', 'Water', 'upcoming', {
      cadenceText: 'Every 3 months on the 15th', payee: 'Water Co', expectedAmount: 4550,
      nextDate: '2026-01-20', deadline: '2026-01-25'
    }),
    ev('gym', 'Gym', 'received', { cadenceText: 'Every month on the 1st', payee: 'Gym Ltd', expectedAmount: 2900, nextDate: '2026-02-01', deadline: '2026-01-04' }),
    ev('insurance', 'Insurance', 'received', { cadenceText: 'Every year on 3 March', payee: 'Insure Co', expectedAmount: 48000, nextDate: '2026-03-03', deadline: '2026-03-06' }),
    ev('phone', 'Phone', 'upcoming', { cadenceText: 'Every month on the 18th', payee: 'Phone Co', expectedAmount: 1500, nextDate: '2026-01-18', deadline: '2026-01-21' }),
    ev('storage', 'Storage Unit', 'received', { cadenceText: 'Every month on the 12th', payee: 'Store Co', expectedAmount: 6500, nextDate: '2026-02-12', deadline: '2026-02-15' }),
    ev('school', 'School Fees', 'received', { cadenceText: 'Every 2 weeks on Friday', payee: 'School', expectedAmount: null, nextDate: '2026-01-23', deadline: '2026-01-26' }),
    ev('garden', 'Gardener', 'upcoming', { cadenceText: 'Every week on Monday', payee: 'Gardener', expectedAmount: 4000, nextDate: '2026-01-19', deadline: '2026-01-22' })
  ];
}

module.exports = { AS_OF_MIN, FAILED_AT_MIN, ALERT_MIN, CONFIGURED, ev, occurrences, attentionEvaluations };
