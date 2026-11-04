/**
 * The six service loggers must be children of the main logger, so they share its
 * level, format, sinks and redaction instead of being independent instances. (#440)
 */
const { SyncHistoryService } = require('../services/syncHistory');
const PrometheusService = require('../services/prometheusService');
const { HealthCheckService } = require('../services/healthCheck');
const { NotificationService } = require('../services/notificationService');
const { TelegramBotService } = require('../services/telegramBot');

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
