// Settings plus three configuration changes in the audit trail, the newest
// with a markup-like target for the escaping spec. (#259)
const settings = require('./settings');

module.exports = {
  ...settings,
  seed(s) {
    settings.seed(s);
    s.configChange({
      server: 'Main Budget', remoteAddr: '192.168.1.20', action: 'payment_alert_state',
      target: 'rent', changes: { enabled: [true, false] }
    }, 180);
    s.configChange({
      server: 'Family Budget', remoteAddr: '192.168.1.21', action: 'payment_alert_state',
      target: 'internet', changes: { mutedUntil: [null, '2026-02-01'], reason: '[redacted]' }
    }, 90);
    s.configChange({
      server: 'Personal Budget', remoteAddr: '10.0.0.7', action: 'payment_alert_state',
      target: '<img src=x onerror="window.__xss=1">', changes: { enabled: [false, true] }
    }, 30);
  }
};
