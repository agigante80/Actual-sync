/**
 * Behavioural tests for a runBankSync that times out and settles late (#284).
 *
 * Loads the real src/syncService.js (which runs a --force-run sync on require)
 * with its collaborators stubbed, and drives the real account loop with
 * runBankSync calls that settle after the 60 s call timeout.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve; let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function makeLogger() {
    const l = {
        level: 'info',
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
        startTimer: () => () => 1,
        generateCorrelationId: () => 'cid',
        setCorrelationId: jest.fn(), clearCorrelationId: jest.fn(),
        setBroadcastCallback: jest.fn()
    };
    l.child = () => l;
    return l;
}

/**
 * Run one sync of a server with `accountIds` bank-linked accounts.
 * `script(actual, advance)` drives the late settlements.
 * Resolves to { recorded, actual }.
 */
async function runSync(accountIds, bankCalls, script, { failEvaluation = false, logging = {} } = {}) {
    jest.resetModules();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-bank-'));
    const recordSync = jest.fn();
    // #260: maybeRunScheduleAlerts marks failure on the caller's outcome object
    // (as the real step does); persistPaymentSnapshot records what it received.
    const maybeRun = jest.fn(async (server, opts) => {
        if (failEvaluation && opts.outcome) { opts.outcome.failed = true; opts.outcome.errorCode = 'boom'; }
        return null;
    });
    const persist = jest.fn();
    const notifySync = jest.fn().mockResolvedValue(undefined);
    const actual = {
        init: jest.fn().mockResolvedValue(undefined),
        downloadBudget: jest.fn().mockResolvedValue(undefined),
        loadBudget: jest.fn().mockResolvedValue(undefined),
        sync: jest.fn().mockResolvedValue(undefined),
        shutdown: jest.fn().mockResolvedValue(undefined),
        q: () => { const b = { filter: () => b, select: () => b }; return b; },
        aqlQuery: jest.fn().mockResolvedValue({
            data: accountIds.map(id => ({ id, name: id, closed: false, account_sync_source: 'goCardless' }))
        }),
        runBankSync: jest.fn(({ accountId }) => bankCalls[accountId]())
    };
    jest.doMock('@actual-app/api', () => actual);
    jest.doMock('node-schedule', () => ({ scheduleJob: jest.fn() }));
    jest.doMock('dotenv', () => ({ config: jest.fn() }));
    jest.doMock('../lib/configLoader', () => function ConfigLoader() {
        this.load = () => ({
            servers: [{ name: 's1', url: 'http://x', password: 'p', syncId: 'b', dataDir }],
            // 1 s phase timeout: also the length of the drain after a call timeout
            sync: { maxRetries: 0, baseRetryDelayMs: 1, schedule: '0 0 * * *', phaseTimeoutSeconds: 1 },
            logging: { level: 'error', format: 'text', ...logging },
            prometheus: { enabled: false }
        });
    });
    const loggers = [];
    jest.doMock('../lib/logger', () => ({ createLogger: () => { const l = makeLogger(); loggers.push(l); return l; } }));
    jest.doMock('../lib/versionInfo', () => ({
        fetchServerVersion: async () => null,
        getClientVersion: () => '1.0.0',
        describeCompatibility: () => ({ verdict: 'unknown', level: 'debug', message: '' })
    }));
    jest.doMock('../services/syncHistory', () => ({
        SyncHistoryService: function () { this.recordSync = recordSync; this.persistAccountMetadata = jest.fn(); }
    }));
    jest.doMock('../services/healthCheck', () => ({
        HealthCheckService: function () { this.updateSyncStatus = jest.fn(); this.broadcastLog = jest.fn(); }
    }));
    jest.doMock('../services/notificationService', () => ({
        NotificationService: function () { this.recordSyncResult = jest.fn(); this.notifySync = notifySync; }
    }));
    jest.doMock('../lib/scheduleAlertsStep', () => ({
        maybeRunScheduleAlerts: maybeRun,
        persistPaymentSnapshot: persist,
        maybeDeliverScheduleAlerts: jest.fn().mockResolvedValue(undefined)
    }));
    const argv = process.argv;
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    process.argv = ['node', 'syncService.js', '--force-run', '--server', 's1'];
    try {
        require('../syncService');
        const advance = async (ms) => {
            for (let i = 0; i < 20; i++) await flush();
            await jest.advanceTimersByTimeAsync(ms);
            for (let i = 0; i < 20; i++) await flush();
        };
        // Real fs work precedes the account loop; wait for it on the real event
        // loop instead of guessing how many ticks it takes under load.
        const until = async (cond) => {
            for (let i = 0; i < 5000 && !cond(); i++) await flush();
        };
        await script(advance, () => until(() => actual.runBankSync.mock.calls.length > 0));
        for (let i = 0; i < 40 && recordSync.mock.calls.length === 0; i++) {
            await advance(1000);
            await until(() => recordSync.mock.calls.length > 0 || i > 3);
        }
        expect(exit).not.toHaveBeenCalled();
        return { loggers, recorded: recordSync.mock.calls[0]?.[0], actual, persist, notified: notifySync.mock.calls[0]?.[0] };
    } finally {
        process.argv = argv;
        exit.mockRestore();
        jest.useRealTimers();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

describe('a timed-out runBankSync that settles late (#284)', () => {
    afterEach(() => jest.dontMock('@actual-app/api'));

    test('late success counts the account succeeded once and not failed', async () => {
        const slow = deferred();
        const { recorded, actual } = await runSync(['a1', 'a2'], {
            a1: () => slow.promise,
            a2: () => Promise.resolve()
        }, async (advance, started) => {
            await started();
            await advance(60000); // a1 hits the 60 s call timeout, the drain starts
            slow.resolve();       // and it finishes inside the drain
            await advance(2000);
        });
        expect(recorded.accountsSucceeded).toBe(2);
        expect(recorded.accountsFailed).toBe(0);
        expect(recorded.status).toBe('success');
        expect(actual.sync).toHaveBeenCalledTimes(2); // initial + final
    });

    test('a bank sync still running after the drain skips the final api.sync', async () => {
        const never = deferred();
        const { recorded, actual } = await runSync(['a1', 'a2'], {
            a1: () => never.promise,
            a2: () => Promise.resolve()
        }, async (advance, started) => {
            await started();
            await advance(60000);
            await advance(3000); // past the 1 s drain: stuck
        });
        expect(actual.runBankSync).toHaveBeenCalledTimes(1); // a2 was not started
        expect(recorded.accountsFailed).toBe(2);             // a1 timed out, a2 skipped
        expect(actual.sync).toHaveBeenCalledTimes(1);        // the initial sync only
    });

    test('a late "No new transactions" rejection is a success, not the timeout failure (#98)', async () => {
        const slow = deferred();
        const { recorded } = await runSync(['a1'], {
            a1: () => slow.promise
        }, async (advance, started) => {
            await started();
            await advance(60000);
            slow.reject(new Error('No new transactions'));
            await advance(2000);
        });
        expect(recorded.accountsSucceeded).toBe(1);
        expect(recorded.accountsFailed).toBe(0);
    });

    test('a late real rejection is reported with its own error, not the timeout message', async () => {
        const slow = deferred();
        const { recorded } = await runSync(['a1'], {
            a1: () => slow.promise
        }, async (advance, started) => {
            await started();
            await advance(60000);
            slow.reject(new Error('bank said no'));
            await advance(2000);
        });
        expect(recorded.accountsFailed).toBe(1);
        expect(recorded.errorMessage).toContain('bank said no');
        expect(recorded.errorMessage).not.toMatch(/timed out/i);
    });
});

describe('payment snapshot wiring in the real sync (#260)', () => {
    afterEach(() => jest.dontMock('@actual-app/api'));

    test('a failed evaluation reaches persistPaymentSnapshot as a failed outcome', async () => {
        const { persist } = await runSync(['a1'], { a1: () => Promise.resolve() },
            async (advance, started) => { await started(); await advance(2000); },
            { failEvaluation: true });
        expect(persist).toHaveBeenCalledTimes(1);
        const opts = persist.mock.calls[0][2];
        expect(opts.outcome.failed).toBe(true);
        expect(opts.outcome.errorCode).toBe('boom');
        expect(opts.serverName).toBe('s1');
    });

    test('a stuck bank sync (#284) does not persist a snapshot', async () => {
        const never = deferred();
        const { persist } = await runSync(['a1'], { a1: () => never.promise },
            async (advance, started) => { await started(); await advance(60000); await advance(3000); });
        expect(persist).not.toHaveBeenCalled();
    });
});

describe('transaction counts from runBankSync (#391)', () => {
    afterEach(() => jest.dontMock('@actual-app/api'));

    const started = async (advance, begin) => { await begin(); await advance(1000); };

    test('counts accumulate across accounts into history and the notification', async () => {
        const { recorded, notified } = await runSync(['a1', 'a2'], {
            a1: () => Promise.resolve({ newTransactions: ['t1', 't2'], matchedTransactions: ['t3'], updatedAccounts: ['a1'] }),
            a2: () => Promise.resolve({ newTransactions: ['t4'], matchedTransactions: [], updatedAccounts: ['a2'] })
        }, started);
        expect(recorded).toMatchObject({ status: 'success', transactionsAdded: 3, transactionsUpdated: 1 });
        expect(notified).toMatchObject({ status: 'success', transactionsAdded: 3, transactionsUpdated: 1 });
    });

    test('an api that resolves undefined (pre-26.11.0) gives 0 and 0 without error', async () => {
        const { recorded, notified } = await runSync(['a1', 'a2'], {
            a1: () => Promise.resolve(undefined),
            a2: () => Promise.resolve(undefined)
        }, started);
        expect(recorded).toMatchObject({ status: 'success', accountsSucceeded: 2, transactionsAdded: 0, transactionsUpdated: 0 });
        expect(notified).toMatchObject({ transactionsAdded: 0, transactionsUpdated: 0 });
    });

    test('a timed-out account that settles late contributes 0; the run still completes', async () => {
        const slow = deferred();
        const { recorded, notified } = await runSync(['a1', 'a2'], {
            a1: () => slow.promise,
            a2: () => Promise.resolve({ newTransactions: ['t9'], matchedTransactions: ['t8', 't7'] })
        }, async (advance, begin) => {
            await begin();
            await advance(60000);
            slow.resolve({ newTransactions: ['late1', 'late2', 'late3'], matchedTransactions: ['late4'] });
            await advance(2000);
        });
        expect(recorded).toMatchObject({ status: 'success', accountsSucceeded: 2, transactionsAdded: 1, transactionsUpdated: 2 });
        expect(notified).toMatchObject({ transactionsAdded: 1, transactionsUpdated: 2 });
    });

    test('a failed account contributes 0 while the others are counted', async () => {
        const { recorded } = await runSync(['a1', 'a2'], {
            a1: () => Promise.reject(new Error('bank said no')),
            a2: () => Promise.resolve({ newTransactions: ['t1'], matchedTransactions: [] })
        }, started);
        expect(recorded).toMatchObject({ status: 'partial', transactionsAdded: 1, transactionsUpdated: 0 });
    });
});

describe('api.init verbose flag (#425)', () => {
    afterEach(() => jest.dontMock('@actual-app/api'));
    const drive = async (advance, begun) => { await begun(); await advance(1000); };
    const calls = { a1: () => Promise.resolve() };

    test('defaults to verbose:false so loot-core does not print transactions', async () => {
        const { actual } = await runSync(['a1'], calls, drive);
        expect(actual.init).toHaveBeenCalledWith(expect.objectContaining({ verbose: false }));
    });

    test('logging.actualApiVerbose:true opts in to verbose:true', async () => {
        const { actual } = await runSync(['a1'], calls, drive, { logging: { actualApiVerbose: true } });
        expect(actual.init).toHaveBeenCalledWith(expect.objectContaining({ verbose: true }));
    });

    const verboseWarns = (loggers) => loggers
        .flatMap(l => l.warn.mock.calls)
        .filter(c => String(c[0]).includes('actualApiVerbose'));

    test('startup logs one static WARN when the unsafe flag is on', async () => {
        const { loggers } = await runSync(['a1'], calls, drive, { logging: { actualApiVerbose: true } });
        const warns = verboseWarns(loggers);
        expect(warns).toHaveLength(1);
        expect(warns[0]).toEqual(['logging.actualApiVerbose is on: @actual-app/api will print transaction data to stdout']);
    });

    test('no WARN when the flag is off', async () => {
        const { loggers } = await runSync(['a1'], calls, drive);
        expect(verboseWarns(loggers)).toHaveLength(0);
    });

    test('a non-boolean value never enables verbose', async () => {
        const { actual } = await runSync(['a1'], calls, drive, { logging: { actualApiVerbose: 'yes' } });
        expect(actual.init).toHaveBeenCalledWith(expect.objectContaining({ verbose: false }));
    });
});
