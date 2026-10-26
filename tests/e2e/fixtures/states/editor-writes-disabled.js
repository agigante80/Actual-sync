// The editor with configuration writes left off: View and Copy work, the rest is disabled (#268).
const { base, ev } = require('./_editor');

const state = base({
  alerts: [{ id: 'cfg-electricity', schedule: 'Electricity' }],
  rules: [[{ id: 'gym', schedule: 'Gym' }, 30]],
  evaluations: [ev('cfg-electricity', 'Electricity', 'received'), ev('gym', 'Gym', 'upcoming')]
});
delete state.allowConfigWrites;
module.exports = state;
