// The degraded servers with a longer history holding a known number of
// failures, for the History tab. (#263)
const degraded = require('./degraded');
const { seedRun } = require('./_shared');

const NAMES = degraded.servers.map(s => s.name);
const COUNT = 30;
const isFailure = (i) => i % 4 === 1;

module.exports = {
  ...degraded,
  // Every failed row in the seed; the spec checks the table against it.
  failureCount: Array.from({ length: COUNT }, (_, i) => i).filter(isFailure).length,
  totalRows: COUNT,
  seed(s) {
    seedRun(s, NAMES, {
      count: COUNT,
      spacingMinutes: 50,
      newestMinutesAgo: 8,
      row: (i, name) => (isFailure(i)
        ? { status: 'failure', succeeded: 0, failed: 1 + (i % 2), error: degraded.errors[name] || 'Bank connection reset' }
        : {})
    });
  }
};
