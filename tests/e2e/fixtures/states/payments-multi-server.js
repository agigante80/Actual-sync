// One server ok, one whose last evaluation failed, one not configured (#341).
const { AS_OF_MIN, FAILED_AT_MIN, CONFIGURED, attentionEvaluations } = require('./_payments');

module.exports = {
  servers: [{ name: 'Main', ...CONFIGURED }, { name: 'Other', ...CONFIGURED }, { name: 'Third' }],
  seed(s) {
    s.payments('Main', attentionEvaluations().slice(0, 3), {}, AS_OF_MIN);
    s.payments('Other', attentionEvaluations().slice(3, 6), {}, AS_OF_MIN + 4000);
    s.paymentRunFailure('Other', 'actual_read_failed', FAILED_AT_MIN);
  }
};
