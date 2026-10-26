// A config.json rule: the editor opens it read-only (#268).
const { base, ev } = require('./_editor');

module.exports = base({
  alerts: [{ id: 'cfg-rent', schedulePrefix: 'Rent', graceDays: 5, templates: { missing: 'Rent is late' } }],
  evaluations: [ev('cfg-rent', 'Rent - Parking A', 'missing')]
});
