// Three servers, all syncing cleanly. (#263)
const { EVERY_4_HOURS, seedRun, ACCOUNTS } = require('./_shared');

const NAMES = ['Main Budget', 'Personal Budget', 'Family Budget'];

module.exports = {
  uptimeSeconds: 86400,
  servers: [
    { name: 'Main Budget', encryptionPassword: 'fixture-key' },
    { name: 'Personal Budget' },
    { name: 'Family Budget', encryptionPassword: 'fixture-key' }
  ],
  schedules: [{ ...EVERY_4_HOURS, servers: NAMES, nextInMinutes: 95 }],
  // What the specs assert against: the newest sync per server.
  expected: {
    'Main Budget': '5m ago',
    'Personal Budget': '10m ago',
    'Family Budget': '15m ago'
  },
  seed(s) {
    seedRun(s, NAMES, {
      count: 24,
      spacingMinutes: 60,
      newestMinutesAgo: 20,
      row: (i) => (i === 7 || i === 16 ? { status: 'failure', succeeded: 0, failed: 1, error: 'Bank connection reset' } : {})
    });
    s.sync('Family Budget', 15, { succeeded: 4 });
    s.sync('Personal Budget', 10, { succeeded: 2, skipped: 2 });
    s.sync('Main Budget', 5, { succeeded: 3, skipped: 1 });
    for (const [name, accounts] of Object.entries(ACCOUNTS)) s.accounts(name, accounts);
  }
};
