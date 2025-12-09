/**
 * Health Check Service
 * 
 * Provides HTTP endpoints for monitoring service health and metrics.
 * Includes /health and /metrics endpoints for integration with monitoring systems.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { createLogger } = require('../lib/logger');

class HealthCheckService {
  /**
   * @param {Object} options - Health check service options
   * @param {number} options.port - HTTP port for health check endpoints
   * @param {string} options.host - Host to bind to
   * @param {Object} options.prometheusService - PrometheusService instance (optional)
   * @param {Object} options.syncHistory - SyncHistoryService instance (optional)
   * @param {Function} options.syncBank - Sync function for manual triggers (optional)
   * @param {Function} options.getServers - Function to get server list (optional)
   * @param {Object} options.loggerConfig - Logger configuration
   */
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.host = options.host || '0.0.0.0';
    this.prometheusService = options.prometheusService;
    this.syncHistory = options.syncHistory;
    this.syncBank = options.syncBank;
    this.getServers = options.getServers;
    this.logger = createLogger(options.loggerConfig || {});
    
    this.app = express();
    this.server = null;
    this.wsClients = new Set();
    
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
    
    // Parse JSON bodies
    this.app.use(express.json());
    
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
        service: 'actual-sync',
        version: global.APP_VERSION || process.env.VERSION || 'unknown'
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
        version: global.APP_VERSION || process.env.VERSION || 'unknown',
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

    // Dashboard UI
    this.app.get('/dashboard', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard.html'));
    });

    // Dashboard API: Get status
    this.app.get('/api/dashboard/status', (req, res) => {
      const uptime = Math.floor((Date.now() - new Date(this.status.startTime).getTime()) / 1000);
      
      res.json({
        status: this.getOverallStatus(),
        version: global.APP_VERSION || process.env.VERSION || 'unknown',
        uptime: uptime,
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
        servers: this.status.serverStatuses
      });
    });

    // Dashboard API: Trigger sync
    this.app.post('/api/dashboard/sync', async (req, res) => {
      if (!this.syncBank) {
        return res.status(503).json({ 
          error: 'Sync function not available',
          message: 'Manual sync is not configured'
        });
      }

      if (!this.getServers) {
        return res.status(503).json({ 
          error: 'Server list not available'
        });
      }

      try {
        const { server } = req.body;
        
        if (!server) {
          return res.status(400).json({ error: 'Server name required' });
        }

        const servers = this.getServers();
        
        if (server === 'all') {
          // Trigger sync for all servers
          this.logger.info('Manual sync triggered for all servers via dashboard', {
            remoteAddress: req.ip
          });
          
          // Don't await - trigger async
          Promise.all(servers.map(s => this.syncBank(s).catch(err => {
            this.logger.error('Manual sync failed', { 
              server: s.name, 
              error: err.message 
            });
          })));
          
          res.json({ success: true, message: 'Sync triggered for all servers' });
        } else {
          // Trigger sync for specific server
          const targetServer = servers.find(s => s.name === server);
          
          if (!targetServer) {
            return res.status(404).json({ 
              error: 'Server not found',
              availableServers: servers.map(s => s.name)
            });
          }

          this.logger.info('Manual sync triggered via dashboard', {
            server: server,
            remoteAddress: req.ip
          });
          
          // Don't await - trigger async
          this.syncBank(targetServer).catch(err => {
            this.logger.error('Manual sync failed', { 
              server: server, 
              error: err.message 
            });
          });
          
          res.json({ success: true, message: `Sync triggered for ${server}` });
        }
      } catch (error) {
        this.logger.error('Dashboard sync trigger failed', {
          error: error.message
        });
        res.status(500).json({ error: 'Failed to trigger sync' });
      }
    });

    // Dashboard API: Get sync history
    this.app.get('/api/dashboard/history', (req, res) => {
      if (!this.syncHistory) {
        return res.status(503).json({ 
          error: 'Sync history not available'
        });
      }

      try {
        const limit = parseInt(req.query.limit) || 10;
        const history = this.syncHistory.getHistory({ limit });
        res.json(history);
      } catch (error) {
        this.logger.error('Failed to get sync history', {
          error: error.message
        });
        res.status(500).json({ error: 'Failed to retrieve history' });
      }
    });

    // 404 handler
    this.app.use((req, res) => {
      this.logger.warn('Unknown endpoint requested', { 
        path: req.path,
        method: req.method,
        remoteAddress: req.ip 
      });
      
      const endpoints = ['/health', '/metrics', '/ready', '/dashboard'];
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
   * Broadcast log to WebSocket clients
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} metadata - Additional metadata
   */
  broadcastLog(level, message, metadata = {}) {
    const logData = JSON.stringify({
      level,
      message,
      metadata,
      timestamp: new Date().toISOString()
    });

    this.wsClients.forEach(client => {
      try {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(logData);
        }
      } catch (error) {
        this.logger.error('Failed to send log to WebSocket client', {
          error: error.message
        });
      }
    });
  }

  /**
   * Start the health check HTTP server with WebSocket support
   * @returns {Promise<void>}
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        const http = require('http');
        const WebSocket = require('ws');

        // Create HTTP server
        this.server = http.createServer(this.app);

        // Create WebSocket server
        this.wss = new WebSocket.Server({ 
          server: this.server,
          path: '/ws/logs'
        });

        this.wss.on('connection', (ws, req) => {
          this.logger.info('WebSocket client connected', {
            remoteAddress: req.socket.remoteAddress
          });

          this.wsClients.add(ws);

          ws.on('close', () => {
            this.logger.info('WebSocket client disconnected');
            this.wsClients.delete(ws);
          });

          ws.on('error', (error) => {
            this.logger.error('WebSocket client error', {
              error: error.message
            });
            this.wsClients.delete(ws);
          });

          // Send welcome message
          ws.send(JSON.stringify({
            level: 'info',
            message: 'Connected to Actual-sync log stream',
            timestamp: new Date().toISOString()
          }));
        });

        this.server.listen(this.port, this.host, () => {
          this.logger.info('Health check service started', {
            port: this.port,
            host: this.host,
            dashboard: `http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}/dashboard`
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

      // Close WebSocket connections
      if (this.wss) {
        this.wsClients.forEach(client => {
          client.close();
        });
        this.wsClients.clear();
        
        this.wss.close(() => {
          this.logger.info('WebSocket server closed');
        });
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
