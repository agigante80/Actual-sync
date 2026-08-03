/**
 * Driver-boundary guarantees for better-sqlite3 (#185).
 *
 * The 12.x → 13.x major rewrote the addon onto N-API. Nothing in the existing
 * suite asserts what crosses the JS/native boundary, and that is the failure
 * mode that does not announce itself: an INTEGER column arriving as a BigInt,
 * or a NULL as undefined, would not crash — it would put wrong numbers on a
 * finance dashboard, which is worse than a crash.
 *
 * These assert **type as well as value**, through the real service API rather
 * than raw SQL, because the marshalling that matters is the one the app does.
 *
 * They are equally useful on any future driver bump; nothing here is specific
 * to 13.x.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { SyncHistoryService } = require('../services/syncHistory');

const quiet = { level: 'ERROR' };

describe('better-sqlite3 driver boundary (#185)', () => {
    let dir;
    let db;

    const open = (file = 'h.db') => new SyncHistoryService({
        dbPath: path.join(dir, file), loggerConfig: quiet
    });

    const record = (over = {}) => ({
        timestamp: new Date().toISOString(),
        serverName: 'Main',
        status: 'success',
        durationMs: 1234,
        accountsProcessed: 3,
        accountsSucceeded: 2,
        accountsFailed: 1,
        accountsSkipped: 0,
        ...over
    });

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-driver-'));
        db = open();
    });

    afterEach(() => {
        try { db.close(); } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('the binding itself', () => {
        it('loads and reports a usable SQLite build', () => {
            const probe = new Database(':memory:');
            try {
                const { v } = probe.prepare('SELECT sqlite_version() AS v').get();
                expect(v).toMatch(/^3\./);
            } finally {
                probe.close();
            }
        });

        it('runs the WAL journal mode the service asks for', () => {
            // The service sets `journal_mode = WAL` at init; a driver that
            // silently ignored the pragma would degrade durability with no error.
            expect(String(db.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
        });
    });

    describe('type marshalling', () => {
        it('returns INTEGER columns as number, not BigInt or string', () => {
            db.recordSync(record());
            const [row] = db.getRecentSyncs(1);

            for (const col of ['duration', 'accountsProcessed', 'accountsSucceeded', 'accountsFailed']) {
                expect(typeof row[col]).toBe('number');
            }
            expect(row.duration).toBe(1234);
            expect(row.accountsSucceeded).toBe(2);
        });

        it('returns NULL as null, not undefined or 0', () => {
            // `0` would be catastrophic and silent: a null duration rendering as
            // an instant sync, a null error reading as "no error".
            db.recordSync(record({ status: 'success', errorMessage: null, errorCode: null }));
            const [row] = db.getRecentSyncs(1);

            expect(row.errorMessage).toBeNull();
            expect(row.errorCode).toBeNull();
            expect(row.errorMessage).not.toBeUndefined();
        });

        it('round-trips a large integer without silent truncation', () => {
            const big = Number.MAX_SAFE_INTEGER;
            db.recordSync(record({ durationMs: big }));
            const [row] = db.getRecentSyncs(1);

            expect(row.duration).toBe(big);
            expect(Number.isSafeInteger(row.duration)).toBe(true);
        });

        it('round-trips multi-byte text byte-identically', () => {
            // Server names carry emoji in this project — the test-notification
            // path uses 🧪 — and a mangled name breaks per-server grouping.
            const serverName = '🧪 Ünïcodé 服务器';
            db.recordSync(record({ serverName }));
            const [row] = db.getRecentSyncs(1);

            expect(row.serverName).toBe(serverName);
        });

        it('preserves timestamp text and orders by it correctly', () => {
            // recordSync() stamps its own timestamp, so write these directly to
            // control ordering.
            const ins = db.db.prepare(
                'INSERT INTO sync_history (timestamp, server_name, status) VALUES (?, ?, ?)');
            ins.run('2026-01-01T00:00:00.000Z', 'older', 'success');
            ins.run('2026-06-01T00:00:00.000Z', 'newer', 'success');
            const rows = db.getRecentSyncs(2);

            expect(rows[0].serverName).toBe('newer');
            expect(rows[0].timestamp).toBe('2026-06-01T00:00:00.000Z');
        });
    });

    describe('statements and transactions', () => {
        it('commits a transaction on success', () => {
            // replaceAccountMetadata wraps delete+insert in one transaction.
            expect(db.replaceAccountMetadata('Main', [
                { id: 'a1', name: 'Checking', classification: 'syncable' },
                { id: 'a2', name: 'Savings', classification: 'closed' }
            ])).toBe(2);

            const stored = db.getAllAccountMetadata().find(g => g.server === 'Main');
            expect(stored.accounts).toHaveLength(2);
        });

        it('rolls back a transaction when the body throws', () => {
            // The path that matters. A driver whose transaction() stopped
            // rolling back would leave the previous snapshot half-deleted, and
            // no test here would have noticed before this one.
            db.replaceAccountMetadata('Main', [{ id: 'a1', name: 'Checking', classification: 'syncable' }]);

            const boom = db.db.transaction(() => {
                db.db.prepare('DELETE FROM account_metadata WHERE server_name = ?').run('Main');
                throw new Error('deliberate');
            });
            expect(() => boom()).toThrow('deliberate');

            const stored = db.getAllAccountMetadata().find(g => g.server === 'Main');
            expect(stored.accounts).toHaveLength(1); // the delete was rolled back
        });

        it('reports affected rows from run()', () => {
            db.recordSync(record());
            const res = db.db.prepare('UPDATE sync_history SET status = ? WHERE server_name = ?')
                .run('partial', 'Main');
            expect(res.changes).toBe(1);
            expect(typeof res.changes).toBe('number');
        });
    });

    describe('persistence across close and reopen', () => {
        it('releases the file on close and reads the rows back', () => {
            db.recordSync(record({ serverName: 'Persisted' }));
            db.close();

            const reopened = open();
            try {
                const rows = reopened.getRecentSyncs(10);
                expect(rows.some(r => r.serverName === 'Persisted')).toBe(true);
            } finally {
                reopened.close();
            }
        });

        it('reads a database written by a previous service instance', () => {
            // The upgrade path a user experiences: existing rows, new driver.
            db.recordSync(record({ serverName: 'Legacy', durationMs: 999 }));
            db.replaceAccountMetadata('Legacy', [{ id: 'x', name: 'X', classification: 'syncable' }]);
            db.close();

            const reopened = open();
            try {
                const [row] = reopened.getRecentSyncs(1);
                expect(row.serverName).toBe('Legacy');
                expect(row.duration).toBe(999);
                expect(typeof row.duration).toBe('number');
                expect(reopened.getAllAccountMetadata().find(g => g.server === 'Legacy').accounts).toHaveLength(1);
            } finally {
                reopened.close();
            }
        });

        it('creates its tables idempotently on an existing file', () => {
            db.close();
            expect(() => { const again = open(); again.close(); }).not.toThrow();
        });
    });

    describe('error surfaces', () => {
        it('throws a readable Error for a bad statement, not an opaque native failure', () => {
            // Every catch block in syncHistory logs error.message; a driver that
            // changed the error shape would degrade those to noise.
            let caught;
            try {
                db.db.prepare('SELECT * FROM table_that_does_not_exist').all();
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(Error);
            expect(typeof caught.message).toBe('string');
            expect(caught.message).toMatch(/no such table/i);
        });

        it('reports a constraint violation with a usable code', () => {
            let caught;
            try {
                db.db.prepare('INSERT INTO sync_history (timestamp, server_name, status) VALUES (?, ?, ?)')
                    .run(null, 'X', 'success'); // timestamp is NOT NULL
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(Error);
            expect(String(caught.code || '')).toMatch(/SQLITE_CONSTRAINT/);
        });

        it('fails loudly when the database path is unwritable', () => {
            // initialize() mkdirs recursively, so a missing parent is fine. A
            // path that is itself a directory cannot be opened as a database.
            const asDirectory = path.join(dir, 'iam-a-directory');
            fs.mkdirSync(asDirectory);
            // The service logs the failure before rethrowing; silence it so the
            // suite output stays clean rather than showing a scary stack for a
            // failure this test is deliberately causing.
            const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
            try {
                expect(() => new SyncHistoryService({ dbPath: asDirectory, loggerConfig: quiet })).toThrow();
            } finally {
                spy.mockRestore();
            }
        });
    });
});
