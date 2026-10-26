// The editor with room to add: one config rule (cfg-electricity, evaluated) and one
// dashboard rule whose id is what the first schedule would be named (#268).
const { base, ev } = require('./_editor');

module.exports = base({
  alerts: [{ id: 'cfg-electricity', schedule: 'Electricity' }],
  rules: [[{ id: 'rent-parking-a', schedule: 'Rent - Parking A' }, 30]],
  evaluations: [ev('cfg-electricity', 'Electricity', 'received', { cadenceText: 'Every month on the 28th', payee: 'Power Co' })]
});
