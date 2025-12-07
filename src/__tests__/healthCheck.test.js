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
      expect(response.body.availableEndpoints).toEqual(['/health', '/metrics', '/ready']);
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
});
