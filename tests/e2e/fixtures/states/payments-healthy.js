// Every schedule ok: nothing needs attention (#341).
const { AS_OF_MIN, configuredFor, ev } = require('./_payments');

const EVALS = [
  ev('rent', 'Rent', 'received'),
  ev('phone', 'Phone', 'upcoming', { deadline: '2026-01-21', nextDate: '2026-01-18' }),
  ev('gym', 'Gym', 'received')
];

module.exports = {
  servers: [{ name: 'Main', ...configuredFor(EVALS) }],
  seed(s) {
    s.payments('Main', EVALS, {}, AS_OF_MIN);
  }
};
