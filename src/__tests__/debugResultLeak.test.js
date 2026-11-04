/**
 * Sentinel test (#434, CWE-532): a sync at DEBUG must not write transaction
 * data from the runBankSync result to any log sink.
 *
 * Loads the real src/syncService.js with the REAL logger at level debug and a
 * real log directory, then scans the console, the log file and the /ws/logs
 * broadcast (HealthCheckService.broadcastLog) for sentinel values.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('DEBUG logging of the runBankSync result (#434)', () => {
    let tmp, logDir, dataDir, consoleOut, broadcasts, actual, recordSync, spies;

    beforeEach(() => {
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
                data: [{ id: 'a1', name: 'Checking', closed: false, account_sync_source: 'goCardless' }]
            }),
            runBankSync: jest.fn().mockResolvedValue({
                newTransactions: ['t1', 't2'],
                matchedTransactions: ['t3'],
                updatedAccounts: ['a1'],
                payee_name: 'SENTINEL_PAYEE',
                details: [{ payee: 'SENTINEL_PAYEE', amount: -12345 }]
            })
        };
        jest.doMock('@actual-app/api', () => actual);
        jest.doMock('node-schedule', () => ({ scheduleJob: jest.fn() }));
        jest.doMock('dotenv', () => ({ config: jest.fn() }));
        jest.doMock('../lib/configLoader', () => function ConfigLoader() {
            this.load = () => ({
                servers: [{ name: 's1', url: 'http://x', password: 'p', syncId: 'b', dataDir }],
                sync: { maxRetries: 0, baseRetryDelayMs: 1, schedule: '0 0 * * *', phaseTimeoutSeconds: 1 },
                logging: { level: 'debug', format: 'text', logDir, rotation: { enabled: false } },
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
        jest.doMock('../services/healthCheck', () => ({
            HealthCheckService: function () {
                this.updateSyncStatus = jest.fn();
                this.broadcastLog = (level, message, meta) => broadcasts.push(JSON.stringify({ level, message, meta }));
            }
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

    test('no sink contains the payee or amount; DEBUG logs counts and key names', async () => {
        await runSync();
        expect(recordSync).toHaveBeenCalled();
        expect(actual.runBankSync).toHaveBeenCalled();

        const files = fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8'));
        const fileOut = files.join('\n');
        const sinks = { console: consoleOut.join('\n'), file: fileOut, broadcast: broadcasts.join('\n') };

        for (const [name, text] of Object.entries(sinks)) {
            expect({ name, leaked: text.includes('SENTINEL_PAYEE') }).toEqual({ name, leaked: false });
            expect({ name, leaked: text.includes('-12345') }).toEqual({ name, leaked: false });
        }
        // The debug line is present (so the test really ran at DEBUG) with counts and keys.
        expect(sinks.file).toContain('runBankSync result');
        expect(sinks.file).toContain('"added":2');
        expect(sinks.file).toContain('"updated":1');
        expect(sinks.file).toContain('payee_name');
        expect(sinks.broadcast).toContain('runBankSync result');
    });
});
