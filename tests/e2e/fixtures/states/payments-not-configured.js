// A server with no scheduleAlerts block (#341).
module.exports = {
  servers: [{ name: 'Main' }],
  seed(s) {
    s.sync('Main', 20, { succeeded: 3 });
  }
};
