/**
 * Payment alert overrides (#261): the payment_alert_override table, the ledger
 * `delivery` filter, retention (cleanup + expireStaleMutes), the history
 * resets and (further down) the PUT / DELETE / GET routes.
 */
const path = require('path');
const http = require('http');
const { HealthCheckService } = require('../services/healthCheck');
const { SyncHistoryService } = require('../services/syncHistory');
const { createTempDir, cleanupTempDir } = require('./helpers/testHelpers');

describe('payment_alert_override storage (#261)', () => {
  let syncHistory;
  let dbDir;
  let dbPath;
  let clock;

  const open = () => new SyncHistoryService({
    dbPath, loggerConfig: { level: 'ERROR' }, now: () => new Date(clock)
  });
  const count = (table, where = '1=1') => syncHistory.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;

  beforeEach(() => {
    clock = new Date('2026-10-01T08:00:00.000Z');
    dbDir = createTempDir();
    dbPath = path.join(dbDir, 'sync-history.db');
    syncHistory = open();
  });

  afterEach(() => {
    if (syncHistory.db) syncHistory.close();
    cleanupTempDir(dbDir);
  });

  const mute = (extra = {}) => ({
    server: 'Main', alertId: 'parking-a', enabled: true,
    mutedFrom: '2026-10-01T08:00:00.000Z', mutedUntil: '2026-10-20', reason: 'vacant', ...extra
  });

  describe('getOverride / setOverride / deleteOverride / listOverrides', () => {
    test('getOverride is null when there is none', () => {
      expect(syncHistory.getOverride('Main', 'parking-a')).toBeNull();
    });

    test('setOverride stores and getOverride reads it back, with updatedAt from the clock', () => {
      syncHistory.setOverride(mute());
      expect(syncHistory.getOverride('Main', 'parking-a')).toEqual({
        server: 'Main', alertId: 'parking-a', enabled: true,
        mutedFrom: '2026-10-01T08:00:00.000Z', mutedUntil: '2026-10-20', reason: 'vacant',
        updatedAt: '2026-10-01T08:00:00.000Z'
      });
    });

    test('setOverride replaces the row for the same key', () => {
      syncHistory.setOverride(mute());
      clock = new Date('2026-10-02T08:00:00.000Z');
      syncHistory.setOverride(mute({ enabled: false }));
      expect(count('payment_alert_override')).toBe(1);
      expect(syncHistory.getOverride('Main', 'parking-a')).toMatchObject({ enabled: false, updatedAt: '2026-10-02T08:00:00.000Z' });
    });

    test('an override at the default state (enabled, no mute) is deleted, not stored', () => {
      syncHistory.setOverride(mute());
      const stored = syncHistory.setOverride({ server: 'Main', alertId: 'parking-a', enabled: true, mutedFrom: null, mutedUntil: null, reason: null });
      expect(stored).toBeNull();
      expect(count('payment_alert_override')).toBe(0);
      expect(syncHistory.setOverride({ server: 'Main', alertId: 'x', enabled: true })).toBeNull();
      expect(count('payment_alert_override')).toBe(0);
    });

    test('a switched-off alert with no mute is stored', () => {
      syncHistory.setOverride({ server: 'Main', alertId: 'gym', enabled: false });
      expect(syncHistory.getOverride('Main', 'gym')).toMatchObject({ enabled: false, mutedUntil: null, reason: null, mutedFrom: null });
    });

    test('deleteOverride reports whether a row was removed', () => {
      syncHistory.setOverride(mute());
      expect(syncHistory.deleteOverride('Main', 'parking-a')).toBe(true);
      expect(syncHistory.deleteOverride('Main', 'parking-a')).toBe(false);
    });

    test('listOverrides is ordered by server then alert id and can filter by server', () => {
      syncHistory.setOverride(mute({ server: 'B', alertId: 'z' }));
      syncHistory.setOverride(mute({ server: 'A', alertId: 'z' }));
      syncHistory.setOverride(mute({ server: 'A', alertId: 'b' }));
      expect(syncHistory.listOverrides().map(o => `${o.server}/${o.alertId}`)).toEqual(['A/b', 'A/z', 'B/z']);
      expect(syncHistory.listOverrides('A').map(o => o.alertId)).toEqual(['b', 'z']);
      expect(syncHistory.listOverrides('none')).toEqual([]);
    });

    test('the mute survives closing and reopening the database on the same path', () => {
      syncHistory.setOverride(mute());
      syncHistory.close();
      syncHistory = open();
      expect(syncHistory.getOverride('Main', 'parking-a')).toMatchObject({ mutedUntil: '2026-10-20', reason: 'vacant', enabled: true });
    });
  });

  describe('findLatestScheduleAlert delivery filter', () => {
    const rec = async (delivery, iso) => {
      clock = new Date(iso);
      await syncHistory.recordScheduleAlert({ server: 'Main', alertId: 'a', scheduleId: 's1', occurrenceDate: '2026-10-01', event: 'missing', delivery, channel: 'slack' });
    };
    const find = (extra = {}) => syncHistory.findLatestScheduleAlert({ server: 'Main', alertId: 'a', scheduleId: 's1', occurrenceDate: '2026-10-01', event: 'missing', ...extra });

    test('without a filter the latest row wins, with delivery sent the latest sent row is returned', async () => {
      await rec('sent', '2026-10-01T08:00:00.000Z');
      await rec('muted', '2026-10-02T08:00:00.000Z');
      expect((await find()).recordedAt).toBe('2026-10-02T08:00:00.000Z');
      expect((await find({ delivery: 'sent' })).recordedAt).toBe('2026-10-01T08:00:00.000Z');
      expect((await find({ delivery: 'muted' })).recordedAt).toBe('2026-10-02T08:00:00.000Z');
    });

    test('a delivery filter with no matching row returns null', async () => {
      await rec('muted', '2026-10-02T08:00:00.000Z');
      expect(await find({ delivery: 'sent' })).toBeNull();
    });

    test('the filter combines with a channel', async () => {
      await rec('sent', '2026-10-01T08:00:00.000Z');
      expect(await find({ delivery: 'sent', channel: 'slack' })).not.toBeNull();
      expect(await find({ delivery: 'sent', channel: 'telegram' })).toBeNull();
    });
  });

  describe('muted ledger rows', () => {
    const rec = async (extra = {}) => syncHistory.recordScheduleAlert({
      server: 'Main', alertId: 'parking-a', scheduleId: 's1', occurrenceDate: '2026-10-05', event: 'missing', delivery: 'muted', channel: 'slack', ...extra
    });

    test('listMutedRows returns muted rows of the alert from a time on, within a window', async () => {
      clock = new Date('2026-09-30T08:00:00.000Z'); await rec({ occurrenceDate: '2026-09-29' });
      clock = new Date('2026-10-05T08:00:00.000Z'); await rec();
      clock = new Date('2026-10-25T08:00:00.000Z'); await rec({ occurrenceDate: '2026-10-24' });
      await rec({ alertId: 'other' });
      await rec({ delivery: 'sent', occurrenceDate: '2026-10-06' });
      const rows = syncHistory.listMutedRows({ server: 'Main', alertId: 'parking-a', since: '2026-10-01T08:00:00.000Z', until: new Date('2026-10-21T00:00:00.000Z') });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ scheduleId: 's1', occurrenceDate: '2026-10-05', event: 'missing', channel: 'slack' });
    });

    test('deleteMutedRows removes only the alert\'s muted rows since a time', async () => {
      clock = new Date('2026-09-30T08:00:00.000Z'); await rec({ occurrenceDate: '2026-09-29' });
      clock = new Date('2026-10-05T08:00:00.000Z'); await rec();
      await rec({ alertId: 'other' });
      await rec({ delivery: 'sent', occurrenceDate: '2026-10-06' });
      expect(syncHistory.deleteMutedRows({ server: 'Main', alertId: 'parking-a', since: '2026-10-01T08:00:00.000Z' })).toBe(1);
      expect(count('schedule_alerts')).toBe(3);
      expect(syncHistory.deleteMutedRows({ server: 'Main', alertId: 'parking-a' })).toBe(1);
      expect(count('schedule_alerts', "alert_id = 'parking-a' AND delivery = 'muted'")).toBe(0);
    });

    test('deleteMutedRow removes one destination key only', async () => {
      await rec(); await rec({ channel: 'telegram' });
      expect(syncHistory.deleteMutedRow({ server: 'Main', alertId: 'parking-a', scheduleId: 's1', occurrenceDate: '2026-10-05', event: 'missing', channel: 'slack' })).toBe(1);
      expect(count('schedule_alerts', "channel = 'telegram'")).toBe(1);
    });
  });

  describe('cleanup keeps muted rows of a live mute', () => {
    const rec = async (iso, extra = {}) => {
      clock = new Date(iso);
      await syncHistory.recordScheduleAlert({ server: 'Main', alertId: 'parking-a', scheduleId: 's1', occurrenceDate: '2026-01-05', event: 'missing', delivery: 'muted', channel: 'slack', ...extra });
    };

    test('a 200-day mute keeps its day-one muted rows at day 150, other old rows are purged', async () => {
      await rec('2026-01-01T08:00:00.000Z');
      await rec('2026-01-01T08:00:00.000Z', { delivery: 'sent', occurrenceDate: '2026-01-06' });
      await rec('2026-01-01T08:00:00.000Z', { alertId: 'other' });
      syncHistory.setOverride({ server: 'Main', alertId: 'parking-a', enabled: true, mutedFrom: '2026-01-01T08:00:00.000Z', mutedUntil: '2026-07-19', reason: 'x' });
      clock = new Date('2026-05-31T08:00:00.000Z'); // day 150
      syncHistory.cleanup();
      expect(count('schedule_alerts')).toBe(1);
      expect(count('schedule_alerts', "delivery = 'muted' AND alert_id = 'parking-a'")).toBe(1);
    });

    test('once the mute fields are cleared the muted rows are purged normally', async () => {
      await rec('2026-01-01T08:00:00.000Z');
      clock = new Date('2026-05-31T08:00:00.000Z');
      syncHistory.cleanup();
      expect(count('schedule_alerts')).toBe(0);
    });
  });

  describe('expireStaleMutes', () => {
    const rec = async (extra = {}) => syncHistory.recordScheduleAlert({
      server: 'Main', alertId: 'parking-a', scheduleId: 's1', occurrenceDate: '2026-10-05', event: 'missing', delivery: 'muted', channel: 'slack', ...extra
    });

    test('at mutedUntil + 7 days it clears reason, muted rows and mute fields, and logs a WARN', async () => {
      await rec();
      syncHistory.setOverride(mute({ enabled: false }));
      const warn = jest.spyOn(syncHistory.logger, 'warn').mockImplementation(() => {});
      clock = new Date('2026-10-28T00:00:00.000Z'); // the mute ends 21st 00:00; + 7 days
      const expired = syncHistory.expireStaleMutes({ server: 'Main', timezone: 'UTC' });
      expect(expired).toEqual([{ server: 'Main', alertId: 'parking-a' }]);
      expect(syncHistory.getOverride('Main', 'parking-a')).toMatchObject({ enabled: false, mutedUntil: null, mutedFrom: null, reason: null });
      expect(count('schedule_alerts', "delivery = 'muted'")).toBe(0);
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('vacant');
    });

    test('an enabled override is deleted when expiry leaves the default state', async () => {
      syncHistory.setOverride(mute());
      clock = new Date('2026-11-01T00:00:00.000Z');
      syncHistory.expireStaleMutes({ server: 'Main', timezone: 'UTC' });
      expect(syncHistory.getOverride('Main', 'parking-a')).toBeNull();
    });

    test('a minute before the 7 days are up nothing is expired', async () => {
      await rec();
      syncHistory.setOverride(mute());
      clock = new Date('2026-10-27T23:59:00.000Z');
      expect(syncHistory.expireStaleMutes({ server: 'Main', timezone: 'UTC' })).toEqual([]);
      expect(syncHistory.getOverride('Main', 'parking-a').reason).toBe('vacant');
      expect(count('schedule_alerts', "delivery = 'muted'")).toBe(1);
    });

    test('it covers every override of the server, including orphans, and no other server', () => {
      syncHistory.setOverride(mute({ alertId: 'orphan' }));
      syncHistory.setOverride(mute({ server: 'Other' }));
      clock = new Date('2026-11-15T00:00:00.000Z');
      syncHistory.expireStaleMutes({ server: 'Main', timezone: 'UTC' });
      expect(syncHistory.getOverride('Main', 'orphan')).toBeNull();
      expect(syncHistory.getOverride('Other', 'parking-a')).not.toBeNull();
    });

    test('without a server it covers all servers (cleanup path)', () => {
      syncHistory.setOverride(mute());
      syncHistory.setOverride(mute({ server: 'Other' }));
      clock = new Date('2026-11-15T00:00:00.000Z');
      syncHistory.cleanup();
      expect(syncHistory.listOverrides()).toEqual([]);
    });
  });

  describe('resets and hasServerData', () => {
    beforeEach(() => {
      syncHistory.setOverride(mute());
      syncHistory.setOverride(mute({ server: 'Other' }));
    });

    test('hasServerData is true for a server with only an override', () => {
      expect(syncHistory.hasServerData('Main')).toBe(true);
      expect(syncHistory.hasServerData('Nobody')).toBe(false);
    });

    test('resetServerHistory deletes that server\'s overrides and counts them in the audit', async () => {
      await syncHistory.resetServerHistory('Main');
      expect(syncHistory.listOverrides().map(o => o.server)).toEqual(['Other']);
      const row = syncHistory.getConfigAudit({ limit: 1 })[0];
      expect(row.changes.deleted.payment_alert_override).toBe(1);
    });

    test('resetAllHistory deletes every override and counts them in the audit', async () => {
      await syncHistory.resetAllHistory();
      expect(syncHistory.listOverrides()).toEqual([]);
      expect(syncHistory.getConfigAudit({ limit: 1 })[0].changes.deleted.payment_alert_override).toBe(2);
    });
  });
});

describe('deliverScheduleAlerts reads the overrides (#261)', () => {
  const { maybeDeliverScheduleAlerts: deliverScheduleAlerts } = require('../lib/scheduleAlertsStep');
  const { getRules } = require('../lib/scheduleAlertRules');
  let syncHistory;
  let dbDir;
  const now = new Date('2026-10-12T09:00:00.000Z');
  const notificationService = {
    config: { telegram: { enabled: true } },
    calls: [],
    async sendTemplated(outputs) { this.calls.push(outputs); return { telegram: { success: true } }; }
  };
  const logger = { warn() {}, info() {}, debug() {}, error() {} };
  const evaluated = (alertOverrides = {}) => ({
    events: [{ event: 'missing', alertId: 'rent', scheduleId: 's1', occurrence: '2026-10-05', deadline: '2026-10-08', daysOverdue: 2, expectedAmount: -50000 }],
    evaluations: [{ alertId: 'rent', scheduleId: 's1', name: 'Rent', account: 'A', payee: 'P', expectedAmount: -50000, occurrences: [] }],
    skipDecisions: [],
    scheduleAlertRules: getRules({ alerts: [{ id: 'rent', schedule: 'Rent', ...alertOverrides }] }),
    timezone: 'UTC', serverName: 'Main', now
  });

  beforeEach(() => {
    dbDir = createTempDir();
    syncHistory = new SyncHistoryService({
      dbPath: path.join(dbDir, 'h.db'), loggerConfig: { level: 'ERROR' }, now: () => new Date(now)
    });
    notificationService.calls.length = 0;
  });
  afterEach(() => { syncHistory.close(); cleanupTempDir(dbDir); });

  const deliver = (ev) => deliverScheduleAlerts(ev, { syncHistory, notificationService, logger });

  test('no override: the event is sent', async () => {
    await deliver(evaluated());
    expect(notificationService.calls).toHaveLength(1);
  });

  test('switched off: nothing is sent and no row is written, and the event list is untouched', async () => {
    syncHistory.setOverride({ server: 'Main', alertId: 'rent', enabled: false });
    const result = await deliver(evaluated());
    expect(result).toEqual({ events: 1, sent: 0, skipped: 1 });
    expect(notificationService.calls).toHaveLength(0);
    expect(syncHistory.db.prepare('SELECT COUNT(*) AS n FROM schedule_alerts').get().n).toBe(0);
  });

  test('muted: nothing is sent and one muted row is written', async () => {
    syncHistory.setOverride({ server: 'Main', alertId: 'rent', enabled: true, mutedFrom: '2026-10-01T00:00:00.000Z', mutedUntil: '2026-10-20', reason: 'x' });
    await deliver(evaluated());
    expect(notificationService.calls).toHaveLength(0);
    expect(syncHistory.db.prepare("SELECT delivery FROM schedule_alerts").all()).toEqual([{ delivery: 'muted' }]);
  });

  test('config enabled false wins over an enabling override', async () => {
    syncHistory.setOverride({ server: 'Main', alertId: 'rent', enabled: false });
    syncHistory.setOverride({ server: 'Main', alertId: 'rent', enabled: true, mutedFrom: '2026-10-01T00:00:00.000Z', mutedUntil: '2026-10-02', reason: 'x' });
    await deliver(evaluated({ enabled: false }));
    expect(notificationService.calls).toHaveLength(0);
  });

  test('an override of another server is ignored', async () => {
    syncHistory.setOverride({ server: 'Other', alertId: 'rent', enabled: false });
    await deliver(evaluated());
    expect(notificationService.calls).toHaveLength(1);
  });

  test('an orphaned override (no such rule) is ignored without error', async () => {
    syncHistory.setOverride({ server: 'Main', alertId: 'old', enabled: false });
    await deliver(evaluated());
    expect(notificationService.calls).toHaveLength(1);
  });
});

describe('payment alert state routes (#261)', () => {
  const NOW = new Date('2026-10-01T08:00:00.000Z');
  const BASIC = { type: 'basic', username: 'op', password: 'hunter2' };
  const basicHeader = (pw = 'hunter2') => `Basic ${Buffer.from(`op:${pw}`).toString('base64')}`;
  const STATE = (server, id) => `/api/dashboard/payments/${server}/${id}/state`;
  const SERVERS = [{
    name: 'Main',
    scheduleAlerts: { alerts: [
      { id: 'parking-a', schedule: 'Rent - Parking A' },
      { id: 'legacy', schedule: 'Legacy', enabled: false }
    ] }
  }];

  let dbDir;
  let history;
  let svc;

  async function boot({ dashboard = {}, servers = SERVERS } = {}) {
    dbDir = createTempDir();
    history = new SyncHistoryService({
      dbPath: path.join(dbDir, 'h.db'), loggerConfig: { level: 'ERROR' }, now: () => new Date(NOW)
    });
    svc = new HealthCheckService({
      port: 0, host: '127.0.0.1', loggerConfig: { level: 'ERROR' }, now: () => new Date(NOW),
      getTimezone: () => 'UTC',
      syncHistory: history, getServers: () => servers,
      dashboardConfig: { enabled: true, allowConfigWrites: true, auth: BASIC, ...dashboard }
    });
    svc.logger = { debug() {}, info() {}, warn() {}, error() {} };
    await svc.start();
  }

  afterEach(async () => {
    if (svc) { try { await svc.stop(); } catch { /* not started */ } }
    svc = null;
    if (history && history.db) history.close();
    if (dbDir) cleanupTempDir(dbDir);
    dbDir = null;
  });

  function call(method, reqPath, { body, headers = {}, auth = basicHeader() } = {}) {
    const hasBody = body !== undefined;
    const payload = hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: svc.port, path: reqPath, method,
        headers: Object.fromEntries(Object.entries({
          Connection: 'close',
          ...(auth ? { Authorization: auth } : {}),
          ...(hasBody ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }).filter(([, v]) => v !== undefined))
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
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
  const put = (id, body, opts = {}) => call('PUT', STATE('Main', id), { body, ...opts });
  const audit = () => history.getConfigAudit().filter((a) => a.action === 'payment_alert_state');

  describe('PUT', () => {
    test('mutes with a reason, merges, audits with the reason redacted', async () => {
      await boot();
      const res = await put('parking-a', { mutedUntil: '2026-12-01', reason: 'vacant' });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ruleState: { enabled: true, mutedUntil: '2026-12-01', reason: 'vacant', lockedByConfig: false, muteEndDue: false } });
      expect(history.getOverride('Main', 'parking-a')).toMatchObject({ mutedFrom: NOW.toISOString(), mutedUntil: '2026-12-01' });
      const rows = audit();
      expect(rows).toHaveLength(1);
      expect(rows[0].target).toBe('parking-a');
      expect(Object.keys(rows[0].changes).sort()).toEqual(['mutedUntil', 'reason']);
      expect(JSON.stringify(rows[0])).not.toContain('vacant');
    });

    test('switching off keeps an existing mute (merge)', async () => {
      await boot();
      await put('parking-a', { mutedUntil: '2026-12-01', reason: 'vacant' });
      const res = await put('parking-a', { enabled: false });
      expect(res.json.ruleState).toMatchObject({ enabled: false, mutedUntil: '2026-12-01', reason: 'vacant' });
    });

    test('an extension keeps the original mutedFrom', async () => {
      await boot();
      await put('parking-a', { mutedUntil: '2026-12-01', reason: 'vacant' });
      history.db.prepare("UPDATE payment_alert_override SET muted_from = '2026-09-15T00:00:00.000Z'").run();
      await put('parking-a', { mutedUntil: '2027-01-01', reason: 'still vacant' });
      expect(history.getOverride('Main', 'parking-a')).toMatchObject({ mutedFrom: '2026-09-15T00:00:00.000Z', mutedUntil: '2027-01-01', reason: 'still vacant' });
    });

    test('early unmute deletes the override and the held-back rows, with no summary', async () => {
      await boot();
      await put('parking-a', { mutedUntil: '2026-12-01', reason: 'vacant' });
      history.recordScheduleAlert({
        server: 'Main', alertId: 'parking-a', scheduleId: 's1', occurrenceDate: '2026-10-05',
        event: 'missing', channel: 'telegram', delivery: 'muted'
      });
      const res = await put('parking-a', { mutedUntil: null });
      expect(res.status).toBe(200);
      expect(res.json.ruleState).toMatchObject({ enabled: true, mutedUntil: null, reason: null });
      expect(history.getOverride('Main', 'parking-a')).toBeNull();
      expect(history.listMutedRows({ server: 'Main', alertId: 'parking-a' })).toEqual([]);
    });

    test('enabled:true with no override is a no-op: nothing stored, nothing audited', async () => {
      await boot();
      const res = await put('parking-a', { enabled: true });
      expect(res.status).toBe(200);
      expect(history.listOverrides()).toEqual([]);
      expect(audit()).toEqual([]);
    });

    test('mutedUntil:null with a reason ignores the reason', async () => {
      await boot();
      const res = await put('parking-a', { mutedUntil: null, reason: 'x' });
      expect(res.status).toBe(200);
      expect(history.listOverrides()).toEqual([]);
    });

    test('a config-disabled alert can be unmuted but not enabled or muted', async () => {
      await boot();
      history.setOverride({ server: 'Main', alertId: 'legacy', mutedFrom: NOW.toISOString(), mutedUntil: '2026-12-01', reason: 'r' });
      const unmute = await put('legacy', { mutedUntil: null });
      expect(unmute.status).toBe(200);
      expect(unmute.json.ruleState.lockedByConfig).toBe(true);
      const before = audit().length;
      const enable = await put('legacy', { enabled: true });
      expect(enable.status).toBe(409);
      expect(enable.json).toEqual({ error: 'disabled_in_config' });
      expect((await put('legacy', { mutedUntil: '2026-12-01', reason: 'x' })).status).toBe(409);
      expect(audit()).toHaveLength(before);
    });

    // A top-level JSON string never reaches the handler: the #259 parser is
    // strict and answers invalid_json (the issue text said invalid_body).
    test('a top-level JSON string is refused by the strict #259 parser', async () => {
      await boot();
      const res = await put('parking-a', '"x"');
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'invalid_json' });
    });

    test.each([
      ['empty object', {}],
      ['array', []],
      ['unknown key', { foo: 1 }],
      ['wrong enabled type', { enabled: 'yes' }]
    ])('invalid_body: %s', async (_n, body) => {
      await boot();
      const res = await put('parking-a', body);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'invalid_body' });
    });

    test.each([
      ['not a real date', { mutedUntil: '2026-02-30', reason: 'x' }],
      ['yesterday', { mutedUntil: '2026-09-30', reason: 'x' }],
      ['today + 366 days', { mutedUntil: '2027-10-02', reason: 'x' }],
      ['bad format', { mutedUntil: '1/2/2026', reason: 'x' }]
    ])('invalid_muted_until: %s', async (_n, body) => {
      await boot();
      const res = await put('parking-a', body);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'invalid_muted_until' });
    });

    test('today and today + 365 days are accepted', async () => {
      await boot();
      expect((await put('parking-a', { mutedUntil: '2026-10-01', reason: 'x' })).status).toBe(200);
      expect((await put('parking-a', { mutedUntil: '2027-10-01', reason: 'x' })).status).toBe(200);
    });

    test('reason_required and invalid_reason', async () => {
      await boot();
      expect((await put('parking-a', { mutedUntil: '2026-12-01' })).json).toEqual({ error: 'reason_required' });
      expect((await put('parking-a', { mutedUntil: '2026-12-01', reason: '   ' })).json).toEqual({ error: 'reason_required' });
      const long = await put('parking-a', { mutedUntil: '2026-12-01', reason: 'x'.repeat(201) });
      expect(long.status).toBe(400);
      expect(long.json).toEqual({ error: 'invalid_reason' });
      expect((await put('parking-a', { mutedUntil: '2026-12-01', reason: 'x'.repeat(200) })).status).toBe(200);
    });

    test('a reason-only PUT on a muted alert is rejected when too long or blank, never cut (#261)', async () => {
      await boot();
      await put('parking-a', { mutedUntil: '2026-12-01', reason: 'vacant' });
      const long = await put('parking-a', { reason: 'y'.repeat(300) });
      expect(long.status).toBe(400);
      expect(long.json).toEqual({ error: 'invalid_reason' });
      expect((await put('parking-a', { reason: '   ' })).json).toEqual({ error: 'reason_required' });
      expect(history.getOverride('Main', 'parking-a').reason).toBe('vacant');
      const ok = await put('parking-a', { reason: '  new reason  ' });
      expect(ok.status).toBe(200);
      expect(history.getOverride('Main', 'parking-a').reason).toBe('new reason');
    });

    test('404 for an unknown server, an unknown alert and __proto__', async () => {
      await boot();
      const server = await call('PUT', STATE('Nope', 'parking-a'), { body: { enabled: false } });
      expect(server.status).toBe(404);
      expect(server.json).toEqual({ error: 'server_not_found' });
      expect((await put('missing', { enabled: false })).json).toEqual({ error: 'alert_not_found' });
      const proto = await put('__proto__', { enabled: false });
      expect(proto.status).toBe(404);
      expect(proto.json).toEqual({ error: 'alert_not_found' });
    });

    test('write gates: disabled, auth none, origin, auth, bad JSON, size, content type', async () => {
      await boot({ dashboard: { allowConfigWrites: false } });
      const off = await put('parking-a', { enabled: false });
      expect(off.status).toBe(403);
      expect(off.json).toEqual({ error: 'config_writes_disabled', reason: 'disabled' });
      await svc.stop();
      history.close();
      cleanupTempDir(dbDir);

      await boot({ dashboard: { auth: { type: 'none' } } });
      const none = await put('parking-a', { enabled: false }, { auth: null });
      expect(none.json).toEqual({ error: 'config_writes_disabled', reason: 'auth-none' });
      await svc.stop();
      history.close();
      cleanupTempDir(dbDir);

      await boot();
      const evil = await put('parking-a', { enabled: false }, { headers: { Origin: 'https://evil.example' } });
      expect(evil.json).toEqual({ error: 'origin_rejected' });
      expect((await put('parking-a', { enabled: false }, { auth: null })).json).toEqual({ error: 'Authentication required' });
      expect((await put('parking-a', { enabled: false }, { auth: basicHeader('bad') })).json).toEqual({ error: 'Invalid credentials' });
      expect((await put('parking-a', '{"enabled":')).json).toEqual({ error: 'invalid_json' });
      const big = await put('parking-a', JSON.stringify({ reason: 'x'.repeat(17000) }));
      expect(big.status).toBe(413);
      const text = await put('parking-a', '{"enabled":false}', { headers: { 'Content-Type': 'text/plain' } });
      expect(text.status).toBe(415);
      expect(history.listOverrides()).toEqual([]);
      expect(audit()).toEqual([]);
    });
  });

  describe('DELETE', () => {
    const del = (id, opts = {}) => call('DELETE', STATE('Main', id), opts);

    test('removes the override with no body, audits, and drops held-back rows', async () => {
      await boot();
      await put('parking-a', { enabled: false, mutedUntil: '2026-12-01', reason: 'vacant' });
      history.recordScheduleAlert({
        server: 'Main', alertId: 'parking-a', scheduleId: 's1', occurrenceDate: '2026-10-05',
        event: 'missing', channel: 'telegram', delivery: 'muted'
      });
      const res = await del('parking-a');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ deleted: true });
      expect(history.getOverride('Main', 'parking-a')).toBeNull();
      expect(history.listMutedRows({ server: 'Main', alertId: 'parking-a' })).toEqual([]);
      expect(audit()).toHaveLength(2);
      expect(JSON.stringify(audit())).not.toContain('vacant');
    });

    test('an orphaned override and a config-disabled alert can be deleted', async () => {
      await boot();
      history.setOverride({ server: 'Gone', alertId: 'old', enabled: false });
      history.setOverride({ server: 'Main', alertId: 'legacy', enabled: false });
      expect((await call('DELETE', STATE('Gone', 'old'))).json).toEqual({ deleted: true });
      expect((await del('legacy')).status).toBe(200);
    });

    test('404 override_not_found when there is none', async () => {
      await boot();
      const res = await del('parking-a');
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: 'override_not_found' });
    });

    test('gates leave the override in place', async () => {
      await boot();
      history.setOverride({ server: 'Main', alertId: 'parking-a', enabled: false });
      expect((await del('parking-a', { auth: null })).json).toEqual({ error: 'Authentication required' });
      expect((await del('parking-a', { headers: { Origin: 'https://evil.example' } })).json).toEqual({ error: 'origin_rejected' });
      expect(history.getOverride('Main', 'parking-a')).not.toBeNull();
      expect(audit()).toEqual([]);
    });
  });

  describe('GET /api/dashboard/payment-overrides', () => {
    test('lists overrides ordered, with orphaned flags', async () => {
      await boot();
      history.setOverride({ server: 'Main', alertId: 'parking-a', mutedFrom: '2026-10-20T08:00:00.000Z', mutedUntil: '2026-12-01', reason: 'vacant' });
      history.setOverride({ server: 'Main', alertId: 'old', enabled: false });
      const res = await call('GET', '/api/dashboard/payment-overrides');
      expect(res.status).toBe(200);
      expect(res.json.overrides.map((o) => [o.alertId, o.orphaned])).toEqual([['old', true], ['parking-a', false]]);
      expect(res.json.overrides[1]).toEqual({
        server: 'Main', alertId: 'parking-a', enabled: true, mutedFrom: '2026-10-20T08:00:00.000Z',
        mutedUntil: '2026-12-01', reason: 'vacant', updatedAt: NOW.toISOString(), orphaned: false
      });
    });

    test('empty and unauthenticated', async () => {
      await boot();
      expect((await call('GET', '/api/dashboard/payment-overrides')).json).toEqual({ overrides: [] });
      expect((await call('GET', '/api/dashboard/payment-overrides', { auth: null })).status).toBe(401);
    });
  });

  test('GET /payments reports the rule state with the override', async () => {
    await boot();
    history.replacePaymentSnapshot('Main', [
      { alertId: 'parking-a', scheduleId: 's1', name: 'Rent', cadenceText: 'x', account: 'Main', payee: 'T', expectedAmount: 1, nextDate: '2026-11-05', deadline: '2026-10-11', state: 'missing', occurrences: [] },
      { alertId: 'legacy', scheduleId: 's2', name: 'Old', cadenceText: 'x', account: 'Main', payee: 'T', expectedAmount: 1, nextDate: '2026-11-05', deadline: '2026-10-11', state: 'missing', occurrences: [] }
    ]);
    history.setOverride({ server: 'Main', alertId: 'parking-a', mutedFrom: NOW.toISOString(), mutedUntil: '2026-12-01', reason: 'vacant' });
    const res = await call('GET', '/api/dashboard/payments?server=Main');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.json.servers[0].items.map((i) => [i.alertId, i.ruleState]));
    expect(byId['parking-a']).toEqual({ enabled: true, mutedUntil: '2026-12-01', reason: 'vacant', lockedByConfig: false, muteEndDue: false });
    expect(byId.legacy).toEqual({ enabled: false, mutedUntil: null, reason: null, lockedByConfig: true, muteEndDue: false });
  });

  test('GET /payments reports muteEndDue once the mute day is over in the server timezone (#261)', async () => {
    await boot();
    history.replacePaymentSnapshot('Main', [
      { alertId: 'parking-a', scheduleId: 's1', name: 'Rent', cadenceText: 'x', account: 'Main', payee: 'T', expectedAmount: 1, nextDate: '2026-11-05', deadline: '2026-10-11', state: 'missing', occurrences: [] }
    ]);
    history.setOverride({ server: 'Main', alertId: 'parking-a', mutedFrom: '2026-09-01T00:00:00.000Z', mutedUntil: '2026-09-20', reason: 'vacant' });
    const res = await call('GET', '/api/dashboard/payments?server=Main');
    expect(res.json.servers[0].items[0].ruleState).toMatchObject({ mutedUntil: '2026-09-20', muteEndDue: true });
  });
});
