/**
 * Sync History Service Tests
 * 
 * Tests for sync history persistence and querying
 */

const { SyncHistoryService } = require('../services/syncHistory');
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

  describe('getDbPath', () => {
    test('should return database path', () => {
      expect(syncHistory.getDbPath()).toBe(testDbPath);
    });
  });
});
