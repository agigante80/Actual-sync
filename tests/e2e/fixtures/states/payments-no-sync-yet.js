// Configured, never evaluated; "Sync now" seeds the attention rows (#341).
const { CONFIGURED, attentionEvaluations } = require('./_payments');

module.exports = {
  servers: [{ name: 'Main', ...CONFIGURED }],
  seed() {},
  onSync(s, serverName) {
    s.payments(serverName, attentionEvaluations(), {}, 0);
  }
};
