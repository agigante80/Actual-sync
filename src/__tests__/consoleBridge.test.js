/**
 * Console bridge (#426): @actual-app/api prints warn/error (and, with
 * verbose, log) straight to console. The bridge routes that output through
 * our logger as one static record and drops the arguments.
 */
const { createLogger, Logger } = require('../lib/logger');
const { installConsoleBridge } = require('../lib/consoleBridge');

describe('console bridge (#426)', () => {
    let out, orig, logger, broadcasts;

    beforeEach(() => {
        out = [];
        broadcasts = [];
        orig = {};
        for (const m of ['log', 'info', 'warn', 'error', 'debug', 'group', 'groupEnd']) {
            orig[m] = console[m];
            console[m] = (...a) => out.push({ m, line: a.map(String).join(' ') });
        }
        logger = createLogger({ level: 'DEBUG', format: 'json', logDir: null, broadcastCallback: (l, msg, meta) => broadcasts.push({ l, msg, meta }) });
    });
    afterEach(() => {
        for (const m of Object.keys(orig)) console[m] = orig[m];
    });

    const records = () => out.filter(o => o.line.startsWith('{')).map(o => ({ m: o.m, ...JSON.parse(o.line) }));

    test('warn goes through the logger as a static record without the arguments', () => {
        const restore = installConsoleBridge(logger);
        console.warn('Payee Acme Corp', { amount: -12345, payee: 'SENTINEL_PAYEE' });
        restore();
        const recs = records();
        expect(recs).toHaveLength(1);
        expect(recs[0]).toMatchObject({ m: 'warn', level: 'WARN', component: 'actual-api', event: 'third_party.console' });
        const text = JSON.stringify(out);
        expect(text).not.toMatch(/SENTINEL_PAYEE|Acme|12345/);
        expect(recs[0].consolePreview).toBeUndefined();
    });

    test('error maps to ERROR, log/info/group to INFO, debug to DEBUG, groupEnd is swallowed', () => {
        const restore = installConsoleBridge(logger);
        console.error('e'); console.log('l'); console.info('i'); console.group('g'); console.debug('d'); console.groupEnd();
        restore();
        expect(records().map(r => r.level)).toEqual(['ERROR', 'INFO', 'INFO', 'INFO', 'DEBUG']);
        expect(out.some(o => o.m === 'groupEnd')).toBe(false);
    });

    test('the configured level applies', () => {
        const quiet = createLogger({ level: 'ERROR', format: 'json', logDir: null });
        const restore = installConsoleBridge(quiet);
        console.warn('w'); console.error('e');
        restore();
        expect(records().map(r => r.level)).toEqual(['ERROR']);
    });

    test('restore puts the previous console methods back', () => {
        const before = console.warn;
        const restore = installConsoleBridge(logger);
        expect(console.warn).not.toBe(before);
        restore();
        expect(console.warn).toBe(before);
    });

    test('our own logger writes during the window are not captured as third-party', () => {
        const restore = installConsoleBridge(logger);
        logger.child({ server: 's' }).warn('our own warning');
        restore();
        const recs = records();
        expect(recs).toHaveLength(1);
        expect(recs[0].event).toBeUndefined();
        expect(recs[0].message).toBe('our own warning');
    });

    test('no recursion when the logger itself writes to console', () => {
        const restore = installConsoleBridge(logger);
        console.warn('x');
        restore();
        expect(records()).toHaveLength(1);
    });

    test('restores Logger.prototype.log and survives nested installs', () => {
        const proto = Logger.prototype.log;
        const r1 = installConsoleBridge(logger);
        const r2 = installConsoleBridge(logger);
        r1();
        console.warn('still bridged');
        expect(records()).toHaveLength(1);
        r2();
        expect(Logger.prototype.log).toBe(proto);
        console.warn('raw');
        expect(out[out.length - 1].line).toBe('raw');
    });

    test('with verbose, a capped masked preview is added and never broadcast', () => {
        const restore = installConsoleBridge(logger, { verbose: true });
        console.warn('x'.repeat(500), 'password=hunter2');
        restore();
        const rec = records()[0];
        expect(rec.consolePreview.length).toBeLessThanOrEqual(300);
        expect(broadcasts).toHaveLength(0);
    });

    test('verbose preview does not contain a secret within the cap', () => {
        const restore = installConsoleBridge(logger, { verbose: true });
        console.error('login failed password=hunter2 token=abc123');
        restore();
        expect(records()[0].consolePreview).not.toMatch(/hunter2|abc123/);
    });

    test('records are not broadcast to /ws/logs even without verbose', () => {
        const restore = installConsoleBridge(logger);
        console.warn('w');
        restore();
        expect(broadcasts).toHaveLength(0);
    });
});
