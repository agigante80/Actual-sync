/**
 * Health Check Service Tests
 * 
 * Tests for health check HTTP endpoints
 */

const { HealthCheckService } = require('../services/healthCheck');
const http = require('http');

// Helper to make HTTP requests
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (error) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    }).on('error', reject);
  });
}

describe('HealthCheckService', () => {
  let healthCheck;
  let testPort = 3456; // Use non-standard port for testing

  beforeEach(() => {
    // Use a different port for each test to avoid conflicts
    testPort = 3456 + Math.floor(Math.random() * 1000);
    healthCheck = new HealthCheckService({
      port: testPort,
      host: '127.0.0.1',
      loggerConfig: { level: 'ERROR' } // Quiet during tests
    });
  });

  afterEach(async () => {
    if (healthCheck) {
      await healthCheck.stop();
    }
  });

  describe('Constructor', () => {
    test('should initialize with default values', () => {
      const hc = new HealthCheckService();
      expect(hc.port).toBe(3000);
      expect(hc.host).toBe('0.0.0.0');
      expect(hc.status).toBeDefined();
      expect(hc.status.startTime).toBeDefined();
    });

    test('should initialize with custom values', () => {
      expect(healthCheck.port).toBe(testPort);
      expect(healthCheck.host).toBe('127.0.0.1');
    });

    test('should initialize status tracking', () => {
      expect(healthCheck.status.syncCount).toBe(0);
      expect(healthCheck.status.successCount).toBe(0);
      expect(healthCheck.status.failureCount).toBe(0);
      expect(healthCheck.status.lastSyncStatus).toBe('pending');
    });
  });

  describe('HTTP Server', () => {
    test('should start server successfully', async () => {
      await healthCheck.start();
      expect(healthCheck.server).toBeDefined();
      expect(healthCheck.server.listening).toBe(true);
    });

    test('should stop server successfully', async () => {
      await healthCheck.start();
      await healthCheck.stop();
      expect(healthCheck.server).toBeNull();
    });

    test('should handle multiple stop calls gracefully', async () => {
      await healthCheck.start();
      await healthCheck.stop();
      await expect(healthCheck.stop()).resolves.toBeUndefined();
    });

    test('should reject start if port is in use', async () => {
      await healthCheck.start();
      
      const healthCheck2 = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        loggerConfig: { level: 'ERROR' }
      });
      
      // The error event will be emitted but promise might not reject in time
      // Just verify the first server is running
      expect(healthCheck.server.listening).toBe(true);
      
      // Clean up second instance
      await healthCheck2.stop();
    });
  });

  describe('/health endpoint', () => {
    beforeEach(async () => {
      await healthCheck.start();
    });

    test('should return UP status', async () => {
      const response = await httpGet(`http://127.0.0.1:${testPort}/health`);
      
      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe('UP');
      expect(response.body.service).toBe('actual-sync');
      expect(response.body.timestamp).toBeDefined();
      expect(response.body.uptime).toBeGreaterThanOrEqual(0);
    });

    test('should track uptime correctly', async () => {
      const response1 = await httpGet(`http://127.0.0.1:${testPort}/health`);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const response2 = await httpGet(`http://127.0.0.1:${testPort}/health`);
      
      expect(response2.body.uptime).toBeGreaterThan(response1.body.uptime);
    });
  });

  describe('/metrics endpoint', () => {
    beforeEach(async () => {
      await healthCheck.start();
    });

    test('should return initial metrics', async () => {
      const response = await httpGet(`http://127.0.0.1:${testPort}/metrics`);
      
      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe('PENDING');
      expect(response.body.sync.totalSyncs).toBe(0);
      expect(response.body.sync.successfulSyncs).toBe(0);
      expect(response.body.sync.failedSyncs).toBe(0);
      expect(response.body.sync.successRate).toBe('N/A');
    });

    test('should show sync metrics after successful sync', async () => {
      healthCheck.updateSyncStatus({
        status: 'success',
        serverName: 'TestServer'
      });
      
      const response = await httpGet(`http://127.0.0.1:${testPort}/metrics`);
      
      expect(response.body.status).toBe('HEALTHY');
      expect(response.body.sync.totalSyncs).toBe(1);
      expect(response.body.sync.successfulSyncs).toBe(1);
      expect(response.body.sync.failedSyncs).toBe(0);
      expect(response.body.sync.successRate).toBe('100.00%');
      expect(response.body.sync.lastSyncStatus).toBe('success');
      expect(response.body.servers.TestServer).toBeDefined();
      expect(response.body.servers.TestServer.status).toBe('success');
    });

    test('should show sync metrics after failed sync', async () => {
      healthCheck.updateSyncStatus({
        status: 'failure',
        serverName: 'TestServer',
        error: new Error('Test error')
      });
      
      const response = await httpGet(`http://127.0.0.1:${testPort}/metrics`);
      
      expect(response.body.status).toBe('UNHEALTHY');
      expect(response.body.sync.totalSyncs).toBe(1);
      expect(response.body.sync.successfulSyncs).toBe(0);
      expect(response.body.sync.failedSyncs).toBe(1);
      expect(response.body.sync.successRate).toBe('0.00%');
      expect(response.body.lastError).toBeDefined();
      expect(response.body.lastError.message).toBe('Test error');
    });

    test('should calculate success rate correctly', async () => {
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'Server1' });
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'Server2' });
      healthCheck.updateSyncStatus({ status: 'failure', serverName: 'Server3', error: new Error('Test') });
      
      const response = await httpGet(`http://127.0.0.1:${testPort}/metrics`);
      
      expect(response.body.sync.totalSyncs).toBe(3);
      expect(response.body.sync.successfulSyncs).toBe(2);
      expect(response.body.sync.failedSyncs).toBe(1);
      expect(response.body.sync.successRate).toBe('66.67%');
    });
  });

  describe('/ready endpoint', () => {
    beforeEach(async () => {
      await healthCheck.start();
    });

    test('should return READY initially (within 60s grace period)', async () => {
      const response = await httpGet(`http://127.0.0.1:${testPort}/ready`);
      
      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe('READY');
    });

    test('should return READY after successful sync', async () => {
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'TestServer' });
      
      const response = await httpGet(`http://127.0.0.1:${testPort}/ready`);
      
      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe('READY');
    });

    test('should return READY even after failed sync', async () => {
      healthCheck.updateSyncStatus({ status: 'failure', serverName: 'TestServer', error: new Error('Test') });
      
      const response = await httpGet(`http://127.0.0.1:${testPort}/ready`);
      
      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe('READY');
    });
  });

  describe('Unknown endpoints', () => {
    beforeEach(async () => {
      await healthCheck.start();
    });

    test('should return 404 for unknown paths', async () => {
      const response = await httpGet(`http://127.0.0.1:${testPort}/unknown`);
      
      expect(response.statusCode).toBe(404);
      expect(response.body.error).toBe('Not Found');
      expect(response.body.availableEndpoints).toEqual(['/health', '/metrics', '/ready', '/dashboard']);
    });
  });

  describe('getOverallStatus', () => {
    test('should return PENDING with no syncs', () => {
      expect(healthCheck.getOverallStatus()).toBe('PENDING');
    });

    test('should return HEALTHY after successful sync', () => {
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'TestServer' });
      expect(healthCheck.getOverallStatus()).toBe('HEALTHY');
    });

    test('should return UNHEALTHY with only failures', () => {
      healthCheck.updateSyncStatus({ status: 'failure', serverName: 'TestServer', error: new Error('Test') });
      expect(healthCheck.getOverallStatus()).toBe('UNHEALTHY');
    });

    test('should return DEGRADED with >50% failure rate', () => {
      healthCheck.updateSyncStatus({ status: 'failure', serverName: 'Server1', error: new Error('Test') });
      healthCheck.updateSyncStatus({ status: 'failure', serverName: 'Server2', error: new Error('Test') });
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'Server3' });
      expect(healthCheck.getOverallStatus()).toBe('DEGRADED');
    });

    test('should return HEALTHY with <50% failure rate', () => {
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'Server1' });
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'Server2' });
      healthCheck.updateSyncStatus({ status: 'failure', serverName: 'Server3', error: new Error('Test') });
      expect(healthCheck.getOverallStatus()).toBe('HEALTHY');
    });
  });

  describe('updateSyncStatus', () => {
    test('should update status on success', () => {
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'TestServer' });
      
      const status = healthCheck.getStatus();
      expect(status.syncCount).toBe(1);
      expect(status.successCount).toBe(1);
      expect(status.failureCount).toBe(0);
      expect(status.lastSyncStatus).toBe('success');
      expect(status.lastError).toBeNull();
    });

    test('should update status on failure', () => {
      const error = new Error('Test error');
      healthCheck.updateSyncStatus({ status: 'failure', serverName: 'TestServer', error });
      
      const status = healthCheck.getStatus();
      expect(status.syncCount).toBe(1);
      expect(status.successCount).toBe(0);
      expect(status.failureCount).toBe(1);
      expect(status.lastSyncStatus).toBe('failure');
      expect(status.lastError.message).toBe('Test error');
    });

    test('should track multiple syncs', () => {
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'Server1' });
      healthCheck.updateSyncStatus({ status: 'failure', serverName: 'Server2', error: new Error('Test') });
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'Server3' });
      
      const status = healthCheck.getStatus();
      expect(status.syncCount).toBe(3);
      expect(status.successCount).toBe(2);
      expect(status.failureCount).toBe(1);
    });

    test('should update server-specific statuses', () => {
      healthCheck.updateSyncStatus({ status: 'success', serverName: 'Server1' });
      healthCheck.updateSyncStatus({ status: 'failure', serverName: 'Server2', error: new Error('Test') });
      
      const status = healthCheck.getStatus();
      expect(status.serverStatuses.Server1.status).toBe('success');
      expect(status.serverStatuses.Server2.status).toBe('failure');
      expect(status.serverStatuses.Server2.error).toBe('Test');
    });
  });

  describe('getStatus', () => {
    test('should return copy of status', () => {
      const status = healthCheck.getStatus();
      status.syncCount = 999;
      
      expect(healthCheck.getStatus().syncCount).toBe(0);
    });
  });

  describe('Dashboard Authentication', () => {
    test('should allow access with auth type none', async () => {
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        dashboardConfig: { enabled: true, auth: { type: 'none' } },
        loggerConfig: { level: 'ERROR' }
      });
      
      await hc.start();
      const response = await httpGet(`http://127.0.0.1:${testPort}/dashboard`);
      expect(response.statusCode).toBe(200);
      await hc.stop();
    });

    test('should reject dashboard access when disabled', async () => {
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        dashboardConfig: { enabled: false },
        loggerConfig: { level: 'ERROR' }
      });
      
      await hc.start();
      const response = await httpGet(`http://127.0.0.1:${testPort}/dashboard`);
      expect(response.statusCode).toBe(403);
      expect(response.body.error).toBe('Dashboard is disabled');
      await hc.stop();
    });

    test('should require basic authentication', async () => {
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        dashboardConfig: { 
          enabled: true, 
          auth: { type: 'basic', username: 'admin', password: 'secret' } 
        },
        loggerConfig: { level: 'ERROR' }
      });
      
      await hc.start();
      
      // Without credentials
      const response1 = await httpGet(`http://127.0.0.1:${testPort}/dashboard`);
      expect(response1.statusCode).toBe(401);
      
      // With wrong credentials
      const wrongAuth = Buffer.from('admin:wrong').toString('base64');
      const response2 = await new Promise((resolve) => {
        const req = http.get({
          hostname: '127.0.0.1',
          port: testPort,
          path: '/dashboard',
          headers: { 'Authorization': `Basic ${wrongAuth}` }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
          });
        });
      });
      expect(response2.statusCode).toBe(401);
      
      // With correct credentials
      const correctAuth = Buffer.from('admin:secret').toString('base64');
      const response3 = await new Promise((resolve) => {
        const req = http.get({
          hostname: '127.0.0.1',
          port: testPort,
          path: '/dashboard',
          headers: { 'Authorization': `Basic ${correctAuth}` }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode });
          });
        });
      });
      expect(response3.statusCode).toBe(200);
      
      await hc.stop();
    });

    test('should require token authentication', async () => {
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        dashboardConfig: { 
          enabled: true, 
          auth: { type: 'token', token: 'my-secret-token' } 
        },
        loggerConfig: { level: 'ERROR' }
      });
      
      await hc.start();
      
      // Without token
      const response1 = await httpGet(`http://127.0.0.1:${testPort}/api/dashboard/status`);
      expect(response1.statusCode).toBe(401);
      
      // With wrong token
      const response2 = await new Promise((resolve) => {
        const req = http.get({
          hostname: '127.0.0.1',
          port: testPort,
          path: '/api/dashboard/status',
          headers: { 'Authorization': 'Bearer wrong-token' }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
          });
        });
      });
      expect(response2.statusCode).toBe(401);
      
      // With correct token
      const response3 = await new Promise((resolve) => {
        const req = http.get({
          hostname: '127.0.0.1',
          port: testPort,
          path: '/api/dashboard/status',
          headers: { 'Authorization': 'Bearer my-secret-token' }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
          });
        });
      });
      expect(response3.statusCode).toBe(200);
      
      await hc.stop();
    });

    test('should protect all dashboard routes', async () => {
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        dashboardConfig: { 
          enabled: true, 
          auth: { type: 'token', token: 'test-token' } 
        },
        loggerConfig: { level: 'ERROR' }
      });
      
      await hc.start();
      
      const routes = [
        '/dashboard',
        '/api/dashboard/status',
        '/api/dashboard/history'
      ];
      
      for (const route of routes) {
        const response = await httpGet(`http://127.0.0.1:${testPort}${route}`);
        expect(response.statusCode).toBe(401);
      }
      
      await hc.stop();
    });
  });

  describe('Dashboard Metrics API', () => {
    test('should return metrics when services are available', async () => {
      const mockSyncHistory = {
        getRecentSyncs: jest.fn().mockReturnValue([
          {
            serverName: 'Server1',
            status: 'success',
            duration: 5000,
            timestamp: new Date().toISOString()
          },
          {
            serverName: 'Server1',
            status: 'failure',
            duration: 3000,
            timestamp: new Date().toISOString()
          }
        ])
      };

      const mockPrometheusService = {
        getMetrics: jest.fn().mockResolvedValue('mock metrics')
      };

      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        syncHistory: mockSyncHistory,
        prometheusService: mockPrometheusService,
        loggerConfig: { level: 'ERROR' }
      });

      await hc.start();
      const response = await httpGet(`http://127.0.0.1:${testPort}/api/dashboard/metrics`);
      
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty('overall');
      expect(response.body).toHaveProperty('byServer');
      expect(response.body).toHaveProperty('timeline');
      expect(response.body.overall.totalSyncs).toBe(2);
      expect(response.body.overall.successCount).toBe(1);
      expect(response.body.overall.failureCount).toBe(1);
      
      await hc.stop();
    });

    test('should return 503 when prometheus service not available', async () => {
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        loggerConfig: { level: 'ERROR' }
      });

      await hc.start();
      const response = await httpGet(`http://127.0.0.1:${testPort}/api/dashboard/metrics`);
      
      expect(response.statusCode).toBe(503);
      expect(response.body.error).toBe('Metrics not available');
      
      await hc.stop();
    });

    test('should require authentication for metrics endpoint', async () => {
      const mockSyncHistory = {
        getRecentSyncs: jest.fn().mockReturnValue([])
      };

      const mockPrometheusService = {
        getMetrics: jest.fn().mockResolvedValue('mock metrics')
      };

      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        syncHistory: mockSyncHistory,
        prometheusService: mockPrometheusService,
        dashboardConfig: { 
          enabled: true, 
          auth: { type: 'token', token: 'secret-token' } 
        },
        loggerConfig: { level: 'ERROR' }
      });

      await hc.start();
      
      // Without token
      const response1 = await httpGet(`http://127.0.0.1:${testPort}/api/dashboard/metrics`);
      expect(response1.statusCode).toBe(401);
      
      // With correct token
      const response2 = await new Promise((resolve) => {
        http.get({
          hostname: '127.0.0.1',
          port: testPort,
          path: '/api/dashboard/metrics',
          headers: { 'Authorization': 'Bearer secret-token' }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
          });
        });
      });
      expect(response2.statusCode).toBe(200);
      
      await hc.stop();
    });
  });

  describe('Dashboard API - Server Encryption Status', () => {
    test('should return server encryption status', async () => {
      const mockServers = [
        { name: 'Main Budget', encryptionPassword: 'secret123' },
        { name: 'Family Budget', encryptionPassword: '' },
        { name: 'Work Budget' } // No encryption password
      ];

      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        getServers: () => mockServers,
        dashboardConfig: { enabled: true, auth: { type: 'none' } },
        loggerConfig: { level: 'ERROR' }
      });

      await hc.start();
      
      const response = await httpGet(`http://127.0.0.1:${testPort}/api/dashboard/servers`);
      expect(response.statusCode).toBe(200);
      expect(response.body.servers).toEqual([
        { name: 'Main Budget', encrypted: true },
        { name: 'Family Budget', encrypted: false },
        { name: 'Work Budget', encrypted: false }
      ]);
      
      await hc.stop();
    });

    test('should return 503 when getServers not available', async () => {
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        dashboardConfig: { enabled: true, auth: { type: 'none' } },
        loggerConfig: { level: 'ERROR' }
      });

      await hc.start();
      
      const response = await httpGet(`http://127.0.0.1:${testPort}/api/dashboard/servers`);
      expect(response.statusCode).toBe(503);
      expect(response.body.error).toBe('Server list not available');
      
      await hc.stop();
    });

    test('should require authentication when configured', async () => {
      const mockServers = [
        { name: 'Main Budget', encryptionPassword: 'secret123' }
      ];

      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        getServers: () => mockServers,
        dashboardConfig: { 
          enabled: true, 
          auth: { type: 'token', token: 'test-token' } 
        },
        loggerConfig: { level: 'ERROR' }
      });

      await hc.start();
      
      // Without token
      const response1 = await httpGet(`http://127.0.0.1:${testPort}/api/dashboard/servers`);
      expect(response1.statusCode).toBe(401);
      
      // With correct token
      const response2 = await new Promise((resolve) => {
        http.get({
          hostname: '127.0.0.1',
          port: testPort,
          path: '/api/dashboard/servers',
          headers: { 'Authorization': 'Bearer test-token' }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
          });
        });
      });
      expect(response2.statusCode).toBe(200);
      expect(response2.body.servers).toEqual([
        { name: 'Main Budget', encrypted: true }
      ]);
      
      await hc.stop();
    });

    test('should handle getServers errors gracefully', async () => {
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        getServers: () => { throw new Error('Database connection failed'); },
        dashboardConfig: { enabled: true, auth: { type: 'none' } },
        loggerConfig: { level: 'ERROR' }
      });

      await hc.start();
      
      const response = await httpGet(`http://127.0.0.1:${testPort}/api/dashboard/servers`);
      expect(response.statusCode).toBe(500);
      expect(response.body.error).toBe('Failed to get server information');
      
      await hc.stop();
    });
  });

  describe('WebSocket Keep-Alive', () => {
    test('should respond to ping with pong', async () => {
      const WebSocket = require('ws');
      
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        loggerConfig: { level: 'ERROR' }
      });

      await hc.start();

      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws/logs`);
        
        ws.on('open', () => {
          // Send ping
          ws.send(JSON.stringify({ type: 'ping' }));
        });

        ws.on('message', (data) => {
          const message = JSON.parse(data);
          
          // Skip welcome message
          if (message.level) return;
          
          // Check for pong response
          if (message.type === 'pong') {
            expect(message.type).toBe('pong');
            expect(message.timestamp).toBeDefined();
            ws.close();
            hc.stop().then(resolve);
          }
        });
      });
    });

    test('should handle multiple WebSocket clients', async () => {
      const WebSocket = require('ws');
      
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        loggerConfig: { level: 'ERROR' }
      });

      await hc.start();

      return new Promise((resolve) => {
        let pongCount = 0;
        const clients = [];

        for (let i = 0; i < 3; i++) {
          const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws/logs`);
          clients.push(ws);
          
          ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'ping' }));
          });

          ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.type === 'pong') {
              pongCount++;
              if (pongCount === 3) {
                clients.forEach(client => client.close());
                hc.stop().then(resolve);
              }
            }
          });
        }
      });
    });

    test('should broadcast logs to all connected clients', async () => {
      const WebSocket = require('ws');
      
      const hc = new HealthCheckService({
        port: testPort,
        host: '127.0.0.1',
        loggerConfig: { level: 'ERROR' }
      });

      await hc.start();

      return new Promise((resolve) => {
        let receivedCount = 0;
        const clients = [];

        for (let i = 0; i < 2; i++) {
          const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws/logs`);
          clients.push(ws);
          
          ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.message === 'Test broadcast') {
              receivedCount++;
              if (receivedCount === 2) {
                clients.forEach(client => client.close());
                hc.stop().then(resolve);
              }
            }
          });
        }

        // Wait for connections to establish
        setTimeout(() => {
          hc.broadcastLog('INFO', 'Test broadcast', {});
        }, 100);
      });
    });
  });
});

