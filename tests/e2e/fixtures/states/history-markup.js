// A server name with a double quote and an error message holding markup, for
// the History tab escaping checks. (#288)
const { EVERY_4_HOURS } = require('./_shared');

const QUOTED = 'Mum\'s "Joint" Budget';
const OTHER = 'Main Budget';
const MARKUP_ERROR = '<b id="injected">Bank</b> said no';

module.exports = {
  uptimeSeconds: 3600,
  servers: [{ name: QUOTED }, { name: OTHER }],
  schedules: [{ ...EVERY_4_HOURS, servers: [QUOTED, OTHER], nextInMinutes: 40 }],
  quoted: QUOTED,
  markupError: MARKUP_ERROR,
  seed(s) {
    s.sync(QUOTED, 30, { status: 'failure', succeeded: 0, failed: 1, error: MARKUP_ERROR });
    s.sync(OTHER, 60, { succeeded: 2 });
  }
};
