/**
 * The logger runs every record through the field allowlist (D3, #437).
 * These calls drop fields on purpose, so the file opts out of the
 * fail-on-drop harness and checks the drops itself.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Ajv = require('ajv');
const { Logger } = require('../lib/logger');

allowDroppedFields();

const validate = new Ajv({ strict: false }).compile(require('../../docs/log-record.schema.json'));

const SENTINEL_PAYEE = 'SENTINEL_PAYEE';
const transaction = { id: 't1', payee_name: SENTINEL_PAYEE, amount: -12345, notes: 'rent to Marco' };

describe('logger field allowlist (#437)', () => {
    let dir;
    let consoleOut;
    let spies;
    let syslogSent;
    let broadcasts;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logfields-'));
        consoleOut = [];
        spies = ['log', 'warn', 'error'].map((m) => jest.spyOn(console, m).mockImplementation((l) => consoleOut.push(l)));
        syslogSent = [];
        broadcasts = [];
    });

    afterEach(() => {
        spies.forEach((s) => s.mockRestore());
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const makeLogger = (opts = {}) => {
        const logger = new Logger({
            format: 'json', fileFormat: 'json', level: 'DEBUG', logDir: dir,
            rotation: { enabled: false }, ...opts
        });
        logger.syslog = { enabled: true, host: 'localhost', port: 514, protocol: 'udp', facility: 16 };
        logger.syslogClient = { send: (buf) => syslogSent.push(buf.toString()) };
        logger.setBroadcastCallback((level, message, meta) => broadcasts.push(JSON.stringify({ level, message, meta })));
        return logger;
    };

    const fileText = () => fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');

    test('a nested transaction object and an unknown key reach no sink', () => {
        const logger = makeLogger();
        logger.debug('runBankSync result', {
            result: { newTransactions: [transaction] },
            payload: { transactions: [transaction] },
            unknownKey: 'UNKNOWN_VALUE',
            added: 1
        });
        const sinks = { console: consoleOut.join('\n'), file: fileText(), syslog: syslogSent.join('\n'), broadcast: broadcasts.join('\n') };
        for (const [name, text] of Object.entries(sinks)) {
            expect({ name, leaked: /SENTINEL_PAYEE|12345|Marco|UNKNOWN_VALUE|unknownKey|payee_name/.test(text) }).toEqual({ name, leaked: false });
        }
        expect(sinks.file).toContain('"added":1');
        expect(takeDroppedFields().sort()).toEqual(['payload', 'result', 'unknownKey']);
    });

    test('the record carries droppedFieldCount, not the key names', () => {
        const logger = makeLogger();
        logger.info('m', { a1: 1, b2: 2, durationMs: 5 });
        const rec = JSON.parse(consoleOut[0]);
        expect(rec.droppedFieldCount).toBe(2);
        expect(rec.fields).toEqual({ durationMs: 5 });
        expect(consoleOut[0]).not.toMatch(/a1|b2/);
        takeDroppedFields();
    });

    test('no drop leaves no droppedFieldCount', () => {
        const logger = makeLogger();
        logger.info('m', { durationMs: 5 });
        expect(JSON.parse(consoleOut[0])).not.toHaveProperty('droppedFieldCount');
    });

    test('a caller cannot supply droppedFieldCount', () => {
        const logger = makeLogger();
        logger.info('m', { droppedFieldCount: 0 });
        expect(JSON.parse(consoleOut[0]).droppedFieldCount).toBe(1);
        takeDroppedFields();
    });

    test('registered fields sit under `fields`; the envelope stays at the top', () => {
        const logger = makeLogger().child({ component: 'sync', server: 'Vega II' });
        logger.info('Bank sync completed for account', {
            event: 'sync.account.completed', accountId: 'a1b2', durationMs: 812, added: 5, updated: 0
        });
        const rec = JSON.parse(consoleOut[0]);
        expect(rec).toMatchObject({
            component: 'sync', server: 'Vega II', event: 'sync.account.completed',
            fields: { accountId: 'a1b2', durationMs: 812, added: 5, updated: 0 }
        });
        expect(rec).not.toHaveProperty('durationMs');
        expect(validate(rec) ? null : validate.errors).toBeNull();
    });

    test('the pretty console line shows the same fields and drops the same keys', () => {
        const logger = makeLogger({ format: 'pretty' });
        logger.info('m', { durationMs: 5, unknownKey: 'UNKNOWN_VALUE' });
        expect(consoleOut[0]).toContain('"durationMs":5');
        expect(consoleOut[0]).not.toContain('UNKNOWN_VALUE');
        takeDroppedFields();
    });

    test('a secret under a registered key is still masked before the allowlist', () => {
        const logger = makeLogger();
        logger.info('m', { reason: 'password=hunter2' });
        expect(fileText()).not.toContain('hunter2');
        expect(fileText()).toContain('password=[REDACTED]');
    });

    test('account names are withheld by default and written with includeAccountNames: true (#448)', () => {
        const off = makeLogger();
        off.info('m', { accountName: 'Alice Joint', accountId: 'a1' });
        const rec = JSON.parse(consoleOut[0]);
        expect(rec.fields).toEqual({ accountId: 'a1' });
        expect(rec).not.toHaveProperty('droppedFieldCount');
        expect(consoleOut[0]).not.toContain('Alice');

        consoleOut.length = 0;
        const on = makeLogger({ includeAccountNames: true });
        on.info('m', { accountName: 'Alice Joint', accountId: 'a1' });
        expect(JSON.parse(consoleOut[0]).fields).toEqual({ accountName: 'Alice Joint', accountId: 'a1' });
        expect(on.child({ component: 'x' }).includeAccountNames).toBe(true);
    });

    test('class personal is emitted by default and withheld with includePersonal: false', () => {
        const on = makeLogger();
        on.info('m', { dataDir: '/srv/alice', accountId: 'a1' });
        expect(JSON.parse(consoleOut[0]).fields).toEqual({ dataDir: '/srv/alice', accountId: 'a1' });

        consoleOut.length = 0;
        const off = makeLogger({ includePersonal: false });
        off.info('m', { dataDir: '/srv/alice', accountId: 'a1' });
        const rec = JSON.parse(consoleOut[0]);
        expect(rec.fields).toEqual({ accountId: 'a1' });
        expect(rec.droppedFieldCount).toBe(1);
        expect(consoleOut[0]).not.toContain('alice');
        expect(takeDroppedFields()).toEqual(['dataDir']);
    });

    test('with includePersonal: false a security record keeps remoteAddress, a plain record does not (M3)', () => {
        const logger = makeLogger({ includePersonal: false });
        logger.security('authn_login_fail', { remoteAddress: '10.0.0.9' });
        logger.info('m', { remoteAddress: '10.0.0.8' });
        const [sec, plain] = consoleOut.map((l) => JSON.parse(l));
        expect(sec.fields.remoteAddress).toBe('10.0.0.9');
        expect(plain.fields).toBeUndefined();
        expect(plain.droppedFieldCount).toBe(1);
        takeDroppedFields();
    });

    test('with includePersonal: false security.suppressed keeps remoteAddress (M3)', () => {
        const logger = makeLogger({ includePersonal: false });
        for (let i = 0; i < 30; i++) logger.security('authn_login_fail', { remoteAddress: '10.0.0.9' });
        consoleOut.length = 0;
        logger.flushSecurity();
        const rec = consoleOut.map((l) => JSON.parse(l)).find((r) => r.message === 'security.suppressed');
        expect(rec.fields.remoteAddress).toBe('10.0.0.9');
        takeDroppedFields();
    });

    test('a child logger inherits includePersonal', () => {
        const child = makeLogger({ includePersonal: false }).child({ component: 'x' });
        child.info('m', { accountName: 'Alice Joint' });
        expect(consoleOut[0]).not.toContain('Alice');
        takeDroppedFields();
    });

    test('context is filtered too: an unregistered context key does not leak', () => {
        const child = makeLogger().child({ component: 'x', accountNumber: 'DE89370400440532013000' });
        child.info('m');
        expect(consoleOut[0]).not.toContain('DE89');
        expect(JSON.parse(consoleOut[0]).droppedFieldCount).toBe(1);
        takeDroppedFields();
    });

    test('a non-object metadata argument does not throw or leak', () => {
        const logger = makeLogger();
        expect(() => logger.info('m', 'SENTINEL_STRING')).not.toThrow();
        expect(consoleOut[0]).not.toContain('SENTINEL_STRING');
        takeDroppedFields();
    });

    test('logger.error(err) logs the class and code, not the frames or a message field', () => {
        const logger = makeLogger();
        const err = Object.assign(new Error('Category Rent to Marco already exists'), { code: 'E_DUP' });
        logger.error(err);
        const rec = JSON.parse(consoleOut[0]);
        expect(rec.fields).toEqual({ errorType: 'Error', errorCode: 'E_DUP' });
        expect(consoleOut[0]).not.toContain('at Object');
        expect(takeDroppedFields()).toEqual([]);
    });
});
