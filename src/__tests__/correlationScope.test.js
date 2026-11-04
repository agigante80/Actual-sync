/**
 * Correlation scopes (#441, D4): one AsyncLocalStorage scope per sync, HTTP
 * request, Telegram update and scheduled job. Every record written inside a
 * scope carries its correlationId, whichever logger or child wrote it.
 */
const http = require('http');
const { Logger, withCorrelation, currentCorrelationId } = require('../lib/logger');
const { HealthCheckService } = require('../services/healthCheck');

jest.mock('https');
const { TelegramBotService } = require('../services/telegramBot');

const tick = () => new Promise(resolve => setImmediate(resolve));

/** A root logger whose JSON lines are collected instead of printed. */
function capturingRoot() {
    const lines = [];
    const root = new Logger({ level: 'DEBUG', format: 'json', logDir: null });
    const spies = ['log', 'warn', 'error'].map(m =>
        jest.spyOn(console, m).mockImplementation(line => lines.push(JSON.parse(line))));
    return { root, lines, restore: () => spies.forEach(s => s.mockRestore()) };
}

describe('correlation scopes (#441)', () => {
    let cap;
    afterEach(() => { if (cap) cap.restore(); cap = null; });

    test('two concurrent syncs and one request get three distinct ids, each on every line', async () => {
        cap = capturingRoot();
        const syncA = cap.root.child({ component: 'sync', server: 'A' });
        const syncB = cap.root.child({ component: 'sync', server: 'B' });
        const web = cap.root.child({ component: 'healthCheck' });

        const fakeSync = (log, label) => withCorrelation(async () => {
            log.info(`${label} start`);
            await tick();
            log.info(`${label} middle`);
            await tick();
            log.info(`${label} end`);
        });
        const fakeRequest = () => withCorrelation(async () => {
            await tick();
            web.warn('request failed');
        });

        await Promise.all([fakeSync(syncA, 'A'), fakeSync(syncB, 'B'), fakeRequest()]);

        const ids = new Set(cap.lines.map(l => l.correlationId));
        expect(ids.size).toBe(3);
        for (const prefix of ['A ', 'B ']) {
            const own = cap.lines.filter(l => l.message.startsWith(prefix));
            expect(own).toHaveLength(3);
            expect(new Set(own.map(l => l.correlationId)).size).toBe(1);
        }
        expect(cap.lines.every(l => typeof l.correlationId === 'string')).toBe(true);
    });

    test('a child created in a scope does not keep the id outside it', () => {
        cap = capturingRoot();
        const child = withCorrelation(() => cap.root.child({ component: 'x' }), 'scope-1');
        child.info('after');
        expect(cap.lines[0].correlationId).toBeUndefined();
        expect(child.correlationId).toBeNull();
    });

    test('a nested scope replaces the outer id for its own span only', () => {
        cap = capturingRoot();
        withCorrelation(() => {
            cap.root.info('outer 1');
            withCorrelation(() => cap.root.info('inner'), 'inner-id');
            cap.root.info('outer 2');
        }, 'outer-id');
        expect(cap.lines.map(l => l.correlationId)).toEqual(['outer-id', 'inner-id', 'outer-id']);
        expect(currentCorrelationId()).toBeNull();
    });

    test('a timer stopped outside its scope still reports under the id it started in', () => {
        cap = capturingRoot();
        const log = new Logger({ level: 'DEBUG', format: 'json', logDir: null, performance: { enabled: true } });
        const stop = withCorrelation(() => log.startTimer('op'), 'timer-id');
        stop();
        expect(cap.lines.at(-1).correlationId).toBe('timer-id');
    });

    test('syslog structured data carries the scope id', () => {
        const log = new Logger({ logDir: null });
        const sd = withCorrelation(() => log.formatSyslog('INFO', 'm'), 'sys-id');
        expect(sd).toContain('correlationId="sys-id"');
    });

    test('each HTTP request, with or without a body, logs under its own id', async () => {
        cap = capturingRoot();
        const svc = new HealthCheckService({
            port: 0, host: '127.0.0.1', logger: undefined, loggerConfig: { parent: cap.root }
        });
        await svc.start();
        const port = svc.server.address().port;
        const call = (method, body) => new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/nope', method,
                headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} },
            res => { res.resume(); res.on('end', resolve); });
            req.on('error', reject);
            req.end(body);
        });
        try {
            await Promise.all([call('GET'), call('POST', '{"a":1}'), call('GET')]);
        } finally {
            await svc.stop();
        }
        const lines = cap.lines.filter(l => l.message === 'Unknown endpoint requested');
        expect(lines).toHaveLength(3);
        expect(new Set(lines.map(l => l.correlationId)).size).toBe(3);
        expect(lines.every(l => l.correlationId)).toBe(true);
    });

    test('a Telegram update runs in its own scope', async () => {
        cap = capturingRoot();
        const bot = new TelegramBotService({ botToken: '123:ABC', chatId: '456' }, {}, { parent: cap.root });
        bot.sendMessage = jest.fn().mockResolvedValue(undefined);
        const update = (id) => ({ update_id: id, message: { message_id: id, chat: { id: '456' }, text: '/nope' } });
        await Promise.all([bot.processUpdate(update(1)), bot.processUpdate(update(2))]);
        const lines = cap.lines.filter(l => l.message === 'Telegram message received');
        expect(lines).toHaveLength(2);
        expect(lines[0].correlationId).toBeTruthy();
        expect(lines[0].correlationId).not.toBe(lines[1].correlationId);
    });
});
