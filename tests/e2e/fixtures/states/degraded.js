// Four servers, two failing and one partial: more failures than successes,
// so the service reports DEGRADED. (#263)
const { EVERY_4_HOURS, seedRun, ACCOUNTS } = require('./_shared');

const NAMES = ['Main Budget', 'Personal Budget', 'Family Budget', 'Business Budget'];

const ERRORS = {
  'Personal Budget': 'Connection timeout after 3 retries',
  'Business Budget': 'Rate limit exceeded'
};

module.exports = {
  uptimeSeconds: 172800,
  servers: [
    { name: 'Main Budget', encryptionPassword: 'fixture-key' },
    { name: 'Personal Budget' },
    { name: 'Family Budget', encryptionPassword: 'fixture-key' },
    { name: 'Business Budget' }
  ],
  schedules: [{ ...EVERY_4_HOURS, servers: NAMES, nextInMinutes: 40 }],
  errors: ERRORS,
  seed(s) {
    seedRun(s, NAMES, {
      count: 20,
      spacingMinutes: 45,
      newestMinutesAgo: 100,
      row: (i, name) => (ERRORS[name] || i % 3 === 0
        ? { status: 'failure', succeeded: 0, failed: 1 + (i % 3), error: ERRORS[name] || 'Bank connection reset' }
        : {})
    });
    s.sync('Main Budget', 30, { succeeded: 3, skipped: 1 });
    s.sync('Family Budget', 40, { status: 'partial', succeeded: 2, failed: 1, skipped: 2, error: '1 account(s) failed to sync: Card login expired' });
    s.sync('Personal Budget', 60, { status: 'failure', succeeded: 0, failed: 2, skipped: 1, error: ERRORS['Personal Budget'] });
    s.sync('Business Budget', 90, { status: 'failure', succeeded: 0, failed: 3, error: ERRORS['Business Budget'] });
    for (const [name, accounts] of Object.entries(ACCOUNTS)) s.accounts(name, accounts);
  }
};
