// Configured, but no schedule snapshot has been captured yet (#268).
const authBasic = require('./auth-basic');

module.exports = {
  ...authBasic,
  allowConfigWrites: true,
  servers: [{ name: 'Main', scheduleAlerts: {} }],
  seed(s) {
    s.sync('Main', 20, { succeeded: 3 });
  }
};
