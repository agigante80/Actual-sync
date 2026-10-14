/**
 * Health Check Service
 * 
 * Provides HTTP endpoints for monitoring service health and metrics.
 * Includes /health and /metrics endpoints for integration with monitoring systems.
 */

const express = require('express');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const path = require('path');
const { createLogger } = require('../lib/logger');
const { MessageFormatter } = require('../lib/messageFormatter');
const { resolveVersion } = require('../lib/version');
const { checkCredentials, WsTicketStore } = require('../lib/dashboardCredentials');
const moment = require('moment-timezone');
const { getRules, ruleState } = require('../lib/scheduleAlertRules');
const { resolveTimezone } = require('../lib/timezone');

// 16 KB JSON parser for configuration writes (#259), used by configWrite().
// markParser tags an error with fromBodyParser so jsonBodyErrors can tell a
// body-parser failure from a 4xx raised by a route. A corrupt gzip body arrives
// as createError(400, zlibErr) with no `type`, so only a marker works. (#259)
const markParser = (parser) => (req, res, next) =>
  parser(req, res, (e) => next(e && Object.assign(e, { fromBodyParser: true })));

const configJson = markParser(express.json({ limit: '16kb' }));

/**
 * Four-argument error middleware that answers body-parser failures as JSON
 * instead of Express's HTML error page. Registered after the global
 * express.json() and as the last element of every configWrite() chain. (#259)
 */
function jsonBodyErrors(err, req, res, next) {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json' });
  }
  if (err && (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported')) {
    return res.status(400).json({ error: 'invalid_body_encoding' });
  }
  // Any other 4xx body-parser failure (a corrupt gzip body, an aborted
  // request, a bad Content-Length) gets a JSON body, never Express's HTML page
  // with a stack trace. Only errors marked by markParser qualify: a 4xx that a
  // route passed to next(err) keeps its own status via the final handler.
  const status = err && (err.status || err.statusCode);
  if (err && err.fromBodyParser && status >= 400 && status < 500 && !res.headersSent) {
    return res.status(status).json({ error: 'invalid_body' });
  }
  return next(err);
}

/**
 * Fixed-window count of failed dashboard logins per client key. (#246)
 * Every method is synchronous; see dashboardAuth() for why that matters.
 * get() returns an entry whose window has ended until the sweep removes it,
 * so callers must compare resetTime themselves.
 */
class AuthFailureCounter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.entries = new Map();
    this.sweeper = null;
    this.arm();
  }

  /** Start the sweep timer (unref'd, so it never keeps the process alive). */
  arm() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (entry.resetTime <= now) this.entries.delete(key);
      }
    }, this.windowMs);
    this.sweeper.unref();
  }

  /** Stop the sweep timer. A later increment() re-arms it, so a restarted service still sweeps. (#286) */
  shutdown() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  get(key) {
    return this.entries.get(key);
  }

  increment(key) {
    this.arm();
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetTime <= now) {
      entry = { totalHits: 0, resetTime: now + this.windowMs };
      this.entries.set(key, entry);
    }
    entry.totalHits++;
    return entry;
  }
}

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
   * @param {Function} options.isSyncQueued - (serverName) => true while that server's sync waits or runs (optional)
   * @param {Function} options.getRunningSync - () => { key, startedAt } for the sync holding the queue, or null (optional, #272)
   * @param {Function} options.getServers - Function to get server list (optional)
   * @param {Function} options.getSchedules - Function to get schedule info (optional)
   * @param {Function} options.getCronSchedules - Function to get cron schedule details (optional)
   * @param {Object} options.loggerConfig - Logger configuration
   * @param {boolean} options.hsts - send Strict-Transport-Security (#243); off unless true
   * @param {boolean|number|string|string[]} options.trustProxy - Express 'trust proxy' value (#245); off when unset
   */
  constructor(options = {}) {
    // ?? not ||: port 0 asks the OS for a free port (the e2e fixtures, #263);
    // the real port is read back once listening.
    this.port = options.port ?? 3000;
    // Injectable clock and rate limit so the e2e fixtures render stable
    // timestamps and can drive many requests; production uses the defaults. (#263)
    this.now = options.now || (() => new Date());
    this.rateLimitMax = options.rateLimitMax ?? 60;
    // The timezone mute dates are read in (#261); production passes resolveTimezone(config).
    this.getTimezone = options.getTimezone || (() => resolveTimezone({}));
    this.host = options.host || '0.0.0.0';
    this.prometheusService = options.prometheusService;
    this.syncHistory = options.syncHistory;
    this.notificationService = options.notificationService;
    this.telegramBot = options.telegramBot;
    this.syncBank = options.syncBank;
    this.isSyncQueued = options.isSyncQueued || (() => false);
    this.getRunningSync = options.getRunningSync || (() => null);
    this.getServers = options.getServers;
    this.getSchedules = options.getSchedules;
    this.getCronSchedules = options.getCronSchedules;
    this.dashboardConfig = options.dashboardConfig || { enabled: true, auth: { type: 'none' } };
    this.logger = createLogger(options.loggerConfig || {});
    
    this.app = express();
    // Opt-in only (#245). Behind a reverse proxy every request comes from the
    // proxy's address, so the per-IP rate limit becomes one shared bucket and
    // auth-failure logs name the proxy. Trusting X-Forwarded-For on a directly
    // exposed instance would let any client pick its own IP, so it stays off
    // unless configured. express-rate-limit's own validation stays enabled.
    if (options.trustProxy !== undefined && options.trustProxy !== false) {
      this.app.set('trust proxy', options.trustProxy);
    } else {
      // Without trustProxy every request through a proxy shares the proxy's
      // address, so one guesser burns the dashboard login budget for everyone.
      // The header is the only sign of that, so warn once, on the first
      // request that carries it. (#286)
      let warned = false;
      this.app.use((req, res, next) => {
        if (!warned && req.headers['x-forwarded-for']) {
          warned = true;
          this.logger.warn('Request carries X-Forwarded-For but healthCheck.trustProxy is not set: all clients behind a proxy share one rate limit and one dashboard login failure budget. Set healthCheck.trustProxy if a reverse proxy you control is in front.', {
            remoteAddress: req.ip
          });
        }
        next();
      });
    }
    this.server = null;
    this.wsClients = new Set();
    // /ws/logs handshake state (#242)
    this.wsTickets = new WsTicketStore();
    this.wsConnectionsPerIp = new Map();
    this.maxWsConnectionsPerIp = 10;
    // Failed dashboard logins allowed per client IP per window (#246).
    this.authFailureLimit = options.authFailureLimit ?? 10;
    this.authFailureWindowMs = options.authFailureWindowMs ?? 15 * 60 * 1000;
    
    // Health status tracking
    this.status = {
      startTime: this.now().toISOString(),
      lastSyncTime: null,
      lastSyncStatus: 'pending',
      syncCount: 0,
      successCount: 0,
      failureCount: 0,
      lastError: null,
      serverStatuses: {},
      // Version compatibility per server (#154/#158), kept separate from
      // serverStatuses so a sync-status update never clobbers it.
      serverVersions: {}
    };
    // "Tested up to" = the installed @actual-app/api client version (#154).
    this.testedUpTo = null;
    
    // Security headers first, so every response carries them: static assets,
    // the 401 from the auth middleware, and body-parser's own errors. (#243)
    this.app.disable('x-powered-by');
    this.app.use(helmet(this.helmetOptions(options.hsts === true)));

    // Order matters (#259): helmet, then the rate limiter, then configRouter,
    // then the global body parser, then the routes. The limiter sits before
    // configRouter so a configWrite() route can answer 429; configRouter sits
    // before the global express.json() so a configWrite() route meets its own
    // 16 KB parser first. Every route that uses configWrite() is registered on
    // this.configRouter, never on this.app. Unmatched requests fall through to
    // the global parser (100 KB default, unchanged).
    this.app.use(this.createRateLimiter());
    this.configRouter = express.Router();
    this.app.use(this.configRouter);

    // Parse JSON bodies. jsonBodyErrors keeps a malformed body on the four
    // existing POSTs a JSON answer instead of Express's HTML page (#259).
    this.app.use(markParser(express.json()));
    this.app.use(jsonBodyErrors);
    
    this.setupRoutes();
  }

  /**
   * The per-IP rate limiter, mounted in the constructor (it used to be created
   * in setupRoutes(); it moved so configRouter sits behind it). (#259)
   */
  createRateLimiter() {
    return rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: this.rateLimitMax, // requests per minute per IP (60 unless a test overrides it)
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many requests, please try again later.',
      // The dashboard fetches /icon.png as its favicon + header logo on every
      // load; exempt this cacheable static asset so it never competes with the
      // dashboard API calls for the per-IP abuse budget. (#113)
      skip: (req) => req.path === '/icon.png' || req.path === '/vendor/chart.umd.min.js' || req.path === '/dashboard.js'
    });
  }

  /**
   * helmet configuration (#243).
   *
   * The dashboard page and script are same-origin only, so script-src is
   * 'self' with no 'unsafe-inline'; dashboard.html carries no inline script or
   * inline handler attribute (dashboard.js wires events with addEventListener).
   * style-src keeps 'unsafe-inline' because the page uses many style="..."
   * attributes and sets styles on rendered fragments; it only widens style
   * injection, not script execution. connect-src 'self' covers fetch() and the
   * same-origin /ws/logs WebSocket (CSP3: 'self' matches ws:/wss: of the same
   * host).
   *
   * Deliberately NOT sent: upgrade-insecure-requests (helmet's default). The
   * service is usually plain HTTP on a LAN, and that directive makes the browser
   * rewrite every subresource to https, which breaks the page. HSTS is opt-in
   * for the same reason; TLS belongs to the reverse proxy.
   *
   * @param {boolean} hsts - enable Strict-Transport-Security
   */
  helmetOptions(hsts) {
    return {
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          scriptSrcAttr: ["'none'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"]
        }
      },
      frameguard: { action: 'deny' },
      // includeSubDomains off: helmet adds it by default, and an operator
      // serving https://example.com would otherwise lock every plain-HTTP
      // subdomain (nas.example.com) out for 180 days (#243 round 1 L1).
      strictTransportSecurity: hsts ? { maxAge: 15552000, includeSubDomains: false } : false
    };
  }

  /**
   * Dashboard authentication middleware
   */
  dashboardAuth() {
    // One failure counter shared by every dashboard route, so the budget is per
    // client IP across /dashboard and /api/dashboard/*, not per route. (#246)
    //
    // Credentials are checked FIRST and only a wrong one is counted. An earlier
    // version ran express-rate-limit with skipSuccessfulRequests, which counts
    // every request up front and refunds it on 'finish': a correct request the
    // browser aborted (a reload during a slow sync) was never refunded, and a
    // burst of correct requests could briefly exceed the limit, so an operator
    // with the right password got locked out. Do not go back to that.
    if (!this.authFailures) {
      this.authFailures = new AuthFailureCounter(this.authFailureWindowMs);
    }

    // Synchronous on purpose: no await may sit between reading the count and
    // adding a failure. Node parses every request pipelined on one socket in
    // the same tick, so with an await in between (express-rate-limit's async
    // MemoryStore) all of them read the old count and a single write of 60
    // wrong guesses was checked in full against a limit of 10.
    // Named (not an anonymous arrow): the route-enumeration test in
    // dashboardWriteSecurity.test.js matches layers by layer.handle.name. (#259)
    const dashboardAuth = (req, res, next) => {
      // Skip if dashboard is disabled
      if (!this.dashboardConfig.enabled) {
        return res.status(403).json({ error: 'Dashboard is disabled' });
      }

      const authConfig = this.dashboardConfig.auth || {};
      const authType = authConfig.type || 'none';
      if (authType === 'none') return next();

      try {
        const key = ipKeyGenerator(req.ip || '');
        const seen = this.authFailures.get(key);
        // get() also returns entries whose window has ended (they are
        // only swept on a timer), so check resetTime or a lockout lasts up to
        // two windows.
        if (seen && seen.resetTime > Date.now() && seen.totalHits >= this.authFailureLimit) {
          this.logger.warn('Dashboard authentication throttled after repeated failures', {
            remoteAddress: req.ip,
            limit: this.authFailureLimit,
            windowMinutes: Math.round(this.authFailureWindowMs / 60000)
          });
          return res.status(429).json({ error: 'Too many failed authentication attempts, try again later' });
        }
        this.checkDashboardCredentials(req, res, next, authConfig, authType);
        if (res.locals.authFailed) this.authFailures.increment(key);
      } catch (err) {
        next(err);
      }
    };
    return dashboardAuth;
  }

  /**
   * Origin guard for state-changing requests (#259). Applied per route, after
   * dashboardAuth() (an unauthenticated cross-origin request gets 401 and
   * learns nothing about the origin policy), on every route whose method is
   * not GET, HEAD or OPTIONS. The route-enumeration test enforces that.
   *
   * - Origin decides when present; otherwise the Referer's origin does.
   * - No Origin, no Referer and no Sec-Fetch-Site: not a browser (curl, Home
   *   Assistant), accepted.
   * - Sec-Fetch-Site with neither Origin nor Referer is refused, even
   *   same-origin: a browser always adds Origin to a state-changing request.
   * - Origin: null, malformed values and unparseable Referers are refused.
   */
  checkOrigin() {
    // Named for the route-enumeration test (see dashboardAuth).
    const checkOrigin = (req, res, next) => {
      const { origin, referer } = req.headers;
      const candidate = origin !== undefined ? origin : referer;
      let ok;
      if (candidate === undefined) {
        ok = req.headers['sec-fetch-site'] === undefined;
      } else {
        ok = this.isAllowedOrigin(candidate, req.headers.host);
      }
      if (ok) return next();
      this.logger.warn('Request refused: origin not allowed', {
        method: req.method,
        path: req.path,
        origin: typeof candidate === 'string' ? candidate.slice(0, 200) : null,
        remoteAddress: req.ip
      });
      return res.status(403).json({ error: 'origin_rejected' });
    };
    return checkOrigin;
  }

  /** The rule state the dashboard shows and the PUT returns (#261). */
  publicRuleState(rule, override, now, timezone) {
    const st = ruleState({ rule, override: override || null, now, timezone });
    // muteEndDue is decided here, in the server timezone delivery uses, so the
    // client never compares the mute date with the browser's own date.
    return { enabled: st.enabled, mutedUntil: st.mutedUntil, reason: st.reason, lockedByConfig: st.lockedByConfig, muteEndDue: st.muteEndDue };
  }

  /**
   * PUT /api/dashboard/payments/:server/:alertId/state (#261). Validation
   * order: body shape, dates and reason, 404s, then 409. The given keys merge
   * into the stored override.
   */
  putPaymentAlertState(req, res) {
    const body = req.body;
    const KEYS = ['enabled', 'mutedUntil', 'reason'];
    const bad = (code, status = 400) => res.status(status).json({ error: code });
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('invalid_body');
    const given = Object.keys(body);
    if (given.length === 0 || given.some((k) => !KEYS.includes(k))) return bad('invalid_body');
    if ('enabled' in body && typeof body.enabled !== 'boolean') return bad('invalid_body');
    if ('mutedUntil' in body && body.mutedUntil !== null && typeof body.mutedUntil !== 'string') return bad('invalid_body');
    if ('reason' in body && body.reason !== null && typeof body.reason !== 'string') return bad('invalid_body');

    const timezone = this.getTimezone();
    const now = this.now();
    let reason;
    if (typeof body.mutedUntil === 'string') {
      const m = /^\d{4}-\d{2}-\d{2}$/.test(body.mutedUntil) ? moment.tz(body.mutedUntil, 'YYYY-MM-DD', true, timezone) : null;
      if (!m || !m.isValid() || m.format('YYYY-MM-DD') !== body.mutedUntil) return bad('invalid_muted_until');
      const today = moment.tz(now, timezone).startOf('day');
      const days = Math.round(m.clone().startOf('day').diff(today, 'days', true));
      if (days < 0 || days > 365) return bad('invalid_muted_until');
    }
    // A reason given with a date, or alone on a muted alert, passes the same
    // trim, required and length check (a long reason is rejected, never cut).
    if (typeof body.mutedUntil === 'string' || (typeof body.reason === 'string' && body.mutedUntil !== null)) {
      reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason === '') return bad('reason_required');
      if (reason.length > 200) return bad('invalid_reason');
    }

    const serverName = req.params.server;
    const alertId = req.params.alertId;
    const servers = this.getServers ? (this.getServers() || []) : [];
    const server = servers.find((s) => s.name === serverName);
    if (!server) return bad('server_not_found', 404);
    const rule = getRules(server.scheduleAlerts).find((r) => r.id === alertId);
    if (!rule) return bad('alert_not_found', 404);
    const unmuteOnly = body.mutedUntil === null && !('enabled' in body);
    if (rule.enabled === false && !unmuteOnly) return bad('disabled_in_config', 409);

    try {
      const before = this.syncHistory.getOverride(serverName, alertId);
      const next = {
        server: serverName,
        alertId,
        enabled: before ? before.enabled : true,
        mutedFrom: before ? before.mutedFrom : null,
        mutedUntil: before ? before.mutedUntil : null,
        reason: before ? before.reason : null
      };
      if ('enabled' in body) next.enabled = body.enabled;
      if (body.mutedUntil === null) {
        next.mutedFrom = null; next.mutedUntil = null; next.reason = null;
      } else if (typeof body.mutedUntil === 'string') {
        // An extension keeps the original start so the summary covers the whole period.
        next.mutedFrom = before && before.mutedUntil && before.mutedFrom ? before.mutedFrom : now.toISOString();
        next.mutedUntil = body.mutedUntil;
        next.reason = reason;
      } else if ('reason' in body && next.mutedUntil && typeof body.reason === 'string' && body.reason.trim() !== '') {
        next.reason = reason;
      }

      // One transaction: the held-back rows, the override and the audit row
      // change together or not at all. An early unmute drops the rows (no
      // summary; otherwise the latest 'muted' row would suppress the alert for good).
      const was = { enabled: before ? before.enabled : true, mutedUntil: before ? before.mutedUntil : null, reason: before ? before.reason : null };
      const stored = this.syncHistory.applyOverrideChange({
        server: serverName,
        alertId,
        override: next,
        dropMutedRows: Boolean(before && before.mutedUntil && next.mutedUntil === null),
        mutedSince: before && before.mutedFrom ? before.mutedFrom : undefined,
        remoteAddr: req.ip,
        auditChanges: (saved) => {
          const is = { enabled: saved ? saved.enabled : true, mutedUntil: saved ? saved.mutedUntil : null, reason: saved ? saved.reason : null };
          const changes = {};
          for (const field of Object.keys(was)) {
            if (was[field] !== is[field]) changes[field] = [was[field], is[field]];
          }
          return changes;
        }
      });
      return res.json({ ruleState: this.publicRuleState(rule, stored, now, timezone) });
    } catch (error) {
      this.logger.error('Failed to update payment alert state', { error: error.message });
      return res.status(500).json({ error: 'Failed to update payment alert state' });
    }
  }

  /** DELETE /api/dashboard/payments/:server/:alertId/state (#261): reset enabled and the mute. */
  deletePaymentAlertState(req, res) {
    const serverName = req.params.server;
    const alertId = req.params.alertId;
    try {
      const before = this.syncHistory.getOverride(serverName, alertId);
      if (!before) return res.status(404).json({ error: 'override_not_found' });
      const changes = {};
      if (before.enabled !== true) changes.enabled = [before.enabled, true];
      if (before.mutedUntil) {
        changes.mutedUntil = [before.mutedUntil, null];
        changes.reason = [before.reason, null];
      }
      this.syncHistory.applyOverrideChange({
        server: serverName,
        alertId,
        override: null,
        dropMutedRows: Boolean(before.mutedUntil),
        mutedSince: before.mutedFrom || undefined,
        remoteAddr: req.ip,
        auditChanges: () => changes
      });
      return res.json({ deleted: true });
    } catch (error) {
      this.logger.error('Failed to delete payment alert override', { error: error.message });
      return res.status(500).json({ error: 'Failed to delete payment alert override' });
    }
  }

  /** Why configuration writes are unavailable, or null when they are allowed. */
  configWritesReason() {
    if (this.dashboardConfig.allowConfigWrites !== true) return 'disabled';
    if ((this.dashboardConfig.auth?.type || 'none') === 'none') return 'auth-none';
    return null;
  }

  /** Refuses configuration writes unless enabled and auth is not none. (#259) */
  requireConfigWrites() {
    const requireConfigWrites = (req, res, next) => {
      const reason = this.configWritesReason();
      if (reason) return res.status(403).json({ error: 'config_writes_disabled', reason });
      return next();
    };
    return requireConfigWrites;
  }

  /**
   * The middleware chain for every route that changes configuration (#261,
   * #262): auth, Origin, writes enabled, a JSON-only 16 KB body, and last the
   * JSON error mapper (it must be part of the chain: Express runs an error
   * handler only for layers registered before it, so a router-level handler
   * would never see a route registered later). Register such routes on
   * this.configRouter, not this.app, so the 16 KB parser runs first.
   * @returns {Function[]}
   */
  configWrite() {
    const configBody = (req, res, next) => {
      const hasBody = req.headers['transfer-encoding'] !== undefined ||
        Number(req.headers['content-length']) > 0;
      if (!hasBody) {
        // body-parser leaves req.body undefined when there is no body.
        req.body = {};
        return next();
      }
      // req.is() is type-is, the matcher express.json() uses by default, so
      // this check and the parser cannot disagree.
      if (!req.is('application/json')) {
        return res.status(415).json({ error: 'invalid_content_type' });
      }
      return configJson(req, res, next);
    };
    return [
      this.dashboardAuth(),
      this.checkOrigin(),
      this.requireConfigWrites(),
      configBody,
      jsonBodyErrors
    ];
  }

  /**
   * Check the credentials once the failure throttle has let the request through.
   * A wrong credential sets res.locals.authFailed so the throttle counts it.
   */
  checkDashboardCredentials(req, res, next, authConfig, authType) {
    const result = checkCredentials(req.headers, authConfig);
    if (result.ok) return next();

    if (result.reason === 'config') {
      return res.status(500).json({ error: 'Invalid authentication configuration' });
    }

    if (authType === 'basic') {
      res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
      if (result.reason === 'missing') {
        return res.status(401).json({ error: 'Authentication required' });
      }
      res.locals.authFailed = true;
      // Never log the username: users paste passwords into that field. (#286)
      this.logger.warn('Dashboard authentication failed', {
        remoteAddress: req.ip
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Token authentication
    if (result.reason === 'missing') {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.locals.authFailed = true;
    this.logger.warn('Dashboard token authentication failed', {
      remoteAddress: req.ip
    });
    return res.status(401).json({ error: 'Invalid token' });
  }

  /**
   * Set up Express routes
   */
  setupRoutes() {
    // Health endpoint - simple alive check
    this.app.get('/health', (req, res) => {
      const uptime = Math.floor((this.now().getTime() - new Date(this.status.startTime).getTime()) / 1000);
      
      const health = {
        status: 'UP',
        timestamp: this.now().toISOString(),
        uptime: uptime,
        service: 'actual-sync',
        version: global.APP_VERSION || resolveVersion()
      };

      this.logger.debug('Health check requested', { uptime, remoteAddress: req.ip });
      res.json(health);
    });

    // Metrics endpoint - detailed sync metrics
    this.app.get('/metrics', (req, res) => {
      const uptime = Math.floor((this.now().getTime() - new Date(this.status.startTime).getTime()) / 1000);
      
      const metrics = {
        status: this.getOverallStatus(),
        timestamp: this.now().toISOString(),
        uptime: uptime,
        service: 'actual-sync',
        version: global.APP_VERSION || resolveVersion(),
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
        // /metrics has no authentication, so it names which server failed and
        // when, never the error text: that can carry bank or Actual messages.
        // The text stays on the authenticated dashboard. (#263)
        servers: Object.fromEntries(Object.entries(this.status.serverStatuses)
          .map(([name, { error, ...rest }]) => [name, rest])),
        lastError: this.status.lastError && {
          timestamp: this.status.lastError.timestamp,
          serverName: this.status.lastError.serverName
        }
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
                      (this.now().getTime() - new Date(this.status.startTime).getTime()) < 60000;
      
      if (isReady) {
        res.json({ status: 'READY', timestamp: this.now().toISOString() });
      } else {
        res.status(503).json({ 
          status: 'NOT_READY', 
          timestamp: this.now().toISOString(),
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

    // Project icon, served locally so the dashboard works offline (no external
    // GitHub fetch). Used as the favicon and the dashboard header logo. Cached
    // for an hour — long enough to avoid re-reads on every load, short enough
    // that a new release's icon propagates to returning users within the hour
    // (the asset has no cache-busting in its URL). Content-Type is applied only
    // on success; a missing file yields a clean 404 and any other error its real
    // status (500 when the sender did not classify it). No auth needed. (#113)
    this.app.get('/icon.png', (req, res) => {
      res.sendFile(path.join(__dirname, 'icon.png'), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }
      }, (err) => {
        if (err && !res.headersSent) res.status(err.statusCode || 500).end();
      });
    });

    // The dashboard's own script, split out of dashboard.html so the CSP can
    // forbid inline script. A single fixed route, like /icon.png. It is the page's
    // static code, not data, so it needs no auth (the API it calls does). (#243)
    this.app.get('/dashboard.js', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard.js'), {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }
      }, (err) => {
        if (err && !res.headersSent) res.status(err.statusCode || 500).end();
      });
    });

    // Chart.js, served from the npm dependency instead of a CDN so the dashboard
    // works offline and no third party can run script in the admin page. A single
    // fixed route (not a directory mount), so no other file under node_modules is
    // reachable and there is nothing to traverse. No auth, like /icon.png. (#244)
    // chart.js's package "exports" map does not expose its dist/ files, so the
    // bundle is located beside the resolved main entry (dist/chart.cjs).
    const chartJsPath = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
    this.app.get('/vendor/chart.umd.min.js', (req, res) => {
      res.sendFile(chartJsPath, {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }
      }, (err) => {
        if (err && !res.headersSent) res.status(err.statusCode || 500).end();
      });
    });

    // Dashboard API: Get status (with authentication)
    // Single-use ticket for the /ws/logs handshake: browsers cannot send an
    // Authorization header on a WebSocket, so the dashboard fetches one of
    // these over authenticated HTTP and passes it as ?ticket=. (#242)
    this.app.get('/api/dashboard/ws-ticket', this.dashboardAuth(), (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ ticket: this.wsTickets.mint(), expiresInSeconds: this.wsTickets.ttlMs / 1000 });
    });

    this.app.get('/api/dashboard/status', this.dashboardAuth(), (req, res) => {
      const uptime = Math.floor((this.now().getTime() - new Date(this.status.startTime).getTime()) / 1000);
      
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
                  // Per-account breakdown for the dashboard server card (#101)
                  serverStatus.lastSyncCounts = {
                    succeeded: lastSync.accounts_succeeded,
                    failed: lastSync.accounts_failed,
                    skipped: lastSync.accounts_skipped
                  };
                }
              } catch (error) {
                this.logger.debug('Failed to get last sync status for server', { 
                  serverName: server.name, 
                  error: error.message 
                });
              }
            }
            
            // Merge per-server version compatibility (#158)
            const versionInfo = this.status.serverVersions[server.name];
            if (versionInfo) {
              serverStatus.serverVersion = versionInfo.serverVersion;
              serverStatus.versionVerdict = versionInfo.verdict;
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
        version: global.APP_VERSION || resolveVersion(),
        // "Tested up to" @actual-app/api client version (#154/#158)
        testedUpTo: this.testedUpTo,
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
        // The sync holding the queue, so a hung one is visible by name and age (#272).
        // Dashboard only: public /health must not disclose server names.
        runningSync: this.safeRunningSync(),
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
        const cronSchedules = this.getCronSchedules ? this.getCronSchedules() : [];
        
        // Create a map of server name to cron info
        const cronMap = {};
        cronSchedules.forEach(schedule => {
          schedule.servers.forEach(serverName => {
            cronMap[serverName] = {
              cron: schedule.cron,
              cronHuman: schedule.cronHuman,
              nextInvocation: schedule.nextInvocation
            };
          });
        });
        
        const serverInfo = servers.map(server => {
          const cronInfo = cronMap[server.name];
          
          return {
            name: server.name,
            encrypted: !!(server.encryptionPassword && server.encryptionPassword.trim()),
            schedule: cronInfo ? cronInfo.nextInvocation : null,
            cron: cronInfo ? cronInfo.cron : null,
            cronHuman: cronInfo ? cronInfo.cronHuman : null,
            nextInvocation: cronInfo ? cronInfo.nextInvocation : null
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
    this.app.post('/api/dashboard/dismiss-error', this.dashboardAuth(), this.checkOrigin(), (req, res) => {
      try {
        const { server } = req.body;
        
        if (!server || typeof server !== 'string') {
          return res.status(400).json({ error: 'Server name required' });
        }

        // Validate server name exists in serverStatuses (prevents prototype pollution).
        // Statuses live on this.status; a bare this.serverStatuses is undefined and
        // made every dismiss a 500 (#264).
        const serverStatuses = this.status.serverStatuses;
        if (!Object.prototype.hasOwnProperty.call(serverStatuses, server)) {
          return res.status(404).json({ error: 'Server not found' });
        }

        // Clear error from server status (using safer approach)
        if (Object.prototype.hasOwnProperty.call(serverStatuses[server], 'error')) {
          delete serverStatuses[server].error;
          // The card stops highlighting the failure; the "failure" badge from sync
          // history stays. The next sync replaces this object, clearing the flag.
          serverStatuses[server].errorDismissed = true;
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
    this.app.post('/api/dashboard/sync', this.dashboardAuth(), this.checkOrigin(), async (req, res) => {
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
          
          // Don't await - trigger async. syncBank queues each server, so they
          // run one at a time in config order, never concurrently (#265).
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

          if (this.isSyncQueued(server)) {
            return res.json({ success: true, message: 'Sync already queued' });
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
    this.app.post('/api/dashboard/reset-history', this.dashboardAuth(), this.checkOrigin(), async (req, res) => {
      if (!this.syncHistory) {
        return res.status(503).json({ 
          error: 'Sync history service not available'
        });
      }

      try {
        const { server } = req.body;
        
        if (server && server !== 'all') {
          if (typeof server !== 'string') {
            return res.status(400).json({ error: 'invalid_server' });
          }
          if (server.length > 200) {
            return res.status(400).json({ error: 'server_name_too_long' });
          }
          // Only a configured server, or an orphan that still has history rows
          // (the orphaned-servers cleanup), can be reset. Anything else would
          // write a history_reset audit row for a name that never existed.
          const configured = this.getServers ? (this.getServers() || []).map(sv => sv.name) : null;
          const known = configured === null ||
            configured.includes(server) ||
            this.syncHistory.hasServerData(server);
          if (!known) {
            return res.status(404).json({ error: 'server_not_found' });
          }
          // Reset history for specific server
          await this.syncHistory.resetServerHistory(server, { remoteAddr: req.ip });
          
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
          await this.syncHistory.resetAllHistory({ remoteAddr: req.ip });
          
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
    this.app.post('/api/dashboard/test-notification', this.dashboardAuth(), this.checkOrigin(), async (req, res) => {
      const { channel } = req.body;

      if (!channel) {
        return res.status(400).json({ error: 'Channel parameter required' });
      }

      try {
        const os = require('os');
        const packageJson = require('../../package.json');
        
        const testMessage = {
          serverName: '🧪 Test Notification',
          errorMessage: `This is a test notification from Actual-sync service.

**Server Information:**
• Service Version: ${packageJson.version}
• Hostname: ${os.hostname()}
• Platform: ${os.platform()} ${os.arch()}
• Node.js: ${process.version}
• Uptime: ${Math.floor(process.uptime() / 60)} minutes
• Memory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB

This test verifies that notifications are configured correctly and can reach their destination.`,
          errorCode: 'TEST_NOTIFICATION',
          timestamp: new Date().toISOString(),
          correlationId: `test-${Date.now()}`,
          context: {
            testMode: true,
            configuredChannels: this.getConfiguredChannels()
          }
        };

        // One representative sync notification, built via the unified formatter
        // so a test looks like the real thing rather than a divergent ad-hoc
        // message (#110). Built once: three channels were assembling identical
        // copies, which is how they drift apart.
        const buildTestNotification = () => MessageFormatter.formatSyncNotification({
          status: 'success',
          serverName: '🧪 Test Notification',
          duration: 1234,
          accountsProcessed: 2,
          accountsFailed: 0,
          succeededAccounts: ['Checking', 'Savings'],
          skippedAccounts: [{ name: 'Old Loan', reason: 'closed' }]
        });

        let result;

        switch (channel) {
          case 'email':
            this.logger.info('Testing email notification', {
              hasNotificationService: !!this.notificationService,
              hasConfig: !!this.notificationService?.config,
              hasEmailConfig: !!this.notificationService?.config?.email,
              emailHost: this.notificationService?.config?.email?.host,
              emailTo: this.notificationService?.config?.email?.to,
              hasEmailTransporter: !!this.notificationService?.emailTransporter
            });
            if (!this.notificationService?.config?.email?.host || 
                !this.notificationService?.config?.email?.to?.length) {
              return res.status(400).json({ error: 'Email not configured' });
            }
            // Call sendEmail directly to bypass threshold checks
            const emailResult = await this.notificationService.sendEmail({
              serverName: testMessage.serverName,
              errorMessage: testMessage.errorMessage,
              errorCode: testMessage.errorCode,
              timestamp: testMessage.timestamp,
              correlationId: testMessage.correlationId,
              context: testMessage.context,
              consecutiveFailures: 1,
              thresholds: {
                consecutiveExceeded: false,
                rateExceeded: false,
                failureRate: 0,
                consecutiveFailures: 1
              }
            });
            if (emailResult && emailResult.success) {
              result = { success: true, message: 'Test email sent successfully' };
            } else {
              return res.status(500).json({ error: 'Failed to send email', details: emailResult?.error });
            }
            break;

          case 'discord':
            // Count only entries that would actually be sent to, so an all-disabled
            // array reports "not configured" instead of claiming success (#169).
            if (!this.notificationService?.config?.webhooks?.discord
                ?.filter(w => w.enabled !== false).length) {
              return res.status(400).json({ error: 'Discord not configured' });
            }
            // Call sendDiscordWebhooks directly
            const discordResults = await this.notificationService.sendDiscordWebhooks({
              serverName: testMessage.serverName,
              errorMessage: testMessage.errorMessage,
              errorCode: testMessage.errorCode,
              timestamp: testMessage.timestamp,
              correlationId: testMessage.correlationId,
              context: testMessage.context,
              consecutiveFailures: 1,
              thresholds: {
                consecutiveExceeded: false,
                rateExceeded: false,
                failureRate: 0,
                consecutiveFailures: 1
              }
            });
            if (discordResults && discordResults.length > 0 && discordResults[0].success) {
              result = { success: true, message: 'Test Discord message sent successfully' };
            } else {
              return res.status(500).json({ error: 'Failed to send Discord message' });
            }
            break;

          case 'slack':
            // Same as Discord above: disabled entries must not count as configured (#169).
            if (!this.notificationService?.config?.webhooks?.slack
                ?.filter(w => w.enabled !== false).length) {
              return res.status(400).json({ error: 'Slack not configured' });
            }
            // Call sendSlackWebhooks directly
            const slackResults = await this.notificationService.sendSlackWebhooks({
              serverName: testMessage.serverName,
              errorMessage: testMessage.errorMessage,
              errorCode: testMessage.errorCode,
              timestamp: testMessage.timestamp,
              correlationId: testMessage.correlationId,
              context: testMessage.context,
              consecutiveFailures: 1,
              thresholds: {
                consecutiveExceeded: false,
                rateExceeded: false,
                failureRate: 0,
                consecutiveFailures: 1
              }
            });
            if (slackResults && slackResults.length > 0 && slackResults[0].success) {
              result = { success: true, message: 'Test Slack message sent successfully' };
            } else {
              return res.status(500).json({ error: 'Failed to send Slack message' });
            }
            break;

          case 'telegram':
            if (!this.telegramBot || 
                !this.telegramBot.config?.botToken ||
                (!this.telegramBot.config?.chatId && !this.telegramBot.config?.chatIds?.length)) {
              return res.status(400).json({ error: 'Telegram bot not configured' });
            }
            const tgOs = require('os');
            const tgPackageJson = require('../../package.json');
            const testNotification = buildTestNotification();
            const testFooter = `\n\nThis is a test from Actual-sync (v${tgPackageJson.version} on ${tgOs.hostname()}, ${tgOs.platform()} ${tgOs.arch()}, Node.js ${process.version}). It verifies that Telegram notifications are working.`;
            await this.telegramBot.sendMessage(testNotification.text + testFooter);
            result = { success: true, message: 'Test Telegram message sent successfully' };
            break;

          case 'ntfy': {
            // ntfy is a first-class channel in the schema and the README, but
            // had no test path — so a typo'd topic URL stayed invisible until a
            // real failure needed to reach it (#182).
            const ntfyCfg = this.notificationService?.config?.ntfy;
            if (!ntfyCfg?.enabled || !ntfyCfg?.url) {
              return res.status(400).json({ error: 'ntfy not configured' });
            }
            const ntfyResult = await this.notificationService.sendNtfy(buildTestNotification().ntfy);
            if (!ntfyResult?.success) {
              return res.status(500).json({ error: 'Failed to send ntfy notification', details: ntfyResult?.error });
            }
            result = { success: true, message: 'Test ntfy notification sent successfully' };
            break;
          }

          case 'generic': {
            // Same as Slack/Discord above: an all-disabled array is NOT
            // configured, and must not report success (#169).
            const genericEntries = (this.notificationService?.config?.webhooks?.generic || [])
              .filter(w => w.url && w.enabled !== false);
            if (!genericEntries.length) {
              return res.status(400).json({ error: 'Generic webhooks not configured' });
            }
            // No `allow` predicate on purpose: this route proves delivery works,
            // so a per-entry errors_only must not silently skip the send and
            // still let us report success (#169).
            const genericResults = await this.notificationService
              .sendGenericWebhooks(buildTestNotification().generic);
            const genericDelivered = (genericResults || []).filter(r => r.success).length;
            if (!genericDelivered) {
              return res.status(500).json({
                error: 'Failed to send generic webhook',
                details: (genericResults || []).map(r => r.error).filter(Boolean).join('; ') || undefined
              });
            }
            // Report what actually happened. "Sent successfully" while two of
            // three endpoints refused is the dishonest-reporting bug #171 fixed
            // on the sync path; the same claim is no more true here.
            result = genericDelivered === genericResults.length
              ? { success: true, message: `Test generic webhook sent successfully (${genericDelivered}/${genericResults.length})` }
              : {
                success: true,
                message: `Test generic webhook partially delivered (${genericDelivered}/${genericResults.length})`,
                failed: genericResults.filter(r => !r.success).map(r => ({ name: r.name, error: r.error }))
              };
            break;
          }

          default:
            return res.status(400).json({
              error: 'Invalid channel. Use: email, discord, slack, telegram, ntfy, or generic'
            });
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
        const filters = { limit };
        // The History tab's server filter (#288). A repeated ?serverName=a&serverName=b
        // arrives as an array; only a single non-empty string is a filter.
        const { serverName } = req.query;
        if (typeof serverName === 'string' && serverName !== '') filters.serverName = serverName;
        const history = this.syncHistory.getHistory(filters);
        res.json(history);
      } catch (error) {
        this.logger.error('Failed to get sync history', {
          error: error.message
        });
        res.status(500).json({ error: 'Failed to retrieve history' });
      }
    });

    // Per-server account snapshot (syncable / manual / closed) persisted on each
    // sync. Lets the dashboard show which accounts actually bank-sync without a
    // live Actual connection. Returns [] (200) when nothing has been synced yet. (#99)
    this.app.get('/api/dashboard/accounts', this.dashboardAuth(), (req, res) => {
      if (!this.syncHistory) {
        return res.status(503).json({ error: 'Sync history not available' });
      }

      try {
        res.json(this.syncHistory.getAllAccountMetadata());
      } catch (error) {
        this.logger.error('Failed to get account metadata', { error: error.message });
        res.status(500).json({ error: 'Failed to retrieve account metadata' });
      }
    });

    // Payment alert snapshot (#260): what the #258 evaluation last said about
    // every watched schedule, persisted during each sync, so the dashboard
    // needs no connection to Actual. `lastAlertAt` is joined from the
    // schedule_alerts ledger at request time, not stored (the snapshot is saved
    // before the ledger is written for the same sync).
    this.app.get('/api/dashboard/payments', this.dashboardAuth(), (req, res) => {
      if (!this.getServers) {
        return res.status(503).json({ error: 'Server list not available' });
      }
      if (!this.syncHistory) {
        return res.status(503).json({ error: 'Sync history not available' });
      }

      // Only a single non-empty string selects a server: ?server=a&server=b,
      // ?server[]=x, ?server[a]=b and ?server= are all rejected.
      // Express 5's default "simple" query parser does not nest, so
      // `server[]=x` and `server[a]=b` arrive as the literal keys "server[]" and
      // "server[a]"; they are rejected by name rather than ignored.
      const requested = req.query.server;
      const bracketed = Object.keys(req.query).some((k) => k.startsWith('server['));
      if (bracketed || (requested !== undefined && (typeof requested !== 'string' || requested === ''))) {
        return res.status(400).json({ error: 'Invalid server parameter' });
      }

      try {
        // Matched by name against the configured list (never as an object key),
        // so `__proto__` is just an unknown server.
        let servers = this.getServers() || [];
        if (requested !== undefined) {
          const match = servers.find((s) => s.name === requested);
          if (!match) return res.status(404).json({ error: 'Server not found' });
          servers = [match];
        }

        const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

        const now = this.now();
        const timezone = this.getTimezone();
        const result = servers.map((server) => {
          if (!server.scheduleAlerts) {
            return { server: server.name, configured: false, lastRun: null, items: [] };
          }
          const rulesById = new Map(getRules(server.scheduleAlerts).map((r) => [r.id, r]));
          const overrides = new Map(this.syncHistory.listOverrides(server.name).map((o) => [o.alertId, o]));
          const { items, run } = this.syncHistory.getPaymentSnapshot(server.name);
          const lastSent = this.syncHistory.getLastSentAlerts(server.name);
          return {
            server: server.name,
            configured: true,
            lastRun: run,
            items: items.map((item) => ({
              ...item,
              lastAlertAt: lastSent.get(JSON.stringify([item.alertId, item.scheduleId])) || null,
              // Constant until #262 lands.
              source: 'config',
              ruleState: this.publicRuleState(rulesById.get(item.alertId), overrides.get(item.alertId), now, timezone),
              occurrences: item.occurrences.map((o) => ({
                ...o,
                daysLate: o.state === 'late' && o.receivedDate && o.deadline
                  ? daysBetween(o.deadline, o.receivedDate)
                  : null
              }))
            }))
          };
        });
        res.json({ servers: result });
      } catch (error) {
        this.logger.error('Failed to get payments', { error: error.message });
        res.status(500).json({ error: 'Failed to retrieve payments' });
      }
    });

    // Payment alert controls (#261). PUT and DELETE change configuration, so
    // they sit on configRouter behind configWrite(); the GET export is a plain
    // dashboard read.
    this.configRouter.put('/api/dashboard/payments/:server/:alertId/state', ...this.configWrite(), (req, res) => {
      this.putPaymentAlertState(req, res);
    });
    this.configRouter.delete('/api/dashboard/payments/:server/:alertId/state', ...this.configWrite(), (req, res) => {
      this.deletePaymentAlertState(req, res);
    });
    this.app.get('/api/dashboard/payment-overrides', this.dashboardAuth(), (req, res) => {
      if (!this.syncHistory) return res.status(503).json({ error: 'Sync history not available' });
      try {
        const servers = this.getServers ? (this.getServers() || []) : [];
        const known = new Map(servers.map((srv) => [srv.name, new Set(getRules(srv.scheduleAlerts).map((r) => r.id))]));
        const overrides = this.syncHistory.listOverrides().map((o) => ({
          server: o.server,
          alertId: o.alertId,
          enabled: o.enabled,
          mutedFrom: o.mutedFrom,
          mutedUntil: o.mutedUntil,
          reason: o.reason,
          updatedAt: o.updatedAt,
          orphaned: !(known.has(o.server) && known.get(o.server).has(o.alertId))
        }));
        res.json({ overrides });
      } catch (error) {
        this.logger.error('Failed to list payment overrides', { error: error.message });
        res.status(500).json({ error: 'Failed to retrieve payment overrides' });
      }
    });

    // Notification activity and how much rate-limit budget is left (#188).
    // Rate limiting was otherwise invisible: a user whose failure alerts were
    // being suppressed had no surface telling them so. `rateLimit` is echoed
    // alongside the counts because "remaining" means nothing without the
    // ceiling it counts down from.
    this.app.get('/api/dashboard/notifications', this.dashboardAuth(), (req, res) => {
      if (!this.notificationService) {
        return res.status(503).json({ error: 'Notification service not available' });
      }

      try {
        res.json({
          ...this.notificationService.getStats(),
          rateLimit: this.notificationService.config?.rateLimit
        });
      } catch (error) {
        this.logger.error('Failed to get notification stats', { error: error.message });
        res.status(500).json({ error: 'Failed to retrieve notification statistics' });
      }
    });

    // What the dashboard may do: whether configuration writes are available
    // and, when not, why. (#259)
    this.app.get('/api/dashboard/capabilities', this.dashboardAuth(), (req, res) => {
      const reason = this.configWritesReason();
      res.json({ configWrites: reason === null, reason });
    });

    // Configuration change audit, newest first. (#259)
    this.app.get('/api/dashboard/config-audit', this.dashboardAuth(), (req, res) => {
      if (!this.syncHistory) {
        return res.status(503).json({ error: 'Sync history not available' });
      }

      // One query value of 1 to 3 digits, then 1 to 200. A repeated ?limit
      // arrives as an array and fails the first step.
      let limit = 50;
      if (req.query.limit !== undefined) {
        const raw = req.query.limit;
        limit = typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
        if (!(limit >= 1 && limit <= 200)) {
          return res.status(400).json({ error: 'invalid_limit' });
        }
      }

      try {
        res.json({ entries: this.syncHistory.getConfigAudit({ limit }) });
      } catch (error) {
        this.logger.error('Failed to get configuration audit', { error: error.message });
        res.status(500).json({ error: 'Failed to retrieve configuration changes' });
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

    // Final error handler (#259): a thrown or passed error is logged and answered
    // as JSON. Express's default handler would render the stack trace as HTML.
    this.app.use((err, req, res, next) => {
      this.logger.error('Unhandled request error', {
        error: err && err.message,
        path: req.path,
        method: req.method
      });
      if (res.headersSent) return next(err);
      // A 4xx from a route or middleware keeps its status; never a stack. (#259)
      const status = err && (err.status || err.statusCode);
      if (status >= 400 && status < 500) {
        return res.status(status).json({ error: 'request_error' });
      }
      return res.status(500).json({ error: 'internal_error' });
    });
  }

  /**
   * Startup notices about configuration writes (#259), logged once from start().
   * allowedOrigins authorizes writes as well as the log stream, so say so.
   */
  logWriteConfigWarnings() {
    if (this.dashboardConfig.allowConfigWrites !== true) return;
    if (this.configWritesReason() === 'auth-none') {
      this.logger.error('dashboard.allowConfigWrites is true but dashboard.auth.type is "none": configuration writes stay refused. Enable basic or token auth to use them.');
    }
    const origins = this.dashboardConfig.allowedOrigins || [];
    if (origins.length > 0) {
      this.logger.warn('dashboard.allowedOrigins also authorizes state-changing requests: pages on these origins can submit configuration writes. Review the list.', {
        allowedOrigins: origins
      });
    }
  }

  /** getRunningSync() guarded, so a failing callback cannot break the status route. (#272) */
  safeRunningSync() {
    try {
      return this.getRunningSync() || null;
    } catch (error) {
      this.logger.debug('Failed to read the running sync', { error: error.message });
      return null;
    }
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
   * Get list of configured notification channels
   * @returns {Array<string>} Array of configured channel names
   */
  getConfiguredChannels() {
    const channels = [];
    
    if (this.notificationService?.config?.email?.host) {
      channels.push('Email');
    }
    if (this.notificationService?.config?.webhooks?.discord?.length > 0) {
      channels.push('Discord');
    }
    if (this.notificationService?.config?.webhooks?.slack?.length > 0) {
      channels.push('Slack');
    }
    if (this.telegramBot?.config?.botToken && 
        (this.telegramBot.config?.chatId || this.telegramBot.config?.chatIds?.length > 0)) {
      channels.push('Telegram');
    }
    
    return channels;
  }

  /**
   * Update sync status after a sync operation
   * @param {Object} syncResult - Result of sync operation
   * @param {string} syncResult.status - 'success' or 'failure'
   * @param {string} syncResult.serverName - Name of server synced
   * @param {Error} syncResult.error - Error object if sync failed
   */
  /**
   * Record per-server version compatibility (#154/#158). Stored separately from
   * serverStatuses so a later sync-status update does not overwrite it.
   * @param {string} serverName
   * @param {{ testedUpTo: string|null, serverVersion: string|null, verdict: string }} info
   */
  updateServerVersion(serverName, info = {}) {
    if (!serverName) return;
    this.status.serverVersions[serverName] = {
      serverVersion: info.serverVersion || null,
      verdict: info.verdict || 'unknown',
      checkedAt: this.now().toISOString()
    };
    if (info.testedUpTo) {
      this.testedUpTo = info.testedUpTo;
    }
  }

  updateSyncStatus(syncResult) {
    // syncService passes the error as a string; older callers passed an Error.
    // Reading only .message dropped the string, so server cards never showed
    // the failure text and lastError read "Unknown error". (#263)
    const errorText = typeof syncResult.error === 'string'
      ? syncResult.error
      : syncResult.error?.message;
    this.status.lastSyncTime = this.now().toISOString();
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
        message: errorText || 'Unknown error',
        timestamp: this.status.lastSyncTime,
        serverName: syncResult.serverName
      };
      
      // Update server-specific status
      this.status.serverStatuses[syncResult.serverName] = {
        lastSync: this.status.lastSyncTime,
        status: 'failure',
        error: errorText
      };
      
      this.logger.error('Sync status updated', { 
        serverName: syncResult.serverName,
        status: 'failure',
        error: errorText,
        totalSyncs: this.status.syncCount
      });
    }
  }

  /**
   * Admit or refuse a /ws/logs handshake. (#242)
   *
   * Authentication happens here, before the upgrade, so an unauthenticated
   * socket is never opened and never receives a log line.
   * - dashboard disabled: 403
   * - an Origin that is neither same-origin nor in dashboard.allowedOrigins:
   *   403, at every auth type. This is the Cross-Site WebSocket Hijacking
   *   guard. A request with no Origin is not from a browser and is let through
   *   to the credential check.
   * - more than maxWsConnectionsPerIp open sockets from one address (the
   *   trustProxy-resolved client address): 429
   * - auth type basic/token: a valid single-use ?ticket= from
   *   /api/dashboard/ws-ticket. Otherwise 401. The ticket is consumed first,
   *   so it dies with any refusal. An Authorization header is not accepted on
   *   the handshake (it would be an unthrottled password oracle).
   * @param {{origin?: string, req: import('http').IncomingMessage}} info
   * @param {Function} done - ws callback (result, code, message)
   */
  verifyWsClient(info, done) {
    const req = info.req;
    const remoteAddress = this.resolveWsClientIp(req);
    const refuse = (code, message) => {
      this.logger.warn('WebSocket handshake refused', { status: code, reason: message, remoteAddress });
      done(false, code, message);
    };

    const authConfig = this.dashboardConfig.auth || {};
    const needsTicket = (authConfig.type || 'none') !== 'none';

    // Spend the ticket before any other check, so a handshake refused for its
    // Origin, the cap or a disabled dashboard cannot leave a usable ticket
    // behind in a proxy access log (the URL carries it). (#280)
    let ticketOk = false;
    if (needsTicket) {
      let ticket = null;
      try {
        ticket = new URL(req.url, 'http://localhost').searchParams.get('ticket');
      } catch { /* malformed URL: no ticket */ }
      ticketOk = Boolean(ticket) && this.wsTickets.consume(ticket);
    }

    if (!this.dashboardConfig.enabled) return refuse(403, 'Dashboard is disabled');

    if (info.origin && !this.isAllowedOrigin(info.origin, req.headers.host)) {
      return refuse(403, 'Origin not allowed');
    }

    if ((this.wsConnectionsPerIp.get(remoteAddress) || 0) >= this.maxWsConnectionsPerIp) {
      return refuse(429, 'Too many connections');
    }

    if (!needsTicket) return done(true);

    // Ticket only. An Authorization header is deliberately NOT accepted here:
    // WebSocket upgrades bypass the Express rate limiter, so a header check on
    // the handshake would be an unthrottled password oracle. Scripts get a
    // ticket from /api/dashboard/ws-ticket with their header instead. (#242)
    if (ticketOk) return done(true);

    return refuse(401, 'Authentication required');
  }

  /**
   * The client address for the per-address socket cap and the handshake log.
   * Resolved the way Express resolves req.ip, so it honours healthCheck.trustProxy
   * (X-Forwarded-For only from trusted hops) and is the raw peer address when
   * that is off. A WebSocket upgrade never passes through Express, so req.ip is
   * not set on it. (#280)
   * @param {import('http').IncomingMessage} req
   * @returns {string}
   */
  resolveWsClientIp(req) {
    const probe = Object.create(this.app.request);
    probe.headers = req.headers;
    probe.socket = req.socket;
    return probe.ip || req.socket.remoteAddress;
  }

  /**
   * The one origin rule, shared by the /ws/logs handshake and the Origin guard
   * on state-changing requests (#242, #259). Same-origin is a host comparison
   * (port included), not scheme + host, so a TLS-terminating proxy that does
   * not set trustProxy still works: the service sees plain HTTP but the
   * browser's Origin says https. dashboard.allowedOrigins is the only extra
   * list; there is deliberately no separate write list.
   * @param {string} origin - the Origin header (or a Referer URL)
   * @param {string} host - the Host header
   * @returns {boolean} true when same-origin or listed in dashboard.allowedOrigins
   */
  isAllowedOrigin(origin, host) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (host && parsed.host === host) return true;
    const allowed = this.dashboardConfig.allowedOrigins || [];
    return allowed.some(entry => {
      try {
        return new URL(entry).origin === parsed.origin;
      } catch {
        return false;
      }
    });
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
    this.logWriteConfigWarnings();
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
          perMessageDeflate: false,
          verifyClient: (info, done) => this.verifyWsClient(info, done)
        });

        // ws forwards the underlying HTTP server's errors (e.g. a bind failure)
        // onto the WebSocket.Server. Without a listener that becomes an
        // 'Unhandled "error" event' / uncaught exception. The HTTP server's own
        // 'error' handler below does the real handling (fallback/reject); this
        // just prevents the forwarded copy from crashing the process. (#94)
        this.wss.on('error', (error) => {
          this.logger.debug('WebSocket server error (handled by HTTP server listener)', {
            error: error.message,
            code: error.code
          });
        });

        this.wss.on('connection', (ws, req) => {
          this.logger.info('WebSocket client connected', {
            remoteAddress: this.resolveWsClientIp(req)
          });

          this.wsClients.add(ws);
          ws.isAlive = true;
          const ip = this.resolveWsClientIp(req);
          this.wsConnectionsPerIp.set(ip, (this.wsConnectionsPerIp.get(ip) || 0) + 1);
          ws.once('close', () => {
            const left = (this.wsConnectionsPerIp.get(ip) || 1) - 1;
            if (left > 0) this.wsConnectionsPerIp.set(ip, left);
            else this.wsConnectionsPerIp.delete(ip);
          });
          
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

        let settled = false;
        const onListening = () => {
          settled = true;
          // Only port 0 needs the real port read back; calling address() when a
          // fixed port was requested would also break tests that mock this.server
          // as a plain EventEmitter with no address() method (#94's fallback
          // tests). (#263)
          if (this.port === 0) {
            this.port = this.server.address().port;
          }
          this.logger.info('Health check service started', {
            port: this.port,
            host: this.host,
            dashboard: `http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}/dashboard`
          });
          resolve();
        };
        // Register the success handler once for the server's lifetime. Passing it
        // as the listen() callback would re-register it on the fallback retry
        // below, so it would fire twice on success. (#94)
        this.server.once('listening', onListening);

        this.server.listen(this.port, this.host);

        this.server.on('error', (error) => {
          // A configured host the container can't bind (e.g. the Unraid host's LAN
          // IP in bridge mode) yields EADDRNOTAVAIL. Rather than failing — which
          // leaves the dashboard unreachable — fall back to 0.0.0.0 with a warning
          // so it still comes up. The guard on host !== '0.0.0.0' prevents a loop. (#94)
          if (error.code === 'EADDRNOTAVAIL' && this.host !== '0.0.0.0') {
            this.logger.warn('Could not bind health server to configured host; falling back to 0.0.0.0 (EADDRNOTAVAIL)', {
              configuredHost: this.host,
              port: this.port,
              error: error.message,
              hint: 'In containers set healthCheck.host to 0.0.0.0 — a host LAN IP is not bindable inside a bridge-networked container.'
            });
            this.host = '0.0.0.0';
            this.server.listen(this.port, this.host);
            return;
          }
          this.logger.error('Health check service error', {
            error: error.message,
            code: error.code
          });
          // This handler stays attached for the server's lifetime. A runtime error
          // AFTER a successful start must only be logged — tearing the service down
          // here would orphan the live listening socket. Only a startup failure
          // (before 'listening') cleans up and rejects, so we don't leak the
          // heartbeat timer or leave a never-listened server that makes a later
          // stop() reject with "Server is not running". (#94)
          if (settled) {
            return;
          }
          clearInterval(heartbeatInterval);
          try {
            this.server.removeListener('listening', onListening);
            if (this.wss) this.wss.close();
          } catch (cleanupErr) {
            this.logger.debug('Cleanup after failed health check start failed', { error: cleanupErr.message });
          }
          this.wss = null;
          this.server = null;
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
    if (this.authFailures) this.authFailures.shutdown();
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
