// Every schedule ok: nothing needs attention (#341).
const { AS_OF_MIN, CONFIGURED, ev } = require('./_payments');

module.exports = {
  servers: [{ name: 'Main', ...CONFIGURED }],
  seed(s) {
    s.payments('Main', [
      ev('rent', 'Rent', 'received'),
      ev('phone', 'Phone', 'upcoming', { deadline: '2026-01-21', nextDate: '2026-01-18' }),
      ev('gym', 'Gym', 'received')
    ], {}, AS_OF_MIN);
  }
};
