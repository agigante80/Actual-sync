// Writes requested but dashboard auth is none: the controls stay read-only. (#261)
const { AS_OF_MIN, CONTROL_SERVER, controlEvaluations } = require('./_payments');

module.exports = {
  allowConfigWrites: true,
  servers: [{ ...CONTROL_SERVER }],
  seed(s) {
    s.sync('Main', 20, { succeeded: 3 });
    s.payments('Main', controlEvaluations(), {}, AS_OF_MIN);
  }
};
