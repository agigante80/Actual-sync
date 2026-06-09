/**
 * Unit tests for accountFilter (#98).
 */
const { partitionSyncableAccounts } = require('../lib/accountFilter');

describe('partitionSyncableAccounts', () => {
    test('F0: empty input returns empty partitions without throwing', () => {
        expect(() => partitionSyncableAccounts([])).not.toThrow();
        expect(partitionSyncableAccounts([])).toEqual({ syncable: [], skipped: [] });
    });

    test('F1: a bank-linked, open account is syncable', () => {
        const acct = { id: 'a1', name: 'SabadellSync', account_sync_source: 'goCardless', closed: false };
        const { syncable, skipped } = partitionSyncableAccounts([acct]);
        expect(syncable).toEqual([acct]);
        expect(skipped).toEqual([]);
    });

    test('F2: a manual account (no account_sync_source) is skipped as not-linked', () => {
        const { syncable, skipped } = partitionSyncableAccounts([
            { id: 'm1', name: 'Mortgage', closed: false }
        ]);
        expect(syncable).toEqual([]);
        expect(skipped).toEqual([{ id: 'm1', name: 'Mortgage', reason: 'not-linked' }]);
    });

    test('F2b: account_sync_source: null is skipped as not-linked (null-safe)', () => {
        const { syncable, skipped } = partitionSyncableAccounts([
            { id: 'm2', name: 'Cash', account_sync_source: null, closed: false }
        ]);
        expect(syncable).toEqual([]);
        expect(skipped).toEqual([{ id: 'm2', name: 'Cash', reason: 'not-linked' }]);
    });

    test('F3: a closed account is skipped as closed (even if linked)', () => {
        const { syncable, skipped } = partitionSyncableAccounts([
            { id: 'c1', name: 'Old Card', account_sync_source: 'goCardless', closed: true }
        ]);
        expect(syncable).toEqual([]);
        expect(skipped).toEqual([{ id: 'c1', name: 'Old Card', reason: 'closed' }]);
    });

    test('F4: mixed list partitions completely', () => {
        const linked = { id: 'a1', name: 'SabadellSync', account_sync_source: 'goCardless', closed: false };
        const manual = { id: 'm1', name: 'Mortgage', closed: false };
        const closed = { id: 'c1', name: 'Old Card', account_sync_source: 'goCardless', closed: true };
        const { syncable, skipped } = partitionSyncableAccounts([linked, manual, closed]);

        expect(syncable).toEqual([linked]);
        expect(skipped).toEqual([
            { id: 'm1', name: 'Mortgage', reason: 'not-linked' },
            { id: 'c1', name: 'Old Card', reason: 'closed' }
        ]);
        // counts add up to the input length
        expect(syncable.length + skipped.length).toBe(3);
    });
});
