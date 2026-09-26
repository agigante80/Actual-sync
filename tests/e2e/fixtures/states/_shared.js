/**
 * Building blocks shared by the fixture states (#263). Not a state itself.
 * All names are invented; nothing here is personal data.
 */

const EVERY_4_HOURS = { cron: '0 */4 * * *', cronHuman: 'Every 4 hours' };

/**
 * Seed a deterministic run of past syncs, oldest first so the newest write
 * is what the in-memory server status ends on.
 * @param {Object} s - the seeder from fixtures/index.js
 * @param {string[]} names - servers, synced round-robin
 * @param {Object} opts
 * @param {number} opts.count - rows to write
 * @param {number} opts.spacingMinutes - gap between consecutive rows
 * @param {number} [opts.newestMinutesAgo=5]
 * @param {(i: number, name: string) => Object} [opts.row] - per-row overrides (status, error, ...)
 */
function seedRun(s, names, { count, spacingMinutes, newestMinutesAgo = 5, row = () => ({}) }) {
  for (let i = count - 1; i >= 0; i--) {
    const name = names[i % names.length];
    s.sync(name, newestMinutesAgo + i * spacingMinutes, {
      succeeded: 2 + (i % 3),
      skipped: i % 2,
      durationMs: 3000 + ((i * 737) % 4000),
      ...row(i, name)
    });
  }
}

const ACCOUNTS = {
  'Main Budget': [
    { id: 'acc-main-1', name: 'Everyday Checking', classification: 'syncable' },
    { id: 'acc-main-2', name: 'Rewards Card', classification: 'syncable' },
    { id: 'acc-main-3', name: 'Cash Wallet', classification: 'manual' },
    { id: 'acc-main-4', name: 'Old Savings', classification: 'closed' }
  ],
  'Personal Budget': [
    { id: 'acc-pers-1', name: 'Joint Account', classification: 'syncable' },
    { id: 'acc-pers-2', name: 'Holiday Fund', classification: 'manual' }
  ],
  'Family Budget': [
    { id: 'acc-fam-1', name: 'Household Account', classification: 'syncable' },
    { id: 'acc-fam-2', name: 'Kids Savings', classification: 'manual' },
    { id: 'acc-fam-3', name: 'Closed Card', classification: 'closed' }
  ]
};

module.exports = { EVERY_4_HOURS, seedRun, ACCOUNTS };
