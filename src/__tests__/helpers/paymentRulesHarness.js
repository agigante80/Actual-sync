/**
 * Shared harness for the payment rule and preview route tests (#262): a real
 * HealthCheckService on an ephemeral port with a real SyncHistoryService, and a
 * raw http.request helper (no supertest), as in paymentOverrides.test.js.
 */
const path = require('path');
const http = require('http');
const { HealthCheckService } = require('../../services/healthCheck');
const { SyncHistoryService } = require('../../services/syncHistory');
const { createTempDir, cleanupTempDir } = require('./testHelpers');

const NOW = new Date('2026-10-14T08:00:00.000Z');
const BASIC = { type: 'basic', username: 'op', password: 'hunter2' };
const basicHeader = (pw = 'hunter2') => `Basic ${Buffer.from(`op:${pw}`).toString('base64')}`;

function makeSender(config) {
  return {
    config,
    calls: [],
    result: null,
    async sendTemplated(outputs) {
      this.calls.push(outputs);
      if (this.result) return this.result(outputs);
      return Object.fromEntries(Object.keys(outputs).map((key) => [key, { success: true }]));
    }
  };
}

function createHarness() {
  const state = { svc: null, history: null, dir: null, errors: [] };

  async function boot({ servers, config = { telegram: { enabled: true } }, dashboard = {}, sender, history } = {}) {
    state.dir = createTempDir();
    state.history = history || new SyncHistoryService({
      dbPath: path.join(state.dir, 'h.db'), loggerConfig: { level: 'ERROR' }, now: () => new Date(NOW)
    });
    state.sender = sender || makeSender(config);
    state.servers = servers || [{ name: 'Main', scheduleAlerts: { alerts: [{ id: 'cfg-rent', schedule: 'Rent' }] } }];
    state.svc = new HealthCheckService({
      port: 0, host: '127.0.0.1', loggerConfig: { level: 'ERROR' }, now: () => new Date(NOW),
      getTimezone: () => 'UTC', syncHistory: state.history, getServers: () => state.servers,
      notificationService: state.sender,
      dashboardConfig: { enabled: true, allowConfigWrites: true, auth: BASIC, ...dashboard }
    });
    state.svc.logger = {
      debug() {}, info() {}, warn() {}, error: (msg, meta) => { state.errors.push([msg, meta]); }
    };
    await state.svc.start();
    return state;
  }

  async function cleanup() {
    if (state.svc) { try { await state.svc.stop(); } catch { /* not started */ } }
    if (state.history && state.history.db) state.history.close();
    if (state.dir) cleanupTempDir(state.dir);
    Object.assign(state, { svc: null, history: null, dir: null, errors: [] });
  }

  function call(method, reqPath, { body, headers = {}, auth = basicHeader() } = {}) {
    const hasBody = body !== undefined;
    const payload = hasBody ? (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: state.svc.port, path: reqPath, method,
        headers: Object.fromEntries(Object.entries({
          Connection: 'close',
          ...(auth ? { Authorization: auth } : {}),
          ...(hasBody ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }).filter(([, v]) => v !== undefined))
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, text, json });
        });
      });
      req.on('error', reject);
      if (hasBody) req.write(payload);
      req.end();
    });
  }

  return { state, boot, cleanup, call };
}

module.exports = { NOW, BASIC, basicHeader, makeSender, createHarness };
