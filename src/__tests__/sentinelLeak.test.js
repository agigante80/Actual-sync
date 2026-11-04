/**
 * Sentinel suite (#450, D9): data that must never be logged is injected at
 * every entry point and every sink is scanned for it.
 *
 * Sentinels: a payee, an amount, a webhook token, a Telegram bot token, a
 * server password and an account name. Logging runs at DEBUG with the
 * defaults for logging.includePersonal and logging.includeAccountNames.
 *
 * Entry points: a mocked sync (runBankSync result with payee and amount, an
 * upstream failure whose text carries all sentinels, console output printed by
 * @actual-app/api), a failing Slack webhook and Telegram message (the remote
 * answers 500/401 with the sentinels in its body), and a Telegram command.
 *
 * Sinks: console, the log file (live and the rotated gzip), syslog (UDP),
 * /ws/logs broadcasts, sync_history rows and every outgoing notification body.
 *
 * Patterns reused from accountNameGate.test.js and debugResultLeak.test.js.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const dgram = require('dgram');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

jest.setTimeout(60000);

const PAYEE = 'SENTINEL_PAYEE';
const AMOUNT = '-12345';
const WEBHOOK_TOKEN = 'T0KENwebhookSENTINEL9988';
const TELEGRAM_TOKEN = '987654321:AAFakeTelegramSentinelTokenXYZ0123456789';
const PASSWORD = 'SENTINEL_PASSWORD_hunter2';
const ACCOUNT = 'SENTINEL_ACCOUNT Joint Savings';

const UPSTREAM_TEXT =
    `Failed syncing account "${ACCOUNT}". payee ${PAYEE} amount ${AMOUNT} ` +
    `token ${WEBHOOK_TOKEN} bot ${TELEGRAM_TOKEN} password ${PASSWORD}`;

const SECRETS = { PAYEE, AMOUNT, WEBHOOK_TOKEN, TELEGRAM_TOKEN, PASSWORD };

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Poll until fn() is truthy or the time runs out. */
async function waitFor(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn()) return true;
        await wait(25);
    }
    return false;
}

/** Names of the sentinels present in a text. */
function found(text, names = Object.keys(SECRETS)) {
    return names.filter(n => text.includes(SECRETS[n]));
}

describe('sentinel values stay out of every sink (#450)', () => {
    let tmp, logDir, dataDir, consoleOut, broadcasts, syslogMsgs, udp, udpPort;
    let streams, outgoing, spies, httpSpies, socketSpy, clients;

    beforeEach(async () => {
        jest.resetModules();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-'));
        logDir = path.join(tmp, 'logs');
        dataDir = path.join(tmp, 'data');
        consoleOut = [];
        broadcasts = [];
        syslogMsgs = [];
        streams = [];
        clients = [];
        outgoing = []; // { host, path, body } of every http(s) request the code made

        const capture = (...args) => { consoleOut.push(args.map(String).join(' ')); };
        spies = ['log', 'info', 'warn', 'error', 'debug'].map(m => jest.spyOn(console, m).mockImplementation(capture));

        udp = dgram.createSocket('udp4');
        udp.on('message', m => syslogMsgs.push(m.toString()));
        await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
        udpPort = udp.address().port;

        // The loggers under test open syslog client sockets; close them after the test.
        const createSocket = dgram.createSocket.bind(dgram);
        socketSpy = jest.spyOn(dgram, 'createSocket').mockImplementation((...a) => { const sock = createSocket(...a); clients.push(sock); return sock; });

        // Reach the rotating stream so the rotated gzip can be read cheaply.
        jest.doMock('rotating-file-stream', () => {
            const actual = jest.requireActual('rotating-file-stream');
            return { ...actual, createStream: (...a) => { const s = actual.createStream(...a); streams.push(s); return s; } };
        });

        // Every outgoing notification: record it, answer 500 with the sentinels in the body.
        const fakeRequest = (kind) => (options, callback) => {
            const req = new EventEmitter();
            const chunks = [];
            req.write = (c) => { chunks.push(String(c)); };
            req.setTimeout = () => req;
            req.destroy = () => {};
            req.end = (c) => {
                if (c) chunks.push(String(c));
                outgoing.push({ kind, host: options.hostname, path: options.path, body: chunks.join('') });
                const res = new EventEmitter();
                res.statusCode = kind === 'https' ? 401 : 500;
                setImmediate(() => {
                    callback(res);
                    res.emit('data', JSON.stringify({ ok: false, description: UPSTREAM_TEXT }));
                    res.emit('end');
                });
            };
            return req;
        };
        httpSpies = [
            jest.spyOn(http, 'request').mockImplementation(fakeRequest('http')),
            jest.spyOn(https, 'request').mockImplementation(fakeRequest('https'))
        ];
    });

    afterEach(async () => {
        httpSpies.forEach(s => s.mockRestore());
        socketSpy.mockRestore();
        clients.forEach((c) => { try { c.close(); } catch { /* already closed */ } });
        streams.forEach((st) => { try { st.end(); } catch { /* already ended */ } });
        spies.forEach(s => s.mockRestore());
        jest.dontMock('@actual-app/api');
        jest.dontMock('rotating-file-stream');
        await new Promise(resolve => udp.close(resolve));
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const loggingConfig = () => ({
        level: 'debug',
        format: 'text',
        logDir,
        rotation: { enabled: true, maxSize: '10M', maxFiles: 5, compress: 'gzip' },
        syslog: { enabled: true, host: '127.0.0.1', port: udpPort, protocol: 'udp', facility: 16 }
        // includePersonal and includeAccountNames are left at their defaults on purpose
    });

    /** Rotate every open stream (this gzips the live file), then read live and rotated files. */
    async function readLogFiles() {
        for (const s of streams) {
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 5000);
                s.once('rotated', () => { clearTimeout(timer); resolve(); });
                s.rotate();
            });
        }
        // rotating-file-stream gzips in place: the rotated file keeps its .log name, so
        // compression is recognised by the gzip magic bytes, not by an extension.
        const isGzip = (buf) => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
        await waitFor(() => fs.existsSync(logDir) && fs.readdirSync(logDir).some(f => isGzip(fs.readFileSync(path.join(logDir, f)))), 5000);
        const files = fs.existsSync(logDir) ? fs.readdirSync(logDir) : [];
        const gzipped = [];
        const texts = files.map((f) => {
            const buf = fs.readFileSync(path.join(logDir, f));
            if (!isGzip(buf)) return buf.toString('utf8');
            gzipped.push(f);
            return zlib.gunzipSync(buf).toString('utf8');
        });
        return { files, gzipped, texts };
    }

    const sinkTexts = async (extra = {}) => {
        await wait(150); // let the last UDP datagrams arrive
        const { files, gzipped, texts } = await readLogFiles();
        return { files, gzipped, sinks: {
            console: consoleOut.join('\n'),
            file: texts.join('\n'),
            syslog: syslogMsgs.join('\n'),
            wsLogs: broadcasts.join('\n'),
            ...extra
        } };
    };

    // A scan that cannot see a leak proves nothing: put a sentinel in a message (which the
    // source guard forbids in production) and check every sink, gzip included, shows it.
    test('control: a sentinel written on purpose is seen in every sink', async () => {
        const { createLogger } = require('../lib/logger');
        const root = createLogger({ ...loggingConfig() });
        root.setBroadcastCallback((level, message, metadata) => {
            broadcasts.push(JSON.stringify({ level, message, metadata }));
        });
        root.info(`control ${PAYEE}`);
        const { gzipped, sinks } = await sinkTexts();
        expect(gzipped.length).toBeGreaterThan(0);
        for (const [name, text] of Object.entries(sinks)) {
            expect({ sink: name, seen: found(text) }).toEqual({ sink: name, seen: ['PAYEE'] });
        }
    });

    // ---------------------------------------------------------------- sync

    describe('a mocked sync with a failing account, failing notifications and a Telegram bot', () => {
        let recordSync, history;

        beforeEach(() => {
            const realHistory = jest.requireActual('../services/syncHistory');
            recordSync = jest.fn();
            const actual = {
                init: jest.fn(async () => {
                    // @actual-app/api prints through the global console (#426)
                    console.warn(`api: payee ${PAYEE} amount ${AMOUNT} password ${PASSWORD}`);
                }),
                downloadBudget: jest.fn().mockResolvedValue(undefined),
                loadBudget: jest.fn().mockResolvedValue(undefined),
                sync: jest.fn().mockResolvedValue(undefined),
                shutdown: jest.fn().mockResolvedValue(undefined),
                q: () => { const b = { filter: () => b, select: () => b }; return b; },
                aqlQuery: jest.fn().mockResolvedValue({
                    data: [
                        { id: 'a1', name: 'Plain Checking', closed: false, account_sync_source: 'goCardless' },
                        { id: 'a2', name: ACCOUNT, closed: false, account_sync_source: 'goCardless' },
                        { id: 'a3', name: 'Cash', closed: false, account_sync_source: null }
                    ]
                }),
                runBankSync: jest.fn(async ({ accountId }) => {
                    if (accountId === 'a2') {
                        const e = new Error(UPSTREAM_TEXT);
                        e.details = { payee: PAYEE, amount: Number(AMOUNT) };
                        throw e;
                    }
                    return {
                        newTransactions: ['t1'], matchedTransactions: [], updatedAccounts: [accountId],
                        payee_name: PAYEE, details: [{ payee: PAYEE, amount: Number(AMOUNT) }]
                    };
                })
            };
            jest.doMock('@actual-app/api', () => actual);
            jest.doMock('node-schedule', () => ({ scheduleJob: jest.fn() }));
            jest.doMock('dotenv', () => ({ config: jest.fn() }));
            jest.doMock('../lib/configLoader', () => function ConfigLoader() {
                this.load = () => ({
                    servers: [{ name: 's1', url: 'http://x', password: PASSWORD, syncId: 'b', dataDir }],
                    sync: { maxRetries: 0, baseRetryDelayMs: 1, schedule: '0 0 * * *', phaseTimeoutSeconds: 5 },
                    logging: loggingConfig(),
                    prometheus: { enabled: false },
                    syncHistory: { dbPath: path.join(tmp, 'history.db') },
                    notifications: {
                        webhooks: { slack: [{ name: 'ops', url: `http://hooks.invalid/services/${WEBHOOK_TOKEN}` }] },
                        telegram: { enabled: true, botToken: TELEGRAM_TOKEN, chatId: '777' },
                        thresholds: { consecutiveFailures: 1, failureRate: 0.01, ratePeriodMinutes: 60 },
                        rateLimit: { minIntervalMinutes: 0, maxPerHour: 100 }
                    }
                });
            });
            jest.doMock('../lib/versionInfo', () => ({
                fetchServerVersion: async () => null,
                getClientVersion: () => '1.0.0',
                describeCompatibility: () => ({ verdict: 'unknown', level: 'debug', message: '' })
            }));
            // the real SyncHistoryService (sqlite file in tmp), wrapped to know when a row was written
            jest.doMock('../services/syncHistory', () => ({
                SyncHistoryService: function (opts) {
                    const svc = new realHistory.SyncHistoryService(opts);
                    const original = svc.recordSync.bind(svc);
                    svc.recordSync = (...a) => { const r = original(...a); recordSync(); history = svc; return r; };
                    return svc;
                }
            }));
            jest.doMock('../lib/scheduleAlertsStep', () => ({
                maybeRunScheduleAlerts: jest.fn().mockResolvedValue(null),
                persistPaymentSnapshot: jest.fn(),
                maybeDeliverScheduleAlerts: jest.fn().mockResolvedValue(undefined)
            }));
        });

        async function runSync() {
            const argv = process.argv;
            const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
            process.argv = ['node', 'syncService.js', '--force-run', '--server', 's1'];
            try {
                const { HealthCheckService } = require('../services/healthCheck');
                jest.spyOn(HealthCheckService.prototype, 'broadcastLog')
                    .mockImplementation((level, message, metadata) => {
                        broadcasts.push(JSON.stringify({ level, message, metadata }));
                    });
                require('../syncService');
                await waitFor(() => recordSync.mock.calls.length > 0, 15000);
                // notifications go out after the history row; wait until both channels were tried
                await waitFor(() => outgoing.some(o => o.kind === 'http') && outgoing.some(o => o.kind === 'https'), 8000);
                await wait(300);
            } finally {
                process.argv = argv;
                exit.mockRestore();
            }
        }

        test('console, file (live and gzip), syslog and /ws/logs carry no sentinel', async () => {
            await runSync();
            expect(recordSync).toHaveBeenCalled();
            const { gzipped, sinks } = await sinkTexts();

            // the run really happened at DEBUG, through every sink
            expect(gzipped.length).toBeGreaterThan(0); // the rotated gzip was reached and read
            expect(sinks.file).toContain('Sync completed');
            expect(sinks.console).toContain('Sync completed');
            expect(sinks.syslog).toContain('Sync completed');
            expect(sinks.wsLogs).toContain('Sync completed');
            expect(sinks.file).toContain('runBankSync result');
            expect(outgoing.some(o => o.kind === 'http')).toBe(true); // webhook attempted
            expect(outgoing.some(o => o.kind === 'https')).toBe(true); // telegram attempted

            for (const [name, text] of Object.entries(sinks)) {
                expect({ sink: name, leaked: found(text) }).toEqual({ sink: name, leaked: [] });
                // the account name is off by default (#448)
                expect({ sink: name, accountName: text.includes('SENTINEL_ACCOUNT') }).toEqual({ sink: name, accountName: false });
            }
            takeDroppedFields(); // dropped result keys are counted, not written; asserted in debugResultLeak.test.js
        });

        test('sync_history rows carry no payee, amount, token or password', async () => {
            await runSync();
            expect(history).toBeDefined();
            const rows = JSON.stringify(history.getHistory({ limit: 50 }));
            expect(rows).toContain('s1');
            // sync_history stores account names by design (the dashboard shows them),
            // so the account name is deliberately NOT asserted here.
            expect({ leaked: found(rows) }).toEqual({ leaked: [] });
            takeDroppedFields();
        });

        test('no outgoing notification body carries a sentinel (the token is only in the URL path)', async () => {
            await runSync();
            expect(outgoing.length).toBeGreaterThan(0);
            // The destination path holds the secret by design; it is the body that is scanned.
            expect(outgoing.some(o => o.path.includes(WEBHOOK_TOKEN))).toBe(true);
            for (const o of outgoing) {
                expect({ to: o.kind, leaked: found(o.body) }).toEqual({ to: o.kind, leaked: [] });
            }
            takeDroppedFields();
        });
    });

    // ------------------------------------------- notification service and bot

    describe('notification failures and a Telegram message, with a root logger', () => {
        test('Slack and Telegram failures and a Telegram command leak nothing', async () => {
            const { createLogger } = require('../lib/logger');
            const root = createLogger({ ...loggingConfig() });
            root.setBroadcastCallback((level, message, metadata) => {
                broadcasts.push(JSON.stringify({ level, message, metadata }));
            });
            const { NotificationService } = require('../services/notificationService');
            const { TelegramBotService } = require('../services/telegramBot');

            const notifier = new NotificationService({
                webhooks: { slack: [{ name: 'ops', url: `http://hooks.invalid/services/${WEBHOOK_TOKEN}` }] },
                telegram: { enabled: true, botToken: TELEGRAM_TOKEN, chatId: '777' },
                thresholds: { consecutiveFailures: 1, failureRate: 0.01, ratePeriodMinutes: 60 },
                rateLimit: { minIntervalMinutes: 0, maxPerHour: 100 }
            }, { parent: root });

            // syncService hands the notifier the classified message (errorClassifier), never
            // the raw upstream text; the sync scenario above proves that path end to end.
            const { classifyError } = require('../lib/errorClassifier');
            const safe = classifyError(new Error(UPSTREAM_TEXT)).safeMessage;

            // 1. a sync failure notification, every channel answering with the sentinels
            notifier.recordSyncResult('s1', false, 'corr-1');
            await notifier.notifySync({
                status: 'failure', serverName: 's1', duration: 5, accountsProcessed: 1, accountsFailed: 1,
                failedAccounts: [], error: safe, errorCode: 'SYNC_FAILED', correlationId: 'corr-1'
            });
            // 2. the direct senders the dashboard test button and startup notice use
            await notifier.sendTelegramMessage('hello');
            await notifier.sendSlackWebhooks({
                serverName: 's1', timestamp: 'now', errorMessage: safe, consecutiveFailures: 1,
                thresholds: { failureRate: 1 }, errorCode: 'X'
            });

            // 3. the Telegram bot: a plain message and a /sync whose sync fails upstream
            const syncBank = jest.fn().mockRejectedValue(Object.assign(new Error(UPSTREAM_TEXT), { code: 'E_UP' }));
            const bot = new TelegramBotService(
                { botToken: TELEGRAM_TOKEN, chatId: '777', timezone: 'UTC' },
                {
                    syncHistory: { getHistory: () => [], getStatistics: () => ({}), getRecentErrors: () => [] },
                    healthCheck: { getStatus: () => ({}) },
                    getServerConfig: () => [{ name: 's1' }],
                    syncBank,
                    isSyncQueued: () => false,
                    notificationService: notifier
                },
                { parent: root }
            );
            await bot.processUpdate({ message: { chat: { id: 777 }, from: { first_name: 'Eve' }, text: `payee ${PAYEE} ${AMOUNT} ${PASSWORD}` } });
            await bot.processUpdate({ message: { chat: { id: 777 }, text: '/sync s1' } });
            await bot.pendingSync;
            await bot.processUpdate({ message: { chat: { id: 999 }, text: `${PAYEE} ${TELEGRAM_TOKEN}` } }); // stranger

            const { gzipped, sinks } = await sinkTexts();
            expect(gzipped.length).toBeGreaterThan(0);
            expect(sinks.file).toContain('Failed to send');
            for (const [name, text] of Object.entries(sinks)) {
                expect({ sink: name, leaked: found(text) }).toEqual({ sink: name, leaked: [] });
                expect({ sink: name, accountName: text.includes('SENTINEL_ACCOUNT') }).toEqual({ sink: name, accountName: false });
            }

            // Bodies: the bot answers a plain message by quoting it back to the person who
            // typed it (by design), so that one reply is excluded; every other body is scanned.
            const bodies = outgoing.filter(o => !o.body.includes('I received your message'));
            expect(bodies.length).toBeGreaterThan(2);
            for (const o of bodies) {
                expect({ to: o.kind, leaked: found(o.body, ['PAYEE', 'AMOUNT', 'PASSWORD', 'WEBHOOK_TOKEN']) }).toEqual({ to: o.kind, leaked: [] });
            }
            // the bot's "Sync failed" reply carries the classified message only
            const failed = outgoing.find(o => o.body.includes('Sync failed'));
            expect(failed).toBeDefined();
            expect(found(failed.body)).toEqual([]);
            takeDroppedFields();
        });
    });
});
