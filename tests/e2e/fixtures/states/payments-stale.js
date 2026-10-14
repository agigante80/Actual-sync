// The bank connection is too stale to trust: every schedule is cannotCheck (#341).
const { AS_OF_MIN, CONFIGURED, ev } = require('./_payments');

module.exports = {
  servers: [{ name: 'Main', ...CONFIGURED }],
  seed(s) {
    s.payments('Main', [
      ev('rent', 'Rent', 'cannotCheck'),
      ev('phone', 'Phone', 'cannotCheck', { deadline: '2026-01-21', nextDate: '2026-01-18' }),
      ev('gym', 'Gym', 'cannotCheck')
    ], {}, AS_OF_MIN);
  }
};
