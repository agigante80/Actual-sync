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

/**
 * Flatten a partition into dashboard account-metadata rows, one per account,
 * each tagged with a `classification` the UI renders as a badge:
 *   - 'syncable' — bank-linked and open (will bank-sync)
 *   - 'closed'   — a closed account
 *   - 'manual'   — open but not bank-linked (the 'not-linked' skip reason)
 * (#99)
 *
 * @param {{ syncable: Array<object>, skipped: Array<{name:string,id:string,reason:string}> }} partition
 * @returns {Array<{id:string,name:string,classification:'syncable'|'manual'|'closed'}>}
 */
function classifyAccountsForDashboard(partition) {
    const { syncable = [], skipped = [] } = partition || {};
    return [
        ...syncable.map(a => ({ id: a.id, name: a.name, classification: 'syncable' })),
        ...skipped.map(s => ({
            id: s.id,
            name: s.name,
            classification: s.reason === 'closed' ? 'closed' : 'manual'
        }))
    ];
}

/**
 * Best-effort persistence of the dashboard account snapshot. Classifies the
 * partition and writes it via syncHistory, swallowing any error so a metadata
 * write can NEVER abort the sync. No-op when there is no syncHistory, and skips
 * an EMPTY snapshot so a transient zero-account read does not wipe good data. (#99)
 *
 * @param {object} syncHistory - SyncHistoryService (or null)
 * @param {string} serverName
 * @param {{syncable:Array,skipped:Array}} partition - output of partitionSyncableAccounts
 * @param {{warn:Function}} [logger]
 * @returns {number} rows persisted (0 when skipped)
 */
function persistAccountMetadata(syncHistory, serverName, partition, logger) {
    if (!syncHistory) return 0;
    const rows = classifyAccountsForDashboard(partition);
    if (rows.length === 0) return 0; // don't clear a good snapshot on an empty read
    try {
        syncHistory.replaceAccountMetadata(serverName, rows);
        return rows.length;
    } catch (error) {
        if (logger && typeof logger.warn === 'function') {
            logger.warn('Failed to persist account metadata for dashboard', { error: error.message });
        }
        return 0;
    }
}

module.exports = { partitionSyncableAccounts, classifyAccountsForDashboard, persistAccountMetadata };
