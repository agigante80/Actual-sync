// A server with no scheduleAlerts block and no stored rule (#268).
const authBasic = require('./auth-basic');

module.exports = {
  ...authBasic,
  allowConfigWrites: true,
  servers: [{ name: 'Main' }],
  seed(s) {
    s.sync('Main', 20, { succeeded: 3 });
  }
};
