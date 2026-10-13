/**
 * SyncHistoryService payment snapshot methods (#260): replacePaymentSnapshot,
 * recordPaymentRunFailure, deletePaymentSnapshot, getPaymentSnapshot,
 * getLastSentAlerts and the two history resets. Real SQLite, injected clock.
 */
const path = require('path');
const { SyncHistoryService } = require('../services/syncHistory');
const { createTempDir, cleanupTempDir } = require('./helpers/testHelpers');

function evaluation(overrides = {}) {
  return {
    alertId: 'parking-a', scheduleId: 's1', name: 'Rent - Parking A',
    cadenceText: 'Every month on the 5th', account: 'Main', payee: 'Tenant A',
    expectedAmount: 6000, nextDate: '2026-02-05', deadline: '2026-01-11', state: 'missing',
    occurrences: [{ date: '2026-01-05', deadline: '2026-01-11', state: 'missing', receivedDate: null, receivedAmount: null }],
    ...overrides
  };
}

describe('payment snapshot persistence (#260)', () => {
  let syncHistory;
  let dbDir;
  let clock;

  beforeEach(() => {
    clock = new Date('2026-01-14T08:01:00.000Z');
    dbDir = createTempDir();
    syncHistory = new SyncHistoryService({
      dbPath: path.join(dbDir, 'sync-history.db'),
      loggerConfig: { level: 'ERROR' },
      now: () => new Date(clock)
    });
  });

  afterEach(() => {
    syncHistory.close();
    cleanupTempDir(dbDir);
  });

  const rowCount = (table, server) => syncHistory.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE server = ?`).get(server).n;

  test('saves an evaluation as one row with cents, state and a successful run row', () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation()], { erroredPairs: [] });
    const raw = syncHistory.db.prepare('SELECT * FROM payment_alert_status WHERE server = ?').all('Main');
    expect(raw).toHaveLength(1);
    expect(raw[0].state).toBe('missing');
    expect(raw[0].expected_amount).toBe(6000);
    const { items, run } = syncHistory.getPaymentSnapshot('Main');
    expect(items[0].occurrences).toEqual(evaluation().occurrences);
    expect(run).toEqual({
      at: '2026-01-14T08:01:00.000Z', ok: true, errorCode: null,
      lastSuccessAt: '2026-01-14T08:01:00.000Z', rulesErrored: 0
    });
  });

  test('normalises an isbetween range to min/max and round-trips a skipped occurrence', () => {
    const occ = [{ date: '2026-01-05', deadline: '2026-01-11', state: 'skipped', receivedDate: null, receivedAmount: null }];
    syncHistory.replacePaymentSnapshot('Main', [evaluation({ expectedAmount: { num1: 7000, num2: 5000 }, state: 'skipped', occurrences: occ })]);
    const raw = syncHistory.db.prepare('SELECT * FROM payment_alert_status').get();
    expect(raw.expected_amount).toBeNull();
    expect(raw.expected_min).toBe(5000);
    expect(raw.expected_max).toBe(7000);
    const [item] = syncHistory.getPaymentSnapshot('Main').items;
    expect(item.expectedAmount).toEqual({ num1: 5000, num2: 7000 });
    expect(item.occurrences).toEqual(occ);
  });

  test('stores an absent amount as null', () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation({ expectedAmount: null })]);
    expect(syncHistory.getPaymentSnapshot('Main').items[0].expectedAmount).toBeNull();
  });

  test('deletes a row whose pair is no longer evaluated', () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation({ alertId: 'old', scheduleId: 's9' }), evaluation()]);
    syncHistory.replacePaymentSnapshot('Main', [evaluation()]);
    const ids = syncHistory.getPaymentSnapshot('Main').items.map((i) => i.alertId);
    expect(ids).toEqual(['parking-a']);
  });

  test('a successful run with zero evaluations empties the set and keeps the run ok', () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation()]);
    syncHistory.replacePaymentSnapshot('Main', [], { erroredPairs: [] });
    expect(rowCount('payment_alert_status', 'Main')).toBe(0);
    expect(syncHistory.getPaymentSnapshot('Main').run.ok).toBe(true);
  });

  test('an errored pair keeps its previous row and is counted', () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation({ alertId: 'r1' }), evaluation({ alertId: 'r2' })]);
    syncHistory.replacePaymentSnapshot('Main', [evaluation({ alertId: 'r2', state: 'received' })], {
      erroredPairs: [{ alertId: 'r1', scheduleId: 's1' }]
    });
    const { items, run } = syncHistory.getPaymentSnapshot('Main');
    expect(items.map((i) => [i.alertId, i.state])).toEqual([['r1', 'missing'], ['r2', 'received']]);
    expect(run.rulesErrored).toBe(1);
  });

  test('a disabled rule that is still evaluated keeps its row', () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation()]);
    syncHistory.replacePaymentSnapshot('Main', [evaluation({ state: 'upcoming' })]);
    expect(syncHistory.getPaymentSnapshot('Main').items).toHaveLength(1);
  });

  test('never touches another server', () => {
    syncHistory.replacePaymentSnapshot('Other', [evaluation()]);
    syncHistory.replacePaymentSnapshot('Main', []);
    expect(rowCount('payment_alert_status', 'Other')).toBe(1);
  });

  test('a mid-transaction failure rolls everything back', () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation({ alertId: 'keep' })]);
    // The first row upserts fine; the second violates NOT NULL on state inside
    // the transaction, so only a real rollback leaves ['keep'] (#343 review, M1).
    expect(() => syncHistory.replacePaymentSnapshot('Main', [
      evaluation({ alertId: 'new' }), evaluation({ alertId: 'bad', state: null })
    ])).toThrow();
    const ids = syncHistory.db.prepare('SELECT alert_id FROM payment_alert_status').all().map((r) => r.alert_id);
    expect(ids).toEqual(['keep']);
  });

  test('recordPaymentRunFailure writes only the run row and keeps last_success_at', () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation()]);
    clock = new Date('2026-01-15T08:00:00.000Z');
    syncHistory.recordPaymentRunFailure('Main', 'actual_read_failed');
    const { items, run } = syncHistory.getPaymentSnapshot('Main');
    expect(items).toHaveLength(1);
    expect(run).toEqual({
      at: '2026-01-15T08:00:00.000Z', ok: false, errorCode: 'actual_read_failed',
      lastSuccessAt: '2026-01-14T08:01:00.000Z', rulesErrored: 0
    });
  });

  test('a first run that failed has lastSuccessAt null and no items', () => {
    syncHistory.recordPaymentRunFailure('Main', 'rules_invalid');
    const { items, run } = syncHistory.getPaymentSnapshot('Main');
    expect(items).toEqual([]);
    expect(run.lastSuccessAt).toBeNull();
    expect(run.ok).toBe(false);
  });

  test('a success after a failure restores ok and clears the error code', () => {
    syncHistory.recordPaymentRunFailure('Main', 'evaluation_failed');
    syncHistory.replacePaymentSnapshot('Main', [evaluation()]);
    expect(syncHistory.getPaymentSnapshot('Main').run).toMatchObject({ ok: true, errorCode: null });
  });

  test('getPaymentSnapshot has no run before the first evaluation', () => {
    expect(syncHistory.getPaymentSnapshot('Main')).toEqual({ items: [], run: null });
  });

  test('deletePaymentSnapshot removes both tables for that server only', () => {
    syncHistory.replacePaymentSnapshot('Main', [evaluation()]);
    syncHistory.replacePaymentSnapshot('Other', [evaluation()]);
    syncHistory.deletePaymentSnapshot('Main');
    expect(rowCount('payment_alert_status', 'Main')).toBe(0);
    expect(rowCount('payment_alert_run', 'Main')).toBe(0);
    expect(rowCount('payment_alert_status', 'Other')).toBe(1);
    expect(rowCount('payment_alert_run', 'Other')).toBe(1);
  });

  describe('getLastSentAlerts', () => {
    test('returns the latest sent time per pair, ignoring inferred rows and other servers', async () => {
      const rec = async (server, delivery, iso, scheduleId = 's1') => {
        clock = new Date(iso);
        await syncHistory.recordScheduleAlert({ server, alertId: 'parking-a', scheduleId, occurrenceDate: '2026-01-05', event: 'missing', delivery });
      };
      await rec('Main', 'sent', '2026-01-12T08:01:00.000Z');
      await rec('Main', 'sent', '2026-01-12T09:30:00.000Z');
      await rec('Main', 'inferred', '2026-01-12T10:00:00.000Z');
      await rec('Main', 'sent', '2026-01-11T10:00:00.000Z', 's2');
      await rec('Other', 'sent', '2026-01-13T10:00:00.000Z');
      const map = syncHistory.getLastSentAlerts('Main');
      expect(map.get(JSON.stringify(['parking-a', 's1']))).toBe('2026-01-12T09:30:00.000Z');
      expect(map.get(JSON.stringify(['parking-a', 's2']))).toBe('2026-01-11T10:00:00.000Z');
      expect(map.size).toBe(2);
    });
  });

  describe('history resets', () => {
    beforeEach(() => {
      syncHistory.replacePaymentSnapshot('Main', [evaluation()]);
      syncHistory.replacePaymentSnapshot('Other', [evaluation()]);
    });

    test('resetServerHistory removes that server only', async () => {
      await syncHistory.resetServerHistory('Main');
      expect(rowCount('payment_alert_status', 'Main')).toBe(0);
      expect(rowCount('payment_alert_run', 'Main')).toBe(0);
      expect(rowCount('payment_alert_status', 'Other')).toBe(1);
      expect(rowCount('payment_alert_run', 'Other')).toBe(1);
    });

    test('resetAllHistory removes everything', async () => {
      await syncHistory.resetAllHistory();
      expect(syncHistory.db.prepare('SELECT COUNT(*) AS n FROM payment_alert_status').get().n).toBe(0);
      expect(syncHistory.db.prepare('SELECT COUNT(*) AS n FROM payment_alert_run').get().n).toBe(0);
    });
  });
});
