/**
 * The six service loggers must be children of the main logger, so they share its
 * level, format, sinks and redaction instead of being independent instances. (#440)
 */
const { SyncHistoryService } = require('../services/syncHistory');
const PrometheusService = require('../services/prometheusService');
const { HealthCheckService } = require('../services/healthCheck');
const { NotificationService } = require('../services/notificationService');
const { TelegramBotService } = require('../services/telegramBot');
const fs = require('fs');
const path = require('path');
const { Logger } = require('../lib/logger');

function makeParent() {
    const children = [];
    const parent = {
        child: jest.fn((ctx) => {
            const c = { ctx, info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
            children.push(c);
            return c;
        })
    };
    return { parent, children };
}

describe('service loggers inherit the main logger (#440)', () => {
    test('SyncHistoryService', () => {
        const { parent, children } = makeParent();
        const s = new SyncHistoryService({ dbPath: ':memory:', loggerConfig: { parent } });
        expect(s.logger).toBe(children[0]);
        expect(children[0].ctx).toEqual({ component: 'SyncHistory' });
        if (s.close) s.close();
    });

    test('PrometheusService', () => {
        const { parent, children } = makeParent();
        const s = new PrometheusService({ loggerConfig: { parent } });
        expect(s.logger).toBe(children[0]);
        expect(children[0].ctx).toEqual({ component: 'Prometheus' });
    });

    test('HealthCheckService', () => {
        const { parent, children } = makeParent();
        const s = new HealthCheckService({ loggerConfig: { parent } });
        expect(s.logger).toBe(children[0]);
        expect(children[0].ctx).toEqual({ component: 'HealthCheck' });
    });

    test('NotificationService', () => {
        const { parent, children } = makeParent();
        const s = new NotificationService({}, { parent });
        expect(s.logger).toBe(children[0]);
        expect(children[0].ctx).toEqual({ component: 'NotificationService' });
    });

    test('TelegramBotService', () => {
        const { parent, children } = makeParent();
        const s = new TelegramBotService({ botToken: 't', chatId: '1' }, {}, { parent });
        expect(s.logger).toBe(children[0]);
        expect(children[0].ctx).toEqual({ component: 'TelegramBot' });
    });

    test('without a parent a standalone logger is still created', () => {
        const s = new PrometheusService({});
        expect(typeof s.logger.info).toBe('function');
    });
});

describe('children follow the parent broadcast callback (#440)', () => {
    test('a callback set after the child was created still receives its lines', () => {
        const parent = new Logger({ logDir: null, level: 'DEBUG' });
        const child = parent.child({ component: 'X' });
        const cb = jest.fn();
        parent.setBroadcastCallback(cb);
        const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
        child.info('hello');
        spy.mockRestore();
        expect(cb).toHaveBeenCalledWith('INFO', 'hello', expect.anything());
    });

    test('HealthCheck child lines reach the callback, and a failing send does not loop', () => {
        const parent = new Logger({ logDir: null, level: 'DEBUG' });
        const hc = new HealthCheckService({ loggerConfig: { parent } });
        const send = jest.fn(() => { throw new Error('socket gone'); });
        hc.wsClients.add({ readyState: 1, send, bufferedAmount: 0 });
        parent.setBroadcastCallback((l, m, md) => hc.broadcastLog(l, m, md));
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            parent.info('trigger');
        } finally {
            log.mockRestore();
            err.mockRestore();
        }
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('a secret in a HealthCheck line is masked in the syslog payload', () => {
        const parent = new Logger({ logDir: null, level: 'DEBUG' });
        const sendSpy = jest.fn();
        parent.syslog = { enabled: true, host: 'localhost', port: 514, protocol: 'udp', facility: 16 };
        parent.syslogClient = { send: sendSpy };
        const hc = new HealthCheckService({ loggerConfig: { parent } });
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            hc.logger.info('x', { reason: 'token=topsecretvalue', count: 1 });
        } finally {
            log.mockRestore();
        }
        const sent = sendSpy.mock.calls[0][0].toString();
        expect(sent).not.toContain('topsecretvalue');
        expect(sent).toContain('REDACTED');
    });
});

describe('service wiring source guards (#440)', () => {
    const root = path.join(__dirname, '..');
    const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
    const services = ['syncHistory', 'prometheusService', 'healthCheck', 'notificationService', 'telegramBot'];

    test('only syncService calls createLogger unconditionally; services only as no-parent fallback', () => {
        for (const name of services) {
            const src = read(path.join('services', name + '.js'));
            const calls = src.match(/createLogger\(/g) || [];
            expect(calls).toHaveLength(1);
            expect(src).toMatch(/\.parent\s*\n?\s*\?[^:]*\.child\(\{ component:[^)]*\)\s*\n?\s*: createLogger\(/);
        }
        expect(read('syncService.js').match(/createLogger\(/g)).toHaveLength(1);
    });

    test('syncService passes parent: logger to all five services', () => {
        const src = read('syncService.js');
        expect(src.match(/parent: logger,/g) || []).toHaveLength(5);
    });
});
