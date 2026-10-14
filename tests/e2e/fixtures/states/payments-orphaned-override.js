// Overrides whose alert (or whole server) is no longer in the configuration (#261).
const base = require('./payments-writes-enabled');

module.exports = {
  ...base,
  seed(s) {
    base.seed(s);
    s.override({ server: 'Main', alertId: 'removed-alert', enabled: false }, 600);
    s.override({ server: 'Gone', alertId: 'old-rule', mutedFrom: '2026-01-10T09:00:00.000Z', mutedUntil: '2026-02-01', reason: 'old' }, 600);
  }
};
