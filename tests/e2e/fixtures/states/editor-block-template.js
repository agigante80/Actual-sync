// The server's scheduleAlerts block carries its own `missing` template: the editor
// must prefill it, not the built-in one (#268).
const { base } = require('./_editor');

module.exports = base({ block: { templates: { missing: 'BLOCK: {{name}} is late' } } });
