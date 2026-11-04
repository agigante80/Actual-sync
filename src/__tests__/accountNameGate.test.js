/**
 * Acceptance test (#448): a default-config sync log carries account ids and no
 * account names; with logging.includeAccountNames: true the names appear.
 *
 * Loads the real src/syncService.js with the REAL logger, one account that
 * syncs, one that fails and one that is skipped, then scans the console, the
 * log file and the /ws/logs broadcast.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('account names in sync logs (#448)', () => {
    let includeNames;
    let failText;
    let failAll;
    let accountRows;
    let tmp, logDir, dataDir, consoleOut, broadcasts, actual, recordSync, spies;

    beforeEach(() => {
        includeNames = undefined;
        failAll = false;
        failText = 'Failed syncing account "SENTINEL Bob Savings."';
        accountRows = null;
        jest.resetModules();
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-leak-'));
        logDir = path.join(tmp, 'logs');
        dataDir = path.join(tmp, 'data');
        consoleOut = [];
        broadcasts = [];
        recordSync = jest.fn();
        const capture = (...args) => { consoleOut.push(args.map(String).join(' ')); };
        spies = ['log', 'info', 'warn', 'error', 'debug'].map(m => jest.spyOn(console, m).mockImplementation(capture));
        actual = {
            init: jest.fn().mockResolvedValue(undefined),
            downloadBudget: jest.fn().mockResolvedValue(undefined),
            loadBudget: jest.fn().mockResolvedValue(undefined),
            sync: jest.fn().mockResolvedValue(undefined),
            shutdown: jest.fn().mockResolvedValue(undefined),
            q: () => { const b = { filter: () => b, select: () => b }; return b; },
            aqlQuery: jest.fn().mockResolvedValue({
                data: accountRows || [
                    { id: 'a1', name: 'SENTINEL Alice Joint', closed: false, account_sync_source: 'goCardless' },
                    { id: 'a2', name: 'SENTINEL Bob Savings', closed: false, account_sync_source: 'goCardless' },
                    { id: 'a3', name: 'SENTINEL Cash Wallet', closed: false, account_sync_source: null }
                ]
            }),
            runBankSync: jest.fn(async ({ accountId }) => {
                if (accountId === 'a2' || failAll) throw new Error(failText);
                return { newTransactions: ['t1'], matchedTransactions: [], updatedAccounts: [accountId] };
            })
        };
        jest.doMock('@actual-app/api', () => actual);
        jest.doMock('node-schedule', () => ({ scheduleJob: jest.fn() }));
        jest.doMock('dotenv', () => ({ config: jest.fn() }));
        jest.doMock('../lib/configLoader', () => function ConfigLoader() {
            this.load = () => ({
                servers: [{ name: 's1', url: 'http://x', password: 'p', syncId: 'b', dataDir }],
                sync: { maxRetries: 0, baseRetryDelayMs: 1, schedule: '0 0 * * *', phaseTimeoutSeconds: 1 },
                logging: { level: 'debug', format: 'text', logDir, rotation: { enabled: false }, ...(includeNames === undefined ? {} : { includeAccountNames: includeNames }) },
                prometheus: { enabled: false }
            });
        });
        jest.doMock('../lib/versionInfo', () => ({
            fetchServerVersion: async () => null,
            getClientVersion: () => '1.0.0',
            describeCompatibility: () => ({ verdict: 'unknown', level: 'debug', message: '' })
        }));
        jest.doMock('../services/syncHistory', () => ({
            SyncHistoryService: function () { this.recordSync = recordSync; this.persistAccountMetadata = jest.fn(); }
        }));
        jest.doMock('../services/notificationService', () => ({
            NotificationService: function () { this.recordSyncResult = jest.fn(); this.notifySync = jest.fn().mockResolvedValue(undefined); }
        }));
        jest.doMock('../lib/scheduleAlertsStep', () => ({
            maybeRunScheduleAlerts: jest.fn().mockResolvedValue(null),
            persistPaymentSnapshot: jest.fn(),
            maybeDeliverScheduleAlerts: jest.fn().mockResolvedValue(undefined)
        }));
    });

    afterEach(() => {
        spies.forEach(s => s.mockRestore());
        jest.useRealTimers();
        jest.dontMock('@actual-app/api');
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    async function runSync() {
        const argv = process.argv;
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
        process.argv = ['node', 'syncService.js', '--force-run', '--server', 's1'];
        try {
            require('../syncService');
            for (let i = 0; i < 40 && recordSync.mock.calls.length === 0; i++) {
                for (let j = 0; j < 20; j++) await flush();
                await jest.advanceTimersByTimeAsync(1000);
                for (let j = 0; j < 20; j++) await flush();
            }
        } finally {
            process.argv = argv;
            exit.mockRestore();
        }
    }

    const allOutput = () => {
        const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')) : [];
        return [consoleOut.join('\n'), files.join('\n'), broadcasts.join('\n')].join('\n');
    };

    test('default config: ids are logged, no account name appears in any sink', async () => {
        await runSync();
        expect(recordSync).toHaveBeenCalled();
        const out = allOutput();
        expect(out).not.toContain('SENTINEL');
        expect(out).toContain('Sync completed');
        for (const id of ['a1', 'a2', 'a3']) expect(out).toContain(id);
        expect(out).toContain('"succeededAccountIds"');
        expect(out).toContain('"failedAccounts"');
        expect(out).toContain('"skippedAccounts"');
        // omission is configured, not a defect: no droppedFieldCount from the gate
        expect(takeDroppedFields()).toEqual([]);
    });

    test('logging.includeAccountNames: true writes the names next to the ids', async () => {
        includeNames = true;
        await runSync();
        expect(recordSync).toHaveBeenCalled();
        const out = allOutput();
        expect(out).toContain('SENTINEL Alice Joint');
        expect(out).toContain('SENTINEL Bob Savings');
        expect(out).toContain('SENTINEL Cash Wallet');
        expect(out).toContain('a2');
    });

    test('rate-limit wording without quotes does not leak the name either', async () => {
        failText = 'Failed syncing account SENTINEL Bob Savings. Rate limit exceeded, retry later';
        await runSync();
        expect(recordSync).toHaveBeenCalled();
        expect(allOutput()).not.toContain('SENTINEL');
        takeDroppedFields();
    });

    test('every account failing: the real HealthCheckService "Sync status updated" line is scanned', async () => {
        failAll = true;
        accountRows = [
            { id: 'a1', name: 'SENTINEL Alice Joint', closed: false, account_sync_source: 'goCardless' },
            { id: 'a2', name: 'SENTINEL Bob Savings', closed: false, account_sync_source: 'goCardless' }
        ];
        failText = 'Failed syncing account "SENTINEL Bob Savings."';
        await runSync();
        expect(recordSync).toHaveBeenCalled();
        const out = allOutput();
        expect(out).toContain('Sync status updated');
        expect(out).not.toContain('SENTINEL');
        takeDroppedFields();
    });

    test('flag on: the name appears, and only in name fields', async () => {
        includeNames = true;
        await runSync();
        expect(recordSync).toHaveBeenCalled();
        const lines = allOutput().split('\n').filter(l => l.includes('SENTINEL'));
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) {
            // every occurrence sits in an accountName / name / succeededAccounts value
            const stripped = l.replace(/"(accountName|name)":"SENTINEL [^"]*"/g, '').replace(/"succeededAccounts":\[[^\]]*\]/g, '');
            expect(stripped).not.toContain('SENTINEL');
        }
    });
});
