/**
 * Unit tests for accountFilter (#98, #99).
 */
const { partitionSyncableAccounts, classifyAccountsForDashboard, persistAccountMetadata } = require('../lib/accountFilter');

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

describe('classifyAccountsForDashboard (#99)', () => {
    test('maps a full partition to one row per account with the right badge', () => {
        const partition = partitionSyncableAccounts([
            { id: 'a1', name: 'SabadellSync', account_sync_source: 'goCardless', closed: false },
            { id: 'm1', name: 'Mortgage', closed: false },
            { id: 'c1', name: 'Old Card', account_sync_source: 'goCardless', closed: true }
        ]);
        const rows = classifyAccountsForDashboard(partition);
        expect(rows).toEqual([
            { id: 'a1', name: 'SabadellSync', classification: 'syncable' },
            { id: 'm1', name: 'Mortgage', classification: 'manual' },   // 'not-linked' -> manual
            { id: 'c1', name: 'Old Card', classification: 'closed' }
        ]);
    });

    test('empty / missing partition yields an empty list without throwing', () => {
        expect(classifyAccountsForDashboard({ syncable: [], skipped: [] })).toEqual([]);
        expect(classifyAccountsForDashboard(undefined)).toEqual([]);
    });

    test("'not-linked' is the only reason mapped to manual; closed stays closed", () => {
        const rows = classifyAccountsForDashboard({
            syncable: [],
            skipped: [
                { id: 'm1', name: 'A', reason: 'not-linked' },
                { id: 'c1', name: 'B', reason: 'closed' }
            ]
        });
        expect(rows.map(r => r.classification)).toEqual(['manual', 'closed']);
    });
});

describe('persistAccountMetadata (#99)', () => {
    const partition = { syncable: [{ id: 'a1', name: 'Checking' }], skipped: [{ id: 'm1', name: 'Cash', reason: 'not-linked' }] };

    test('writes the classified rows via syncHistory', () => {
        const syncHistory = { replaceAccountMetadata: jest.fn() };
        const n = persistAccountMetadata(syncHistory, 'Main', partition, { warn: jest.fn() });
        expect(n).toBe(2);
        expect(syncHistory.replaceAccountMetadata).toHaveBeenCalledWith('Main', [
            { id: 'a1', name: 'Checking', classification: 'syncable' },
            { id: 'm1', name: 'Cash', classification: 'manual' }
        ]);
    });

    test('a write failure does NOT throw (must never abort the sync) and is warned', () => {
        const error = new Error('db locked');
        const syncHistory = { replaceAccountMetadata: jest.fn(() => { throw error; }) };
        const logger = { warn: jest.fn() };
        let result;
        expect(() => { result = persistAccountMetadata(syncHistory, 'Main', partition, logger); }).not.toThrow();
        expect(result).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Failed to persist account metadata'),
            expect.objectContaining({ error: 'db locked' })
        );
    });

    test('no-ops when there is no syncHistory', () => {
        expect(persistAccountMetadata(null, 'Main', partition, { warn: jest.fn() })).toBe(0);
    });

    test('skips an EMPTY snapshot so a transient zero-account read does not wipe good data', () => {
        const syncHistory = { replaceAccountMetadata: jest.fn() };
        expect(persistAccountMetadata(syncHistory, 'Main', { syncable: [], skipped: [] }, { warn: jest.fn() })).toBe(0);
        expect(syncHistory.replaceAccountMetadata).not.toHaveBeenCalled();
    });

    test('tolerates a missing logger when the write fails and still returns 0', () => {
        const syncHistory = { replaceAccountMetadata: jest.fn(() => { throw new Error('x'); }) };
        let result;
        expect(() => { result = persistAccountMetadata(syncHistory, 'Main', partition); }).not.toThrow();
        expect(result).toBe(0);
    });
});
