// The bank connection is too stale to trust: every schedule is cannotCheck (#341).
const { AS_OF_MIN, configuredFor, ev } = require('./_payments');

const EVALS = [
  ev('rent', 'Rent', 'cannotCheck'),
  ev('phone', 'Phone', 'cannotCheck', { deadline: '2026-01-21', nextDate: '2026-01-18' }),
  ev('gym', 'Gym', 'cannotCheck')
];

module.exports = {
  servers: [{ name: 'Main', ...configuredFor(EVALS) }],
  seed(s) {
    s.payments('Main', EVALS, {}, AS_OF_MIN);
  }
};
