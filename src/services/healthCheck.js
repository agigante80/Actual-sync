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
   * @param {Object} options.notificationService - NotificationService instance (optional)
   * @param {Object} options.telegramBot - TelegramBotService instance (optional)
   * @param {Function} options.syncBank - Sync function for manual triggers (optional)
   * @param {Function} options.getServers - Function to get server list (optional)
   * @param {Function} options.getSchedules - Function to get schedule info (optional)
   * @param {Function} options.getCronSchedules - Function to get cron schedule details (optional)
   * @param {Object} options.loggerConfig - Logger configuration
   */
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.host = options.host || '0.0.0.0';
    this.prometheusService = options.prometheusService;
    this.syncHistory = options.syncHistory;
    this.notificationService = options.notificationService;
    this.telegramBot = options.telegramBot;
    this.syncBank = options.syncBank;
    this.getServers = options.getServers;
    this.getSchedules = options.getSchedules;
    this.getCronSchedules = options.getCronSchedules;
    this.dashboardConfig = options.dashboardConfig || { enabled: true, auth: { type: 'none' } };
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
   * Dashboard authentication middleware
   */
  dashboardAuth() {
    return (req, res, next) => {
      // Skip if dashboard is disabled
      if (!this.dashboardConfig.enabled) {
        return res.status(403).json({ error: 'Dashboard is disabled' });
      }

      const authConfig = this.dashboardConfig.auth || {};
      const authType = authConfig.type || 'none';

      // No authentication required
      if (authType === 'none') {
        return next();
      }

      // Basic authentication
      if (authType === 'basic') {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Basic ')) {
          res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
          return res.status(401).json({ error: 'Authentication required' });
        }

        const base64Credentials = authHeader.substring(6);
        const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
        const [username, password] = credentials.split(':');

        if (username === authConfig.username && password === authConfig.password) {
          return next();
        }

        this.logger.warn('Dashboard authentication failed', { 
          username, 
          remoteAddress: req.ip 
        });
        res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Token authentication
      if (authType === 'token') {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({ error: 'Authentication required' });
        }

        const token = authHeader.substring(7);

        if (token === authConfig.token) {
          return next();
        }

        this.logger.warn('Dashboard token authentication failed', { 
          remoteAddress: req.ip 
        });
        return res.status(401).json({ error: 'Invalid token' });
      }

      // Unknown auth type
      return res.status(500).json({ error: 'Invalid authentication configuration' });
    };
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

    // Dashboard UI (with authentication)
    this.app.get('/dashboard', this.dashboardAuth(), (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard.html'));
    });

    // Favicon (no authentication needed)
    this.app.get('/favicon.svg', (req, res) => {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.sendFile(path.join(__dirname, 'favicon.svg'));
    });

    // Dashboard API: Get status (with authentication)
    this.app.get('/api/dashboard/status', this.dashboardAuth(), (req, res) => {
      const uptime = Math.floor((Date.now() - new Date(this.status.startTime).getTime()) / 1000);
      
      // Get all configured servers from getServers function
      let allServers = {};
      if (this.getServers) {
        try {
          const configuredServers = this.getServers();
          // Initialize all servers with default status
          configuredServers.forEach(server => {
            const serverStatus = this.status.serverStatuses[server.name] || {
              status: 'pending',
              lastSync: null,
              error: null
            };
            
            // Get last sync status from sync history if available
            if (this.syncHistory) {
              try {
                const lastSync = this.syncHistory.getLastSync(server.name);
                if (lastSync) {
                  serverStatus.lastSyncStatus = lastSync.status;
                }
              } catch (error) {
                this.logger.debug('Failed to get last sync status for server', { 
                  serverName: server.name, 
                  error: error.message 
                });
              }
            }
            
            allServers[server.name] = serverStatus;
          });
        } catch (error) {
          this.logger.error('Failed to get configured servers', { error: error.message });
          // Fall back to only servers with sync history
          allServers = this.status.serverStatuses;
        }
      } else {
        // Fall back to only servers with sync history
        allServers = this.status.serverStatuses;
      }
      
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
        servers: allServers
      });
    });

    // Dashboard API: Get server encryption status and schedules
    this.app.get('/api/dashboard/servers', this.dashboardAuth(), (req, res) => {
      if (!this.getServers) {
        return res.status(503).json({ 
          error: 'Server list not available'
        });
      }

      try {
        const servers = this.getServers();
        const schedules = this.getSchedules ? this.getSchedules() : {};
        
        const serverInfo = servers.map(server => {
          // getSchedules() already returns human-readable formatted strings
          const formattedSchedule = schedules[server.name] || null;
          
          return {
            name: server.name,
            encrypted: !!(server.encryptionPassword && server.encryptionPassword.trim()),
            schedule: formattedSchedule
          };
        });
        
        res.json({ servers: serverInfo });
      } catch (error) {
        this.logger.error('Failed to get server information', { error: error.message });
        res.status(500).json({ error: 'Failed to get server information' });
      }
    });

    // Dashboard API: Get orphaned servers (in history but not in config)
    this.app.get('/api/dashboard/orphaned-servers', this.dashboardAuth(), (req, res) => {
      if (!this.syncHistory || !this.getServers) {
        return res.status(503).json({ 
          error: 'Service not available'
        });
      }

      try {
        // Get all configured server names
        const configuredServers = this.getServers();
        const configuredNames = configuredServers.map(s => s.name);
        
        // Get all servers from sync history
        const historyServers = this.syncHistory.getAllServerNames();
        
        // Find servers in history but not in config
        const orphaned = historyServers
          .filter(historyServer => !configuredNames.includes(historyServer.server_name))
          .map(server => ({
            server_name: server.server_name,
            sync_count: server.sync_count,
            last_sync: server.last_sync
          }));
        
        res.json({ orphaned });
      } catch (error) {
        this.logger.error('Failed to get orphaned servers', { error: error.message });
        res.status(500).json({ error: 'Failed to get orphaned servers' });
      }
    });

    // Dashboard API: Get cron schedules (with authentication)
    this.app.get('/api/dashboard/schedules', this.dashboardAuth(), (req, res) => {
      if (!this.getCronSchedules) {
        return res.status(503).json({ 
          error: 'Schedule information not available'
        });
      }

      try {
        const schedules = this.getCronSchedules();
        res.json({ schedules });
      } catch (error) {
        this.logger.error('Failed to get schedule information', { error: error.message });
        res.status(500).json({ error: 'Failed to get schedule information' });
      }
    });

    // Dashboard API: Dismiss server error (with authentication)
    this.app.post('/api/dashboard/dismiss-error', this.dashboardAuth(), (req, res) => {
      try {
        const { server } = req.body;
        
        if (!server) {
          return res.status(400).json({ error: 'Server name required' });
        }

        // Clear error from server status
        if (this.serverStatuses[server]) {
          delete this.serverStatuses[server].error;
          this.logger.info('Server error dismissed via dashboard', {
            server: server,
            remoteAddress: req.ip
          });
        }
        
        res.json({ success: true, message: 'Error dismissed' });
      } catch (error) {
        this.logger.error('Failed to dismiss error', {
          error: error.message
        });
        res.status(500).json({ error: 'Failed to dismiss error' });
      }
    });

    // Dashboard API: Trigger manual sync (with authentication)
    this.app.post('/api/dashboard/sync', this.dashboardAuth(), async (req, res) => {
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

    // Dashboard API: Reset sync history (with authentication)
    this.app.post('/api/dashboard/reset-history', this.dashboardAuth(), async (req, res) => {
      if (!this.syncHistory) {
        return res.status(503).json({ 
          error: 'Sync history service not available'
        });
      }

      try {
        const { server } = req.body;
        
        if (server && server !== 'all') {
          // Reset history for specific server
          await this.syncHistory.resetServerHistory(server);
          
          this.logger.info('Sync history reset for server via dashboard', {
            server: server,
            remoteAddress: req.ip
          });
          
          res.json({ 
            success: true, 
            message: `History reset for ${server}` 
          });
        } else if (server === 'all') {
          // Reset all history
          await this.syncHistory.resetAllHistory();
          
          this.logger.info('All sync history reset via dashboard', {
            remoteAddress: req.ip
          });
          
          res.json({ 
            success: true, 
            message: 'All history reset successfully' 
          });
        } else {
          return res.status(400).json({ 
            error: 'Server parameter required (use "all" for all servers)' 
          });
        }
      } catch (error) {
        this.logger.error('Failed to reset sync history', {
          error: error.message
        });
        res.status(500).json({ error: 'Failed to reset history' });
      }
    });

    // Dashboard API: Test notification channels (with authentication)
    this.app.post('/api/dashboard/test-notification', this.dashboardAuth(), async (req, res) => {
      const { channel } = req.body;

      if (!channel) {
        return res.status(400).json({ error: 'Channel parameter required' });
      }

      try {
        const testMessage = {
          serverName: 'Test Server',
          errorMessage: 'This is a test notification from Actual-sync',
          errorCode: 'TEST',
          timestamp: new Date().toISOString(),
          correlationId: `test-${Date.now()}`,
          context: {
            accountsProcessed: 5,
            accountsSucceeded: 4,
            accountsFailed: 1,
            durationMs: 1234
          }
        };

        let result = { success: false, message: '' };

        switch (channel) {
          case 'email':
            if (!this.notificationService?.emailTransporter) {
              return res.status(400).json({ error: 'Email not configured' });
            }
            await this.notificationService.notifyError(testMessage);
            result = { success: true, message: 'Test email sent successfully' };
            break;

          case 'discord':
            if (!this.notificationService?.webhooks?.discord?.length) {
              return res.status(400).json({ error: 'Discord not configured' });
            }
            await this.notificationService.notifyError(testMessage);
            result = { success: true, message: 'Test Discord message sent successfully' };
            break;

          case 'slack':
            if (!this.notificationService?.webhooks?.slack?.length) {
              return res.status(400).json({ error: 'Slack not configured' });
            }
            await this.notificationService.notifyError(testMessage);
            result = { success: true, message: 'Test Slack message sent successfully' };
            break;

          case 'teams':
            if (!this.notificationService?.webhooks?.teams?.length) {
              return res.status(400).json({ error: 'Microsoft Teams not configured' });
            }
            await this.notificationService.notifyError(testMessage);
            result = { success: true, message: 'Test Teams message sent successfully' };
            break;

          case 'telegram':
            if (!this.telegramBot) {
              return res.status(400).json({ error: 'Telegram bot not configured' });
            }
            await this.telegramBot.notifySync({
              status: 'failure',
              serverName: 'Test Server',
              duration: 1234,
              accountsProcessed: 4,
              accountsFailed: 1,
              error: 'This is a test notification'
            });
            result = { success: true, message: 'Test Telegram message sent successfully' };
            break;

          default:
            return res.status(400).json({ error: 'Invalid channel. Use: email, discord, slack, teams, or telegram' });
        }

        this.logger.info('Test notification sent via dashboard', {
          channel,
          remoteAddress: req.ip
        });

        res.json(result);
      } catch (error) {
        this.logger.error('Failed to send test notification', {
          channel,
          error: error.message
        });
        res.status(500).json({ 
          error: 'Failed to send test notification',
          details: error.message 
        });
      }
    });

    // Dashboard API: Get metrics in JSON format (with authentication)
    this.app.get('/api/dashboard/metrics', this.dashboardAuth(), async (req, res) => {
      if (!this.prometheusService) {
        return res.status(503).json({ 
          error: 'Metrics not available',
          message: 'Prometheus service not configured'
        });
      }

      if (!this.syncHistory) {
        return res.status(503).json({ 
          error: 'Sync history not available'
        });
      }

      try {
        // Get recent sync history for charts
        const recentSyncs = this.syncHistory.getRecentSyncs(50);
        
        // Calculate metrics by server
        const serverMetrics = {};
        const servers = [...new Set(recentSyncs.map(s => s.serverName))];
        
        servers.forEach(server => {
          const serverSyncs = recentSyncs.filter(s => s.serverName === server);
          const successCount = serverSyncs.filter(s => s.status === 'success').length;
          const failureCount = serverSyncs.filter(s => s.status === 'failure').length;
          
          // Calculate average duration (handle null values)
          const durationsWithValues = serverSyncs.filter(s => s.duration != null);
          const avgDuration = durationsWithValues.length > 0
            ? durationsWithValues.reduce((sum, s) => sum + s.duration, 0) / durationsWithValues.length
            : 0;
          
          serverMetrics[server] = {
            totalSyncs: serverSyncs.length,
            successCount,
            failureCount,
            successRate: serverSyncs.length > 0 ? successCount / serverSyncs.length : 0,
            avgDuration: Math.round(avgDuration),
            recentSyncs: serverSyncs.slice(0, 10).map(s => ({
              timestamp: s.timestamp,
              status: s.status,
              duration: s.duration || 0
            }))
          };
        });

        // Overall metrics
        const totalSyncs = recentSyncs.length;
        const successCount = recentSyncs.filter(s => s.status === 'success').length;
        const failureCount = recentSyncs.filter(s => s.status === 'failure').length;

        res.json({
          overall: {
            totalSyncs,
            successCount,
            failureCount,
            successRate: totalSyncs > 0 ? successCount / totalSyncs : 0
          },
          byServer: serverMetrics,
          timeline: recentSyncs.slice(0, 20).reverse().map(s => ({
            timestamp: s.timestamp,
            server: s.serverName,
            status: s.status,
            duration: s.duration
          }))
        });
      } catch (error) {
        this.logger.error('Failed to get dashboard metrics', { error: error.message });
        res.status(500).json({ 
          error: 'Failed to retrieve metrics',
          message: error.message
        });
      }
    });

    // Dashboard API: Get sync history (with authentication)
    this.app.get('/api/dashboard/history', this.dashboardAuth(), (req, res) => {
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
          path: '/ws/logs',
          clientTracking: true,
          perMessageDeflate: false
        });

        this.wss.on('connection', (ws, req) => {
          this.logger.info('WebSocket client connected', {
            remoteAddress: req.socket.remoteAddress
          });

          this.wsClients.add(ws);
          ws.isAlive = true;
          
          // Handle incoming messages (ping/pong keep-alive)
          ws.on('message', (data) => {
            try {
              const message = JSON.parse(data);
              if (message.type === 'ping') {
                // Respond to ping with pong
                ws.isAlive = true;
                ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
              }
            } catch (error) {
              // Ignore invalid messages
            }
          });

          // Handle native WebSocket pong
          ws.on('pong', () => {
            ws.isAlive = true;
          });

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

        // Server-side heartbeat to detect dead connections
        const heartbeatInterval = setInterval(() => {
          this.wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
              this.logger.debug('Terminating inactive WebSocket connection');
              return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping(); // Send native WebSocket ping frame
          });
        }, 45000); // Check every 45 seconds

        this.wss.on('close', () => {
          clearInterval(heartbeatInterval);
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
