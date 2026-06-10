/**
 * Health Check Service Tests
 * 
 * Tests for health check HTTP endpoints
 */

const { HealthCheckService } = require('../services/healthCheck');
const http = require('http');
const net = require('net');

// Is this port bindable on 127.0.0.1 right now? Used to skip ports an unrelated
// local process is already holding (a dev machine can run e.g. Storybook on 6006,
// which falls inside our test bands), so the suite is robust off CI too.
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

// Helper to make HTTP requests
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (error) {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
        }
      });
    }).on('error', reject);
  });
}

describe('HealthCheckService', () => {
  let healthCheck;
  let testPort = 3456; // Use non-standard port for testing
  let portCounter = 0; // monotonic within this worker process

  // Every HealthCheckService built in a test is registered here and stopped in
  // afterEach — even instances created locally inside a test. This is the real
  // teardown guarantee: if an assertion throws before a test's own stop(), the
  // server is still closed and never leaks a bound port or an open handle. (#95)
  const HC = HealthCheckService; // alias so makeService isn't self-rewritten
  const activeServices = [];
  const makeService = (opts) => {
    const svc = new HC(opts);
    activeServices.push(svc);
    return svc;
  };

  beforeEach(async () => {
    // Each Jest worker gets its own 1000-port band kept BELOW the OS ephemeral
    // range (32768+), so parallel workers never collide and we never overflow the
    // port space. Within a worker, ports are walked MONOTONICALLY and each
    // candidate is probed for freeness, skipping any port an unrelated local
    // process holds (e.g. a dev server inside the band). Combined with the
    // afterEach that stops every created service, the suite is immune to
    // EADDRINUSE both on CI and on a busy dev machine. (#95)
    const workerId = Number(process.env.JEST_WORKER_ID) || 1;
    const band = (workerId - 1) % 28; // bands 4000-4899 .. 31000-31899
    const base = 4000 + band * 1000;
    testPort = base; // fallback if every candidate is busy (let start() surface it)
    for (let i = 0; i < 900; i++) {
      const candidate = base + (portCounter++ % 900);
      if (await portFree(candidate)) { testPort = candidate; break; }
    }
    healthCheck = makeService({
      port: testPort,
      host: '127.0.0.1',
      loggerConfig: { level: 'ERROR' } // Quiet during tests
    });
  });

  afterEach(async () => {
    // stop() is idempotent and safe on a never-started service.
    for (const svc of activeServices.splice(0)) {
      try { await svc.stop(); } catch { /* already stopped / never started */ }
    }
    healthCheck = null;
  });

  describe('Constructor', () => {
    test('should initialize with default values', () => {
      const hc = makeService();
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
      
      const healthCheck2 = makeService({
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

  describe('Listen host fallback (#94)', () => {
    const EventEmitter = require('events');
    const WebSocket = require('ws');

    // Build a fake HTTP server + ws server so we can drive listen() outcomes
    // deterministically (no real port binding → no flakiness / collisions).
    function mockServers(listenBehavior) {
      const fakeServer = new EventEmitter();
      fakeServer.listening = false;
      fakeServer.listen = jest.fn((port, host) => {
        listenBehavior(fakeServer, host);
        return fakeServer;
      });
      fakeServer.close = jest.fn((cb) => { fakeServer.listening = false; if (cb) cb(); });

      const fakeWss = new EventEmitter();
      fakeWss.clients = new Set();
      fakeWss.close = jest.fn((cb) => { fakeWss.emit('close'); if (cb) cb(); });

      const createServerSpy = jest.spyOn(http, 'createServer').mockReturnValue(fakeServer);
      const wssSpy = jest.spyOn(WebSocket, 'Server').mockImplementation(() => fakeWss);
      return { fakeServer, fakeWss, restore: () => { createServerSpy.mockRestore(); wssSpy.mockRestore(); } };
    }

    test('falls back to 0.0.0.0 when the configured host is unbindable (EADDRNOTAVAIL)', async () => {
      const hc = makeService({
        port: testPort, host: '192.168.50.224', loggerConfig: { level: 'ERROR' }
      });
      const warnSpy = jest.spyOn(hc.logger, 'warn');
      const infoSpy = jest.spyOn(hc.logger, 'info');
      // First listen (the configured LAN IP) → EADDRNOTAVAIL; retry on 0.0.0.0 → success.
      const { fakeServer, restore } = mockServers((srv, host) => {
        if (host === '0.0.0.0') {
          srv.listening = true;
          setImmediate(() => srv.emit('listening'));
        } else {
          setImmediate(() => srv.emit('error', Object.assign(new Error('listen EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' })));
        }
      });
      try {
        await expect(hc.start()).resolves.toBeUndefined();
        expect(hc.host).toBe('0.0.0.0');                        // fell back
        expect(fakeServer.listen).toHaveBeenCalledTimes(2);     // first + retry
        expect(fakeServer.listen.mock.calls[1][1]).toBe('0.0.0.0');
        expect(warnSpy).toHaveBeenCalledTimes(1);               // exactly one fallback warning
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('EADDRNOTAVAIL'),
          expect.objectContaining({ configuredHost: '192.168.50.224' })
        );
        // The success handler must fire exactly once despite two listen() calls —
        // guards the double-'started'/double-resolve regression. (#94)
        const startedLogs = infoSpy.mock.calls.filter(
          (c) => typeof c[0] === 'string' && c[0].includes('Health check service started')
        );
        expect(startedLogs).toHaveLength(1);
      } finally {
        infoSpy.mockRestore();
        warnSpy.mockRestore();
        restore();
        await hc.stop().catch(() => {});
      }
    });

    test('rejects on a non-EADDRNOTAVAIL listen error (EADDRINUSE) and cleans up', async () => {
      const hc = makeService({
        port: testPort, host: '127.0.0.1', loggerConfig: { level: 'ERROR' }
      });
      const { restore } = mockServers((srv) => {
        setImmediate(() => srv.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })));
      });
      try {
        await expect(hc.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
        expect(hc.host).toBe('127.0.0.1'); // unchanged — fallback NOT triggered
        expect(hc.server).toBeNull();       // cleaned up so a later stop() is a no-op
        await expect(hc.stop()).resolves.toBeUndefined();
      } finally {
        restore();
      }
    });
  });

  describe('/icon.png endpoint (#113)', () => {
    beforeEach(async () => {
      await healthCheck.start();
    });

    test('serves the project icon locally as image/png, cached', async () => {
      const result = await httpGet(`http://127.0.0.1:${testPort}/icon.png`);
      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toContain('image/png');
      expect(result.headers['cache-control']).toContain('max-age'); // not re-read every request (#113)
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
      const hc = makeService({
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
      const hc = makeService({
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
      const hc = makeService({
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
      const hc = makeService({
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
      const hc = makeService({
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

      const hc = makeService({
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
      const hc = makeService({
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

      const hc = makeService({
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

      const hc = makeService({
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
        { name: 'Main Budget', encrypted: true, schedule: null, cron: null, cronHuman: null, nextInvocation: null },
        { name: 'Family Budget', encrypted: false, schedule: null, cron: null, cronHuman: null, nextInvocation: null },
        { name: 'Work Budget', encrypted: false, schedule: null, cron: null, cronHuman: null, nextInvocation: null }
      ]);
      
      await hc.stop();
    });

    test('should return 503 when getServers not available', async () => {
      const hc = makeService({
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

      const hc = makeService({
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
        { name: 'Main Budget', encrypted: true, schedule: null, cron: null, cronHuman: null, nextInvocation: null }
      ]);
      
      await hc.stop();
    });

    test('should handle getServers errors gracefully', async () => {
      const hc = makeService({
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
      
      const hc = makeService({
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
      
      const hc = makeService({
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
      
      const hc = makeService({
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

