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
  maybeDeliverScheduleAlerts,
  persistPaymentSnapshot
} = require('../lib/scheduleAlertsStep');
const { MAX_LOOKBACK_DAYS, LINKED_EARLY_WINDOW_DAYS } = require('../lib/scheduleAlerts');
const { destinationKey } = require('../lib/scheduleAlertDelivery');
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

describe('scheduleAlertsSync: #297 F1 remembered skip across syncs', () => {
  let syncHistory;
  let dbDir;
  const sender = { config: { webhooks: { generic: [{ url: 'http://127.0.0.1:1/hook', enabled: true }] } }, sendTemplated: jest.fn(async () => ({ webhook: { success: true } })) };

  beforeEach(() => {
    dbDir = createTempDir();
    syncHistory = new SyncHistoryService({ dbPath: path.join(dbDir, 'sync-history.db'), loggerConfig: { level: 'ERROR' } });
    sender.sendTemplated.mockClear();
  });
  afterEach(() => {
    syncHistory.close();
    cleanupTempDir(dbDir);
  });

  const monthly = (nextDate) => rentSchedule({ date: { start: '2026-01-01', frequency: 'monthly' }, next_date: nextDate });
  const server_ = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['webhook'] }] } };
  const run = (api, now) => runScheduleAlertsStep({
    api, server: server_, serverName: 'Main', timezone: 'UTC', syncHistory, notificationService: sender, logger: quietLogger, now: new Date(now)
  });

  test('January skipped in Actual, February paid and linked: January is never reported missing', async () => {
    // Sync 1 (Jan 10): user skipped January, so next_date is already 2026-02-01.
    const first = await run(makeFakeApi({
      schedules: [monthly('2026-02-01')],
      payees: [{ id: 'pay1', name: 'Landlord' }],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-09') }]
    }), '2026-01-10T00:00:00.000Z');
    expect(first).toEqual({ events: 0, sent: 0, skipped: 0 });
    expect(await syncHistory.listScheduleAlertSkips({ server: 'Main' }))
      .toEqual([{ scheduleId: 's1', occurrenceDate: '2026-01-01' }]);

    // Sync 2 (Feb 10): February paid and linked on 02-01, next_date advanced to 03-01.
    const second = await run(makeFakeApi({
      schedules: [monthly('2026-03-01')],
      payees: [{ id: 'pay1', name: 'Landlord' }],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-02-09') }],
      transactions: [{ id: 'feb', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-02-01', schedule: 's1' }]
    }), '2026-02-10T00:00:00.000Z');
    expect(second.events).toBe(0);
    expect(sender.sendTemplated).not.toHaveBeenCalled();
  });

  test('without the first observation (no ledger row) the same February state still reports January missing', async () => {
    const result = await run(makeFakeApi({
      schedules: [monthly('2026-03-01')],
      payees: [{ id: 'pay1', name: 'Landlord' }],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-02-09') }],
      transactions: [{ id: 'feb', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-02-01', schedule: 's1' }]
    }), '2026-02-10T00:00:00.000Z');
    expect(result.events).toBe(1);
  });

  test('a skip decision is recorded once, not again on every sync', async () => {
    const api = makeFakeApi({
      schedules: [monthly('2026-02-01')],
      payees: [{ id: 'pay1', name: 'Landlord' }],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-20') }]
    });
    await run(api, '2026-01-25T00:00:00.000Z');
    await run(api, '2026-01-26T00:00:00.000Z');
    const rows = syncHistory.db.prepare("SELECT * FROM schedule_alerts WHERE event = 'skipped'").all();
    expect(rows).toHaveLength(1);
  });

  test('a failure while recording the skip does not stop the alerts from being delivered', async () => {
    jest.spyOn(syncHistory, 'recordScheduleAlert');
    syncHistory.recordScheduleAlert.mockImplementationOnce(async () => { throw new Error('disk full'); });
    const result = await runScheduleAlertsStep({
      api: makeFakeApi({
        schedules: [monthly('2026-02-01'), rentSchedule({ id: 's2', name: 'Gym', payee: 'pay2', date: '2026-01-05' })],
        payees: [{ id: 'pay1', name: 'Landlord' }, { id: 'pay2', name: 'Gym Ltd' }],
        accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-20') }]
      }),
      server: { scheduleAlerts: { alerts: [
        { id: 'rent', schedule: 'Rent', channels: ['webhook'] },
        { id: 'gym', schedule: 'Gym', channels: ['webhook'] }
      ] } },
      serverName: 'Main', timezone: 'UTC', syncHistory, notificationService: sender, logger: quietLogger,
      now: new Date('2026-01-25T00:00:00.000Z')
    });
    expect(result.sent).toBe(1); // Gym's missing alert still went out
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

describe('maybeDeliverScheduleAlerts: a short budget defers a send without abandoning one already started (#295 review round 2, M6)', () => {
  let syncHistory;
  let dbDir;

  beforeEach(() => {
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

  /** Never actually dials out (no real network), just fakes latency. */
  function makeSlowSender(delayMs, { onSend } = {}) {
    const calls = [];
    return {
      calls,
      config: {
        webhooks: {
          generic: [
            { name: 'first', url: 'http://127.0.0.1:1/first', enabled: true },
            { name: 'second', url: 'http://127.0.0.1:1/second', enabled: true }
          ]
        }
      },
      sendTemplated: jest.fn(async (channelOutputs) => {
        calls.push({ at: Date.now(), url: channelOutputs.webhook && channelOutputs.webhook.url });
        if (onSend) onSend(calls.length);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { webhook: { ok: true } };
      })
    };
  }

  test('no sends happen after maybeDeliverScheduleAlerts returns, and the deferred destination is retried (not duplicated) next sync', async () => {
    const api = makeFakeApi({
      schedules: [rentSchedule()],
      payees: [{ id: 'pay1', name: 'Landlord' }],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-09') }],
      transactions: []
    });
    const server_ = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['webhook'] }] } };
    // Deterministic clock (#297 round 2 L-a): the budget is far longer than
    // any pre-send overhead, and the clock jumps past it the moment the first
    // send starts. So the first destination is always in flight when the
    // budget expires, and the second is never started, however slow the host.
    const SEND_DELAY_MS = 100;
    const DELIVER_BUDGET_MS = 60000;
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
    const sender = makeSlowSender(SEND_DELAY_MS, {
      onSend: (count) => { if (count === 1) skewMs += DELIVER_BUDGET_MS + 1; }
    });
    try {

    const evaluated = await maybeRunScheduleAlerts(server_, {
      api, serverName: 'Main', timezone: 'UTC', now: new Date('2026-01-10T00:00:00.000Z'), logger: quietLogger
    });

    // The budget expires while the first send is in flight (the clock jumps
    // inside the sender): the first destination is already in flight, so it
    // must still be awaited to completion; the second destination must never
    // be started this sync.
    const result = await maybeDeliverScheduleAlerts(evaluated, {
      syncHistory, notificationService: sender, logger: quietLogger, deliverBudgetMs: DELIVER_BUDGET_MS
    });

    const callsRightAfterReturn = sender.calls.length;
    expect(callsRightAfterReturn).toBe(1);
    expect(sender.calls[0].url).toBe('http://127.0.0.1:1/first');
    expect(result).toEqual({ events: 1, sent: 1, skipped: 0 });

    // Prove nothing keeps sending in the background after the function
    // already returned: waiting well past the second (never-started) send's
    // would-be completion time must not add any further calls. Without the
    // M6 fix (racing against an external timeout instead of a cooperative
    // deadline), the still-running first `deliver()` call kept going after
    // this `await` returned and could go on to start the second send too.
    await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS * 3));
    expect(sender.calls.length).toBe(callsRightAfterReturn);

    // The destination that was actually sent is recorded; the deferred one is not.
    const firstRow = await syncHistory.findLatestScheduleAlert({
      server: 'Main', alertId: 'rent', scheduleId: 's1', occurrenceDate: '2026-01-05',
      event: 'missing', channel: destinationKey('webhook', { name: 'first', url: 'http://127.0.0.1:1/first' })
    });
    const secondRow = await syncHistory.findLatestScheduleAlert({
      server: 'Main', alertId: 'rent', scheduleId: 's1', occurrenceDate: '2026-01-05',
      event: 'missing', channel: destinationKey('webhook', { name: 'second', url: 'http://127.0.0.1:1/second' })
    });
    expect(firstRow).not.toBeNull();
    expect(secondRow).toBeNull();

    // Next sync, with an ample budget: only the deferred destination sends;
    // the one that already succeeded is never sent again (no duplicate).
    const callsBeforeSecondSync = sender.calls.length;
    const evaluated2 = await maybeRunScheduleAlerts(server_, {
      api, serverName: 'Main', timezone: 'UTC', now: new Date('2026-01-10T00:05:00.000Z'), logger: quietLogger
    });
    const result2 = await maybeDeliverScheduleAlerts(evaluated2, {
      syncHistory, notificationService: sender, logger: quietLogger
    });

    expect(sender.calls.length).toBe(callsBeforeSecondSync + 1);
    expect(sender.calls[sender.calls.length - 1].url).toBe('http://127.0.0.1:1/second');
    expect(result2).toEqual({ events: 1, sent: 1, skipped: 0 });
    } finally {
      nowSpy.mockRestore();
    }
  }, 20000);
});

describe('persistPaymentSnapshot and error codes (#260)', () => {
  let syncHistory;
  let dbDir;
  let warnings;
  const logger = { info() {}, error() {}, warn(message, meta) { warnings.push({ message, meta }); } };
  const NOW = new Date('2026-01-10T00:00:00.000Z');
  const configured = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['webhook'] }] } };

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

  const fakeApi = (extra = {}) => makeFakeApi({
    schedules: [rentSchedule()],
    payees: [{ id: 'pay1', name: 'Landlord' }],
    accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-09') }],
    ...extra
  });

  /** The production sequence: evaluate with an outcome, then persist. */
  async function syncOnce(server_, api, now = NOW, hist = syncHistory) {
    const outcome = {};
    const evaluated = await maybeRunScheduleAlerts(server_, {
      api, serverName: 'Main', timezone: 'UTC', now, logger, syncHistory: hist, outcome
    });
    persistPaymentSnapshot(server_, evaluated, { syncHistory: hist, serverName: 'Main', outcome, logger });
    return { evaluated, outcome };
  }

  const evalRow = (overrides = {}) => ({
    alertId: 'r1', scheduleId: 's1', name: 'N', cadenceText: null, account: 'A', payee: 'P',
    expectedAmount: 100, nextDate: null, deadline: null, state: 'missing', occurrences: [], ...overrides
  });

  test('a real evaluation is stored with the state the notifications use', async () => {
    await syncOnce(configured, fakeApi());
    const { items, run } = syncHistory.getPaymentSnapshot('Main');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ alertId: 'rent', scheduleId: 's1', name: 'Rent', state: 'missing', expectedAmount: -50000 });
    expect(run.ok).toBe(true);
  });

  test('removing the scheduleAlerts block deletes both tables rows for the server', async () => {
    await syncOnce(configured, fakeApi());
    expect(syncHistory.getPaymentSnapshot('Main').run).not.toBeNull();
    await syncOnce({}, fakeApi());
    expect(syncHistory.getPaymentSnapshot('Main')).toEqual({ items: [], run: null });
  });

  test('a getRules failure tagged rules_invalid records only the run row', async () => {
    await syncOnce(configured, fakeApi());
    const before = syncHistory.getPaymentSnapshot('Main');
    // getRules throws (a TypeError in normalizeRule) on a null alert entry; a sync
    // cannot normally reach this because startup validation rejects it first.
    const bad = { scheduleAlerts: { alerts: [null] } };
    const { outcome } = await syncOnce(bad, fakeApi());
    expect(outcome).toEqual({ failed: true, errorCode: 'rules_invalid' });
    const after = syncHistory.getPaymentSnapshot('Main');
    expect(after.items).toEqual(before.items);
    expect(after.run).toMatchObject({ ok: false, errorCode: 'rules_invalid', lastSuccessAt: before.run.lastSuccessAt });
  });

  test('an untagged error from evaluate() maps to evaluation_failed', async () => {
    const api = fakeApi({ schedules: [null] }); // evaluate() throws a plain TypeError outside its per-rule catch
    const { evaluated, outcome } = await syncOnce(configured, api);
    expect(evaluated).toBeNull();
    expect(outcome).toEqual({ failed: true, errorCode: 'evaluation_failed' });
  });

  test('getSchedules rejecting with an error already tagged actual_read_failed keeps that code', async () => {
    const err = Object.assign(new Error('read'), { code: 'actual_read_failed' });
    const api = fakeApi({ getSchedules: jest.fn().mockRejectedValue(err) });
    const { outcome } = await syncOnce(configured, api);
    expect(outcome.errorCode).toBe('actual_read_failed');
  });

  test('an untagged Actual read error is tagged actual_read_failed', async () => {
    const api = fakeApi({ getSchedules: jest.fn().mockRejectedValue(new Error('down')) });
    const { outcome } = await syncOnce(configured, api);
    expect(outcome.errorCode).toBe('actual_read_failed');
  });

  test.each(['PHASE_TIMEOUT', 'ECONNRESET'])('a foreign code %s is not stored (allowlist)', async (code) => {
    const api = fakeApi({ getSchedules: jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code })) });
    const { outcome } = await syncOnce(configured, api);
    expect(outcome.errorCode).toBe('evaluation_failed');
  });

  test('a failed run leaves previous items and records the code, never the message', async () => {
    await syncOnce(configured, fakeApi());
    const api = fakeApi({ getSchedules: jest.fn().mockRejectedValue(new Error('secret detail')) });
    await syncOnce(configured, api);
    const { items, run } = syncHistory.getPaymentSnapshot('Main');
    expect(items).toHaveLength(1);
    expect(JSON.stringify(run)).not.toMatch(/secret detail/);
    expect(run.errorCode).toBe('actual_read_failed');
  });

  test('a rule that threw keeps its previous row and counts as errored; the others upsert', () => {
    syncHistory.replacePaymentSnapshot('Main', [evalRow({ alertId: 'r1' }), evalRow({ alertId: 'r2', state: 'upcoming' })]);
    persistPaymentSnapshot(configured, {
      evaluations: [evalRow({ alertId: 'r2', state: 'received' })],
      warnings: [{ ruleId: 'r1', scheduleId: 's1', message: 'threw' }]
    }, { syncHistory, serverName: 'Main', outcome: {}, logger });
    const { items, run } = syncHistory.getPaymentSnapshot('Main');
    expect(items.map((i) => [i.alertId, i.state])).toEqual([['r1', 'missing'], ['r2', 'received']]);
    expect(run.rulesErrored).toBe(1);
  });

  test('an interval-violation rule (warning plus cannotCheck evaluation) is upserted and not errored', () => {
    persistPaymentSnapshot(configured, {
      evaluations: [evalRow({ state: 'cannotCheck' })],
      warnings: [{ ruleId: 'r1', scheduleId: 's1', message: 'overlap' }]
    }, { syncHistory, serverName: 'Main', outcome: {}, logger });
    const { items, run } = syncHistory.getPaymentSnapshot('Main');
    expect(items[0].state).toBe('cannotCheck');
    expect(run.rulesErrored).toBe(0);
  });

  test('a real interval-violation rule flows through the step as cannotCheck, not errored', async () => {
    const api = fakeApi({ schedules: [rentSchedule({ date: { frequency: 'daily', start: '2026-01-01', endMode: 'never', interval: 1, patterns: [] } })] });
    await syncOnce({ scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['webhook'], graceDays: 5 }] } }, api);
    const { items, run } = syncHistory.getPaymentSnapshot('Main');
    expect(items[0].state).toBe('cannotCheck');
    expect(run.rulesErrored).toBe(0);
  });

  test('a SQLite failure mid-transaction leaves no partial rows, logs WARN and does not throw', () => {
    syncHistory.replacePaymentSnapshot('Main', [evalRow({ alertId: 'keep' })]);
    // Fail inside the transaction (second row hits NOT NULL on state after the
    // first upserted), so only a real rollback leaves ['keep'] (#343 review, M1).
    expect(() => persistPaymentSnapshot(configured, {
      evaluations: [evalRow({ alertId: 'new' }), evalRow({ alertId: 'bad', state: null })], warnings: []
    }, { syncHistory, serverName: 'Main', outcome: {}, logger })).not.toThrow();
    const ids = syncHistory.db.prepare('SELECT alert_id FROM payment_alert_status').all().map((r) => r.alert_id);
    expect(ids).toEqual(['keep']);
    expect(warnings.some((w) => /payment alert snapshot/.test(w.message))).toBe(true);
  });

  test('is a no-op without syncHistory', () => {
    expect(() => persistPaymentSnapshot(configured, { evaluations: [], warnings: [] }, { serverName: 'Main', outcome: {}, logger })).not.toThrow();
    // Without the guard it would throw on syncHistory.deletePaymentSnapshot/replace
    // and be swallowed into a WARN, so assert nothing is logged (#343 review, L1).
    expect(warnings).toEqual([]);
  });
});

describe('scheduleAlertsSync: Telegram requests across syncs and restarts (#296)', () => {
  let fake;
  let baseUrl;
  let requests;
  let dbDir;
  let dbPath;
  let history;

  beforeEach((done) => {
    requests = [];
    fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({ url: req.url, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    fake.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${fake.address().port}`;
      dbDir = createTempDir();
      dbPath = path.join(dbDir, 'sync-history.db');
      history = new SyncHistoryService({ dbPath, loggerConfig: { level: 'ERROR' } });
      done();
    });
  });

  afterEach((done) => {
    history.close();
    cleanupTempDir(dbDir);
    fake.close(done);
  });

  const notifier = () => new NotificationService(
    { telegram: { enabled: true, botToken: 'TOKEN', chatId: '42' } },
    { level: 'ERROR' },
    { telegramApiBaseUrl: baseUrl }
  );
  const block = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['telegram'] }] } };
  const apiFor = (transactions, lastSync) => makeFakeApi({
    schedules: [rentSchedule()],
    payees: [{ id: 'pay1', name: 'Landlord' }],
    accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs(lastSync) }],
    transactions
  });
  const run = (api, now, syncHistory = history) => runScheduleAlertsStep({
    api, server: block, serverName: 'Main', timezone: 'UTC', syncHistory,
    notificationService: notifier(), logger: quietLogger, now: new Date(now)
  });

  test('two syncs of the same missing payment give exactly one Telegram request', async () => {
    await run(apiFor([], '2026-01-09'), '2026-01-10T00:00:00.000Z');
    await run(apiFor([], '2026-01-10'), '2026-01-10T12:00:00.000Z');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/botTOKEN/sendMessage');
    expect(requests[0].body.text).toMatch(/Rent/);
  });

  test('a restart (database reopened from the same file) does not send the alert again', async () => {
    await run(apiFor([], '2026-01-09'), '2026-01-10T00:00:00.000Z');
    expect(requests).toHaveLength(1);

    history.close();
    history = new SyncHistoryService({ dbPath, loggerConfig: { level: 'ERROR' } });

    const second = await run(apiFor([], '2026-01-10'), '2026-01-10T12:00:00.000Z');
    expect(second).toEqual({ events: 1, sent: 0, skipped: 1 });
    expect(requests).toHaveLength(1);
  });

  test('late payment: missing, then resolved once, then silence on later syncs', async () => {
    await run(apiFor([], '2026-01-09'), '2026-01-10T00:00:00.000Z');
    expect(requests).toHaveLength(1);
    expect(requests[0].body.text).toMatch(/not received|did not go out/);

    const paid = [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-10', schedule: null }];
    await run(apiFor(paid, '2026-01-11'), '2026-01-11T00:00:00.000Z');
    expect(requests).toHaveLength(2);
    expect(requests[1].body.text).toMatch(/arrived/);

    const third = await run(apiFor(paid, '2026-01-12'), '2026-01-12T00:00:00.000Z');
    expect(third.events).toBe(0);
    expect(requests).toHaveLength(2);
    const fourth = await run(apiFor(paid, '2026-01-13'), '2026-01-13T00:00:00.000Z');
    expect(fourth.events).toBe(0);
    expect(requests).toHaveLength(2);
  });
});

// #326: a one-off schedule that raised `missing` and is then marked completed
// in Actual drops out of the active set; it must still get one `resolved`.
describe('scheduleAlertsSync: completed one-off schedule closes its open missing (#326)', () => {
  let fake;
  let requests;
  let baseUrl;
  let dbDir;
  let history;

  beforeEach((done) => {
    requests = [];
    fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({ url: req.url, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    fake.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${fake.address().port}`;
      dbDir = createTempDir();
      history = new SyncHistoryService({ dbPath: path.join(dbDir, 'sync-history.db'), loggerConfig: { level: 'ERROR' } });
      done();
    });
  });

  afterEach((done) => {
    history.close();
    cleanupTempDir(dbDir);
    fake.close(done);
  });

  const notifier = () => new NotificationService(
    { telegram: { enabled: true, botToken: 'TOKEN', chatId: '42' } },
    { level: 'ERROR' },
    { telegramApiBaseUrl: baseUrl }
  );
  const block = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['telegram'] }] } };
  const apiFor = ({ completed = false, transactions = [], lastSync = '2026-01-09' } = {}) => makeFakeApi({
    schedules: [rentSchedule(completed ? { completed: true } : {})],
    payees: [{ id: 'pay1', name: 'Landlord' }],
    accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs(lastSync) }],
    transactions
  });
  const run = (api, now) => runScheduleAlertsStep({
    api, server: block, serverName: 'Main', timezone: 'UTC', syncHistory: history,
    notificationService: notifier(), logger: quietLogger, now: new Date(now)
  });

  test('missing sent, then completed with no transaction: resolved once with completed wording, then silence', async () => {
    await run(apiFor(), '2026-01-10T00:00:00.000Z');
    expect(requests).toHaveLength(1);

    const second = await run(apiFor({ completed: true, lastSync: '2026-01-10' }), '2026-01-11T00:00:00.000Z');
    expect(second.sent).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].body.text).toMatch(/Rent/);
    expect(requests[1].body.text).toMatch(/marked completed in Actual/);
    expect(requests[1].body.text).not.toMatch(/arrived/);

    await run(apiFor({ completed: true, lastSync: '2026-01-11' }), '2026-01-12T00:00:00.000Z');
    await run(apiFor({ completed: true, lastSync: '2026-01-12' }), '2026-01-13T00:00:00.000Z');
    expect(requests).toHaveLength(2);
  });

  test('completed with a matching transaction: resolved with the completed wording (pinned), once', async () => {
    await run(apiFor(), '2026-01-10T00:00:00.000Z');
    const paid = [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-10', schedule: 's1' }];
    await run(apiFor({ completed: true, transactions: paid, lastSync: '2026-01-10' }), '2026-01-11T00:00:00.000Z');
    expect(requests).toHaveLength(2);
    expect(requests[1].body.text).toMatch(/marked completed in Actual/);
    await run(apiFor({ completed: true, transactions: paid, lastSync: '2026-01-11' }), '2026-01-12T00:00:00.000Z');
    expect(requests).toHaveLength(2);
  });

  test('completed one-off that never raised a missing sends nothing', async () => {
    const result = await run(apiFor({ completed: true }), '2026-01-10T00:00:00.000Z');
    expect(result.sent).toBe(0);
    expect(requests).toHaveLength(0);
  });

  test('completed one-off whose missing is older than the look-back window sends nothing', async () => {
    await run(apiFor(), '2026-01-10T00:00:00.000Z');
    expect(requests).toHaveLength(1);
    // occurrence 2026-01-05 is MAX_LOOKBACK_DAYS + 1 days before this run
    const later = moment.utc('2026-01-05').add(MAX_LOOKBACK_DAYS + 1, 'days').format('YYYY-MM-DD');
    await run(apiFor({ completed: true, lastSync: later }), `${later}T00:00:00.000Z`);
    expect(requests).toHaveLength(1);
  });

  test('completed one-off whose missing is exactly MAX_LOOKBACK_DAYS old is still resolved', async () => {
    await run(apiFor(), '2026-01-10T00:00:00.000Z');
    expect(requests).toHaveLength(1);
    const edge = moment.utc('2026-01-05').add(MAX_LOOKBACK_DAYS, 'days').format('YYYY-MM-DD');
    await run(apiFor({ completed: true, lastSync: edge }), `${edge}T00:00:00.000Z`);
    expect(requests).toHaveLength(2);
    expect(requests[1].body.text).toMatch(/marked completed in Actual/);
  });

  test('a completed recurring schedule with an open missing is not touched', async () => {
    await run(apiFor(), '2026-01-10T00:00:00.000Z');
    const api = makeFakeApi({
      schedules: [rentSchedule({ completed: true, date: { start: '2026-01-05', frequency: 'monthly' } })],
      payees: [{ id: 'pay1', name: 'Landlord' }],
      accounts: [{ id: 'acc1', name: 'Checking', last_sync: epochMs('2026-01-10') }]
    });
    await run(api, '2026-01-11T00:00:00.000Z');
    expect(requests).toHaveLength(1);
  });

  describe('custom resolved templates (review M1)', () => {
    const withTemplate = (resolved) => ({ scheduleAlerts: { alerts: [{
      id: 'rent', schedule: 'Rent', channels: ['telegram'], templates: { resolved }
    }] } });
    const runWith = (srv, api, now) => runScheduleAlertsStep({
      api, server: srv, serverName: 'Main', timezone: 'UTC', syncHistory: history,
      notificationService: notifier(), logger: quietLogger, now: new Date(now)
    });
    const legacy = '{{name}}: {{received_amount}} arrived {{received_date}}, {{days_overdue}} day(s) late';

    test('a custom resolved without closed_by gets the built-in completed text for a completed one-off', async () => {
      const srv = withTemplate(legacy);
      await runWith(srv, apiFor(), '2026-01-10T00:00:00.000Z');
      await runWith(srv, apiFor({ completed: true, lastSync: '2026-01-10' }), '2026-01-11T00:00:00.000Z');
      expect(requests).toHaveLength(2);
      expect(requests[1].body.text).toMatch(/marked completed in Actual/);
      expect(requests[1].body.text).not.toMatch(/arrived/);
    });

    test('a custom resolved that uses closed_by is honoured for a completed one-off', async () => {
      const srv = withTemplate('{{#if closed_by}}CUSTOM-DONE {{name}}{{else}}CUSTOM-PAID{{/if}}');
      await runWith(srv, apiFor(), '2026-01-10T00:00:00.000Z');
      await runWith(srv, apiFor({ completed: true, lastSync: '2026-01-10' }), '2026-01-11T00:00:00.000Z');
      expect(requests[1].body.text).toMatch(/CUSTOM-DONE Rent/);
    });

    test('a normal payment resolved still uses the custom template', async () => {
      const srv = withTemplate(legacy);
      await runWith(srv, apiFor(), '2026-01-10T00:00:00.000Z');
      const paid = [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-10', schedule: 's1' }];
      await runWith(srv, apiFor({ transactions: paid, lastSync: '2026-01-10' }), '2026-01-11T00:00:00.000Z');
      expect(requests).toHaveLength(2);
      expect(requests[1].body.text).toMatch(/arrived 2026-01-10|arrived .*2026/);
      expect(requests[1].body.text).not.toMatch(/marked completed/);
    });
  });

  describe('resolved is final only until a later missing (review M2)', () => {
    const remind = { scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent', channels: ['telegram'], remindEveryDays: 1 }] } };
    // The ledger stamps rows with the wall clock, so fake only Date and move it
    // together with `now`; reminder spacing is measured against recorded_at.
    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
          'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']
      });
    });
    afterEach(() => { jest.useRealTimers(); });
    const runR = (api, now) => {
      jest.setSystemTime(new Date(now));
      return runScheduleAlertsStep({
      api, server: remind, serverName: 'Main', timezone: 'UTC', syncHistory: history,
      notificationService: notifier(), logger: quietLogger, now: new Date(now)
      });
    };
    const paid = [{ id: 't1', account: 'acc1', payee: 'pay1', amount: -50000, date: '2026-01-10', schedule: 's1' }];

    test('completed, resolved, uncompleted: reminders restart and the next payment closes it again', async () => {
      await runR(apiFor({ lastSync: '2026-01-10' }), '2026-01-10T00:00:00.000Z');
      expect(requests).toHaveLength(1);
      await runR(apiFor({ completed: true, lastSync: '2026-01-10' }), '2026-01-11T00:00:00.000Z');
      expect(requests).toHaveLength(2);
      expect(requests[1].body.text).toMatch(/marked completed/);
      await runR(apiFor({ lastSync: '2026-01-11' }), '2026-01-12T00:00:00.000Z');
      await runR(apiFor({ lastSync: '2026-01-12' }), '2026-01-13T00:00:00.000Z');
      expect(requests).toHaveLength(4);
      expect(requests[3].body.text).not.toMatch(/arrived|marked completed/);
      await runR(apiFor({ transactions: paid, lastSync: '2026-01-13' }), '2026-01-14T00:00:00.000Z');
      expect(requests).toHaveLength(5);
      expect(requests[4].body.text).toMatch(/arrived/);
      await runR(apiFor({ transactions: paid, lastSync: '2026-01-14' }), '2026-01-15T00:00:00.000Z');
      expect(requests).toHaveLength(5);
    });

    test('payment resolved, transaction unlinked, then relinked: resolved is delivered again', async () => {
      await runR(apiFor({ lastSync: '2026-01-10' }), '2026-01-10T00:00:00.000Z');
      await runR(apiFor({ transactions: paid, lastSync: '2026-01-10' }), '2026-01-11T00:00:00.000Z');
      expect(requests).toHaveLength(2);
      await runR(apiFor({ lastSync: '2026-01-11' }), '2026-01-12T00:00:00.000Z');
      expect(requests).toHaveLength(3);
      await runR(apiFor({ transactions: paid, lastSync: '2026-01-12' }), '2026-01-13T00:00:00.000Z');
      expect(requests).toHaveLength(4);
      expect(requests[3].body.text).toMatch(/arrived/);
    });
  });
});
