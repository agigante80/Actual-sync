/**
 * Payment alert overrides (#261): the payment_alert_override table, the ledger
 * `delivery` filter, retention (cleanup + expireStaleMutes), the history
 * resets and (further down) the PUT / DELETE / GET routes.
 */
const path = require('path');
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
