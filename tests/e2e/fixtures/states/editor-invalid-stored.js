// A stored dashboard rule the validator rejects (graceDays out of range), written
// directly as an older version of the service could have (#268).
const { base } = require('./_editor');

module.exports = base({
  rules: [[{ id: 'broken', schedule: 'Electricity', graceDays: 99 }, 30]]
});
