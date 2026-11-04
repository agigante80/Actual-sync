/**
 * sys_startup record (#443, design D8): schema, privacy and the sentinel check.
 */
const { Logger } = require('../lib/logger');
const { buildStartupRecord, CONFIG_SCHEMA_VERSION } = require('../lib/startupRecord');

const SECRET = 'SENTINEL-pw-hunter2';
const URL_SENTINEL = 'https://secret-host.example.com:5006/path';

function makeConfig(overrides = {}) {
    return {
        timezone: 'Europe/Madrid',
        servers: [
            { name: 'Main', url: URL_SENTINEL, password: SECRET, syncId: 'SENTINEL-sync-id', dataDir: '/srv/alice-private/data/main', encryptionPassword: SECRET },
            { name: 'Second', url: URL_SENTINEL, password: SECRET, syncId: 'x', dataDir: './data/second', sync: { schedule: '0 6 * * *' } }
        ],
        sync: { schedule: '0 5 * * 2', phaseTimeoutSeconds: 120, maxRetries: 5, baseRetryDelayMs: 1000, autoRetry: { enabled: true, maxAttempts: 2, delayMinutes: 31 } },
        logging: { level: 'INFO', format: 'json', logDir: '/srv/alice-private/logs', actualApiVerbose: false, rotation: { enabled: true, maxFiles: 14 } },
        healthCheck: { port: 3000, host: '0.0.0.0', dashboard: { enabled: true, auth: { type: 'basic', username: 'admin', password: SECRET } } },
        notifications: {
            telegram: { enabled: true, botToken: `123:${SECRET}`, chatId: '99887766' },
            email: { enabled: false, auth: { user: 'u@example.com', pass: SECRET } },
            webhooks: { slack: [{ url: `https://hooks.slack.com/${SECRET}` }], discord: [], generic: [] },
            ntfy: { enabled: false, url: 'https://ntfy.example.com/topic', token: SECRET }
        },
        ...overrides
    };
}

function makeLogger(over = {}) {
    return new Logger({ level: 'INFO', format: 'json', logDir: null, ...over });
}

describe('buildStartupRecord (#443)', () => {
    test('has the D8 groups with the expected types', () => {
        const r = buildStartupRecord(makeConfig(), makeLogger(), { container: true });
        expect(r).toMatchObject({
            appVersion: expect.any(String),
            nodeVersion: process.version,
            pid: process.pid,
            platform: process.platform,
            container: true,
            timezone: 'Europe/Madrid',
            utcOffset: expect.stringMatching(/^[+-]\d{2}:\d{2}$/),
            logLevel: 'INFO',
            actualApiVerbose: false,
            sinks: ['console'],
            customLogDir: false,
            customDataDir: true,
            retentionDays: null,
            serverCount: 2,
            cronSchedules: ['0 5 * * 2', '0 6 * * *'],
            channelsEnabled: { email: false, telegram: true, slack: true, discord: false, webhook: false, ntfy: false },
            dashboardBind: '0.0.0.0:3000',
            dashboardEnabled: true,
            dashboardAuth: 'basic',
            tls: false,
            timeouts: { phaseTimeoutSeconds: 120 },
            configSchemaVersion: CONFIG_SCHEMA_VERSION
        });
        expect(typeof r.actualApiVersion === 'string' || r.actualApiVersion === null).toBe(true);
        expect(Number.isInteger(CONFIG_SCHEMA_VERSION)).toBe(true);
        expect(r.includeAccountNames).toBe(false);
    });

    test('includeAccountNames reports the value the logger gate uses (#448)', () => {
        const { buildLoggerConfig } = require('../lib/loggerConfig');
        for (const flag of [undefined, false, true]) {
            const cfg = makeConfig();
            if (flag !== undefined) cfg.logging.includeAccountNames = flag;
            const logger = makeLogger(buildLoggerConfig(cfg.logging));
            const r = buildStartupRecord(cfg, logger, {});
            // the record and an actual log line must agree
            const lines = [];
            const spy = jest.spyOn(console, 'log').mockImplementation((l) => lines.push(l));
            try { logger.info('m', { accountName: 'Alice Joint', accountId: 'a1' }); } finally { spy.mockRestore(); }
            expect(r.includeAccountNames).toBe(flag === true);
            expect(lines.join('\n').includes('Alice Joint')).toBe(r.includeAccountNames);
        }
        // a logger built without the option reports false even if the raw config says true
        const cfg = makeConfig();
        cfg.logging.includeAccountNames = true;
        expect(buildStartupRecord(cfg, makeLogger(), {}).includeAccountNames).toBe(false);
        // and the record's field passes the allowlist
        const out = makeLogger({ includeAccountNames: true });
        expect(buildStartupRecord(cfg, out, {}).includeAccountNames).toBe(true);
    });

    test('file fields follow the logger, not the raw config (#443 review L1)', () => {
        const fs = require('fs'); const os = require('os'); const p = require('path');
        const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'startup-'));
        const cfg = makeConfig();
        cfg.logging.logDir = dir;
        const writable = makeLogger({ logDir: dir });
        try {
            const r = buildStartupRecord(cfg, writable, {});
            expect(r).toMatchObject({ customLogDir: true, retentionDays: 14 });
        } finally {
            writable.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
        // An unwritable dir: the logger turns file logging off, so no retention claim.
        cfg.logging.logDir = '/nonexistent-root-dir/logs';
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const off = makeLogger({ logDir: '/nonexistent-root-dir/logs' });
            const r = buildStartupRecord(cfg, off, {});
            expect(r.sinks).not.toContain('file');
            expect(r).toMatchObject({ customLogDir: false, retentionDays: null });
        } finally {
            errSpy.mockRestore(); warnSpy.mockRestore(); logSpy.mockRestore();
        }
    });

    test('websocket is not a sink when the dashboard is disabled (#443 review L2)', () => {
        const logger = makeLogger();
        logger.setBroadcastCallback(() => {});
        const cfg = makeConfig();
        expect(buildStartupRecord(cfg, logger, {}).sinks).toContain('websocket');
        cfg.healthCheck.dashboard.enabled = false;
        expect(buildStartupRecord(cfg, logger, {}).sinks).toEqual(['console']);
    });

    test('UTC offset follows the configured timezone', () => {
        const winter = new Date('2026-01-15T12:00:00Z');
        const summer = new Date('2026-07-15T12:00:00Z');
        expect(buildStartupRecord(makeConfig(), makeLogger(), { now: winter }).utcOffset).toBe('+01:00');
        expect(buildStartupRecord(makeConfig(), makeLogger(), { now: summer }).utcOffset).toBe('+02:00');
    });

    test('defaults: no logDir key means ./logs, not custom; default data dir is not custom', () => {
        const cfg = makeConfig();
        delete cfg.logging.logDir;
        cfg.servers = [{ name: 'A', url: 'x', password: 'y', syncId: 'z', dataDir: 'data/a' }];
        const r = buildStartupRecord(cfg, makeLogger(), {});
        expect(r.customLogDir).toBe(false);
        expect(r.customDataDir).toBe(false);
    });

    test('file logging off: no file sink, retention null', () => {
        const cfg = makeConfig();
        cfg.logging.logDir = null;
        const r = buildStartupRecord(cfg, makeLogger({ logDir: null }), {});
        expect(r.sinks).toEqual(['console']);
        expect(r.retentionDays).toBeNull();
    });

    test('sinks list file, syslog and websocket when active', () => {
        const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'startup-'));
        const logger = makeLogger({ logDir: dir, syslog: { enabled: true, host: 'localhost', port: 514, protocol: 'udp', facility: 16 } });
        logger.setBroadcastCallback(() => {});
        try {
            const r = buildStartupRecord(makeConfig(), logger, {});
            expect(r.sinks).toEqual(['console', 'file', 'syslog', 'websocket']);
        } finally {
            logger.close();
            require('fs').rmSync(dir, { recursive: true, force: true });
        }
    });

    test('actualApiVerbose true is reported as a privacy flag', () => {
        const cfg = makeConfig();
        cfg.logging.actualApiVerbose = true;
        expect(buildStartupRecord(cfg, makeLogger(), {}).actualApiVerbose).toBe(true);
    });

    test('works on a minimal config', () => {
        const r = buildStartupRecord({ servers: [{ name: 'A', dataDir: 'data/a' }] }, makeLogger(), {});
        expect(r.serverCount).toBe(1);
        expect(r.dashboardAuth).toBe('none');
        expect(r.channelsEnabled).toEqual({ email: false, telegram: false, slack: false, discord: false, webhook: false, ntfy: false });
    });

    test('sentinel: no URL, password, token, path or sync id in the serialized record', () => {
        const lines = [];
        const spy = jest.spyOn(console, 'log').mockImplementation((l) => lines.push(l));
        const logger = makeLogger();
        try {
            logger.security('sys_startup', buildStartupRecord(makeConfig(), logger, {}));
        } finally {
            spy.mockRestore();
            logger.close();
        }
        expect(lines).toHaveLength(1);
        const rec = JSON.parse(lines[0]);
        expect(rec).toMatchObject({ event: 'sys_startup', category: 'security', level: 'INFO', severity: 9 });
        const text = lines[0];
        for (const s of [SECRET, 'secret-host', 'https://', 'http://', '/srv/alice-private', 'SENTINEL-sync-id', '99887766', 'hooks.slack.com', 'u@example.com', 'REDACTED']) {
            expect(text).not.toContain(s);
        }
    });
});

describe('Logger.activeSinks (#443)', () => {
    test('console only by default', () => {
        expect(makeLogger().activeSinks()).toEqual(['console']);
    });
});

describe('sys_startup and the field allowlist (#437 x #443)', () => {
    test('every startup field is registered: nothing is dropped', () => {
        const lines = [];
        const spy = jest.spyOn(console, 'log').mockImplementation((l) => lines.push(l));
        const logger = makeLogger();
        logger.setBroadcastCallback(() => {});
        try {
            logger.security('sys_startup', buildStartupRecord(makeConfig(), logger, {}));
        } finally {
            spy.mockRestore();
            logger.close();
        }
        const rec = JSON.parse(lines[0]);
        expect(rec.droppedFieldCount).toBeUndefined();
        expect(rec.fields).toMatchObject({ serverCount: 2, sinks: ['console', 'websocket'], channelsEnabled: { telegram: true }, timeouts: { phaseTimeoutSeconds: 120 } });
    });
});
