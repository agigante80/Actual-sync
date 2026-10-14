// Payments with the alert controls live: basic auth plus allowConfigWrites. (#261)
const authBasic = require('./auth-basic');
const { AS_OF_MIN, CONTROL_SERVER, controlEvaluations } = require('./_payments');

module.exports = {
  ...authBasic,
  allowConfigWrites: true,
  servers: [{ ...CONTROL_SERVER }],
  seed(s) {
    s.sync('Main', 20, { succeeded: 3 });
    s.payments('Main', controlEvaluations(), {}, AS_OF_MIN);
  }
};
