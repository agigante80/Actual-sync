/**
 * Prometheus Metrics Service
 * 
 * Exports application metrics in Prometheus format for monitoring and alerting.
 * Integrates with sync history and health check services for comprehensive observability.
 */

const promClient = require('prom-client');
const { createLogger } = require('../lib/logger');

class PrometheusService {
  /**
   * @param {Object} options - Prometheus service options
   * @param {Object} options.syncHistory - SyncHistoryService instance
   * @param {Object} options.loggerConfig - Logger configuration
   * @param {boolean} options.includeDefaultMetrics - Include Node.js default metrics (default: true)
   */
  constructor(options = {}) {
    this.syncHistory = options.syncHistory;
    this.logger = createLogger(options.loggerConfig || {});
    this.includeDefaultMetrics = options.includeDefaultMetrics !== false;

    // Create registry for this service
    this.register = new promClient.Registry();

    // Initialize metrics
    this.initializeMetrics();

    // Register default Node.js metrics if enabled
    if (this.includeDefaultMetrics) {
      promClient.collectDefaultMetrics({ register: this.register });
      this.logger.info('Prometheus default metrics enabled');
    }

    this.logger.info('Prometheus metrics service initialized');
  }

  /**
   * Initialize custom application metrics
   */
  initializeMetrics() {
    // Sync duration histogram (in seconds)
    this.syncDuration = new promClient.Histogram({
      name: 'actual_sync_duration_seconds',
      help: 'Duration of sync operations in seconds',
      labelNames: ['server', 'status'],
      buckets: [1, 5, 10, 30, 60, 120, 300, 600], // 1s to 10min
      registers: [this.register]
    });

    // Sync total counter
    this.syncTotal = new promClient.Counter({
      name: 'actual_sync_total',
      help: 'Total number of sync operations',
      labelNames: ['server', 'status'],
      registers: [this.register]
    });

    // Accounts processed gauge
    this.accountsProcessed = new promClient.Gauge({
      name: 'actual_sync_accounts_processed',
      help: 'Number of accounts successfully processed in last sync',
      labelNames: ['server'],
      registers: [this.register]
    });

    // Accounts failed gauge
    this.accountsFailed = new promClient.Gauge({
      name: 'actual_sync_accounts_failed',
      help: 'Number of accounts that failed in last sync',
      labelNames: ['server'],
      registers: [this.register]
    });

    // Last sync timestamp gauge
    this.lastSyncTime = new promClient.Gauge({
      name: 'actual_sync_last_sync_timestamp',
      help: 'Timestamp of last sync operation (Unix timestamp)',
      labelNames: ['server', 'status'],
      registers: [this.register]
    });

    // Success rate gauge (0-1)
    this.successRate = new promClient.Gauge({
      name: 'actual_sync_success_rate',
      help: 'Success rate of sync operations (0-1)',
      labelNames: ['server'],
      registers: [this.register]
    });

    // Error gauge
    this.syncErrors = new promClient.Gauge({
      name: 'actual_sync_errors_total',
      help: 'Total number of sync errors in history',
      labelNames: ['server', 'error_code'],
      registers: [this.register]
    });

    // Info metric (application metadata)
    this.appInfo = new promClient.Gauge({
      name: 'actual_sync_info',
      help: 'Application information',
      labelNames: ['version', 'node_version'],
      registers: [this.register]
    });

    // Set application info
    const packageJson = require('../../package.json');
    this.appInfo.labels(packageJson.version || '0.0.0', process.version).set(1);

    this.logger.debug('Prometheus metrics initialized');
  }

  /**
   * Record a sync operation
   * @param {Object} syncResult - Sync operation result
   * @param {string} syncResult.server - Server name
   * @param {string} syncResult.status - Sync status (success/error)
   * @param {number} syncResult.duration - Duration in milliseconds
   * @param {number} syncResult.accountsProcessed - Number of accounts processed
   * @param {number} syncResult.accountsFailed - Number of accounts failed
   * @param {string} syncResult.errorCode - Error code (if failed)
   */
  recordSync(syncResult) {
    const { server, status, duration, accountsProcessed = 0, accountsFailed = 0, errorCode } = syncResult;

    // Record duration (convert ms to seconds)
    this.syncDuration.labels(server, status).observe(duration / 1000);

    // Increment total counter
    this.syncTotal.labels(server, status).inc();

    // Update accounts gauges
    this.accountsProcessed.labels(server).set(accountsProcessed);
    this.accountsFailed.labels(server).set(accountsFailed);

    // Update last sync timestamp (Unix timestamp in seconds)
    this.lastSyncTime.labels(server, status).set(Date.now() / 1000);

    // Update error counter if failed
    if (status === 'error' && errorCode) {
      this.syncErrors.labels(server, errorCode).inc();
    }

    this.logger.debug('Recorded sync metrics', { server, status, duration });
  }

  /**
   * Update metrics from sync history
   * Pulls historical data to populate gauges and counters
   */
  async updateFromHistory() {
    if (!this.syncHistory) {
      this.logger.warn('Sync history not available, skipping history-based metrics');
      return;
    }

    try {
      // Get statistics for each server
      const servers = this.getUniqueServers();

      for (const server of servers) {
        const stats = this.syncHistory.getStatistics({ serverName: server });

        if (stats) {
          // Update success rate
          const rate = stats.total_syncs > 0 ? stats.successful_syncs / stats.total_syncs : 0;
          this.successRate.labels(server).set(rate);

          this.logger.debug('Updated success rate from history', { server, rate });
        }
      }

      this.logger.debug('Metrics updated from sync history');
    } catch (error) {
      this.logger.error('Failed to update metrics from history', { error: error.message });
    }
  }

  /**
   * Get unique server names from sync history
   * @returns {Array<string>} Array of server names
   */
  getUniqueServers() {
    if (!this.syncHistory || !this.syncHistory.db) {
      return [];
    }

    try {
      const stmt = this.syncHistory.db.prepare('SELECT DISTINCT server_name FROM sync_history ORDER BY server_name');
      const rows = stmt.all();
      return rows.map(row => row.server_name);
    } catch (error) {
      this.logger.error('Failed to get unique servers', { error: error.message });
      return [];
    }
  }

  /**
   * Get metrics in Prometheus format
   * @returns {Promise<string>} Metrics in Prometheus text format
   */
  async getMetrics() {
    try {
      // Update metrics from history before exporting
      await this.updateFromHistory();

      // Return metrics in Prometheus format
      return this.register.metrics();
    } catch (error) {
      this.logger.error('Failed to generate metrics', { error: error.message });
      throw error;
    }
  }

  /**
   * Get content type for Prometheus metrics
   * @returns {string} Content-Type header value
   */
  getContentType() {
    return this.register.contentType;
  }

  /**
   * Reset all metrics
   * Useful for testing
   */
  resetMetrics() {
    this.register.resetMetrics();
    this.logger.debug('Metrics reset');
  }

  /**
   * Close the service and cleanup resources
   */
  close() {
    this.register.clear();
    this.logger.info('Prometheus service closed');
  }
}

module.exports = PrometheusService;
