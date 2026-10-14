/**
 * Building blocks for the payment alert editor states (#268). Not a state itself.
 * All names are invented; nothing here is personal data.
 */
const authBasic = require('./auth-basic');
const { AS_OF_MIN, ev } = require('./_payments');

const sched = (id, name, over = {}) => ({
  id, name, cadenceText: 'Every month on the 5th', amount: 6000, amountMin: null, amountMax: null, amountOp: 'is',
  account: 'Main', payee: 'Tenant A', nextDate: '2026-02-05', completed: false, ...over
});

/**
 * Seven snapshot schedules: two Rent parking spots, two schedules both called
 * Gym (so the picker must tell them apart), an approximate monthly bill whose
 * deadline falls in the next month, a completed one-off and a weekly one.
 */
const SCHEDULES = [
  sched('sched-parking-a', 'Rent - Parking A'),
  sched('sched-parking-b', 'Rent - Parking B', { amount: 6500, payee: 'Tenant B' }),
  sched('sched-gym-aaa111', 'Gym', {
    cadenceText: 'Every month on the 1st', amount: null, amountMin: -3000, amountMax: -2000, amountOp: 'isbetween',
    account: null, payee: 'Fit Club', nextDate: '2026-02-01'
  }),
  sched('sched-gym-bbb222', 'Gym', { cadenceText: 'Every month on the 1st', amount: -2500, payee: 'Fit Club', nextDate: '2026-02-01' }),
  sched('sched-power', 'Electricity', {
    cadenceText: 'Every month on the 28th', amount: -5000, amountOp: 'isapprox', payee: 'Power Co', nextDate: '2026-01-28'
  }),
  sched('sched-old', 'Old Plan', { cadenceText: 'Once on 2025-11-01', amount: 1000, payee: 'Old Co', nextDate: '2025-11-01', completed: true }),
  sched('sched-cleaner', 'Weekly Cleaner', { cadenceText: 'Every week on Monday', amount: -4000, payee: 'Cleaner', nextDate: '2026-01-19' })
];

const WEBHOOKS = { discord: [{ url: 'https://discord.invalid/fixture' }], slack: [{ url: 'https://slack.invalid/fixture' }] };

/** Basic auth, config writes on, two channels, a captured snapshot and one run. */
function base(overrides = {}) {
  const { alerts = [], block = {}, rules = [], evaluations = [], seed } = overrides;
  return {
    ...authBasic,
    allowConfigWrites: true,
    webhooks: WEBHOOKS,
    servers: [{ name: 'Main', scheduleAlerts: { ...block, alerts } }],
    seed(s) {
      s.sync('Main', 20, { succeeded: 3 });
      s.scheduleSnapshot('Main', SCHEDULES, 60);
      if (evaluations.length) s.payments('Main', evaluations, {}, AS_OF_MIN);
      rules.forEach(([definition, minutesAgo]) => s.dashboardRule('Main', definition, minutesAgo));
      if (seed) seed(s);
    }
  };
}

module.exports = { SCHEDULES, WEBHOOKS, base, ev, sched, AS_OF_MIN };
