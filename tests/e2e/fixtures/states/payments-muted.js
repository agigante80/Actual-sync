// Payments with parking-a muted until 2026-01-20 and a reason (#261). Also the
// screenshot state for dashboard-payments-muted.png.
const base = require('./payments-writes-enabled');

module.exports = {
  ...base,
  seed(s) {
    base.seed(s);
    s.override({
      server: 'Main', alertId: 'parking-a', mutedFrom: '2026-01-14T09:00:00.000Z',
      mutedUntil: '2026-01-20', reason: 'Tenant is on holiday, paying late'
    }, 1500);
  }
};
