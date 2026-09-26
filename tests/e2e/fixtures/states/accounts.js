// Healthy servers whose account snapshot mixes syncable, manual and closed
// accounts, for the Accounts card. (#263)
const healthy = require('./healthy');
const { ACCOUNTS } = require('./_shared');

const all = Object.values(ACCOUNTS).flat();

module.exports = {
  ...healthy,
  accounts: ACCOUNTS,
  openCount: all.filter(a => a.classification !== 'closed').length,
  closedCount: all.filter(a => a.classification === 'closed').length
};
