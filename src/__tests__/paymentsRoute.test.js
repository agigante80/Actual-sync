/**
 * GET /api/dashboard/payments (#260): a real listener on a test port, as in
 * healthCheck.test.js. HealthCheckService is built with no Actual dependency
 * at all, which is the structural guarantee that reading needs no Actual.
 */
const http = require('http');
const net = require('net');
const path = require('path');
const { HealthCheckService } = require('../services/healthCheck');
const { SyncHistoryService } = require('../services/syncHistory');
const { createTempDir, cleanupTempDir } = require('./helpers/testHelpers');

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); } catch (e) { resolve({ statusCode: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

const evaluation = (overrides = {}) => ({
  alertId: 'parking-a', scheduleId: 's1', name: 'Rent - Parking A', cadenceText: 'Every month on the 5th',
  account: 'Main', payee: 'Tenant A', expectedAmount: 6000, nextDate: '2026-02-05', deadline: '2026-01-11', state: 'missing',
  occurrences: [{ date: '2026-01-05', deadline: '2026-01-11', state: 'missing', receivedDate: null, receivedAmount: null }],
  ...overrides
});

let portCounter = 0;

describe('GET /api/dashboard/payments (#260)', () => {
  let syncHistory;
  let dbDir;
  let clock;
  let port = 0;
  const services = [];
  const servers = [
    { name: 'Main', scheduleAlerts: { alerts: [] } },
    { name: 'Other', scheduleAlerts: { alerts: [] } },
    { name: 'Plain' }
  ];

  beforeEach(async () => {
    clock = new Date('2026-01-14T08:01:00.000Z');
    dbDir = createTempDir();
    syncHistory = new SyncHistoryService({
      dbPath: path.join(dbDir, 'sync-history.db'),
      loggerConfig: { level: 'ERROR' },
      now: () => new Date(clock)
    });
    // Per-worker 1000-port band below the ephemeral range, walked monotonically
    // and probed for freeness (same approach as healthCheck.test.js).
    const base = 4000 + (((Number(process.env.JEST_WORKER_ID) || 1) - 1) % 28) * 1000 + 500;
    for (let i = 0; i < 400; i++) {
      const candidate = base + (portCounter++ % 400);
      if (await portFree(candidate)) { port = candidate; break; }
    }
  });

  afterEach(async () => {
    for (const svc of services.splice(0)) { try { await svc.stop(); } catch (e) { /* not started */ } }
    syncHistory.close();
    cleanupTempDir(dbDir);
  });

  async function start(opts = {}) {
    const svc = new HealthCheckService({
      port, host: '127.0.0.1', loggerConfig: { level: 'ERROR' },
      syncHistory, getServers: () => servers, ...opts
    });
    services.push(svc);
    await svc.start();
    return svc;
  }
  const get = (query = '', headers) => httpGet(`http://127.0.0.1:${port}/api/dashboard/payments${query}`, headers);

  test('?server=Main returns exactly that server', async () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation()]);
    syncHistory.replacePaymentSnapshot('Other', [evaluation()]);
    await start();
    const res = await get('?server=Main');
    expect(res.statusCode).toBe(200);
    expect(res.body.servers.map((s) => s.server)).toEqual(['Main']);
  });

  test('without ?server= every configured server is listed, isolated from each other', async () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation({ alertId: 'm' })]);
    syncHistory.replacePaymentSnapshot('Other', [evaluation({ alertId: 'o' })]);
    await start();
    const { body } = await get();
    expect(body.servers.map((s) => [s.server, s.items.map((i) => i.alertId)])).toEqual([['Main', ['m']], ['Other', ['o']], ['Plain', []]]);
  });

  test('the response has exactly the documented key sets', async () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation()]);
    await start();
    const [main] = (await get('?server=Main')).body.servers;
    expect(Object.keys(main).sort()).toEqual(['configured', 'items', 'lastRun', 'server']);
    expect(Object.keys(main.lastRun).sort()).toEqual(['at', 'errorCode', 'lastSuccessAt', 'ok', 'rulesErrored']);
    const [item] = main.items;
    expect(Object.keys(item).sort()).toEqual([
      'account', 'alertId', 'cadenceText', 'deadline', 'expectedAmount', 'lastAlertAt', 'name', 'nextDate',
      'occurrences', 'payee', 'ruleState', 'scheduleId', 'source', 'state'
    ]);
    expect(Object.keys(item.occurrences[0]).sort()).toEqual(['date', 'daysLate', 'deadline', 'receivedAmount', 'receivedDate', 'state']);
    expect(item.source).toBe('config');
    expect(item.ruleState).toEqual({ enabled: true, mutedUntil: null, reason: null, lockedByConfig: false, muteEndDue: false });
    expect(main.lastRun).toMatchObject({ ok: true, errorCode: null, rulesErrored: 0 });
  });

  test('source is per rule (#262): config and dashboard items, ruleState from the #261 override', async () => {
    syncHistory.insertRule('Main', 'dash-rule', { id: 'dash-rule', schedule: 'Water' });
    syncHistory.insertRule('Main', 'cfg-rule', { id: 'cfg-rule', schedule: 'Shadowed' });
    syncHistory.replacePaymentSnapshot('Main', [
      evaluation({ alertId: 'cfg-rule', scheduleId: 's1' }),
      evaluation({ alertId: 'dash-rule', scheduleId: 's2' })
    ]);
    syncHistory.setOverride({ server: 'Main', alertId: 'dash-rule', enabled: false });
    servers[0] = { name: 'Main', scheduleAlerts: { alerts: [{ id: 'cfg-rule', schedule: 'Rent' }] } };
    try {
      await start();
      const items = (await get('?server=Main')).body.servers[0].items;
      const byId = Object.fromEntries(items.map((i) => [i.alertId, i]));
      expect(byId['cfg-rule'].source).toBe('config');
      expect(byId['dash-rule'].source).toBe('dashboard');
      expect(byId['dash-rule'].ruleState).toEqual({ enabled: false, mutedUntil: null, reason: null, lockedByConfig: false });
      expect(byId['cfg-rule'].ruleState.enabled).toBe(true);
    } finally {
      servers[0] = { name: 'Main', scheduleAlerts: { alerts: [] } };
    }
  });

  test('lastAlertAt is the latest sent time, ignores inferred rows, null without a sent row', async () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation(), evaluation({ alertId: 'quiet' })]);
    const rec = async (iso, delivery) => {
      clock = new Date(iso);
      await syncHistory.recordScheduleAlert({ server: 'Main', alertId: 'parking-a', scheduleId: 's1', occurrenceDate: '2026-01-05', event: 'missing', delivery });
    };
    await rec('2026-01-12T08:01:00.000Z', 'sent');
    await rec('2026-01-12T09:30:00.000Z', 'sent');
    await rec('2026-01-12T10:00:00.000Z', 'inferred');
    await start();
    const items = (await get('?server=Main')).body.servers[0].items;
    expect(items.find((i) => i.alertId === 'parking-a').lastAlertAt).toBe('2026-01-12T09:30:00.000Z');
    expect(items.find((i) => i.alertId === 'quiet').lastAlertAt).toBeNull();
  });

  test('daysLate is receivedDate minus deadline for late occurrences only', async () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation({
      occurrences: [
        { date: '2026-01-05', deadline: '2026-01-11', state: 'late', receivedDate: '2026-01-14', receivedAmount: 6000 },
        { date: '2026-02-05', deadline: '2026-02-11', state: 'received', receivedDate: '2026-02-05', receivedAmount: 6000 },
        { date: '2026-03-05', deadline: '2026-03-11', state: 'missing', receivedDate: null, receivedAmount: null }
      ]
    })]);
    await start();
    const occ = (await get('?server=Main')).body.servers[0].items[0].occurrences;
    expect(occ.map((o) => o.daysLate)).toEqual([3, null, null]);
  });

  test('a range amount is served as {num1,num2} min/max', async () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation({ expectedAmount: { num1: 7000, num2: 5000 } })]);
    await start();
    expect((await get('?server=Main')).body.servers[0].items[0].expectedAmount).toEqual({ num1: 5000, num2: 7000 });
  });

  test('a server without scheduleAlerts is unconfigured with no items even if rows linger', async () => {
    syncHistory.replacePaymentSnapshot('Plain', [evaluation()]);
    await start();
    expect((await get('?server=Plain')).body.servers).toEqual([{ server: 'Plain', configured: false, lastRun: null, items: [] }]);
  });

  test('a configured server before its first run has lastRun null', async () => {
    await start();
    expect((await get('?server=Main')).body.servers[0]).toEqual({ server: 'Main', configured: true, lastRun: null, items: [] });
  });

  test('a failed run reports the code and last success while still serving the previous items', async () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation()]);
    clock = new Date('2026-01-15T08:00:00.000Z');
    syncHistory.recordPaymentRunFailure('Main', 'actual_read_failed');
    await start();
    const [main] = (await get('?server=Main')).body.servers;
    expect(main.lastRun).toEqual({ at: '2026-01-15T08:00:00.000Z', ok: false, errorCode: 'actual_read_failed', lastSuccessAt: '2026-01-14T08:01:00.000Z', rulesErrored: 0 });
    expect(main.items).toHaveLength(1);
  });

  test.each([['?server=Nope'], ['?server=__proto__']])('%s is 404', async (q) => {
    await start();
    const res = await get(q);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Server not found' });
  });

  test.each([['?server=a&server=b'], ['?server[]=x'], ['?server[a]=b'], ['?server=']])('%s is 400', async (q) => {
    await start();
    const res = await get(q);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid server parameter' });
  });

  test('503 without getServers', async () => {
    await start({ getServers: undefined });
    expect(await get()).toEqual({ statusCode: 503, body: { error: 'Server list not available' } });
  });

  test('503 without syncHistory', async () => {
    await start({ syncHistory: undefined });
    expect(await get()).toEqual({ statusCode: 503, body: { error: 'Sync history not available' } });
  });

  test('a throwing snapshot read is a logged 500', async () => {
    const svc = await start();
    const err = jest.spyOn(svc.logger, 'error');
    jest.spyOn(syncHistory, 'getPaymentSnapshot').mockImplementation(() => { throw new Error('db gone'); });
    const res = await get('?server=Main');
    expect(res).toEqual({ statusCode: 500, body: { error: 'Failed to retrieve payments' } });
    expect(err).toHaveBeenCalled();
  });

  test('403 when the dashboard is disabled', async () => {
    await start({ dashboardConfig: { enabled: false } });
    expect(await get()).toEqual({ statusCode: 403, body: { error: 'Dashboard is disabled' } });
  });

  test('500 for an unrecognised auth.type', async () => {
    await start({ dashboardConfig: { enabled: true, auth: { type: 'bogus' } } });
    expect(await get()).toEqual({ statusCode: 500, body: { error: 'Invalid authentication configuration' } });
  });

  test('401 for basic auth without credentials', async () => {
    await start({ dashboardConfig: { enabled: true, auth: { type: 'basic', username: 'u', password: 'p' } } });
    expect((await get()).statusCode).toBe(401);
  });

  test('401 for a wrong token, 200 for the right one', async () => {
    await start({ dashboardConfig: { enabled: true, auth: { type: 'token', token: 'good' } } });
    expect((await get('', { Authorization: 'Bearer bad' })).statusCode).toBe(401);
    expect((await get('', { Authorization: 'Bearer good' })).statusCode).toBe(200);
  });

  test('429 with the throttle message after repeated bad credentials', async () => {
    await start({ dashboardConfig: { enabled: true, auth: { type: 'token', token: 'good' } }, authFailureLimit: 2 });
    await get('', { Authorization: 'Bearer bad' });
    await get('', { Authorization: 'Bearer bad' });
    const res = await get('', { Authorization: 'Bearer bad' });
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toMatch(/Too many failed authentication attempts/);
  });

  test('429 once the request limiter is exhausted', async () => {
    await start({ rateLimitMax: 2 });
    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(429);
  });
});
