/**
 * Health Check Service
 * 
 * Provides HTTP endpoints for monitoring service health and metrics.
 * Includes /health and /metrics endpoints for integration with monitoring systems.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createLogger } = require('../lib/logger');

class HealthCheckService {
  /**
   * @param {Object} options - Health check service options
   * @param {number} options.port - HTTP port for health check endpoints
   * @param {string} options.host - Host to bind to
   * @param {Object} options.prometheusService - PrometheusService instance (optional)
   * @param {Object} options.loggerConfig - Logger configuration
   */
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.host = options.host || '0.0.0.0';
    this.prometheusService = options.prometheusService;
    this.logger = createLogger(options.loggerConfig || {});
    
    this.app = express();
    this.server = null;
    
    // Health status tracking
    this.status = {
      startTime: new Date().toISOString(),
      lastSyncTime: null,
      lastSyncStatus: 'pending',
      syncCount: 0,
      successCount: 0,
      failureCount: 0,
      lastError: null,
      serverStatuses: {}
    };
    
    this.setupRoutes();
  }

  /**
   * Set up Express routes
   */
  setupRoutes() {
    // Rate limiting middleware - prevent abuse
    const limiter = rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 60, // 60 requests per minute per IP
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many requests, please try again later.'
    });

    // Apply rate limiting to all routes
    this.app.use(limiter);

    // Health endpoint - simple alive check
    this.app.get('/health', (req, res) => {
      const uptime = Math.floor((Date.now() - new Date(this.status.startTime).getTime()) / 1000);
      
      const health = {
        status: 'UP',
        timestamp: new Date().toISOString(),
        uptime: uptime,
        service: 'actual-sync'
      };

      this.logger.debug('Health check requested', { uptime, remoteAddress: req.ip });
      res.json(health);
    });

    // Metrics endpoint - detailed sync metrics
    this.app.get('/metrics', (req, res) => {
      const uptime = Math.floor((Date.now() - new Date(this.status.startTime).getTime()) / 1000);
      
      const metrics = {
        status: this.getOverallStatus(),
        timestamp: new Date().toISOString(),
        uptime: uptime,
        service: 'actual-sync',
        sync: {
          lastSyncTime: this.status.lastSyncTime,
          lastSyncStatus: this.status.lastSyncStatus,
          totalSyncs: this.status.syncCount,
          successfulSyncs: this.status.successCount,
          failedSyncs: this.status.failureCount,
          successRate: this.status.syncCount > 0 
            ? ((this.status.successCount / this.status.syncCount) * 100).toFixed(2) + '%'
            : 'N/A'
        },
        servers: this.status.serverStatuses,
        lastError: this.status.lastError
      };

      this.logger.debug('Metrics requested', { 
        totalSyncs: this.status.syncCount,
        remoteAddress: req.ip 
      });
      
      res.json(metrics);
    });

    // Readiness endpoint - checks if service is ready to sync
    this.app.get('/ready', (req, res) => {
      const isReady = this.status.syncCount > 0 || 
                      (Date.now() - new Date(this.status.startTime).getTime()) < 60000;
      
      if (isReady) {
        res.json({ status: 'READY', timestamp: new Date().toISOString() });
      } else {
        res.status(503).json({ 
          status: 'NOT_READY', 
          timestamp: new Date().toISOString(),
          reason: 'No successful syncs yet'
        });
      }
    });

    // Prometheus metrics endpoint
    this.app.get('/metrics/prometheus', async (req, res) => {
      if (!this.prometheusService) {
        this.logger.warn('Prometheus metrics requested but service not configured');
        res.status(503).json({
          error: 'Prometheus metrics not available',
          message: 'PrometheusService not configured'
        });
        return;
      }

      try {
        const metrics = await this.prometheusService.getMetrics();
        res.set('Content-Type', this.prometheusService.getContentType());
        res.send(metrics);
        this.logger.debug('Prometheus metrics served', { remoteAddress: req.ip });
      } catch (error) {
        this.logger.error('Failed to serve Prometheus metrics', {
          error: error.message
        });
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Failed to generate metrics'
        });
      }
    });

    // 404 handler
    this.app.use((req, res) => {
      this.logger.warn('Unknown endpoint requested', { 
        path: req.path,
        method: req.method,
        remoteAddress: req.ip 
      });
      
      const endpoints = ['/health', '/metrics', '/ready'];
      if (this.prometheusService) {
        endpoints.push('/metrics/prometheus');
      }
      
      res.status(404).json({ 
        error: 'Not Found',
        availableEndpoints: endpoints
      });
    });
  }

  /**
   * Get overall service status based on recent sync results
   */
  getOverallStatus() {
    if (this.status.syncCount === 0) return 'PENDING';
    if (this.status.failureCount > 0 && this.status.successCount === 0) return 'UNHEALTHY';
    if (this.status.failureCount / this.status.syncCount > 0.5) return 'DEGRADED';
    if (this.status.lastSyncStatus === 'success') return 'HEALTHY';
    return 'HEALTHY';
  }

  /**
   * Update sync status after a sync operation
   * @param {Object} syncResult - Result of sync operation
   * @param {string} syncResult.status - 'success' or 'failure'
   * @param {string} syncResult.serverName - Name of server synced
   * @param {Error} syncResult.error - Error object if sync failed
   */
  updateSyncStatus(syncResult) {
    this.status.lastSyncTime = new Date().toISOString();
    this.status.syncCount++;
    
    if (syncResult.status === 'success') {
      this.status.lastSyncStatus = 'success';
      this.status.successCount++;
      this.status.lastError = null;
      
      // Update server-specific status
      this.status.serverStatuses[syncResult.serverName] = {
        lastSync: this.status.lastSyncTime,
        status: 'success'
      };
      
      this.logger.info('Sync status updated', { 
        serverName: syncResult.serverName,
        status: 'success',
        totalSyncs: this.status.syncCount
      });
    } else {
      this.status.lastSyncStatus = 'failure';
      this.status.failureCount++;
      this.status.lastError = {
        message: syncResult.error?.message || 'Unknown error',
        timestamp: this.status.lastSyncTime,
        serverName: syncResult.serverName
      };
      
      // Update server-specific status
      this.status.serverStatuses[syncResult.serverName] = {
        lastSync: this.status.lastSyncTime,
        status: 'failure',
        error: syncResult.error?.message
      };
      
      this.logger.error('Sync status updated', { 
        serverName: syncResult.serverName,
        status: 'failure',
        error: syncResult.error?.message,
        totalSyncs: this.status.syncCount
      });
    }
  }

  /**
   * Start the health check HTTP server
   * @returns {Promise<void>}
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, this.host, () => {
          this.logger.info('Health check service started', {
            host: this.host,
            port: this.port,
            endpoints: ['/health', '/metrics', '/ready']
          });
          resolve();
        });

        this.server.on('error', (error) => {
          this.logger.error('Health check service error', {
            error: error.message,
            code: error.code
          });
          reject(error);
        });
      } catch (error) {
        this.logger.error('Failed to start health check service', {
          error: error.message
        });
        reject(error);
      }
    });
  }

  /**
   * Stop the health check HTTP server
   * @returns {Promise<void>}
   */
  async stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error) => {
        if (error) {
          this.logger.error('Error stopping health check service', {
            error: error.message
          });
          reject(error);
        } else {
          this.logger.info('Health check service stopped');
          this.server = null;
          resolve();
        }
      });
    });
  }

  /**
   * Get current health status (for testing)
   */
  getStatus() {
    return { ...this.status };
  }
}

module.exports = { HealthCheckService };
