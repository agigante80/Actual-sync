// A good snapshot, then a failed evaluation: previous rows plus a failure line (#341).
const { AS_OF_MIN, FAILED_AT_MIN, CONFIGURED, attentionEvaluations } = require('./_payments');

module.exports = {
  servers: [{ name: 'Main', ...CONFIGURED }],
  seed(s) {
    s.payments('Main', attentionEvaluations().slice(0, 4), {}, AS_OF_MIN);
    s.paymentRunFailure('Main', 'actual_read_failed', FAILED_AT_MIN);
  }
};
