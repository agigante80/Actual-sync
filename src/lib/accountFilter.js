/**
 * Partition Actual accounts into those worth bank-syncing and those to skip.
 *
 * Only accounts linked to a bank/sync provider (`account_sync_source` set) and
 * not closed are syncable. Manual accounts and closed accounts are skipped —
 * running runBankSync on them is a silent no-op that we'd otherwise miscount as
 * a successful sync. (#98)
 *
 * @param {Array<object>} accounts result of actual.getAccounts()
 * @returns {{ syncable: Array<object>, skipped: Array<{name:string,id:string,reason:string}> }}
 */
function partitionSyncableAccounts(accounts) {
    const syncable = [];
    const skipped = [];

    for (const account of accounts || []) {
        if (account.closed) {
            skipped.push({ name: account.name, id: account.id, reason: 'closed' });
        } else if (!account.account_sync_source) {
            skipped.push({ name: account.name, id: account.id, reason: 'not-linked' });
        } else {
            syncable.push(account);
        }
    }

    return { syncable, skipped };
}

module.exports = { partitionSyncableAccounts };
