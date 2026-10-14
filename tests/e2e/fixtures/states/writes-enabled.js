// Basic auth with configuration writes enabled: the one state where the Origin
// guard sits in front of an enabled write path. Test-only credentials. (#259)
const authBasic = require('./auth-basic');

module.exports = {
  ...authBasic,
  allowConfigWrites: true
};
