// Configured, never evaluated; "Sync now" seeds the attention rows (#341).
const { configuredFor, attentionEvaluations } = require('./_payments');

module.exports = {
  servers: [{ name: 'Main', ...configuredFor(attentionEvaluations()) }],
  seed() {},
  onSync(s, serverName) {
    s.payments(serverName, attentionEvaluations(), {}, 0);
  }
};
