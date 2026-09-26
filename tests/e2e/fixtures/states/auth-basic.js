// Healthy data behind HTTP basic auth. Test-only credentials. (#263)
const healthy = require('./healthy');

module.exports = {
  ...healthy,
  auth: { type: 'basic', username: 'fixture-user', password: 'fixture-pass' }
};
