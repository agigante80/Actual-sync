// Names that look like markup must render literally (#341).
const { AS_OF_MIN, configuredFor, ev } = require('./_payments');

const EVALS = [
  ev('xss', '<img src=x onerror=alert(1)>', 'missing', { payee: '<script>alert(2)</script>', account: '<i>acct</i>' })
];
const SERVER = 'Main <b>bold</b> "q" \'s\'';

module.exports = {
  servers: [{ name: SERVER, ...configuredFor(EVALS) }],
  seed(s) {
    s.payments(SERVER, EVALS, {}, AS_OF_MIN);
  }
};
