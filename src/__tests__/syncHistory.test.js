/**
 * Sync History Service Tests
 * 
 * Tests for sync history persistence and querying
 */

const { SyncHistoryService, CONFIG_AUDIT_REDACT_SUBSTRINGS } = require('../services/syncHistory');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

describe('SyncHistoryService', () => {
  let syncHistory;
  const testDbPath = path.join(__dirname, 'test-sync-history.db');

  beforeEach(() => {
    // Clean up test database if it exists
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    syncHistory = new SyncHistoryService({
      dbPath: testDbPath,
      retentionDays: 30,
      loggerConfig: { level: 'ERROR' } // Quiet during tests
    });
  });

  afterEach(() => {
    if (syncHistory) {
      syncHistory.close();
    }
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('Constructor and Initialization', () => {
    test('should initialize with default values', () => {
      const sh = new SyncHistoryService({
        dbPath: path.join(__dirname, 'test-default.db'),
        loggerConfig: { level: 'ERROR' }
      });
      
      expect(sh.retentionDays).toBe(90);
      expect(sh.db).toBeDefined();
      
      sh.close();
      fs.unlinkSync(path.join(__dirname, 'test-default.db'));
    });

    test('should initialize with custom retention days', () => {
      expect(syncHistory.retentionDays).toBe(30);
    });

    test('should create database file', () => {
      expect(fs.existsSync(testDbPath)).toBe(true);
    });

    test('should create sync_history table', () => {
      const tables = syncHistory.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_history'"
      ).all();
      
      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe('sync_history');
    });

    test('should create indexes', () => {
      const indexes = syncHistory.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index'"
      ).all();
      
      expect(indexes.length).toBeGreaterThan(0);
    });
  });

  describe('recordSync', () => {
    test('should record successful sync', () => {
      const id = syncHistory.recordSync({
        serverName: 'TestServer',
        status: 'success',
        durationMs: 5000,
        accountsProcessed: 3,
        accountsSucceeded: 3,
        accountsFailed: 0,
        correlationId: 'test-uuid-123'
      });

      expect(id).toBeGreaterThan(0);
    });

    test('should record failed sync', () => {
      const id = syncHistory.recordSync({
        serverName: 'TestServer',
        status: 'failure',
        durationMs: 2000,
        accountsProcessed: 3,
        accountsSucceeded: 1,
        accountsFailed: 2,
        errorMessage: 'Connection timeout',
        errorCode: 'ETIMEDOUT',
        correlationId: 'test-uuid-456'
      });

      expect(id).toBeGreaterThan(0);
    });

    test('should handle minimal record', () => {
      const id = syncHistory.recordSync({
        serverName: 'TestServer',
        status: 'success'
      });

      expect(id).toBeGreaterThan(0);
      
      const record = syncHistory.db.prepare('SELECT * FROM sync_history WHERE id = ?').get(id);
      expect(record.accounts_processed).toBe(0);
      expect(record.duration_ms).toBeNull();
    });

    test('should auto-generate timestamp', () => {
      const id = syncHistory.recordSync({
        serverName: 'TestServer',
        status: 'success'
      });

      const record = syncHistory.db.prepare('SELECT * FROM sync_history WHERE id = ?').get(id);
      expect(record.timestamp).toBeDefined();
      
      // Check timestamp is recent (within 1 second)
      const recordTime = new Date(record.timestamp).getTime();
      const now = Date.now();
      expect(now - recordTime).toBeLessThan(1000);
    });

    test('uses an injected now() for the timestamp instead of the real clock (#263)', () => {
      const fixedDbPath = path.join(__dirname, 'test-injected-now.db');
      if (fs.existsSync(fixedDbPath)) fs.unlinkSync(fixedDbPath);
      const fixedNow = () => new Date('2026-01-15T12:00:00.000Z');
      const sh = new SyncHistoryService({ dbPath: fixedDbPath, now: fixedNow, loggerConfig: { level: 'ERROR' } });

      const id = sh.recordSync({ serverName: 'TestServer', status: 'success' });
      const record = sh.db.prepare('SELECT * FROM sync_history WHERE id = ?').get(id);
      expect(record.timestamp).toBe('2026-01-15T12:00:00.000Z');

      sh.close();
      fs.unlinkSync(fixedDbPath);
    });

    // The test above covers the constructor and recordSync. These move the
    // clock after rows exist, so a cutoff computed from the real clock instead
    // of this.now() selects or deletes the wrong rows. (#289)
    describe('now() seam at cutoff sites (#289)', () => {
      const dbPath = path.join(__dirname, 'test-now-cutoffs.db');
      let sh;
      let current;

      const record = (iso, serverName = 'Server1') => {
        current = new Date(iso);
        sh.recordSync({ serverName, status: 'success', durationMs: 1000, accountsProcessed: 1 });
      };

      beforeEach(() => {
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        current = new Date('2026-01-01T00:00:00.000Z'); // the constructor runs cleanup() once
        sh = new SyncHistoryService({
          dbPath, retentionDays: 30, now: () => new Date(current), loggerConfig: { level: 'ERROR' }
        });
        record('2026-01-10T12:00:00.000Z');
        record('2026-01-14T12:00:00.000Z');
        current = new Date('2026-01-15T12:00:00.000Z');
      });

      afterEach(() => {
        sh.close();
        fs.unlinkSync(dbPath);
      });

      test('getHistory days cutoff is measured from now()', () => {
        const rows = sh.getHistory({ days: 2 });
        expect(rows.map(r => r.timestamp)).toEqual(['2026-01-14T12:00:00.000Z']);
      });

      test('getStatistics days cutoff is measured from now()', () => {
        expect(sh.getStatistics({ days: 2 }).total_syncs).toBe(1);
      });

      test('getStatisticsByServer days cutoff is measured from now()', () => {
        const stats = sh.getStatisticsByServer(2);
        expect(stats).toHaveLength(1);
        expect(stats[0].total_syncs).toBe(1);
      });

      test('cleanup retention cutoff is measured from now()', () => {
        record('2025-12-01T12:00:00.000Z');
        current = new Date('2026-01-15T12:00:00.000Z');
        expect(sh.cleanup()).toBe(1);
        expect(sh.db.prepare('SELECT COUNT(*) AS n FROM sync_history').get().n).toBe(2);
      });

      test('cleanup purges schedule alert rows older than 120 days from now()', async () => {
        current = new Date('2025-08-01T00:00:00.000Z');
        await sh.recordScheduleAlert({ server: 'Server1', alertId: 'a1', event: 'missing', delivery: 'sent' });
        current = new Date('2025-12-01T00:00:00.000Z');
        await sh.recordScheduleAlert({ server: 'Server1', alertId: 'a2', event: 'missing', delivery: 'sent' });
        current = new Date('2026-01-15T12:00:00.000Z');

        sh.cleanup();
        const ids = sh.db.prepare('SELECT alert_id FROM schedule_alerts').all().map(r => r.alert_id);
        expect(ids).toEqual(['a2']);
      });
    });
  });

  describe('getHistory', () => {
    beforeEach(() => {
      // Add test data
      syncHistory.recordSync({
        serverName: 'Server1',
        status: 'success',
        durationMs: 4000,
        accountsProcessed: 2
      });
      
      syncHistory.recordSync({
        serverName: 'Server2',
        status: 'failure',
        durationMs: 3000,
        accountsProcessed: 1,
        errorMessage: 'Test error'
      });
      
      syncHistory.recordSync({
        serverName: 'Server1',
        status: 'success',
        durationMs: 5000,
        accountsProcessed: 3
      });
    });

    test('should retrieve all history', () => {
      const history = syncHistory.getHistory();
      expect(history).toHaveLength(3);
    });

    test('should filter by server name', () => {
      const history = syncHistory.getHistory({ serverName: 'Server1' });
      expect(history).toHaveLength(2);
      history.forEach(record => {
        expect(record.server_name).toBe('Server1');
      });
    });

    test('should filter by status', () => {
      const history = syncHistory.getHistory({ status: 'failure' });
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('failure');
    });

    test('should limit results', () => {
      const history = syncHistory.getHistory({ limit: 2 });
      expect(history).toHaveLength(2);
    });

    test('should order by timestamp descending', () => {
      const history = syncHistory.getHistory();
      expect(history[0].id).toBeGreaterThan(history[1].id);
      expect(history[1].id).toBeGreaterThan(history[2].id);
    });

    test('should filter by days', () => {
      const history = syncHistory.getHistory({ days: 1 });
      expect(history).toHaveLength(3); // All within last day
    });

    test('should support pagination with offset', () => {
      const page1 = syncHistory.getHistory({ limit: 2, offset: 0 });
      const page2 = syncHistory.getHistory({ limit: 2, offset: 2 });
      
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('getStatistics', () => {
    beforeEach(() => {
      // Add test data
      for (let i = 0; i < 5; i++) {
        syncHistory.recordSync({
          serverName: 'Server1',
          status: 'success',
          durationMs: 4000 + i * 1000,
          accountsProcessed: 2
        });
      }
      
      for (let i = 0; i < 2; i++) {
        syncHistory.recordSync({
          serverName: 'Server1',
          status: 'failure',
          durationMs: 3000,
          accountsProcessed: 1
        });
      }
    });

    test('should calculate overall statistics', () => {
      const stats = syncHistory.getStatistics();
      
      expect(stats.total_syncs).toBe(7);
      expect(stats.successful_syncs).toBe(5);
      expect(stats.failed_syncs).toBe(2);
      expect(stats.success_rate).toBe('71.43%');
    });

    test('should calculate average duration', () => {
      const stats = syncHistory.getStatistics();
      
      expect(stats.avg_duration_ms).toBeGreaterThan(3000);
      expect(stats.min_duration_ms).toBe(3000);
      expect(stats.max_duration_ms).toBe(8000);
    });

    test('should filter statistics by server', () => {
      syncHistory.recordSync({
        serverName: 'Server2',
        status: 'success',
        durationMs: 5000
      });

      const stats = syncHistory.getStatistics({ serverName: 'Server1' });
      expect(stats.total_syncs).toBe(7); // Only Server1
    });

    test('should handle no data', () => {
      const sh = new SyncHistoryService({
        dbPath: path.join(__dirname, 'test-empty.db'),
        loggerConfig: { level: 'ERROR' }
      });

      const stats = sh.getStatistics();
      expect(stats.total_syncs).toBe(0);
      expect(stats.success_rate).toBe('N/A');

      sh.close();
      fs.unlinkSync(path.join(__dirname, 'test-empty.db'));
    });
  });

  describe('getStatisticsByServer', () => {
    beforeEach(() => {
      syncHistory.recordSync({
        serverName: 'Server1',
        status: 'success',
        durationMs: 4000
      });
      
      syncHistory.recordSync({
        serverName: 'Server1',
        status: 'failure',
        durationMs: 3000
      });
      
      syncHistory.recordSync({
        serverName: 'Server2',
        status: 'success',
        durationMs: 5000
      });
    });

    test('should return statistics per server', () => {
      const stats = syncHistory.getStatisticsByServer();
      
      expect(stats).toHaveLength(2);
      expect(stats.find(s => s.server_name === 'Server1')).toBeDefined();
      expect(stats.find(s => s.server_name === 'Server2')).toBeDefined();
    });

    test('should calculate per-server success rates', () => {
      const stats = syncHistory.getStatisticsByServer();
      
      const server1 = stats.find(s => s.server_name === 'Server1');
      expect(server1.total_syncs).toBe(2);
      expect(server1.successful_syncs).toBe(1);
      expect(server1.success_rate).toBe('50.00%');
      
      const server2 = stats.find(s => s.server_name === 'Server2');
      expect(server2.total_syncs).toBe(1);
      expect(server2.success_rate).toBe('100.00%');
    });

    test('should include last sync timestamp', () => {
      const stats = syncHistory.getStatisticsByServer();
      
      stats.forEach(stat => {
        expect(stat.last_sync).toBeDefined();
      });
    });
  });

  describe('getRecentErrors', () => {
    beforeEach(() => {
      // Add errors with distinct IDs
      for (let i = 0; i < 5; i++) {
        syncHistory.recordSync({
          serverName: 'TestServer',
          status: 'failure',
          errorMessage: `Error ${i}`,
          durationMs: 1000 * i
        });
      }
      
      syncHistory.recordSync({
        serverName: 'TestServer',
        status: 'success',
        durationMs: 5000
      });
    });

    test('should return only failures', () => {
      const errors = syncHistory.getRecentErrors(10);
      
      expect(errors).toHaveLength(5);
      errors.forEach(error => {
        expect(error.status).toBe('failure');
      });
    });

    test('should limit number of errors', () => {
      const errors = syncHistory.getRecentErrors(3);
      expect(errors).toHaveLength(3);
    });

    test('should order by timestamp descending', () => {
      const errors = syncHistory.getRecentErrors(5);
      expect(errors).toHaveLength(5);
      // Check that timestamps are in descending order (newest first)
      for (let i = 0; i < errors.length - 1; i++) {
        const time1 = new Date(errors[i].timestamp).getTime();
        const time2 = new Date(errors[i + 1].timestamp).getTime();
        expect(time1).toBeGreaterThanOrEqual(time2);
      }
    });
  });

  describe('getLastSync', () => {
    beforeEach(() => {
      syncHistory.recordSync({
        serverName: 'Server1',
        status: 'success',
        durationMs: 4000
      });
      
      syncHistory.recordSync({
        serverName: 'Server1',
        status: 'failure',
        durationMs: 3000
      });
      
      syncHistory.recordSync({
        serverName: 'Server2',
        status: 'success',
        durationMs: 5000
      });
    });

    test('should return last sync for server', () => {
      const lastSync = syncHistory.getLastSync('Server1');
      
      expect(lastSync).toBeDefined();
      expect(lastSync.server_name).toBe('Server1');
      // Should be the most recently inserted (failure or success)
      expect(['success', 'failure']).toContain(lastSync.status);
      // Verify it's actually the most recent by checking it has the highest ID for this server
      const server1Records = syncHistory.getHistory({ serverName: 'Server1' });
      expect(lastSync.id).toBe(server1Records[0].id);
    });

    test('should return null for unknown server', () => {
      const lastSync = syncHistory.getLastSync('UnknownServer');
      expect(lastSync).toBeNull();
    });
  });

  describe('accounts_skipped (#101)', () => {
    const hasColumn = (db, name) =>
      db.prepare('PRAGMA table_info(sync_history)').all().some(c => c.name === name);

    test('fresh DB includes the accounts_skipped column', () => {
      expect(hasColumn(syncHistory.db, 'accounts_skipped')).toBe(true);
    });

    test('migrates a pre-existing DB without the column, preserving rows (idempotent)', () => {
      const legacyDbPath = path.join(__dirname, 'test-legacy-schema.db');
      if (fs.existsSync(legacyDbPath)) fs.unlinkSync(legacyDbPath);

      // Build an old-schema table that lacks accounts_skipped, with one legacy row.
      const legacy = new Database(legacyDbPath);
      legacy.exec(`
        CREATE TABLE sync_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          server_name TEXT NOT NULL,
          status TEXT NOT NULL,
          duration_ms INTEGER,
          accounts_processed INTEGER,
          accounts_succeeded INTEGER,
          accounts_failed INTEGER,
          error_message TEXT,
          error_code TEXT,
          correlation_id TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      legacy.prepare(
        'INSERT INTO sync_history (timestamp, server_name, status) VALUES (?, ?, ?)'
      ).run(new Date().toISOString(), 'LegacyServer', 'success');
      expect(hasColumn(legacy, 'accounts_skipped')).toBe(false);
      legacy.close();

      // Opening the service migrates the schema in place.
      const migrated = new SyncHistoryService({
        dbPath: legacyDbPath,
        loggerConfig: { level: 'ERROR' }
      });
      expect(hasColumn(migrated.db, 'accounts_skipped')).toBe(true);

      const legacyRow = migrated.db
        .prepare('SELECT * FROM sync_history WHERE server_name = ?')
        .get('LegacyServer');
      expect(legacyRow).toBeDefined();
      expect(legacyRow.status).toBe('success');
      expect(legacyRow.accounts_skipped).toBeNull(); // older row, column added later
      migrated.close();

      // Re-opening must not throw and must keep the column (idempotent).
      const reopened = new SyncHistoryService({
        dbPath: legacyDbPath,
        loggerConfig: { level: 'ERROR' }
      });
      expect(hasColumn(reopened.db, 'accounts_skipped')).toBe(true);
      reopened.close();

      fs.unlinkSync(legacyDbPath);
    });

    test('recordSync persists accountsSkipped', () => {
      const id = syncHistory.recordSync({
        serverName: 'TestServer',
        status: 'success',
        accountsProcessed: 2,
        accountsSucceeded: 2,
        accountsFailed: 0,
        accountsSkipped: 3
      });

      const record = syncHistory.db.prepare('SELECT * FROM sync_history WHERE id = ?').get(id);
      expect(record.accounts_skipped).toBe(3);
    });

    test('recordSync defaults accountsSkipped to 0 when omitted', () => {
      const id = syncHistory.recordSync({
        serverName: 'TestServer',
        status: 'success'
      });

      const record = syncHistory.db.prepare('SELECT * FROM sync_history WHERE id = ?').get(id);
      expect(record.accounts_skipped).toBe(0);
    });

    test('getRecentSyncs exposes accountsSkipped (camelCase alias)', () => {
      syncHistory.recordSync({
        serverName: 'TestServer',
        status: 'success',
        accountsSkipped: 2
      });

      const recent = syncHistory.getRecentSyncs(1);
      expect(recent).toHaveLength(1);
      expect(recent[0].accountsSkipped).toBe(2);
    });
  });

  describe('cleanup', () => {
    test('should delete old records', () => {      
      // Insert an old record manually
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 35); // 35 days ago (older than 30 day retention)
      
      syncHistory.db.prepare(`
        INSERT INTO sync_history (timestamp, server_name, status)
        VALUES (?, ?, ?)
      `).run(oldDate.toISOString(), 'TestServer', 'success');

      const beforeCount = syncHistory.db.prepare('SELECT COUNT(*) as count FROM sync_history').get().count;
      expect(beforeCount).toBeGreaterThan(0);

      const deleted = syncHistory.cleanup();
      expect(deleted).toBeGreaterThanOrEqual(1);

      // Check that old record was deleted
      const oldRecords = syncHistory.db.prepare(
        'SELECT COUNT(*) as count FROM sync_history WHERE timestamp < ?'
      ).get(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString());
      
      expect(oldRecords.count).toBe(0);
    });

    test('should not delete recent records', () => {
      syncHistory.recordSync({
        serverName: 'TestServer',
        status: 'success'
      });

      const deleted = syncHistory.cleanup();
      expect(deleted).toBe(0);

      const count = syncHistory.db.prepare('SELECT COUNT(*) as count FROM sync_history').get().count;
      expect(count).toBe(1);
    });
  });

  describe('close', () => {
    test('should close database connection', () => {
      syncHistory.close();
      expect(syncHistory.db).toBeNull();
    });

    test('should handle multiple close calls', () => {
      syncHistory.close();
      expect(() => syncHistory.close()).not.toThrow();
    });
  });

  describe('account metadata (#99)', () => {
    // getAccountMetadata() went with #186 — it was a per-server variant nothing
    // called. These tests are about replaceAccountMetadata, so they read back
    // through getAllAccountMetadata(), the path /api/dashboard/accounts uses.
    const metaFor = (server) =>
      (syncHistory.getAllAccountMetadata().find(g => g.server === server) || { accounts: [] }).accounts;

    const sample = [
      { id: 'a1', name: 'Checking', classification: 'syncable' },
      { id: 'a2', name: 'Savings', classification: 'closed' },
      { id: 'a3', name: 'Cash', classification: 'manual' }
    ];

    test('persists and reads back the classified accounts for a server', () => {
      const stored = syncHistory.replaceAccountMetadata('Main', sample);
      expect(stored).toBe(3);

      const rows = metaFor('Main');
      expect(rows).toHaveLength(3);
      const byId = Object.fromEntries(rows.map(r => [r.id, r]));
      expect(byId.a1).toMatchObject({ name: 'Checking', classification: 'syncable' });
      expect(byId.a2).toMatchObject({ name: 'Savings', classification: 'closed' });
      expect(byId.a3).toMatchObject({ name: 'Cash', classification: 'manual' });
      expect(byId.a1.updatedAt).toBeDefined();
    });

    test('returns an empty array (not null) for an unknown server', () => {
      const rows = metaFor('NeverSyncedServer');
      expect(rows).toEqual([]);
    });

    test('replace overwrites the previous snapshot (removed accounts disappear)', () => {
      syncHistory.replaceAccountMetadata('Main', sample); // 3 accounts
      syncHistory.replaceAccountMetadata('Main', [{ id: 'a1', name: 'Checking', classification: 'syncable' }]);
      const rows = metaFor('Main');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('a1');
    });

    test('keeps servers isolated from each other', () => {
      syncHistory.replaceAccountMetadata('Main', sample);
      syncHistory.replaceAccountMetadata('Other', [{ id: 'b1', name: 'Brokerage', classification: 'manual' }]);
      expect(metaFor('Main')).toHaveLength(3);
      expect(metaFor('Other')).toHaveLength(1);
    });

    test('getAllAccountMetadata groups accounts by server', () => {
      syncHistory.replaceAccountMetadata('Main', sample);
      syncHistory.replaceAccountMetadata('Other', [{ id: 'b1', name: 'Brokerage', classification: 'manual' }]);
      const all = syncHistory.getAllAccountMetadata();
      const main = all.find(g => g.server === 'Main');
      const other = all.find(g => g.server === 'Other');
      expect(main.accounts).toHaveLength(3);
      expect(other.accounts).toHaveLength(1);
      expect(other.accounts[0]).toMatchObject({ id: 'b1', classification: 'manual' });
    });

    test('replaceAccountMetadata with an empty list clears the server', () => {
      syncHistory.replaceAccountMetadata('Main', sample);
      expect(syncHistory.replaceAccountMetadata('Main', [])).toBe(0);
      expect(metaFor('Main')).toEqual([]);
    });

    test('the account_metadata table is created on a fresh database (idempotent migration)', () => {
      // A brand-new SyncHistoryService must have the table; CREATE TABLE IF NOT
      // EXISTS runs on every init, so re-initializing the same DB is safe.
      const probe = path.join(__dirname, 'test-acct-meta-migration.db');
      if (fs.existsSync(probe)) fs.unlinkSync(probe);
      const has = (db) => db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='account_metadata'"
      ).get();
      let first, second;
      try {
        first = new SyncHistoryService({ dbPath: probe, loggerConfig: { level: 'ERROR' } });
        expect(has(first.db)).toBeTruthy();
        first.replaceAccountMetadata('S', [{ id: 'x', name: 'X', classification: 'syncable' }]);
        first.close();
        // Re-open the same DB: table still present, data intact, no throw.
        second = new SyncHistoryService({ dbPath: probe, loggerConfig: { level: 'ERROR' } });
        expect(has(second.db)).toBeTruthy();
        expect(second.getAllAccountMetadata().find(g => g.server === 'S').accounts).toHaveLength(1);
      } finally {
        // Clean up even if an assertion above throws, so no stale probe DB lingers.
        if (first && first.db) try { first.close(); } catch { /* already closed */ }
        if (second && second.db) try { second.close(); } catch { /* already closed */ }
        ['', '-wal', '-shm'].forEach(suffix => { if (fs.existsSync(probe + suffix)) fs.unlinkSync(probe + suffix); });
      }
    });

    test('resetServerHistory clears that server account snapshot (#99)', async () => {
      syncHistory.replaceAccountMetadata('Main', sample);
      syncHistory.replaceAccountMetadata('Other', [{ id: 'b1', name: 'B', classification: 'manual' }]);
      await syncHistory.resetServerHistory('Main');
      expect(metaFor('Main')).toEqual([]);
      expect(metaFor('Other')).toHaveLength(1); // untouched
    });

    test('resetAllHistory clears every server account snapshot (#99)', async () => {
      syncHistory.replaceAccountMetadata('Main', sample);
      syncHistory.replaceAccountMetadata('Other', [{ id: 'b1', name: 'B', classification: 'manual' }]);
      await syncHistory.resetAllHistory();
      expect(syncHistory.getAllAccountMetadata()).toEqual([]);
    });

    test('duplicate account ids in one batch self-heal instead of throwing (#99)', () => {
      expect(() => syncHistory.replaceAccountMetadata('Main', [
        { id: 'dup', name: 'First', classification: 'syncable' },
        { id: 'dup', name: 'Second', classification: 'closed' }
      ])).not.toThrow();
      const rows = metaFor('Main');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'dup', name: 'Second', classification: 'closed' }); // last wins
    });
  });

  describe('schedule alert ledger (#258)', () => {
    const key = (overrides = {}) => ({
      server: 'Main', alertId: 'rent', scheduleId: 's1', occurrenceDate: '2026-01-05', event: 'missing',
      ...overrides
    });

    test('creates the schedule_alerts table on a fresh database', () => {
      const tables = syncHistory.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schedule_alerts'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test('findLatestScheduleAlert returns null when nothing has been recorded', async () => {
      expect(await syncHistory.findLatestScheduleAlert(key())).toBeNull();
    });

    test('recordScheduleAlert then findLatestScheduleAlert round-trips recordedAt', async () => {
      await syncHistory.recordScheduleAlert({ ...key(), delivery: 'sent' });
      const found = await syncHistory.findLatestScheduleAlert(key());
      expect(found).not.toBeNull();
      expect(typeof found.recordedAt).toBe('string');
    });

    // #295 review, M6: as originally written this asserted
    // `second.recordedAt >= first.recordedAt`, which passes even if the
    // lookup wrongly returned the FIRST row both times (`x >= x` is `true`),
    // so it could not fail regardless of whether "most recent" was
    // implemented correctly. Driving `now()` explicitly gives two rows with
    // distinct, known `recorded_at` values, so the test can assert the exact
    // newest one and would fail if the oldest (or either row, non-deterministically) came back instead.
    test('findLatestScheduleAlert returns the most recently recorded row for a repeated key', async () => {
      syncHistory.now = () => new Date('2026-01-10T10:00:00.000Z');
      await syncHistory.recordScheduleAlert({ ...key(), delivery: 'sent' });
      const first = await syncHistory.findLatestScheduleAlert(key());
      expect(first.recordedAt).toBe('2026-01-10T10:00:00.000Z');

      // A second write for the exact same key (e.g. a reminder resend) must
      // move the ledger forward, not just leave the first row in place.
      syncHistory.now = () => new Date('2026-01-12T08:00:00.000Z');
      await syncHistory.recordScheduleAlert({ ...key(), delivery: 'sent' });
      const second = await syncHistory.findLatestScheduleAlert(key());
      expect(second.recordedAt).toBe('2026-01-12T08:00:00.000Z');
    });

    test('matches on a null scheduleId/occurrenceDate key (ruleUnmatched events)', async () => {
      const unmatchedKey = key({ scheduleId: null, occurrenceDate: null, event: 'ruleUnmatched' });
      expect(await syncHistory.findLatestScheduleAlert(unmatchedKey)).toBeNull();
      await syncHistory.recordScheduleAlert({ ...unmatchedKey, delivery: 'sent' });
      expect(await syncHistory.findLatestScheduleAlert(unmatchedKey)).not.toBeNull();
      // A key with a non-null scheduleId must not accidentally match the
      // null-scheduleId row (SQL NULL = NULL is not true; IS ? handles this).
      expect(await syncHistory.findLatestScheduleAlert(key({ scheduleId: 's1', occurrenceDate: '2026-01-05' }))).toBeNull();
    });

    test('listMissingScheduleAlertSchedules returns distinct missing (scheduleId, occurrence) pairs for one alert since a date (#356)', async () => {
      const rec = (o) => syncHistory.recordScheduleAlert({ delivery: 'sent', ...key(), ...o });
      await rec({});
      await rec({}); // a reminder: same pair, listed once
      await rec({ scheduleId: 's2', occurrenceDate: '2026-01-06' });
      await rec({ occurrenceDate: '2025-01-01' }); // before sinceDate
      await rec({ event: 'resolved' }); // not a missing row
      await rec({ alertId: 'salary' }); // another alert
      await rec({ server: 'Other' }); // another server
      await rec({ scheduleId: null, occurrenceDate: null, event: 'missing' }); // no schedule to compare
      const rows = await syncHistory.listMissingScheduleAlertSchedules({
        server: key().server, alertId: key().alertId, sinceDate: '2026-01-01'
      });
      expect(rows).toEqual([
        { scheduleId: key().scheduleId, occurrenceDate: key().occurrenceDate },
        { scheduleId: 's2', occurrenceDate: '2026-01-06' }
      ]);
    });

    test('each key field isolates the lookup (server, alertId, scheduleId, occurrenceDate, event)', async () => {
      await syncHistory.recordScheduleAlert({ ...key(), delivery: 'sent' });
      expect(await syncHistory.findLatestScheduleAlert(key({ server: 'Other' }))).toBeNull();
      expect(await syncHistory.findLatestScheduleAlert(key({ alertId: 'salary' }))).toBeNull();
      expect(await syncHistory.findLatestScheduleAlert(key({ scheduleId: 's2' }))).toBeNull();
      expect(await syncHistory.findLatestScheduleAlert(key({ occurrenceDate: '2026-01-06' }))).toBeNull();
      expect(await syncHistory.findLatestScheduleAlert(key({ event: 'late' }))).toBeNull();
    });

    test('cleanup purges schedule_alerts at max(retentionDays, 120) days, independently of retentionDays', () => {
      // retentionDays is 30 for the shared fixture, but schedule_alerts always
      // keeps at least 120 days (longer than the 90-day evaluation look-back
      // cap), so a 100-day-old row must survive a cleanup() that would already
      // have purged a 100-day-old sync_history row.
      const fixedNow = new Date('2026-06-01T00:00:00.000Z');
      const sh = new SyncHistoryService({
        dbPath: path.join(__dirname, 'test-alert-cleanup.db'),
        retentionDays: 30,
        now: () => new Date(fixedNow),
        loggerConfig: { level: 'ERROR' }
      });
      try {
        const daysAgo = (n) => new Date(fixedNow.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
        sh.db.prepare(`
          INSERT INTO schedule_alerts (server, alert_id, schedule_id, occurrence_date, event, delivery, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('Main', 'rent', 's1', '2026-01-01', 'missing', 'sent', daysAgo(100));
        sh.db.prepare(`
          INSERT INTO schedule_alerts (server, alert_id, schedule_id, occurrence_date, event, delivery, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('Main', 'rent', 's1', '2025-12-01', 'missing', 'sent', daysAgo(130));

        sh.cleanup();

        const remaining = sh.db.prepare('SELECT occurrence_date AS d FROM schedule_alerts').all().map((r) => r.d);
        expect(remaining).toEqual(['2026-01-01']);
      } finally {
        sh.close();
        ['', '-wal', '-shm'].forEach((suffix) => {
          const p = path.join(__dirname, 'test-alert-cleanup.db') + suffix;
          if (fs.existsSync(p)) fs.unlinkSync(p);
        });
      }
    });

    test('resetServerHistory clears only that server\'s schedule_alerts rows', async () => {
      await syncHistory.recordScheduleAlert({ ...key(), server: 'Main', delivery: 'sent' });
      await syncHistory.recordScheduleAlert({ ...key(), server: 'Other', delivery: 'sent' });
      await syncHistory.resetServerHistory('Main');
      expect(await syncHistory.findLatestScheduleAlert(key({ server: 'Main' }))).toBeNull();
      expect(await syncHistory.findLatestScheduleAlert(key({ server: 'Other' }))).not.toBeNull();
    });

    test('resetAllHistory clears every server\'s schedule_alerts rows', async () => {
      await syncHistory.recordScheduleAlert({ ...key(), server: 'Main', delivery: 'sent' });
      await syncHistory.recordScheduleAlert({ ...key(), server: 'Other', delivery: 'sent' });
      await syncHistory.resetAllHistory();
      expect(await syncHistory.findLatestScheduleAlert(key({ server: 'Main' }))).toBeNull();
      expect(await syncHistory.findLatestScheduleAlert(key({ server: 'Other' }))).toBeNull();
    });

    // #297 F1: remembered skip decisions
    describe('listScheduleAlertSkips (#297 F1)', () => {
      test('returns the skipped rows of one server as scheduleId and occurrenceDate pairs', async () => {
        await syncHistory.recordScheduleAlert({ ...key({ event: 'skipped' }), delivery: 'inferred' });
        await syncHistory.recordScheduleAlert({ ...key({ event: 'skipped', scheduleId: 's2', occurrenceDate: '2026-02-01' }), delivery: 'inferred' });
        await syncHistory.recordScheduleAlert({ ...key({ event: 'skipped', server: 'Other' }), delivery: 'inferred' });
        await syncHistory.recordScheduleAlert({ ...key(), delivery: 'sent' }); // a missing row is not a skip
        const skips = await syncHistory.listScheduleAlertSkips({ server: 'Main' });
        expect(skips).toEqual(expect.arrayContaining([
          { scheduleId: 's1', occurrenceDate: '2026-01-05' },
          { scheduleId: 's2', occurrenceDate: '2026-02-01' }
        ]));
        expect(skips).toHaveLength(2);
      });

      test('returns an empty list when nothing was skipped', async () => {
        expect(await syncHistory.listScheduleAlertSkips({ server: 'Main' })).toEqual([]);
      });
    });

    // #295 review round 2, M9: the per-destination `channel` column (H5) had
    // no real-DB test at all, so a broken filter or a missing migration would
    // still show green. These exercise both.
    describe('channel column (#295 review, H5 / round 2 M9)', () => {
      test('a lookup with a specific channel does not match a row recorded for a different channel', async () => {
        await syncHistory.recordScheduleAlert({ ...key(), delivery: 'sent', channel: 'slack:#ops:aaaaaaaa' });
        expect(await syncHistory.findLatestScheduleAlert({ ...key(), channel: 'slack:#ops:bbbbbbbb' })).toBeNull();
        expect(await syncHistory.findLatestScheduleAlert({ ...key(), channel: 'slack:#ops:aaaaaaaa' })).not.toBeNull();
      });

      test('a lookup with no channel at all matches a row recorded for any specific channel', async () => {
        await syncHistory.recordScheduleAlert({ ...key(), delivery: 'sent', channel: 'telegram' });
        expect(await syncHistory.findLatestScheduleAlert(key())).not.toBeNull();
      });

      // The migration comment (syncHistory.js, migrateSchema) documents this:
      // a row recorded before per-destination keying existed has channel
      // NULL, and must still be found by a lookup for one specific
      // destination, or every pre-upgrade alert would resend once per
      // destination on the first post-upgrade sync.
      test('a legacy row with a NULL channel matches a lookup for any specific channel', async () => {
        syncHistory.db.prepare(`
          INSERT INTO schedule_alerts (server, alert_id, schedule_id, occurrence_date, event, delivery, recorded_at, channel)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `).run('Main', 'rent', 's1', '2026-01-05', 'missing', 'sent', new Date().toISOString());
        expect(await syncHistory.findLatestScheduleAlert({ ...key(), channel: 'slack:#ops:aaaaaaaa' })).not.toBeNull();
        expect(await syncHistory.findLatestScheduleAlert({ ...key(), channel: 'telegram' })).not.toBeNull();
      });

      // #297 F7: the NULL wildcard exists only for legacy delivered rows. A
      // NULL-channel row that is not a delivery (muted/disabled/inferred
      // skip) must never suppress a real destination.
      test('a NULL-channel row that is not a sent delivery does not match a lookup for a specific channel', async () => {
        await syncHistory.recordScheduleAlert({ ...key(), delivery: 'muted' });
        expect(await syncHistory.findLatestScheduleAlert({ ...key(), channel: 'telegram' })).toBeNull();
        expect(await syncHistory.findLatestScheduleAlert(key())).not.toBeNull(); // channel-less lookup still sees it
      });

      test('migrates a pre-existing DB whose schedule_alerts table lacks the channel column, preserving rows (idempotent)', () => {
        const legacyDbPath = path.join(__dirname, 'test-legacy-schedule-alerts.db');
        if (fs.existsSync(legacyDbPath)) fs.unlinkSync(legacyDbPath);

        const legacy = new Database(legacyDbPath);
        legacy.exec(`
          CREATE TABLE schedule_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server TEXT NOT NULL,
            alert_id TEXT NOT NULL,
            schedule_id TEXT,
            occurrence_date TEXT,
            event TEXT NOT NULL,
            delivery TEXT NOT NULL,
            recorded_at TEXT NOT NULL
          )
        `);
        legacy.prepare(`
          INSERT INTO schedule_alerts (server, alert_id, schedule_id, occurrence_date, event, delivery, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('Main', 'rent', 's1', '2026-01-05', 'missing', 'sent', new Date().toISOString());
        const hasChannel = () => legacy.prepare('PRAGMA table_info(schedule_alerts)').all().some((c) => c.name === 'channel');
        expect(hasChannel()).toBe(false);
        legacy.close();

        const migrated = new SyncHistoryService({ dbPath: legacyDbPath, loggerConfig: { level: 'ERROR' } });
        const hasChannelMigrated = migrated.db.prepare('PRAGMA table_info(schedule_alerts)').all().some((c) => c.name === 'channel');
        expect(hasChannelMigrated).toBe(true);

        const legacyRow = migrated.db.prepare('SELECT * FROM schedule_alerts WHERE server = ?').get('Main');
        expect(legacyRow).toBeDefined();
        expect(legacyRow.channel).toBeNull();
        migrated.close();

        // Re-opening must not throw and must keep the column (idempotent).
        const reopened = new SyncHistoryService({ dbPath: legacyDbPath, loggerConfig: { level: 'ERROR' } });
        expect(reopened.db.prepare('PRAGMA table_info(schedule_alerts)').all().some((c) => c.name === 'channel')).toBe(true);
        reopened.close();

        ['', '-wal', '-shm'].forEach((suffix) => {
          const p = legacyDbPath + suffix;
          if (fs.existsSync(p)) fs.unlinkSync(p);
        });
      });
    });
  });
  describe('config audit (#259)', () => {
    const storedChanges = () => syncHistory.db.prepare('SELECT changes_json FROM config_audit ORDER BY id').all();
    const allRows = () => syncHistory.db.prepare('SELECT * FROM config_audit ORDER BY id').all();

    test('records the changed fields with the metadata and reads them back newest first', () => {
      syncHistory.recordConfigChange({
        server: 'Main', remoteAddr: '10.0.0.1', action: 'payment_alert_state', target: 'rent',
        changes: { enabled: [true, false] }
      });
      syncHistory.recordConfigChange({ server: 'Main', action: 'payment_alert_state', target: 'phone', changes: {} });

      const rows = syncHistory.getConfigAudit({ limit: 10 });
      expect(rows.map(r => r.target)).toEqual(['phone', 'rent']);
      expect(rows[1]).toEqual({
        at: expect.any(String), server: 'Main', remote_addr: '10.0.0.1',
        action: 'payment_alert_state', target: 'rent', changes: { enabled: [true, false] }
      });
      expect(rows[0].remote_addr).toBeNull();
      expect(syncHistory.getConfigAudit({ limit: 1 })).toHaveLength(1);
    });

    test('requires an action', () => {
      expect(() => syncHistory.recordConfigChange({ target: 'x' })).toThrow(/action/);
    });

    test('the denylist is substring based and case insensitive', () => {
      expect(CONFIG_AUDIT_REDACT_SUBSTRINGS).toEqual(expect.arrayContaining(
        ['password', 'passwd', 'secret', 'token', 'apikey', 'authorization', 'webhook', 'reason']));
    });

    test('secrets are recorded as changed only, at every nesting level, while field names stay', () => {
      syncHistory.recordConfigChange({
        action: 'notification_settings',
        changes: {
          password: ['old-1', 'new-1'],
          encryptionPassword: ['old-2', 'new-2'],
          token: ['old-3', 'new-3'],
          botToken: ['old-4', 'new-4'],
          api_key: ['old-5', 'new-5'],
          'X-Api-Key': ['old-6', 'new-6'],
          Authorization: ['old-7', 'new-7'],
          discord: { webhookUrl: 'https://discord.com/api/webhooks/1/old-8' },
          slack: { url: 'https://hooks.slack.com/services/old-9' },
          smtp: { auth: { user: 'mailer-10', pass: 'smtp-11', host: 'mail.example' } },
          'smtp.auth.pass': ['old-12', 'new-12'],
          reason: ['', 'call Alice about rent'],
          note: ['a', 'https://user:hunter2@example.com/path'],
          nested: { deeper: { clientSecret: 'old-13' } },
          enabled: [true, false]
        }
      });
      const [{ changes_json: json }] = storedChanges();
      for (let n = 1; n <= 13; n++) expect(json).not.toMatch(new RegExp(`(old|new|mailer|smtp)-${n}\\b`));
      for (const secret of ['Alice', 'hunter2']) expect(json).not.toContain(secret);

      const changes = JSON.parse(json);
      expect(changes.password).toBe('[redacted]');
      expect(changes.encryptionPassword).toBe('[redacted]');
      expect(changes.botToken).toBe('[redacted]');
      expect(changes.reason).toBe('[redacted]');
      expect(changes.discord.webhookUrl).toBe('[redacted]');
      expect(changes.slack.url).toBe('[redacted]');
      expect(changes.smtp.auth).toEqual({ user: '[redacted]', pass: '[redacted]', host: 'mail.example' });
      expect(changes.nested.deeper.clientSecret).toBe('[redacted]');
      expect(changes.note).toEqual(['a', '[redacted]']);
      // Harmless fields are untouched.
      expect(changes.enabled).toEqual([true, false]);
    });

    test('the real schema path notifications.email.auth.user/pass is redacted, nested and dotted (#259)', () => {
      syncHistory.recordConfigChange({
        action: 'x',
        changes: {
          email: [null, { auth: { user: 'real-user-1', pass: 'S3CRET', host: 'mail.example' } }],
          'notifications.email.auth.pass': ['old-real-2', 'S3CRET-2'],
          'notifications.email.auth.user': ['old-real-3', 'new-real-3'],
          'notifications.email.user': 'real-user-4'
        }
      });
      const [{ changes_json: json }] = storedChanges();
      for (const secret of ['S3CRET', 'real-user-1', 'old-real-2', 'old-real-3', 'new-real-3', 'real-user-4']) {
        expect(json).not.toContain(secret);
      }
      expect(JSON.parse(json).email[1].auth.host).toBe('mail.example');
    });

    test('a plain user or url key outside an smtp or channel parent is kept', () => {
      syncHistory.recordConfigChange({
        action: 'x', changes: { user: ['a', 'b'], homepage: { url: 'https://example.com' } }
      });
      expect(JSON.parse(storedChanges()[0].changes_json)).toEqual({
        user: ['a', 'b'], homepage: { url: 'https://example.com' }
      });
    });

    test('a change over 8 KB is stored as a names-only _truncated marker under 8 KB', () => {
      syncHistory.recordConfigChange({ action: 'x', changes: { notes: ['', 'z'.repeat(20 * 1024)], other: [1, 2] } });
      const [{ changes_json: json }] = storedChanges();
      expect(Buffer.byteLength(json)).toBeLessThan(8 * 1024);
      expect(JSON.parse(json)).toEqual({ _truncated: true, fields: ['notes', 'other'] });
    });

    test('a change just under the cap is stored whole', () => {
      syncHistory.recordConfigChange({ action: 'x', changes: { notes: ['', 'z'.repeat(8000)] } });
      expect(JSON.parse(storedChanges()[0].changes_json).notes[1]).toHaveLength(8000);
    });

    test('resetAllHistory keeps every audit row and appends one history_reset row with the counts and remote_addr', async () => {
      syncHistory.recordConfigChange({ action: 'payment_alert_state', target: 'rent', changes: { enabled: [true, false] } });
      syncHistory.recordSync({ serverName: 'Main', status: 'success' });
      syncHistory.recordSync({ serverName: 'Other', status: 'success' });
      syncHistory.replaceAccountMetadata('Main', [{ id: 'a1', name: 'Checking', classification: 'syncable' }]);

      await syncHistory.resetAllHistory({ remoteAddr: '203.0.113.9' });

      const rows = allRows();
      expect(rows).toHaveLength(2);
      expect(rows[0].action).toBe('payment_alert_state');
      expect(rows[1]).toMatchObject({ action: 'history_reset', server: null, remote_addr: '203.0.113.9' });
      expect(JSON.parse(rows[1].changes_json)).toEqual({
        deleted: {
          sync_history: 2, account_metadata: 1, schedule_alerts: 0, payment_alert_status: 0, payment_alert_run: 0
        }
      });
      expect(syncHistory.db.prepare('SELECT COUNT(*) AS c FROM sync_history').get().c).toBe(0);
    });

    test('resetServerHistory leaves the other server and every audit row, and appends a history_reset row', async () => {
      syncHistory.recordConfigChange({ action: 'payment_alert_state', target: 'rent', changes: {} });
      syncHistory.recordSync({ serverName: 'Main', status: 'success' });
      syncHistory.recordSync({ serverName: 'Other', status: 'success' });

      await syncHistory.resetServerHistory('Main', { remoteAddr: '203.0.113.9' });

      expect(syncHistory.getHistory({ serverName: 'Other', limit: 10 })).toHaveLength(1);
      expect(syncHistory.getHistory({ serverName: 'Main', limit: 10 })).toHaveLength(0);
      const rows = allRows();
      expect(rows.map(r => r.action)).toEqual(['payment_alert_state', 'history_reset']);
      expect(rows[1]).toMatchObject({ server: 'Main', remote_addr: '203.0.113.9' });
      expect(JSON.parse(rows[1].changes_json).deleted.sync_history).toBe(1);
    });

    test('a reset without remoteAddr stores a null remote_addr', async () => {
      await syncHistory.resetAllHistory();
      expect(allRows()[0].remote_addr).toBeNull();
    });

    test('cleanup() purges audit rows older than retentionDays and keeps newer ones', () => {
      const insert = syncHistory.db.prepare(
        'INSERT INTO config_audit (at, action, changes_json) VALUES (?, ?, ?)');
      const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
      insert.run(daysAgo(31), 'old', '{}');
      insert.run(daysAgo(29), 'new', '{}');

      syncHistory.cleanup();

      expect(allRows().map(r => r.action)).toEqual(['new']);
    });
  });
});
