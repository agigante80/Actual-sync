// One configured server, 12 schedules, two needing attention (#341).
const { AS_OF_MIN, ALERT_MIN, configuredFor, attentionEvaluations } = require('./_payments');

module.exports = {
  servers: [{ name: 'Main', ...configuredFor(attentionEvaluations()) }],
  seed(s) {
    s.sync('Main', 20, { succeeded: 3 });
    s.payments('Main', attentionEvaluations(), {}, AS_OF_MIN);
    s.scheduleAlert({ server: 'Main', alertId: 'parking-a', scheduleId: 'sched-parking-a', occurrenceDate: '2026-01-05', channel: 'discord' }, ALERT_MIN);
  }
};
