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

describe('Actual API console output in a sync (#426)', () => {
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
            init: jest.fn().mockImplementation(async () => {
                console.warn('upstream warning', { payee: 'SENTINEL_PAYEE', amount: -12345 });
                console.error('upstream error SENTINEL_PAYEE');
            }),
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
                logging: { level: 'debug', format: 'json', logDir, rotation: { enabled: false } },
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

    test('upstream warn/error reach the logger as static records, args dropped, console restored', async () => {
        const before = console.warn;
        await runSync();
        expect(recordSync).toHaveBeenCalled();
        const fileOut = fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
        const bridged = fileOut.split('\n').filter(l => l.includes('third_party.console')).map(l => JSON.parse(l));
        expect(bridged.map(r => r.level)).toEqual(['WARN', 'ERROR']);
        expect(bridged[0]).toMatchObject({ component: 'actual-api', server: 's1' });
        for (const text of [fileOut, consoleOut.join('\n'), broadcasts.join('\n')]) {
            expect(text).not.toContain('SENTINEL_PAYEE');
            expect(text).not.toContain('-12345');
        }
        expect(broadcasts.join('\n')).not.toContain('third_party.console');
        expect(console.warn).toBe(before);
    });
});
