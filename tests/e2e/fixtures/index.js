/**
 * E2E fixture servers (#263).
 *
 * startFixtureServer(state) builds a REAL HealthCheckService (Express routes,
 * dashboard auth, WebSocket) on an ephemeral port, backed by a REAL
 * SyncHistoryService on a temp SQLite file. Only the edges are stubbed: the
 * sync callback, the server list, the cron schedules and the notification
 * service, so there is no Actual server and no network. The browser therefore
 * never sees mocked JSON; every response comes from the production routes.
 *
 * Time is fixed: both services read a mutable fixture clock, and states seed
 * history by stepping it back ("12 minutes ago") before each write. The browser
 * gets the same "now" through fake-timers (see browser.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { HealthCheckService } = require('../../../src/services/healthCheck');
const { SyncHistoryService } = require('../../../src/services/syncHistory');

// 2026-01-15 12:00 UTC. Any fixed instant works; this one is a weekday noon.
const FIXTURE_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE = 60 * 1000;

const loggerConfig = { logDir: null };

/**
 * A logger that records instead of printing, so seeded failures do not flood
 * the test output. The entries are written to tests/e2e/artifacts/ when a spec
 * fails (see browser.js). E2E_VERBOSE=1 also prints them.
 */
function captureLogger(serverLog) {
  const entry = (level) => (message, meta) => {
    serverLog.push({ level, message, meta });
    if (process.env.E2E_VERBOSE) console.log(`[server ${level}] ${message}`, meta || '');
  };
  return { debug: entry('DEBUG'), info: entry('INFO'), warn: entry('WARN'), error: entry('ERROR') };
}

function loadState(stateName) {
  const file = path.join(__dirname, 'states', `${stateName}.js`);
  if (!fs.existsSync(file)) throw new Error(`Unknown fixture state "${stateName}"`);
  return require(file);
}

/**
 * Seeding helpers handed to a state's seed(). Each write happens with the
 * clock stepped back, so both history rows and in-memory server statuses carry
 * the intended time, then the clock returns to FIXTURE_NOW.
 */
function seeder(clock, hc, history) {
  const at = (minutesAgo, fn) => {
    clock.t = FIXTURE_NOW - minutesAgo * MINUTE;
    try { return fn(); } finally { clock.t = FIXTURE_NOW; }
  };

  return {
    /**
     * One completed sync, recorded the way syncService records it: a history
     * row, plus the in-memory status (partial counts as success for health).
     * @param {string} serverName
     * @param {number} minutesAgo
     * @param {{ status?: 'success'|'partial'|'failure', succeeded?: number,
     *   failed?: number, skipped?: number, durationMs?: number, error?: string,
     *   errorCode?: string, historyOnly?: boolean }} opts
     */
    sync(serverName, minutesAgo, opts = {}) {
      const status = opts.status || 'success';
      at(minutesAgo, () => {
        history.recordSync({
          serverName,
          status,
          durationMs: opts.durationMs ?? 4000,
          accountsProcessed: (opts.succeeded ?? 0) + (opts.failed ?? 0),
          accountsSucceeded: opts.succeeded ?? 0,
          accountsFailed: opts.failed ?? 0,
          accountsSkipped: opts.skipped ?? 0,
          errorMessage: opts.error || null,
          errorCode: opts.errorCode || null,
          correlationId: `fixture-${serverName}-${minutesAgo}`
        });
        if (opts.historyOnly) return;
        hc.updateSyncStatus({
          status: status === 'failure' ? 'failure' : 'success',
          serverName,
          // A string, exactly as syncService passes it.
          error: opts.error || undefined
        });
      });
    },
    accounts(serverName, accounts) {
      at(0, () => history.replaceAccountMetadata(serverName, accounts));
    },
    serverVersion(serverName, info) {
      hc.updateServerVersion(serverName, info);
    }
  };
}

/**
 * Start a fixture server for a named state.
 * @param {string} stateName - a module in ./states
 * @param {Object} overrides - HealthCheckService options to override (e.g. { rateLimitMax: 60 })
 * @returns {Promise<{ url: string, port: number, close: Function, calls: { syncBank: string[] },
 *   sentNotifications: Object[], serverLog: Object[], state: Object, service: HealthCheckService }>}
 */
async function startFixtureServer(stateName, overrides = {}) {
  const state = loadState(stateName);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-sync-e2e-'));
  const clock = { t: FIXTURE_NOW - (state.uptimeSeconds ?? 86400) * 1000 };
  const now = () => new Date(clock.t);

  const calls = { syncBank: [] };
  const sentNotifications = [];
  const servers = state.servers.map(s => ({ ...s }));

  const serverLog = [];
  const history = new SyncHistoryService({ dbPath: path.join(dir, 'history.db'), now, loggerConfig });
  history.logger = captureLogger(serverLog);

  const notificationService = {
    config: {
      rateLimit: { minIntervalMinutes: 15, maxPerHour: 4 },
      webhooks: { discord: [{ url: 'https://discord.invalid/fixture' }], slack: [] }
    },
    getStats: () => state.notificationStats || {
      notificationsSentLastHour: 0,
      rateLimitRemaining: 4,
      perServerStats: {},
      consecutiveFailuresByServer: {},
      recentSyncsByServer: {}
    },
    // The test-notification route calls these per channel; capture instead of sending.
    sendDiscord: async (msg) => { sentNotifications.push({ channel: 'discord', msg }); },
    sendSlack: async (msg) => { sentNotifications.push({ channel: 'slack', msg }); },
    sendEmail: async (msg) => { sentNotifications.push({ channel: 'email', msg }); }
  };

  const hc = new HealthCheckService({
    port: 0,
    host: '127.0.0.1',
    now,
    rateLimitMax: 10000,
    loggerConfig,
    syncHistory: history,
    // /api/dashboard/metrics only checks that a Prometheus service exists.
    prometheusService: { getMetrics: async () => '', recordSync: () => {} },
    notificationService,
    dashboardConfig: { enabled: true, auth: state.auth || { type: 'none' } },
    getServers: () => servers,
    getCronSchedules: () => (state.schedules || []).map(s => ({
      ...s,
      nextInvocation: new Date(FIXTURE_NOW + (s.nextInMinutes ?? 60) * MINUTE).toISOString()
    })),
    syncBank: async (server) => { calls.syncBank.push(server.name); },
    ...overrides
  });

  hc.logger = captureLogger(serverLog);

  // startTime is stamped in the constructor, so uptime is FIXTURE_NOW - that.
  clock.t = FIXTURE_NOW;
  if (state.seed) state.seed(seeder(clock, hc, history));

  await hc.start();
  const url = `http://127.0.0.1:${hc.port}`;

  const close = async () => {
    // Browser keep-alive sockets would hold server.close() open.
    if (hc.server && hc.server.closeAllConnections) hc.server.closeAllConnections();
    await hc.stop();
    history.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { url, port: hc.port, close, calls, sentNotifications, serverLog, state, service: hc, now: FIXTURE_NOW };
}

module.exports = { startFixtureServer, FIXTURE_NOW };
