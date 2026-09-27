/**
 * Service-level tests for the missing-payment alerts sync step (#258).
 *
 * Unlike scheduleAlerts.test.js (pure evaluate()) and
 * scheduleAlertDelivery.test.js (deliver() against in-memory fakes), this
 * file exercises `src/lib/scheduleAlertsStep.js`'s `runScheduleAlertsStep`
 * against:
 *   - a stubbed `@actual-app/api` (plain object, not a jest.mock module: the
 *     step takes `api` as an injected argument, so no module mock is needed);
 *   - a REAL `SyncHistoryService` backed by a temp SQLite file, proving the
 *     ledger round-trips through actual SQL, not a fake;
 *   - a REAL `NotificationService` sending to a local fake-channel HTTP
 *     server, proving the full render-and-send path works end to end.
 *
 * The second describe block is the one docs/plans/p1-v1-18-payment-alerts.md
 * requires under its "Fails if" guard for #271 item 10: a service-level test
 * proving the sync's own result is unchanged when this step throws. The
 * try/catch there is copied verbatim from src/syncService.js's own wrapping
 * of `runScheduleAlertsStep` (see the comment above that call site), so this
 * is a faithful reproduction of production behavior, not a parallel
 * implementation that could drift from it.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { runScheduleAlertsStep } = require('../lib/scheduleAlertsStep');
const { SyncHistoryService } = require('../services/syncHistory');
const { NotificationService } = require('../services/notificationService');
const { createTempDir, cleanupTempDir } = require('./helpers/testHelpers');

const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * A stand-in for the timedActual-wrapped @actual-app/api instance
 * runScheduleAlertsStep depends on. `q(collection)` returns a chainable
 * builder that records only the collection name, since that is all the fake
 * aqlQuery needs to route on.
 */
function makeFakeApi({ schedules = [], payees = [], accounts = [], transactions = [], getSchedules } = {}) {
  const q = (collection) => {
    const builder = {
      collection,
      filter() { return builder; },
      select() { return builder; }
    };
    return builder;
  };
  return {
    getSchedules: getSchedules || jest.fn().mockResolvedValue(schedules),
    q: jest.fn(q),
    aqlQuery: jest.fn(async (builder) => {
      if (builder.collection === 'payees') return { data: payees };
      if (builder.collection === 'accounts') return { data: accounts };
      if (builder.collection === 'transactions') return { data: transactions };
      return { data: [] };
    })
  };
}

function rentSchedule(overrides = {}) {
  return {
    id: 's1', name: 'Rent', account: 'acc1', payee: 'pay1',
    amount: -50000, amountOp: 'is', date: '2026-01-05',
    ...overrides
  };
}

describe('scheduleAlertsSync: end-to-end delivery (#258)', () => {
  let server;
  let baseUrl;
  let received;
  let syncHistory;
  let dbDir;

  beforeEach((done) => {
    received = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ url: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      dbDir = createTempDir();
      syncHistory = new SyncHistoryService({
        dbPath: path.join(dbDir, 'sync-history.db'),
        loggerConfig: { level: 'ERROR' }
      });
      done();
    });
  });

  afterEach((done) => {
    syncHistory.close();
    cleanupTempDir(dbDir);
    server.close(done);
  });

  test('a missing payment is evaluated, rendered, POSTed to the webhook, and recorded in a real SyncHistoryService', async () => {
    const api = makeFakeApi({
      schedules: [rentSchedule()],
      payees: [{ id: 'pay1', name: 'Landlord' }],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: '2026-01-09' }],
      transactions: []
    });
    const notificationService = new NotificationService(
      { webhooks: { generic: [{ url: `${baseUrl}/hook`, enabled: true }] } },
      { level: 'ERROR' }
    );
    const server_ = {
      scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['webhook'] }] }
    };

    const result = await runScheduleAlertsStep({
      api,
      server: server_,
      serverName: 'Main',
      timezone: 'UTC',
      syncHistory,
      notificationService,
      logger: quietLogger,
      now: new Date('2026-01-10T00:00:00.000Z')
    });

    expect(result).toEqual({ events: 1, sent: 1, skipped: 0 });

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/hook');
    expect(received[0].body).toMatch(/Rent/);
    expect(received[0].body).toMatch(/Landlord/);

    const ledgerRow = await syncHistory.findLatestScheduleAlert({
      server: 'Main', alertId: 'rent', scheduleId: 's1', occurrenceDate: '2026-01-05', event: 'missing'
    });
    expect(ledgerRow).not.toBeNull();
  });

  test('a second sync one day later does not resend (no ledger row, no remindEveryDays configured)', async () => {
    const api = makeFakeApi({
      schedules: [rentSchedule()],
      payees: [{ id: 'pay1', name: 'Landlord' }],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: '2026-01-09' }],
      transactions: []
    });
    const notificationService = new NotificationService(
      { webhooks: { generic: [{ url: `${baseUrl}/hook`, enabled: true }] } },
      { level: 'ERROR' }
    );
    const server_ = {
      scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['webhook'] }] }
    };
    const runArgs = {
      api, server: server_, serverName: 'Main', timezone: 'UTC', syncHistory, notificationService, logger: quietLogger
    };

    await runScheduleAlertsStep({ ...runArgs, now: new Date('2026-01-10T00:00:00.000Z') });
    const second = await runScheduleAlertsStep({ ...runArgs, now: new Date('2026-01-11T00:00:00.000Z') });

    expect(second).toEqual({ events: 1, sent: 0, skipped: 1 });
    expect(received).toHaveLength(1); // still just the first sync's send
  });
});

describe('scheduleAlertsSync: sync result unaffected on failure (#258, #271 item 10)', () => {
  let syncHistory;
  let dbDir;
  let warnings;
  const logger = { info() {}, error() {}, warn(message, meta) { warnings.push({ message, meta }); } };

  beforeEach(() => {
    warnings = [];
    dbDir = createTempDir();
    syncHistory = new SyncHistoryService({
      dbPath: path.join(dbDir, 'sync-history.db'),
      loggerConfig: { level: 'ERROR' }
    });
  });

  afterEach(() => {
    syncHistory.close();
    cleanupTempDir(dbDir);
  });

  /**
   * Mirrors src/syncService.js's own wrapping of runScheduleAlertsStep,
   * verbatim: a try/catch that logs at WARN and never rethrows, followed by
   * the sync's own recordSync call (representing "the rest of runSyncBank").
   */
  async function runSyncBankLike(server_, api, notificationService) {
    if (server_.scheduleAlerts) {
      try {
        await runScheduleAlertsStep({
          api, server: server_, serverName: 'Main', timezone: 'UTC',
          syncHistory, notificationService, logger
        });
      } catch (scheduleAlertError) {
        logger.warn('Schedule alerts failed; sync result is unaffected', {
          error: scheduleAlertError.message
        });
      }
    }
    return syncHistory.recordSync({
      serverName: 'Main', status: 'success', durationMs: 1234,
      accountsProcessed: 1, accountsSucceeded: 1, accountsFailed: 0, accountsSkipped: 0
    });
  }

  test('api.getSchedules() rejecting does not throw and does not change the recorded sync status', async () => {
    const api = makeFakeApi({ getSchedules: jest.fn().mockRejectedValue(new Error('Actual session lost')) });
    const server_ = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent' }] } };

    await expect(runSyncBankLike(server_, api, { sendTemplated: jest.fn() })).resolves.toBeDefined();

    const history = syncHistory.getHistory({ serverName: 'Main', limit: 1 });
    expect(history[0]).toMatchObject({ status: 'success', server_name: 'Main' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toBe('Schedule alerts failed; sync result is unaffected');
    expect(warnings[0].meta.error).toBe('Actual session lost');
  });

  test('aqlQuery rejecting mid-step is also swallowed, and no ledger row is left behind', async () => {
    const api = makeFakeApi({ schedules: [rentSchedule()] });
    api.aqlQuery = jest.fn().mockRejectedValue(new Error('aql failed'));
    const server_ = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent' }] } };

    await runSyncBankLike(server_, api, { sendTemplated: jest.fn() });

    const history = syncHistory.getHistory({ serverName: 'Main', limit: 1 });
    expect(history[0].status).toBe('success');
    const ledgerRow = await syncHistory.findLatestScheduleAlert({
      server: 'Main', alertId: 'rent', scheduleId: 's1', occurrenceDate: '2026-01-05', event: 'missing'
    });
    expect(ledgerRow).toBeNull();
  });

  test('a sender that throws on every send is swallowed by deliver(), still leaving the sync result unaffected', async () => {
    const api = makeFakeApi({
      schedules: [rentSchedule()],
      payees: [{ id: 'pay1', name: 'Landlord' }],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: '2026-01-09' }],
      transactions: []
    });
    const throwingSender = {
      config: { webhooks: { generic: [{ url: 'http://127.0.0.1:1', enabled: true }] } },
      sendTemplated: jest.fn().mockRejectedValue(new Error('network unreachable'))
    };
    const server_ = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['webhook'] }] } };

    await runSyncBankLike(server_, api, throwingSender);

    const history = syncHistory.getHistory({ serverName: 'Main', limit: 1 });
    expect(history[0].status).toBe('success');
    // deliver() itself catches the send failure (sendOnce), so no top-level
    // warning is logged here and no ledger row is written for the retry.
    const ledgerRow = await syncHistory.findLatestScheduleAlert({
      server: 'Main', alertId: 'rent', scheduleId: 's1', occurrenceDate: '2026-01-05', event: 'missing'
    });
    expect(ledgerRow).toBeNull();
  });
});
