/**
 * Sync History Service
 * 
 * Tracks and persists sync operation history in SQLite database.
 * Provides query interface for historical analysis and reporting.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { createLogger } = require('../lib/logger');

class SyncHistoryService {
  /**
   * @param {Object} options - Sync history service options
   * @param {string} options.dbPath - Path to SQLite database file
   * @param {number} options.retentionDays - Number of days to retain history (default: 90)
   * @param {Object} options.loggerConfig - Logger configuration
   */
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(process.cwd(), 'data', 'sync-history.db');
    this.retentionDays = options.retentionDays || 90;
    this.logger = createLogger(options.loggerConfig || {});
    this.db = null;
    
    this.initialize();
  }

  /**
   * Initialize database and create tables if needed
   */
  initialize() {
    try {
      // Ensure data directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        this.logger.info('Created data directory for sync history', { dbDir });
      }

      // Open database
      this.db = new Database(this.dbPath);
      this.logger.info('Sync history database opened', { dbPath: this.dbPath });

      // Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');

      // Create tables
      this.createTables();

      // Clean up old records
      this.cleanup();

      this.logger.info('Sync history service initialized', {
        retentionDays: this.retentionDays
      });
    } catch (error) {
      this.logger.error('Failed to initialize sync history database', {
        error: error.message,
        dbPath: this.dbPath
      });
      throw error;
    }
  }

  /**
   * Create database tables
   */
  createTables() {
    const createSyncHistoryTable = `
      CREATE TABLE IF NOT EXISTS sync_history (
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
    `;

    const createIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_timestamp ON sync_history(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_server_name ON sync_history(server_name)',
      'CREATE INDEX IF NOT EXISTS idx_status ON sync_history(status)',
      'CREATE INDEX IF NOT EXISTS idx_correlation_id ON sync_history(correlation_id)'
    ];

    this.db.exec(createSyncHistoryTable);
    this.logger.debug('Created sync_history table');

    createIndexes.forEach(idx => {
      this.db.exec(idx);
    });
    this.logger.debug('Created indexes on sync_history table');
  }

  /**
   * Record a sync operation
   * @param {Object} record - Sync operation record
   * @param {string} record.serverName - Server name
   * @param {string} record.status - 'success' or 'failure'
   * @param {number} record.durationMs - Duration in milliseconds
   * @param {number} record.accountsProcessed - Number of accounts processed
   * @param {number} record.accountsSucceeded - Number of accounts succeeded
   * @param {number} record.accountsFailed - Number of accounts failed
   * @param {string} record.errorMessage - Error message if failed
   * @param {string} record.errorCode - Error code if failed
   * @param {string} record.correlationId - Correlation ID for tracking
   * @returns {number} - Inserted record ID
   */
  recordSync(record) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO sync_history (
          timestamp,
          server_name,
          status,
          duration_ms,
          accounts_processed,
          accounts_succeeded,
          accounts_failed,
          error_message,
          error_code,
          correlation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        new Date().toISOString(),
        record.serverName,
        record.status,
        record.durationMs || null,
        record.accountsProcessed || 0,
        record.accountsSucceeded || 0,
        record.accountsFailed || 0,
        record.errorMessage || null,
        record.errorCode || null,
        record.correlationId || null
      );

      this.logger.debug('Sync operation recorded', {
        id: result.lastInsertRowid,
        serverName: record.serverName,
        status: record.status
      });

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error('Failed to record sync operation', {
        error: error.message,
        serverName: record.serverName
      });
      throw error;
    }
  }

  /**
   * Get sync history with filters
   * @param {Object} filters - Query filters
   * @param {string} filters.serverName - Filter by server name
   * @param {string} filters.status - Filter by status
   * @param {number} filters.days - Number of days to look back
   * @param {number} filters.limit - Maximum number of records to return
   * @param {number} filters.offset - Offset for pagination
   * @returns {Array} - Array of sync records
   */
  getHistory(filters = {}) {
    try {
      let query = 'SELECT * FROM sync_history WHERE 1=1';
      const params = [];

      if (filters.serverName) {
        query += ' AND server_name = ?';
        params.push(filters.serverName);
      }

      if (filters.status) {
        query += ' AND status = ?';
        params.push(filters.status);
      }

      if (filters.days) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - filters.days);
        query += ' AND timestamp >= ?';
        params.push(cutoffDate.toISOString());
      }

      query += ' ORDER BY timestamp DESC';

      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
      }

      if (filters.offset) {
        query += ' OFFSET ?';
        params.push(filters.offset);
      }

      const stmt = this.db.prepare(query);
      const records = stmt.all(...params);

      this.logger.debug('Retrieved sync history', {
        count: records.length,
        filters
      });

      return records;
    } catch (error) {
      this.logger.error('Failed to retrieve sync history', {
        error: error.message,
        filters
      });
      throw error;
    }
  }

  /**
   * Get sync statistics
   * @param {Object} filters - Query filters
   * @param {string} filters.serverName - Filter by server name
   * @param {number} filters.days - Number of days to analyze
   * @returns {Object} - Statistics object
   */
  getStatistics(filters = {}) {
    try {
      let query = `
        SELECT 
          COUNT(*) as total_syncs,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_syncs,
          SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) as failed_syncs,
          AVG(duration_ms) as avg_duration_ms,
          MIN(duration_ms) as min_duration_ms,
          MAX(duration_ms) as max_duration_ms,
          SUM(accounts_processed) as total_accounts_processed,
          MIN(timestamp) as earliest_sync,
          MAX(timestamp) as latest_sync
        FROM sync_history
        WHERE 1=1
      `;
      const params = [];

      if (filters.serverName) {
        query += ' AND server_name = ?';
        params.push(filters.serverName);
      }

      if (filters.days) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - filters.days);
        query += ' AND timestamp >= ?';
        params.push(cutoffDate.toISOString());
      }

      const stmt = this.db.prepare(query);
      const stats = stmt.get(...params);

      // Calculate success rate
      if (stats.total_syncs > 0) {
        stats.success_rate = ((stats.successful_syncs / stats.total_syncs) * 100).toFixed(2) + '%';
      } else {
        stats.success_rate = 'N/A';
      }

      this.logger.debug('Retrieved sync statistics', {
        totalSyncs: stats.total_syncs,
        filters
      });

      return stats;
    } catch (error) {
      this.logger.error('Failed to retrieve sync statistics', {
        error: error.message,
        filters
      });
      throw error;
    }
  }

  /**
   * Get statistics per server
   * @param {number} days - Number of days to analyze
   * @returns {Array} - Array of per-server statistics
   */
  getStatisticsByServer(days = null) {
    try {
      let query = `
        SELECT 
          server_name,
          COUNT(*) as total_syncs,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_syncs,
          SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) as failed_syncs,
          AVG(duration_ms) as avg_duration_ms,
          MAX(timestamp) as last_sync
        FROM sync_history
        WHERE 1=1
      `;
      const params = [];

      if (days) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        query += ' AND timestamp >= ?';
        params.push(cutoffDate.toISOString());
      }

      query += ' GROUP BY server_name ORDER BY server_name';

      const stmt = this.db.prepare(query);
      const stats = stmt.all(...params);

      // Calculate success rate for each server
      stats.forEach(stat => {
        if (stat.total_syncs > 0) {
          stat.success_rate = ((stat.successful_syncs / stat.total_syncs) * 100).toFixed(2) + '%';
        } else {
          stat.success_rate = 'N/A';
        }
      });

      this.logger.debug('Retrieved per-server statistics', {
        serverCount: stats.length,
        days
      });

      return stats;
    } catch (error) {
      this.logger.error('Failed to retrieve per-server statistics', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get recent errors
   * @param {number} limit - Maximum number of errors to return
   * @returns {Array} - Array of error records
   */
  getRecentErrors(limit = 10) {
    try {
      const stmt = this.db.prepare(`
        SELECT *
        FROM sync_history
        WHERE status = 'failure'
        ORDER BY timestamp DESC
        LIMIT ?
      `);

      const errors = stmt.all(limit);

      this.logger.debug('Retrieved recent errors', {
        count: errors.length,
        limit
      });

      return errors;
    } catch (error) {
      this.logger.error('Failed to retrieve recent errors', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get last sync for a server
   * @param {string} serverName - Server name
   * @returns {Object|null} - Last sync record or null
   */
  getLastSync(serverName) {
    try {
      const stmt = this.db.prepare(`
        SELECT *
        FROM sync_history
        WHERE server_name = ?
        ORDER BY timestamp DESC
        LIMIT 1
      `);

      const record = stmt.get(serverName);

      this.logger.debug('Retrieved last sync', {
        serverName,
        found: !!record
      });

      return record || null;
    } catch (error) {
      this.logger.error('Failed to retrieve last sync', {
        error: error.message,
        serverName
      });
      throw error;
    }
  }

  /**
   * Get all unique server names from sync history with metadata
   * @returns {Array} - Array of {server_name, sync_count, last_sync}
   */
  getAllServerNames() {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          server_name,
          COUNT(*) as sync_count,
          MAX(timestamp) as last_sync
        FROM sync_history
        GROUP BY server_name
        ORDER BY server_name
      `);

      const servers = stmt.all();

      this.logger.debug('Retrieved all server names from history', {
        count: servers.length
      });

      return servers;
    } catch (error) {
      this.logger.error('Failed to retrieve server names', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get recent syncs for dashboard display
   * @param {number} limit - Maximum number of records to return
   * @returns {Array} - Array of sync records formatted for dashboard
   */
  getRecentSyncs(limit = 50) {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          id,
          timestamp,
          server_name as serverName,
          status,
          duration_ms as duration,
          accounts_processed as accountsProcessed,
          accounts_succeeded as accountsSucceeded,
          accounts_failed as accountsFailed,
          error_message as errorMessage,
          error_code as errorCode,
          correlation_id as correlationId
        FROM sync_history
        ORDER BY timestamp DESC
        LIMIT ?
      `);

      const records = stmt.all(limit);

      this.logger.debug('Retrieved recent syncs for dashboard', {
        count: records.length,
        limit
      });

      return records;
    } catch (error) {
      this.logger.error('Failed to retrieve recent syncs', {
        error: error.message,
        limit
      });
      throw error;
    }
  }

  /**
   * Clean up old records based on retention policy
   * @returns {number} - Number of records deleted
   */
  cleanup() {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

      const stmt = this.db.prepare(`
        DELETE FROM sync_history
        WHERE timestamp < ?
      `);

      const result = stmt.run(cutoffDate.toISOString());

      if (result.changes > 0) {
        this.logger.info('Cleaned up old sync history records', {
          deletedRecords: result.changes,
          retentionDays: this.retentionDays,
          cutoffDate: cutoffDate.toISOString()
        });
      }

      // Vacuum database to reclaim space
      this.db.exec('VACUUM');

      return result.changes;
    } catch (error) {
      this.logger.error('Failed to clean up old records', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Reset sync history for a specific server
   * @param {string} serverName - Name of the server
   */
  async resetServerHistory(serverName) {
    try {
      const stmt = this.db.prepare('DELETE FROM sync_history WHERE server_name = ?');
      const result = stmt.run(serverName);

      this.logger.info('Sync history reset for server', {
        serverName,
        deletedRows: result.changes
      });

      return { success: true, deletedRows: result.changes };
    } catch (error) {
      this.logger.error('Failed to reset server history', {
        serverName,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Reset all sync history
   */
  async resetAllHistory() {
    try {
      const stmt = this.db.prepare('DELETE FROM sync_history');
      const result = stmt.run();

      this.logger.info('All sync history reset', {
        deletedRows: result.changes
      });

      return { success: true, deletedRows: result.changes };
    } catch (error) {
      this.logger.error('Failed to reset all history', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      try {
        this.db.close();
        this.logger.info('Sync history database closed');
        this.db = null;
      } catch (error) {
        this.logger.error('Error closing sync history database', {
          error: error.message
        });
        throw error;
      }
    }
  }

  /**
   * Get database path (for testing)
   */
  getDbPath() {
    return this.dbPath;
  }
}

module.exports = { SyncHistoryService };
