/**
 * Service-level tests for the missing-payment alerts sync step (#258).
 *
 * Unlike scheduleAlerts.test.js (pure evaluate()) and
 * scheduleAlertDelivery.test.js (deliver() against in-memory fakes), this
 * file exercises `src/lib/scheduleAlertsStep.js` against:
 *   - a stubbed `@actual-app/api` (plain object, not a jest.mock module: the
 *     step takes `api` as an injected argument, so no module mock is needed);
 *   - a REAL `SyncHistoryService` backed by a temp SQLite file, proving the
 *     ledger round-trips through actual SQL, not a fake;
 *   - a REAL `NotificationService` sending to a local fake-channel HTTP
 *     server, proving the full render-and-send path works end to end.
 *
 * The second describe block calls the exact `maybeRunScheduleAlerts` /
 * `maybeDeliverScheduleAlerts` pair src/syncService.js's own `runSyncBank`
 * calls (#295 review, M5): earlier this file tested a hand-copied
 * `runSyncBankLike` helper that could drift from the real gate-and-catch
 * logic without anything catching it. Calling the same exported functions
 * production code calls closes that gap. It is also the service-level test
 * docs/plans/p1-v1-18-payment-alerts.md requires under its "Fails if" guard
 * for #271 item 10: a test proving the sync's own result is unchanged when
 * this step throws.
 *
 * `account.last_sync` fixtures use `epochMs(...)`, matching production
 * Actual's own epoch-millisecond string format, not a plain date string
 * (#295 review, H1) - see scheduleAlerts.test.js's own module comment for
 * the same rationale.
 */

const http = require('http');
const path = require('path');
const moment = require('moment-timezone');
const {
  runScheduleAlertsStep,
  evaluateScheduleAlerts,
  maybeRunScheduleAlerts,
  maybeDeliverScheduleAlerts
} = require('../lib/scheduleAlertsStep');
const { MAX_LOOKBACK_DAYS, LINKED_EARLY_WINDOW_DAYS } = require('../lib/scheduleAlerts');
const { SyncHistoryService } = require('../services/syncHistory');
const { NotificationService } = require('../services/notificationService');
const { createTempDir, cleanupTempDir } = require('./helpers/testHelpers');

const quietLogger = { info() {}, warn() {}, error() {} };

/** Production `last_sync` is an epoch-millisecond string, not a date string (#295 review, H1). */
function epochMs(dateOrDateTimeStr) {
  return String(Date.parse(dateOrDateTimeStr));
}

/**
 * A stand-in for the timedActual-wrapped @actual-app/api instance
 * scheduleAlertsStep.js depends on. `q(collection)` returns a chainable
 * builder that records only the collection name, since that is all the fake
 * aqlQuery needs to route on.
 */
function makeFakeApi({ schedules = [], payees = [], accounts = [], transactions = [], getSchedules } = {}) {
  // `captured` records the last filter()/options() argument seen per
  // collection, so a test can assert on the exact query shape
  // evaluateScheduleAlerts builds (#295 review, H3/M4) without needing a
  // real SQL-filtering fake.
  const captured = { filter: {}, options: {} };
  const q = (collection) => {
    const builder = {
      collection,
      filter(arg) { captured.filter[collection] = arg; return builder; },
      select() { return builder; },
      options(arg) { captured.options[collection] = arg; return builder; }
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
    }),
    _captured: captured
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
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-09') }],
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
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-09') }],
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

describe('scheduleAlertsSync: gate + catch, real functions (#258, #271 item 10, #295 review M5)', () => {
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
   * Mirrors src/syncService.js's own runSyncBank exactly (#295 review, M5):
   * the read phase (`maybeRunScheduleAlerts`) runs where the Actual session
   * would still be open; `recordSync` stands in for "the rest of
   * runSyncBank" (endTimer, syncHistory.recordSync) which in production runs
   * between the two phases; the write phase (`maybeDeliverScheduleAlerts`)
   * runs after that, exactly as it does in syncService.js. Both phases are
   * the real exported functions, not a local copy, so this test cannot drift
   * from production behavior the way the old hand-copied helper could.
   */
  async function runSyncBankLike(server_, api, notificationService, now) {
    const evaluated = await maybeRunScheduleAlerts(server_, {
      api, serverName: 'Main', timezone: 'UTC', now, logger
    });
    const syncResult = syncHistory.recordSync({
      serverName: 'Main', status: 'success', durationMs: 1234,
      accountsProcessed: 1, accountsSucceeded: 1, accountsFailed: 0, accountsSkipped: 0
    });
    await maybeDeliverScheduleAlerts(evaluated, { syncHistory, notificationService, logger });
    return syncResult;
  }

  test('no scheduleAlerts block on the server -> getSchedules is called 0 times and nothing is evaluated', async () => {
    const api = makeFakeApi({ schedules: [rentSchedule()] });
    const server_ = {}; // no scheduleAlerts key at all

    const evaluated = await maybeRunScheduleAlerts(server_, {
      api, serverName: 'Main', timezone: 'UTC', logger
    });

    expect(evaluated).toBeNull();
    expect(api.getSchedules).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(0);
  });

  test('api.getSchedules() rejecting does not throw and does not change the recorded sync status', async () => {
    const api = makeFakeApi({ getSchedules: jest.fn().mockRejectedValue(new Error('Actual session lost')) });
    const server_ = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent' }] } };

    await expect(runSyncBankLike(server_, api, { sendTemplated: jest.fn() })).resolves.toBeDefined();

    const history = syncHistory.getHistory({ serverName: 'Main', limit: 1 });
    expect(history[0]).toMatchObject({ status: 'success', server_name: 'Main' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toBe('Schedule alerts evaluation failed; sync result is unaffected');
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
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-09') }],
      transactions: []
    });
    const throwingSender = {
      config: { webhooks: { generic: [{ url: 'http://127.0.0.1:1', enabled: true }] } },
      sendTemplated: jest.fn().mockRejectedValue(new Error('network unreachable'))
    };
    const server_ = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['webhook'] }] } };

    await runSyncBankLike(server_, api, throwingSender, new Date('2026-01-10T00:00:00.000Z'));

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

describe('evaluateScheduleAlerts: transaction query construction (#295 review, H3/M4)', () => {
  test('H3: the fetch window widens by the largest configured earlyDays (at least LINKED_EARLY_WINDOW_DAYS)', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const api = makeFakeApi({
      schedules: [rentSchedule()],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-05-31') }]
    });
    const server_ = {
      scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', earlyDays: 10 }] }
    };

    await evaluateScheduleAlerts({ api, server: server_, serverName: 'Main', timezone: 'UTC', now, logger: quietLogger });

    const expectedStart = moment.tz(now, 'UTC').subtract(MAX_LOOKBACK_DAYS + 10, 'days').format('YYYY-MM-DD');
    expect(api._captured.filter.transactions.date.$gte).toBe(expectedStart);
    // Without the H3 fix this would equal the fixed MAX_LOOKBACK_DAYS-only
    // boundary, 10 days later than expected - an early payment placed in
    // that gap would never be fetched at all.
    const oldUnfixedStart = moment.tz(now, 'UTC').subtract(MAX_LOOKBACK_DAYS, 'days').format('YYYY-MM-DD');
    expect(api._captured.filter.transactions.date.$gte).not.toBe(oldUnfixedStart);
  });

  test('H3: with no configured earlyDays above the default, the window still widens by LINKED_EARLY_WINDOW_DAYS', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const api = makeFakeApi({
      schedules: [rentSchedule()],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-05-31') }]
    });
    // DEFAULT_EARLY_DAYS (2) happens to equal LINKED_EARLY_WINDOW_DAYS here,
    // so this asserts the floor applies even when every rule's own
    // earlyDays is smaller than it.
    const server_ = {
      scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', earlyDays: 0 }] }
    };

    await evaluateScheduleAlerts({ api, server: server_, serverName: 'Main', timezone: 'UTC', now, logger: quietLogger });

    const expectedStart = moment.tz(now, 'UTC').subtract(MAX_LOOKBACK_DAYS + LINKED_EARLY_WINDOW_DAYS, 'days').format('YYYY-MM-DD');
    expect(api._captured.filter.transactions.date.$gte).toBe(expectedStart);
  });

  test('M4: the transactions query requests splits: none so a split parent keeps its schedule link', async () => {
    const api = makeFakeApi({
      schedules: [rentSchedule()],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-09') }]
    });
    const server_ = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent' }] } };

    await evaluateScheduleAlerts({
      api, server: server_, serverName: 'Main', timezone: 'UTC',
      now: new Date('2026-01-10T00:00:00.000Z'), logger: quietLogger
    });

    expect(api._captured.options.transactions).toEqual({ splits: 'none' });
  });

  test('M4: a scheduled payment recorded as a split parent is matched, not lost to inline explosion', async () => {
    const dbDir = createTempDir();
    const syncHistory = new SyncHistoryService({
      dbPath: path.join(dbDir, 'sync-history.db'),
      loggerConfig: { level: 'ERROR' }
    });
    try {
      const api = makeFakeApi({
        schedules: [rentSchedule()],
        payees: [{ id: 'pay1', name: 'Landlord' }],
        accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-09') }],
        // A split parent: is_parent-style row that still carries the
        // schedule link and the full amount (what `splits: 'none'` returns).
        transactions: [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-05', schedule: 's1' }]
      });
      const sent = [];
      const notificationService = { sendTemplated: jest.fn(async (outputs) => { sent.push(outputs); return { anySucceeded: true, byChannel: {} }; }) };
      const server_ = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['webhook'] }] } };

      const result = await runScheduleAlertsStep({
        api, server: server_, serverName: 'Main', timezone: 'UTC', syncHistory, notificationService,
        logger: quietLogger, now: new Date('2026-01-10T00:00:00.000Z')
      });

      // The split-parent transaction satisfies the schedule, so no "missing"
      // event is produced (before the fix, an inline-exploded transactions
      // query would have dropped the schedule link and reported "missing").
      expect(result).toEqual({ events: 0, sent: 0, skipped: 0 });
    } finally {
      syncHistory.close();
      cleanupTempDir(dbDir);
    }
  });
});
