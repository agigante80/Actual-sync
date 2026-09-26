// Degraded servers over two days of history, so every chart has data. (#263)
const degraded = require('./degraded');
const { seedRun } = require('./_shared');

const NAMES = degraded.servers.map(s => s.name);

module.exports = {
  ...degraded,
  seed(s) {
    seedRun(s, NAMES, {
      count: 48,
      spacingMinutes: 60,
      newestMinutesAgo: 12,
      row: (i, name) => (i % 5 === 2 || (name === 'Personal Budget' && i % 3 === 0)
        ? { status: 'failure', succeeded: 0, failed: 1 + (i % 2), error: degraded.errors[name] || 'Bank connection reset' }
        : {})
    });
  }
};
