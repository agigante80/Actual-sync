// A server whose scheduleAlerts block was removed but whose dashboard rule is still stored (#268).
const authBasic = require('./auth-basic');

module.exports = {
  ...authBasic,
  allowConfigWrites: true,
  servers: [{ name: 'Main' }],
  seed(s) {
    s.sync('Main', 20, { succeeded: 3 });
    s.dashboardRule('Main', { id: 'orphan', schedule: 'Gym' }, 30);
  }
};
