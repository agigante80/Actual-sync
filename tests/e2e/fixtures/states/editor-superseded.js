// A dashboard rule and a config rule share an id: the dashboard one is replaced (#268).
// The config rule is muted, so the #261 control and the editor buttons sit together.
const { base, ev } = require('./_editor');

module.exports = base({
  alerts: [{ id: 'dup', schedule: 'Electricity' }],
  rules: [[{ id: 'dup', schedule: 'Electricity', graceDays: 9 }, 30]],
  evaluations: [ev('dup', 'Electricity', 'missing')],
  seed(s) {
    s.override({ server: 'Main', alertId: 'dup', mutedFrom: '2026-01-14T09:00:00.000Z', mutedUntil: '2026-01-20', reason: 'On holiday' }, 1500);
  }
});
