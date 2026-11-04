// One server whose latest sync has per-account results (new, none, unknown,
// failed, skipped, a markup name), and an older sync recorded before the
// per-account rows existed. For the History expander and the Accounts card. (#430)
const { EVERY_4_HOURS } = require('./_shared');

const SERVER = 'Main Budget';
const MARKUP_NAME = '<img src=x id="injected">';

const ACCOUNTS = [
  { id: 'acc-1', name: 'Everyday Checking', classification: 'syncable' },
  { id: 'acc-2', name: 'Rewards Card', classification: 'syncable' },
  { id: 'acc-3', name: 'Joint Account', classification: 'syncable' },
  { id: 'acc-4', name: 'Holiday Fund', classification: 'syncable' },
  { id: 'acc-5', name: 'Cash Wallet', classification: 'manual' },
  { id: 'acc-6', name: MARKUP_NAME, classification: 'syncable' }
];

const result = (id, name, status, added, updated, countsKnown = true) =>
  ({ id, name, status, added, updated, countsKnown });

module.exports = {
  uptimeSeconds: 3600,
  servers: [{ name: SERVER }],
  schedules: [{ ...EVERY_4_HOURS, servers: [SERVER], nextInMinutes: 40 }],
  server: SERVER,
  markupName: MARKUP_NAME,
  seed(s) {
    s.accounts(SERVER, ACCOUNTS);
    // Older sync, recorded before #429: no account rows.
    s.sync(SERVER, 300, { succeeded: 2 });
    s.sync(SERVER, 10, {
      status: 'partial',
      succeeded: 4,
      failed: 1,
      skipped: 1,
      accountResults: [
        result('acc-1', ACCOUNTS[0].name, 'synced', 5, 2),
        result('acc-2', ACCOUNTS[1].name, 'synced', 0, 0),
        result('acc-3', ACCOUNTS[2].name, 'synced', 15, 0),
        result('acc-4', ACCOUNTS[3].name, 'synced', 0, 0, false),
        result('acc-5', ACCOUNTS[4].name, 'skipped', 0, 0, false),
        result('acc-6', MARKUP_NAME, 'failed', 0, 0, false)
      ]
    });
  }
};
