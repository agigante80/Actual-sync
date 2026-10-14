/**
 * Schedule snapshot and dashboard rule storage (#262).
 */
const path = require('path');
const { SyncHistoryService } = require('../services/syncHistory');
const { createTempDir, cleanupTempDir } = require('./helpers/testHelpers');

describe('actual_schedule_snapshot and payment_alert_rule storage (#262)', () => {
  let syncHistory;
  let dbDir;
  let clock;

  beforeEach(() => {
    clock = new Date('2026-10-01T08:00:00.000Z');
    dbDir = createTempDir();
    syncHistory = new SyncHistoryService({
      dbPath: path.join(dbDir, 'h.db'), loggerConfig: { level: 'ERROR' }, now: () => new Date(clock)
    });
  });

  afterEach(() => {
    if (syncHistory.db) syncHistory.close();
    cleanupTempDir(dbDir);
  });

  const count = (table) => syncHistory.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const sched = (extra = {}) => ({
    id: 's1', name: 'Rent', cadenceText: 'Monthly on the 1st', amount: -85000, amountMin: null,
    amountMax: null, amountOp: 'is', account: 'Checking', payee: 'Landlord', nextDate: '2026-11-01',
    completed: false, ...extra
  });

  describe('schedule snapshot', () => {
    it('round-trips a schedule and reports capturedAt', () => {
      syncHistory.replaceScheduleSnapshot('Main', [sched()], new Date('2026-10-01T08:00:00.000Z'));
      expect(syncHistory.getScheduleSnapshot('Main')).toEqual({
        capturedAt: '2026-10-01T08:00:00.000Z', schedules: [sched()]
      });
    });

    it('stores an isbetween range in min/max with a null amount', () => {
      syncHistory.replaceScheduleSnapshot('Main', [
        sched({ amount: null, amountMin: -5000, amountMax: -9000, amountOp: 'isbetween' })
      ], clock);
      const [row] = syncHistory.getScheduleSnapshot('Main').schedules;
      expect(row).toMatchObject({ amount: null, amountMin: -5000, amountMax: -9000, amountOp: 'isbetween' });
    });

    it('replaces wholesale: a schedule that disappeared is removed', () => {
      syncHistory.replaceScheduleSnapshot('Main', [sched(), sched({ id: 's2', name: 'Gym' })], clock);
      syncHistory.replaceScheduleSnapshot('Main', [sched({ id: 's2', name: 'Gym' })], clock);
      expect(syncHistory.getScheduleSnapshot('Main').schedules.map(s => s.id)).toEqual(['s2']);
    });

    it('keeps servers separate and orders by name', () => {
      syncHistory.replaceScheduleSnapshot('Main', [sched({ id: 'b', name: 'Zoo' }), sched({ id: 'a', name: 'Apple' })], clock);
      syncHistory.replaceScheduleSnapshot('Other', [sched({ id: 'o', name: 'Other' })], clock);
      expect(syncHistory.getScheduleSnapshot('Main').schedules.map(s => s.name)).toEqual(['Apple', 'Zoo']);
      expect(syncHistory.getScheduleSnapshot('Other').schedules).toHaveLength(1);
    });

    it('has a null capturedAt before the first capture', () => {
      expect(syncHistory.getScheduleSnapshot('Main')).toEqual({ capturedAt: null, schedules: [] });
    });

    it('deleteScheduleSnapshot removes only that server', () => {
      syncHistory.replaceScheduleSnapshot('Main', [sched()], clock);
      syncHistory.replaceScheduleSnapshot('Other', [sched()], clock);
      syncHistory.deleteScheduleSnapshot('Main');
      expect(syncHistory.getScheduleSnapshot('Main').schedules).toEqual([]);
      expect(syncHistory.getScheduleSnapshot('Other').schedules).toHaveLength(1);
    });

    it('rolls back the whole replace when a row fails', () => {
      syncHistory.replaceScheduleSnapshot('Main', [sched()], clock);
      expect(() => syncHistory.replaceScheduleSnapshot('Main', [sched({ id: 'x' }), { name: 'no id' }], clock)).toThrow();
      expect(syncHistory.getScheduleSnapshot('Main').schedules.map(s => s.id)).toEqual(['s1']);
    });
  });

  describe('dashboard rules', () => {
    const def = { id: 'rent', schedule: 'Rent', graceDays: 5 };

    it('inserts, reads, lists and counts', () => {
      const row = syncHistory.insertRule('Main', 'rent', def);
      expect(row).toMatchObject({ alertId: 'rent', definition: def, createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' });
      expect(syncHistory.getRule('Main', 'rent').definition).toEqual(def);
      expect(syncHistory.getRule('Other', 'rent')).toBeNull();
      syncHistory.insertRule('Main', 'a-rule', { id: 'a-rule', schedulePrefix: 'A' });
      expect(syncHistory.listRules('Main').map(r => r.alertId)).toEqual(['a-rule', 'rent']);
      expect(syncHistory.countRules('Main')).toBe(2);
      expect(syncHistory.countRules('Other')).toBe(0);
    });

    it('rejects a duplicate (server, alert id)', () => {
      syncHistory.insertRule('Main', 'rent', def);
      expect(() => syncHistory.insertRule('Main', 'rent', def)).toThrow();
    });

    it('update changes the definition and updated_at but not created_at', () => {
      syncHistory.insertRule('Main', 'rent', def);
      clock = new Date('2026-10-02T08:00:00.000Z');
      const row = syncHistory.updateRule('Main', 'rent', { ...def, graceDays: 9 });
      expect(row.definition.graceDays).toBe(9);
      expect(row.createdAt).toBe('2026-10-01T08:00:00.000Z');
      expect(row.updatedAt).toBe('2026-10-02T08:00:00.000Z');
    });

    it('deleteRule reports whether a row was removed', () => {
      syncHistory.insertRule('Main', 'rent', def);
      expect(syncHistory.deleteRule('Main', 'rent')).toBe(true);
      expect(syncHistory.deleteRule('Main', 'rent')).toBe(false);
    });

    it('runInTransaction rolls everything back when the callback throws', () => {
      expect(() => syncHistory.runInTransaction(() => {
        syncHistory.insertRule('Main', 'rent', def);
        throw new Error('boom');
      })).toThrow('boom');
      expect(count('payment_alert_rule')).toBe(0);
    });
  });

  describe('history reset', () => {
    it('resetServerHistory clears the snapshot, counts it, and keeps rules', async () => {
      syncHistory.replaceScheduleSnapshot('Main', [sched(), sched({ id: 's2' })], clock);
      syncHistory.replaceScheduleSnapshot('Other', [sched()], clock);
      syncHistory.insertRule('Main', 'rent', { id: 'rent', schedule: 'Rent' });
      await syncHistory.resetServerHistory('Main', { remoteAddr: '1.2.3.4' });
      expect(syncHistory.getScheduleSnapshot('Main').schedules).toEqual([]);
      expect(syncHistory.getScheduleSnapshot('Other').schedules).toHaveLength(1);
      expect(count('payment_alert_rule')).toBe(1);
      const audit = syncHistory.getConfigAudit({ limit: 1 })[0];
      expect(audit.changes.deleted.actual_schedule_snapshot).toBe(2);
    });

    it('resetAllHistory clears every snapshot, counts them, and keeps rules', async () => {
      syncHistory.replaceScheduleSnapshot('Main', [sched()], clock);
      syncHistory.replaceScheduleSnapshot('Other', [sched()], clock);
      syncHistory.insertRule('Other', 'rent', { id: 'rent', schedule: 'Rent' });
      await syncHistory.resetAllHistory({});
      expect(count('actual_schedule_snapshot')).toBe(0);
      expect(count('payment_alert_rule')).toBe(1);
      const audit = syncHistory.getConfigAudit({ limit: 1 })[0];
      expect(audit.changes.deleted.actual_schedule_snapshot).toBe(2);
    });

    it('hasServerData sees snapshot-only and rule-only servers', () => {
      expect(syncHistory.hasServerData('Main')).toBe(false);
      syncHistory.replaceScheduleSnapshot('Main', [sched()], clock);
      expect(syncHistory.hasServerData('Main')).toBe(true);
      syncHistory.insertRule('Other', 'rent', { id: 'rent', schedule: 'Rent' });
      expect(syncHistory.hasServerData('Other')).toBe(true);
    });
  });
});
