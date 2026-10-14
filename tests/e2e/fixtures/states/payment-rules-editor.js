// What the payment rule editor needs (#262, for #268): writes on behind basic
// auth, a block with one config rule and no other rule, a captured schedule
// snapshot for the picker and one stored dashboard rule.
const authBasic = require('./auth-basic');

module.exports = {
  ...authBasic,
  allowConfigWrites: true,
  servers: [{ name: 'Main', scheduleAlerts: { alerts: [{ id: 'cfg-rent', schedule: 'Rent - Flat' }] } }],
  seed(s) {
    s.sync('Main', 20, { succeeded: 3 });
    s.scheduleSnapshot('Main', [
      {
        id: 'sched-flat', name: 'Rent - Flat', cadenceText: 'Every month on the 5th', amount: -85000,
        amountMin: null, amountMax: null, amountOp: 'is', account: 'Main', payee: 'Landlord',
        nextDate: '2026-02-05', completed: false
      },
      {
        id: 'sched-gym', name: 'Gym', cadenceText: 'Every month on the 1st', amount: null,
        amountMin: -3000, amountMax: -2000, amountOp: 'isbetween', account: null, payee: 'Fit Club',
        nextDate: '2026-02-01', completed: false
      }
    ], 60);
    s.dashboardRule('Main', { id: 'gym', schedule: 'Gym', graceDays: 4 }, 30);
  }
};
