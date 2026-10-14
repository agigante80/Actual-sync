// A dashboard rule with every optional field set, saved after the last evaluation (#268).
const { base, ev } = require('./_editor');

module.exports = base({
  rules: [[{
    id: 'gym', schedule: 'Gym', graceDays: 4, earlyDays: 1, period: 'next', amountTolerancePct: 5,
    remindEveryDays: 2, channels: ['slack'], templates: { missing: 'Gym payment is late' }
  }, 30]],
  evaluations: [ev('gym', 'Gym', 'upcoming', { cadenceText: 'Every month on the 1st', payee: 'Fit Club' })]
});
