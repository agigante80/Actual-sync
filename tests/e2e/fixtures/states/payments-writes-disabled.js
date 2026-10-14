// Payments behind basic auth with configuration writes left off: the controls are read-only. (#261)
const authBasic = require('./auth-basic');
const { AS_OF_MIN, CONTROL_SERVER, controlEvaluations } = require('./_payments');

module.exports = {
  ...authBasic,
  servers: [{ ...CONTROL_SERVER }],
  seed(s) {
    s.sync('Main', 20, { succeeded: 3 });
    s.payments('Main', controlEvaluations(), {}, AS_OF_MIN);
  }
};
