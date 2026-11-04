/**
 * Record contract (#436): every JSON record validates against
 * docs/log-record.schema.json, seq is a per-process counter, and the
 * catalogue in docs/LOGGING.md uses names the schema accepts.
 */
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { Logger } = require('../lib/logger');
const pkg = require('../../package.json');

const schema = require('../../docs/log-record.schema.json');
const validate = new Ajv({ strict: false }).compile(schema);

const capture = (logger, fn) => {
    const lines = [];
    const spies = ['log', 'warn', 'error'].map((m) =>
        jest.spyOn(console, m).mockImplementation((l) => lines.push(l)));
    try { fn(); } finally { spies.forEach((s) => s.mockRestore()); }
    return lines.map((l) => JSON.parse(l));
};

const makeLogger = (opts = {}) => new Logger({ format: 'json', logDir: null, level: 'DEBUG', ...opts });

describe('log record contract', () => {
    test('every record from varied calls validates against the schema', () => {
        const logger = makeLogger();
        const child = logger.child({ component: 'sync', server: 'Vega II' });
        child.correlationId = 'c0ffee12';
        const records = capture(logger, () => {
            logger.debug('Debug line');
            logger.info('Info line', { durationMs: 5 });
            logger.warn('Warn line', { event: 'authz_fail', category: 'security' });
            logger.error('Error line', { error: { category: 'timeout', safeMessage: 'x' } });
            logger.error(new Error('boom'));
            child.info('Child line', { event: 'sync.account.completed' });
            logger.info('Reserved attempt', { seq: 999, schema: 7, version: 'x', severity: 1 });
        });
        expect(records).toHaveLength(7);
        for (const r of records) {
            expect(validate(r) ? null : validate.errors).toBeNull();
        }
    });

    test('severity numbers follow OpenTelemetry', () => {
        const records = capture(null, () => {
            const l = makeLogger();
            l.error('e'); l.warn('w'); l.info('i'); l.debug('d');
        });
        expect(records.map((r) => r.severity)).toEqual([17, 13, 9, 5]);
    });

    test('seq increases by one per record and is shared by console and file', () => {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'seq-'));
        const logger = makeLogger({ logDir: dir, fileFormat: 'json', rotation: { enabled: false } });
        const records = capture(logger, () => { logger.info('a'); logger.info('b'); logger.info('c'); });
        expect(records[1].seq).toBe(records[0].seq + 1);
        expect(records[2].seq).toBe(records[1].seq + 1);
        const file = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
        const fileSeqs = file.trim().split('\n').map((l) => JSON.parse(l).seq);
        expect(fileSeqs).toEqual(records.map((r) => r.seq));
    });

    test('reserved keys cannot be overwritten by fields', () => {
        const [r] = capture(null, () => makeLogger().info('m', { seq: 999, schema: 7, version: 'x', severity: 1 }));
        expect(r.seq).not.toBe(999);
        expect(r.schema).toBe(1);
        expect(r.version).toBe(pkg.version);
        expect(r.severity).toBe(9);
    });

    test('timestamps are UTC ISO 8601 with milliseconds', () => {
        const [r] = capture(null, () => makeLogger().info('m'));
        expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('docs/LOGGING.md states convention version 1 and event names match the schema', () => {
        const doc = fs.readFileSync(path.join(__dirname, '../../docs/LOGGING.md'), 'utf8');
        expect(doc).toMatch(/\*\*Convention version: 1\.\*\*/);
        const section = doc.split('### Event catalogue')[1].split('### Error categories')[0];
        const names = [...section.matchAll(/`([a-z][a-z0-9_.]*)`/g)].map((m) => m[1]);
        expect(names).toEqual(expect.arrayContaining(['process.rejection_benign', 'authz_fail', 'sys_crash']));
        for (const n of names) {
            expect(schema.properties.event.pattern && new RegExp(schema.properties.event.pattern).test(n)).toBe(true);
        }
        for (const c of schema.properties.error.properties.category.enum) {
            expect(doc).toContain(`\`${c}\``);
        }
    });
});
