/**
 * Dashboard write security (#259): the Origin check on every state-changing
 * route, the configWrite() chain, GET /capabilities and GET /config-audit.
 *
 * There is no supertest: these tests use a raw http.request against a real
 * HealthCheckService on an ephemeral port. They define their own helpers and do
 * not import from healthCheck.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { HealthCheckService } = require('../services/healthCheck');
const { SyncHistoryService } = require('../services/syncHistory');

const PUT_PATH = '/api/dashboard/__test/config-write';
const EVIL = 'https://evil.example';
const BASIC = { type: 'basic', username: 'op', password: 'hunter2' };
const basicHeader = (password = 'hunter2') => `Basic ${Buffer.from(`op:${password}`).toString('base64')}`;
const TOKEN = { type: 'token', token: 'good-token-123' };

const live = [];
const liveHistories = [];
const tmpDirs = [];

afterEach(async () => {
  for (const svc of live.splice(0)) {
    try { await svc.stop(); } catch { /* never started or already stopped */ }
  }
  for (const history of liveHistories.splice(0)) {
    try { history.close(); } catch { /* already closed */ }
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A real service on an ephemeral port with a real sync history, a sync stub
 * and a notification stub, so each test can assert whether a handler ran.
 */
async function makeService({ dashboard = {}, service = {}, noHistory = false, start = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-sync-wsec-'));
  tmpDirs.push(dir);
  let history;
  if (!noHistory) {
    history = new SyncHistoryService({ dbPath: path.join(dir, 'h.db'), loggerConfig: { level: 'ERROR' } });
    liveHistories.push(history);
  }
  const calls = { syncBank: [] };
  const notifier = {
    config: { webhooks: { discord: [{ url: 'https://discord.invalid/x' }], slack: [] } },
    sendDiscordWebhooks: jest.fn().mockResolvedValue([{ success: true }])
  };
  const svc = new HealthCheckService({
    port: 0,
    host: '127.0.0.1',
    loggerConfig: { level: 'ERROR' },
    syncHistory: history,
    notificationService: notifier,
    getServers: () => [{ name: 'Main' }],
    syncBank: async (server) => { calls.syncBank.push(server.name); },
    dashboardConfig: { enabled: true, auth: { type: 'none' }, ...dashboard },
    ...service
  });
  // Quiet: expected 4xx/5xx paths log errors. The startup-notice tests spy on these.
  svc.logger = { debug() {}, info() {}, warn() {}, error() {} };
  live.push(svc);
  svc.status.serverStatuses.Main = { error: 'boom' };
  if (start) await svc.start();
  return { svc, history, calls, notifier };
}

function request(svc, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: svc.port,
      path: reqPath,
      method,
      // A header set to undefined is dropped, so a test can remove a default one.
      headers: Object.fromEntries(Object.entries({
        Connection: 'close',
        ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      }).filter(([, value]) => value !== undefined))
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const own = (svc) => `http://127.0.0.1:${svc.port}`;
const post = (svc, route, payload, headers = {}) => request(svc, {
  method: 'POST',
  path: `/api/dashboard/${route}`,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(payload)
});

function seedHistory(history, serverName) {
  history.recordSync({
    serverName,
    status: 'success',
    durationMs: 10,
    accountsProcessed: 1,
    accountsSucceeded: 1,
    accountsFailed: 0,
    accountsSkipped: 0,
    correlationId: `c-${serverName}`
  });
}

// One entry per existing POST route: its payload and a snapshot of the state
// its handler would change, so a refused request can be shown to have left it
// untouched.
const POST_ROUTES = [
  {
    route: 'dismiss-error',
    payload: { server: 'Main' },
    effect: ({ svc }) => JSON.stringify(svc.status.serverStatuses.Main)
  },
  {
    route: 'sync',
    payload: { server: 'Main' },
    effect: ({ calls }) => calls.syncBank.length
  },
  {
    route: 'reset-history',
    payload: { server: 'Main' },
    effect: ({ history }) => history.getHistory({ limit: 50 }).length
  },
  {
    route: 'test-notification',
    payload: { channel: 'discord' },
    effect: ({ notifier }) => notifier.sendDiscordWebhooks.mock.calls.length
  }
];

describe('Origin check on the existing POST routes (#259)', () => {
  describe.each(POST_ROUTES)('POST /api/dashboard/$route', ({ route, payload, effect }) => {
    const refused = [
      ['a foreign Origin', () => ({ Origin: EVIL })],
      ['Origin: null', () => ({ Origin: 'null' })],
      ['a malformed Origin', () => ({ Origin: 'not a url' })],
      ['a foreign Referer and no Origin', () => ({ Referer: `${EVIL}/page` })],
      ['an unparseable Referer and no Origin', () => ({ Referer: 'not a url' })],
      ['Sec-Fetch-Site: cross-site without Origin or Referer', () => ({ 'Sec-Fetch-Site': 'cross-site' })],
      ['Sec-Fetch-Site: same-origin without Origin or Referer', () => ({ 'Sec-Fetch-Site': 'same-origin' })]
    ];

    test.each(refused)('403 origin_rejected for %s, and the handler does not run', async (name, headers) => {
      const ctx = await makeService();
      if (route === 'reset-history') seedHistory(ctx.history, 'Main');
      const before = effect(ctx);

      const res = await post(ctx.svc, route, payload, headers());

      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: 'origin_rejected' });
      expect(effect(ctx)).toEqual(before);
    });

    test('a same-origin Origin passes the guard', async () => {
      const ctx = await makeService();
      const res = await post(ctx.svc, route, payload, { Origin: own(ctx.svc) });
      expect(res.status).not.toBe(403);
    });

    test('a request with no Origin, Referer or Sec-Fetch-Site passes the guard', async () => {
      const ctx = await makeService();
      const res = await post(ctx.svc, route, payload);
      expect(res.status).not.toBe(403);
    });

    test('401 for a wrong password plus a foreign Origin: auth runs before origin', async () => {
      const ctx = await makeService({ dashboard: { auth: BASIC } });
      const res = await post(ctx.svc, route, payload, { Origin: EVIL, Authorization: basicHeader('wrong') });
      expect(res.status).toBe(401);
    });

    test('401, not 403, for no credentials plus a foreign Origin', async () => {
      const ctx = await makeService({ dashboard: { auth: BASIC } });
      const res = await post(ctx.svc, route, payload, { Origin: EVIL });
      expect(res.status).toBe(401);
      expect(res.json.error).not.toBe('origin_rejected');
    });

    test('429 with the limiter text once the per-IP budget is spent', async () => {
      const ctx = await makeService({ service: { rateLimitMax: 1 } });
      await post(ctx.svc, route, payload);
      const res = await post(ctx.svc, route, payload);
      expect(res.status).toBe(429);
      expect(res.text).toBe('Too many requests, please try again later.');
    });
  });

  describe('POST /api/dashboard/sync', () => {
    test('200 and one syncBank call for the service origin', async () => {
      const ctx = await makeService();
      const res = await post(ctx.svc, 'sync', { server: 'Main' }, { Origin: own(ctx.svc) });
      expect(res.status).toBe(200);
      expect(ctx.calls.syncBank).toEqual(['Main']);
    });

    test('200 with no Origin, Referer or Sec-Fetch-Site (curl, Home Assistant)', async () => {
      const ctx = await makeService();
      expect((await post(ctx.svc, 'sync', { server: 'Main' })).status).toBe(200);
    });

    test('200 with no Origin and a same-origin Referer', async () => {
      const ctx = await makeService();
      const res = await post(ctx.svc, 'sync', { server: 'Main' }, { Referer: `${own(ctx.svc)}/dashboard` });
      expect(res.status).toBe(200);
    });

    test('200 for Sec-Fetch-Site: same-origin with a matching Origin (the Origin decides)', async () => {
      const ctx = await makeService();
      const res = await post(ctx.svc, 'sync', { server: 'Main' }, {
        Origin: own(ctx.svc), 'Sec-Fetch-Site': 'same-origin'
      });
      expect(res.status).toBe(200);
    });

    test('403 for an Origin that is not in allowedOrigins', async () => {
      const ctx = await makeService({ dashboard: { allowedOrigins: ['https://budget.example'] } });
      const res = await post(ctx.svc, 'sync', { server: 'Main' }, { Origin: 'https://other.example' });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: 'origin_rejected' });
    });

    test('200 for an Origin listed in allowedOrigins', async () => {
      const ctx = await makeService({ dashboard: { allowedOrigins: ['https://budget.example'] } });
      const res = await post(ctx.svc, 'sync', { server: 'Main' }, { Origin: 'https://budget.example' });
      expect(res.status).toBe(200);
    });

    test('200 behind a TLS proxy without trustProxy: the Origin host matches the Host header', async () => {
      const ctx = await makeService();
      const res = await post(ctx.svc, 'sync', { server: 'Main' }, {
        Host: 'budget.example', Origin: 'https://budget.example'
      });
      expect(res.status).toBe(200);
    });

    test('401 {"error":"Invalid token"} for a wrong token', async () => {
      const ctx = await makeService({ dashboard: { auth: TOKEN } });
      const res = await post(ctx.svc, 'sync', { server: 'Main' }, { Authorization: 'Bearer nope' });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'Invalid token' });
    });
  });

  describe('POST /api/dashboard/reset-history', () => {
    test('400 without a server and 200 with one', async () => {
      const ctx = await makeService();
      seedHistory(ctx.history, 'Main');
      expect((await post(ctx.svc, 'reset-history', {})).status).toBe(400);
      expect((await post(ctx.svc, 'reset-history', { server: 'Main' })).status).toBe(200);
      expect(ctx.history.getHistory({ limit: 10 })).toHaveLength(0);
    });

    test('an unknown server is 404 server_not_found and writes no audit row (#259)', async () => {
      const ctx = await makeService();
      const res = await post(ctx.svc, 'reset-history', { server: 'Ghost' });
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: 'server_not_found' });
      expect(ctx.history.getConfigAudit({ limit: 10 })).toEqual([]);
    });

    test('an orphaned server (not configured, still has history) can be reset', async () => {
      const ctx = await makeService();
      seedHistory(ctx.history, 'Retired');
      const res = await post(ctx.svc, 'reset-history', { server: 'Retired' });
      expect(res.status).toBe(200);
      expect(ctx.history.getConfigAudit({ limit: 1 })[0].action).toBe('history_reset');
    });

    test('a server name over 200 characters is 400 before anything is stored (#259)', async () => {
      const ctx = await makeService();
      const res = await post(ctx.svc, 'reset-history', { server: 'x'.repeat(201) });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('server_name_too_long');
      expect(ctx.history.getConfigAudit({ limit: 10 })).toEqual([]);
    });

    test('the history_reset audit row carries req.ip, which honours trustProxy', async () => {
      const ctx = await makeService({ service: { trustProxy: 1 } });
      seedHistory(ctx.history, 'Main');
      const res = await post(ctx.svc, 'reset-history', { server: 'Main' }, { 'X-Forwarded-For': '198.51.100.7' });
      expect(res.status).toBe(200);
      const [row] = ctx.history.getConfigAudit({ limit: 1 });
      expect(row.action).toBe('history_reset');
      expect(row.remote_addr).toBe('198.51.100.7');
    });
  });

  describe('methods that are not guarded', () => {
    test('HEAD on a GET route is served, not refused', async () => {
      const ctx = await makeService();
      const res = await request(ctx.svc, { method: 'HEAD', path: '/api/dashboard/status', headers: { Origin: EVIL } });
      expect(res.status).toBe(200);
      expect(res.text).toBe('');
    });

    test('OPTIONS falls through to the 404 catch-all with no Allow or CORS header', async () => {
      const ctx = await makeService();
      const res = await request(ctx.svc, { method: 'OPTIONS', path: '/api/dashboard/sync', headers: { Origin: EVIL } });
      expect(res.status).toBe(404);
      expect(res.json.error).toBe('Not Found');
      expect(res.headers.allow).toBeUndefined();
      expect(Object.keys(res.headers).filter(h => h.startsWith('access-control-'))).toEqual([]);
    });
  });
});

/**
 * Walk the Express 5 router stack (descending into nested routers) and list
 * every route that is not GET, HEAD or OPTIONS-only and does not have a layer
 * named checkOrigin AFTER a layer named dashboardAuth.
 */
function findUnguardedRoutes(svc) {
  const unguarded = [];
  const visit = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).filter(m => m !== '_all');
        const all = Boolean(layer.route.methods._all);
        const safe = !all && methods.every(m => ['get', 'head', 'options'].includes(m));
        if (safe) continue;
        const names = layer.route.stack.map(l => l.handle.name);
        const auth = names.indexOf('dashboardAuth');
        const origin = names.indexOf('checkOrigin');
        if (auth < 0 || origin < 0 || origin < auth) {
          unguarded.push(`${(all ? ['ALL'] : methods).join(',').toUpperCase()} ${layer.route.path}`);
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        visit(layer.handle.stack);
      }
    }
  };
  visit(svc.app.router.stack);
  return unguarded;
}

describe('route enumeration guard (#259)', () => {
  const noop = (req, res) => res.end();

  test('every non-GET route of the real service has checkOrigin() after dashboardAuth()', async () => {
    const { svc } = await makeService({ start: false });
    expect(findUnguardedRoutes(svc)).toEqual([]);
  });

  test('the walk sees the four existing POST routes (so an empty result means something)', async () => {
    const { svc } = await makeService({ start: false });
    const posts = [];
    const visit = (stack) => stack.forEach(l => {
      if (l.route && l.route.methods.post) posts.push(l.route.path);
      else if (l.handle && Array.isArray(l.handle.stack)) visit(l.handle.stack);
    });
    visit(svc.app.router.stack);
    expect(posts.sort()).toEqual([
      '/api/dashboard/dismiss-error',
      '/api/dashboard/reset-history',
      '/api/dashboard/sync',
      '/api/dashboard/test-notification'
    ]);
  });

  test('fails for a throwaway POST on the app without the guard', async () => {
    const { svc } = await makeService({ start: false });
    svc.app.post('/__unguarded', noop);
    expect(findUnguardedRoutes(svc)).toEqual(['POST /__unguarded']);
  });

  test('fails for a route that has auth but no origin check, on a nested router', async () => {
    const { svc } = await makeService({ start: false });
    svc.configRouter.delete('/__auth-only', svc.dashboardAuth(), noop);
    expect(findUnguardedRoutes(svc)).toEqual(['DELETE /__auth-only']);
  });

  test('fails when checkOrigin() comes before dashboardAuth()', async () => {
    const { svc } = await makeService({ start: false });
    svc.app.put('/__wrong-order', svc.checkOrigin(), svc.dashboardAuth(), noop);
    expect(findUnguardedRoutes(svc)).toEqual(['PUT /__wrong-order']);
  });

  test('a route built with configWrite() on configRouter passes', async () => {
    const { svc } = await makeService({ start: false });
    svc.configRouter.put('/__ok', ...svc.configWrite(), noop);
    expect(findUnguardedRoutes(svc)).toEqual([]);
  });
});

describe('configWrite() chain (#259)', () => {
  /** A service with a throwaway PUT and DELETE registered AFTER construction. */
  async function makeWriteService(opts = {}) {
    const ctx = await makeService(opts);
    const ran = [];
    const handler = (req, res) => {
      ran.push(req.body);
      res.json({ ok: true, body: req.body });
    };
    ctx.svc.configRouter.put(PUT_PATH, ...ctx.svc.configWrite(), handler);
    ctx.svc.configRouter.delete(PUT_PATH, ...ctx.svc.configWrite(), handler);
    return { ...ctx, ran };
  }
  const WRITES_BASIC = { allowConfigWrites: true, auth: BASIC };
  const put = (svc, { headers = {}, body = '{"a":1}' } = {}) => request(svc, {
    method: 'PUT',
    path: PUT_PATH,
    headers: { 'Content-Type': 'application/json', Origin: own(svc), Authorization: basicHeader(), ...headers },
    body
  });

  test('403 config_writes_disabled / disabled with the default config, even with credentials', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: { auth: BASIC } });
    const res = await put(svc);
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'config_writes_disabled', reason: 'disabled' });
    expect(ran).toEqual([]);
  });

  test('403 / disabled with the fully default dashboard config (auth none)', async () => {
    const { svc } = await makeWriteService();
    const res = await put(svc);
    expect(res.json).toEqual({ error: 'config_writes_disabled', reason: 'disabled' });
  });

  test('403 / auth-none when writes are enabled but auth is none', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: { allowConfigWrites: true } });
    const res = await put(svc);
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'config_writes_disabled', reason: 'auth-none' });
    expect(ran).toEqual([]);
  });

  test('401 without credentials', async () => {
    const { svc } = await makeWriteService({ dashboard: WRITES_BASIC });
    expect((await put(svc, { headers: { Authorization: undefined } })).status).toBe(401);
  });

  test('401 {"error":"Invalid token"} for a wrong token', async () => {
    const { svc } = await makeWriteService({ dashboard: { allowConfigWrites: true, auth: TOKEN } });
    const res = await put(svc, { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'Invalid token' });
  });

  test('401, not 403, for no credentials plus a foreign Origin', async () => {
    const { svc } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await put(svc, { headers: { Authorization: undefined, Origin: EVIL } });
    expect(res.status).toBe(401);
  });

  test('403 origin_rejected for a foreign Origin with valid credentials; the handler does not run', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await put(svc, { headers: { Origin: EVIL } });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'origin_rejected' });
    expect(ran).toEqual([]);
  });

  test('415 invalid_content_type for text/plain', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await put(svc, { headers: { 'Content-Type': 'text/plain' } });
    expect(res.status).toBe(415);
    expect(res.json).toEqual({ error: 'invalid_content_type' });
    expect(ran).toEqual([]);
  });

  test('415 for a body with no Content-Type at all', async () => {
    const { svc } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await put(svc, { headers: { 'Content-Type': undefined } });
    expect(res.status).toBe(415);
  });

  test('the handler runs for application/json; charset=utf-8 (the 415 check and the parser agree)', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await put(svc, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    expect(res.status).toBe(200);
    expect(ran).toEqual([{ a: 1 }]);
  });

  test('the handler runs with token auth and a same-origin JSON body', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: { allowConfigWrites: true, auth: TOKEN } });
    const res = await put(svc, { headers: { Authorization: `Bearer ${TOKEN.token}` } });
    expect(res.status).toBe(200);
    expect(ran).toEqual([{ a: 1 }]);
  });

  test('400 invalid_json as JSON for a malformed body', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await put(svc, { body: '{"a":' });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'invalid_json' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(ran).toEqual([]);
  });

  test('413 payload_too_large as JSON for a 17 KB body', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await put(svc, { body: JSON.stringify({ a: 'x'.repeat(17 * 1024) }) });
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: 'payload_too_large' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(ran).toEqual([]);
  });

  test('a 15 KB body is accepted (the cap is 16 KB)', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await put(svc, { body: JSON.stringify({ a: 'x'.repeat(15 * 1024) }) });
    expect(res.status).toBe(200);
    expect(ran).toHaveLength(1);
  });

  test.each([
    ['an unsupported charset', { 'Content-Type': 'application/json; charset=latin1' }],
    ['an unsupported Content-Encoding', { 'Content-Encoding': 'x-unknown' }]
  ])('400 invalid_body_encoding for %s', async (name, headers) => {
    const { svc, ran } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await put(svc, { headers });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'invalid_body_encoding' });
    expect(ran).toEqual([]);
  });

  test('a route registered after construction answers JSON for 400 and 413 (the mapper is in the chain)', async () => {
    const ctx = await makeService({ dashboard: WRITES_BASIC });
    ctx.svc.configRouter.put('/api/dashboard/__test/late', ...ctx.svc.configWrite(), (req, res) => res.json({ ok: true }));
    const late = (body) => request(ctx.svc, {
      method: 'PUT',
      path: '/api/dashboard/__test/late',
      headers: { 'Content-Type': 'application/json', Origin: own(ctx.svc), Authorization: basicHeader() },
      body
    });
    const bad = await late('{"a":');
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: 'invalid_json' });
    const big = await late(JSON.stringify({ a: 'x'.repeat(17 * 1024) }));
    expect(big.status).toBe(413);
    expect(big.json).toEqual({ error: 'payload_too_large' });
  });

  test('the four existing POSTs answer JSON for a malformed body', async () => {
    const { svc } = await makeService();
    const res = await request(svc, {
      method: 'POST',
      path: '/api/dashboard/sync',
      headers: { 'Content-Type': 'application/json' },
      body: '{"server":'
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'invalid_json' });
  });

  test('a DELETE with no body and no Content-Type runs the handler with req.body {}', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await request(svc, {
      method: 'DELETE', path: PUT_PATH, headers: { Origin: own(svc), Authorization: basicHeader() }
    });
    expect(res.status).toBe(200);
    expect(ran).toEqual([{}]);
  });

  test('a DELETE with Content-Length: 0 and no Content-Type runs the handler with req.body {} (no 415)', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: WRITES_BASIC });
    const res = await request(svc, {
      method: 'DELETE',
      path: PUT_PATH,
      headers: { Origin: own(svc), Authorization: basicHeader(), 'Content-Length': '0' }
    });
    expect(res.status).toBe(200);
    expect(ran).toEqual([{}]);
  });

  test('429 on the 61st request in a minute, and the handler does not run for it', async () => {
    const { svc, ran } = await makeWriteService({ dashboard: WRITES_BASIC });
    for (let i = 0; i < 60; i++) {
      expect((await put(svc)).status).toBe(200);
    }
    const res = await put(svc);
    expect(res.status).toBe(429);
    expect(res.text).toBe('Too many requests, please try again later.');
    expect(ran).toHaveLength(60);
  });

  describe('startup notices', () => {
    const startWith = async (dashboard) => {
      const ctx = await makeService({ dashboard, start: false });
      const error = jest.spyOn(ctx.svc.logger, 'error').mockImplementation(() => {});
      const warn = jest.spyOn(ctx.svc.logger, 'warn').mockImplementation(() => {});
      await ctx.svc.start();
      return { error, warn };
    };

    test('writes enabled with auth none logs one ERROR', async () => {
      const { error } = await startWith({ allowConfigWrites: true });
      expect(error).toHaveBeenCalledTimes(1);
    });

    test('writes enabled, basic auth and allowedOrigins logs one WARN naming the origins and no ERROR', async () => {
      const { error, warn } = await startWith({
        allowConfigWrites: true, auth: BASIC, allowedOrigins: ['https://budget.example']
      });
      expect(error).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1].allowedOrigins).toEqual(['https://budget.example']);
    });

    test('writes disabled with allowedOrigins logs nothing', async () => {
      const { error, warn } = await startWith({ allowedOrigins: ['https://budget.example'] });
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('GET /api/dashboard/capabilities (#259)', () => {
  const get = (svc, headers = {}) => request(svc, { path: '/api/dashboard/capabilities', headers });

  test('reports disabled with the default config', async () => {
    const { svc } = await makeService();
    const res = await get(svc);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ configWrites: false, reason: 'disabled' });
  });

  test('reports auth-none for writes enabled with auth none', async () => {
    const { svc } = await makeService({ dashboard: { allowConfigWrites: true } });
    expect((await get(svc)).json).toEqual({ configWrites: false, reason: 'auth-none' });
  });

  test('reports writes on with allowConfigWrites and basic auth', async () => {
    const { svc } = await makeService({ dashboard: { allowConfigWrites: true, auth: BASIC } });
    const res = await get(svc, { Authorization: basicHeader() });
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"configWrites":true,"reason":null}');
  });

  test('401 without credentials and with a wrong password', async () => {
    const { svc } = await makeService({ dashboard: { auth: BASIC } });
    expect((await get(svc)).status).toBe(401);
    expect((await get(svc, { Authorization: basicHeader('wrong') })).status).toBe(401);
  });

  test('401 {"error":"Invalid token"} for a wrong token', async () => {
    const { svc } = await makeService({ dashboard: { auth: TOKEN } });
    const res = await get(svc, { Authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'Invalid token' });
  });

  test('403 Dashboard is disabled when the dashboard is off', async () => {
    const { svc } = await makeService({ dashboard: { enabled: false } });
    const res = await get(svc);
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'Dashboard is disabled' });
  });

  test('429 on the 61st request in a minute', async () => {
    const { svc } = await makeService();
    for (let i = 0; i < 60; i++) await get(svc);
    expect((await get(svc)).status).toBe(429);
  });
});

describe('GET /api/dashboard/config-audit (#259)', () => {
  const get = (svc, query = '', headers = {}) => request(svc, { path: `/api/dashboard/config-audit${query}`, headers });
  const seed = (history, n = 3) => {
    for (let i = 1; i <= n; i++) {
      history.recordConfigChange({
        server: 'Main', remoteAddr: `10.0.0.${i}`, action: 'payment_alert_state', target: `alert-${i}`,
        changes: { enabled: [true, false] }
      });
    }
  };

  test('returns the newest entries first, limited, with the documented fields', async () => {
    const { svc, history } = await makeService();
    seed(history);
    const res = await get(svc, '?limit=2');
    expect(res.status).toBe(200);
    expect(res.json.entries.map(e => e.target)).toEqual(['alert-3', 'alert-2']);
    expect(Object.keys(res.json.entries[0]).sort()).toEqual(
      ['action', 'at', 'changes', 'remote_addr', 'server', 'target']
    );
    expect(res.json.entries[0].remote_addr).toBe('10.0.0.3');
    expect(res.json.entries[0].changes).toEqual({ enabled: [true, false] });
  });

  test('limit=200 is accepted and the default is at most 50 entries', async () => {
    const { svc, history } = await makeService();
    seed(history, 55);
    expect((await get(svc, '?limit=200')).json.entries).toHaveLength(55);
    expect((await get(svc)).json.entries).toHaveLength(50);
  });

  test.each([
    '?limit=201', '?limit=0', '?limit=abc', '?limit=-1', '?limit=1.5', '?limit=1e2',
    '?limit=1000', '?limit=%205', '?limit=5&limit=6', '?limit='
  ])('400 invalid_limit for %s', async (query) => {
    const { svc } = await makeService();
    const res = await get(svc, query);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'invalid_limit' });
  });

  test('503 Sync history not available without a syncHistory', async () => {
    const { svc } = await makeService({ noHistory: true });
    const res = await get(svc);
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: 'Sync history not available' });
  });

  test('500 with a fixed message when getConfigAudit throws, never the exception text', async () => {
    const { svc, history } = await makeService();
    history.getConfigAudit = () => { throw new Error('disk I/O error'); };
    const res = await get(svc);
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'Failed to retrieve configuration changes' });
    expect(res.text).not.toContain('disk I/O error');
  });

  test('401 without credentials and {"error":"Invalid token"} for a wrong token', async () => {
    const basic = await makeService({ dashboard: { auth: BASIC } });
    expect((await get(basic.svc)).status).toBe(401);
    const token = await makeService({ dashboard: { auth: TOKEN } });
    const res = await get(token.svc, '', { Authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'Invalid token' });
  });

  test('429 on the 61st request in a minute', async () => {
    const { svc } = await makeService();
    for (let i = 0; i < 60; i++) await get(svc);
    expect((await get(svc)).status).toBe(429);
  });

  test('the response holds no secret, only the names of the changed fields', async () => {
    const { svc, history } = await makeService();
    history.recordConfigChange({
      server: 'Main',
      action: 'notification_settings',
      target: 'channels',
      changes: {
        password: ['old-pass-1', 'new-pass-2'],
        token: ['old-tok-1', 'new-tok-2'],
        discord: { webhookUrl: ['https://discord.com/api/webhooks/1/old-hook', 'https://discord.com/api/webhooks/1/new-hook'] },
        smtp: { auth: { user: ['mailer-old', 'mailer-new'], pass: ['smtp-old', 'smtp-new'] } },
        email: [null, { auth: { user: 'real-user', pass: 'real-pass' } }],
        reason: ['', 'call Alice about the rent']
      }
    });
    const res = await get(svc);
    expect(res.status).toBe(200);
    for (const secret of ['old-pass-1', 'new-pass-2', 'old-tok-1', 'new-tok-2', 'old-hook', 'new-hook',
      'mailer-old', 'mailer-new', 'smtp-old', 'smtp-new', 'real-user', 'real-pass', 'Alice']) {
      expect(res.text).not.toContain(secret);
    }
    const { changes } = res.json.entries[0];
    expect(Object.keys(changes).sort()).toEqual(['discord', 'email', 'password', 'reason', 'smtp', 'token']);
  });
});

describe('unmapped body-parser errors and the final error handler (#259)', () => {
  const gzipHeaders = { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' };

  test('a corrupt gzip body is a JSON 400 with no stack (authenticated)', async () => {
    const ctx = await makeService();
    const res = await request(ctx.svc, {
      method: 'POST', path: '/api/dashboard/sync', headers: gzipHeaders, body: 'abcde'
    });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json).toEqual({ error: 'invalid_body' });
    expect(res.text).not.toMatch(/\bat \S+/);
    expect(res.text).not.toMatch(/<html/i);
  });

  test('an unauthenticated POST gets the same JSON 400', async () => {
    const ctx = await makeService({ dashboard: { auth: BASIC } });
    const res = await request(ctx.svc, {
      method: 'POST', path: '/api/dashboard/sync', headers: gzipHeaders, body: 'abcde'
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'invalid_body' });
    expect(res.text).not.toMatch(/\bat \S+/);
  });

  test('a thrown route error is a JSON 500 internal_error, logged, with no stack', async () => {
    const ctx = await makeService();
    const logged = [];
    ctx.svc.logger = { debug() {}, info() {}, warn() {}, error: (...a) => logged.push(a) };
    // configRouter is mounted before the final handler, so a throw reaches it.
    ctx.svc.configRouter.get('/__boom', () => { throw new Error('kaboom at secret/path.js'); });
    const res = await request(ctx.svc, { path: '/__boom' });
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'internal_error' });
    expect(res.text).not.toContain('kaboom');
    expect(logged.length).toBeGreaterThan(0);
  });

  test('a 4xx error passed by a configRouter route keeps its status, not invalid_body', async () => {
    const ctx = await makeService();
    ctx.svc.configRouter.get('/__conflict', (req, res, next) => {
      next(Object.assign(new Error('conflict'), { status: 409 }));
    });
    const res = await request(ctx.svc, { path: '/__conflict' });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: 'request_error' });
    expect(res.text).not.toContain('invalid_body');
  });

  test('a 4xx error carrying statusCode (not status) keeps its status', async () => {
    const ctx = await makeService();
    ctx.svc.configRouter.get('/__gone', (req, res, next) => {
      next(Object.assign(new Error('gone'), { statusCode: 404 }));
    });
    const res = await request(ctx.svc, { path: '/__gone' });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'request_error' });
  });
});
