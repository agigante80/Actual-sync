// Names that look like markup must render literally (#341).
const { AS_OF_MIN, CONFIGURED, ev } = require('./_payments');

const SERVER = 'Main <b>bold</b> "q" \'s\'';

module.exports = {
  servers: [{ name: SERVER, ...CONFIGURED }],
  seed(s) {
    s.payments(SERVER, [
      ev('xss', '<img src=x onerror=alert(1)>', 'missing', { payee: '<script>alert(2)</script>', account: '<i>acct</i>' })
    ], {}, AS_OF_MIN);
  }
};
