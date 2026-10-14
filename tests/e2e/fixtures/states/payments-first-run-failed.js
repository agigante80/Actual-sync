// The very first evaluation failed: lastSuccessAt is null and there are no rows (#341).
const { FAILED_AT_MIN, CONFIGURED } = require('./_payments');

module.exports = {
  servers: [{ name: 'Main', ...CONFIGURED }],
  seed(s) {
    s.paymentRunFailure('Main', 'actual_read_failed', FAILED_AT_MIN);
  }
};
