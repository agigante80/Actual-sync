// Six servers in config order, all healthy, mixed encryption. (#263)
const { EVERY_4_HOURS, seedRun } = require('./_shared');

const NAMES = ['Main Budget', 'Personal Budget', 'Family Budget', 'Business Budget', 'Investments', 'Emergency Fund'];

module.exports = {
  uptimeSeconds: 259200,
  servers: [
    { name: 'Main Budget', encryptionPassword: 'fixture-key' },
    { name: 'Personal Budget' },
    { name: 'Family Budget', encryptionPassword: 'fixture-key' },
    { name: 'Business Budget', encryptionPassword: 'fixture-key' },
    { name: 'Investments' },
    { name: 'Emergency Fund' }
  ],
  schedules: [
    { ...EVERY_4_HOURS, servers: NAMES.slice(0, 3), nextInMinutes: 57 },
    { cron: '30 6 * * *', cronHuman: 'At 06:30 every day', servers: NAMES.slice(3), nextInMinutes: 1110 }
  ],
  names: NAMES,
  seed(s) {
    seedRun(s, NAMES, {
      count: 36,
      spacingMinutes: 30,
      newestMinutesAgo: 3,
      row: (i) => (i === 8 || i === 21 ? { status: 'failure', succeeded: 0, failed: 1, error: 'Bank connection reset' } : {})
    });
  }
};
