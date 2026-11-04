/**
 * Bootstrap logger (#442): pre-logger output is redacted, buffered, flushed
 * into the root logger, or written as JSON lines to stderr.
 */
const fs = require('fs');
const path = require('path');
const bootstrap = require('../lib/bootstrapLogger');
const ConfigLoader = require('../lib/configLoader');
const { createLogger } = require('../lib/logger');

describe('bootstrap logger (#442)', () => {
    beforeEach(() => bootstrap.reset());
    afterAll(() => bootstrap.reset());

    test('buffers records with the level and redacts secrets in message and meta', () => {
        bootstrap.warn('connect https://admin:hunter2@host/x failed', { password: 'p1', note: 'token=abc123' });
        const [r] = bootstrap.records();
        expect(r.level).toBe('warn');
        expect(r.message).toBe('connect https://admin:[REDACTED]@host/x failed');
        expect(r.meta).toEqual({ password: '[REDACTED]', note: 'token=[REDACTED]' });
    });

    test('dumpToStderr writes one JSON line per record with no raw secret and clears the buffer', () => {
        const spy = jest.spyOn(fs, 'writeSync').mockImplementation(() => 0);
        try {
            bootstrap.error('bad bot123456:AAHsecret_tok and\nnewline');
            bootstrap.info('second');
            bootstrap.dumpToStderr();
            expect(spy).toHaveBeenCalledTimes(2);
            const [fd, line] = spy.mock.calls[0];
            expect(fd).toBe(2);
            const parsed = JSON.parse(line);
            expect(parsed.level).toBe('ERROR');
            expect(parsed.service).toBe('actual-sync');
            expect(parsed.message).toBe('bad bot[REDACTED] and\nnewline');
            expect(line.endsWith('\n')).toBe(true);
            expect(line.trimEnd()).not.toMatch(/\n/);
            expect(line).not.toMatch(/AAHsecret/);
            expect(bootstrap.records()).toEqual([]);
        } finally {
            spy.mockRestore();
        }
    });

    test('flushTo replays in order into the root logger, then later records go straight to it', () => {
        const calls = [];
        const root = { info: (m, x) => calls.push(['info', m, x]), warn: (m, x) => calls.push(['warn', m, x]), error: jest.fn(), debug: jest.fn() };
        bootstrap.info('one');
        bootstrap.warn('two', { a: 1 });
        bootstrap.flushTo(root);
        expect(calls).toEqual([['info', 'one', undefined], ['warn', 'two', { a: 1 }]]);
        expect(bootstrap.records()).toEqual([]);
        bootstrap.warn('late');
        expect(calls[2]).toEqual(['warn', 'late', undefined]);
        expect(bootstrap.records()).toEqual([]);
    });

    test('a record that reaches a real json logger is formatted and redacted', () => {
        const out = [];
        const sink = (l) => out.push(l);
        const spies = ['log', 'warn'].map(m => jest.spyOn(console, m).mockImplementation(sink));
        try {
            const root = createLogger({ level: 'INFO', format: 'json', logDir: null });
            bootstrap.warn('url https://u:pw123@h/', {});
            bootstrap.flushTo(root);
            const rec = JSON.parse(out.find(l => l.startsWith('{')));
            expect(rec.message).toBe('url https://u:[REDACTED]@h/');
        } finally {
            spies.forEach(s => s.mockRestore());
        }
    });

    test('ConfigLoader warnings use the bootstrap logger, masked, and never console', () => {
        const spies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation(() => {}));
        try {
            const loader = new ConfigLoader();
            const cfg = {
                servers: [{
                    name: 'S', url: 'http://user:pw@example.com:5006', password: 'abc', syncId: 'x',
                    dataDir: './data/a', schedule: '0 2 * * *'
                }],
                sync: { maxRetries: 1, schedule: '0 2 * * *' }, logging: {}, healthCheck: {}
            };
            loader.validateLogic(cfg);
            const msgs = bootstrap.records().map(r => r.message).join('\n');
            expect(msgs).toMatch(/unencrypted HTTP/);
            expect(msgs).toMatch(/weak password/);
            expect(msgs).not.toMatch(/pw@/);
            spies.forEach(s => expect(s).not.toHaveBeenCalled());
        } finally {
            spies.forEach(s => s.mockRestore());
        }
    });

    test('source guard: no console.* in index.js or src/ except the logger sink, the bridge and the browser dashboard', () => {
        const root = path.join(__dirname, '..', '..');
        const allowed = new Set([
            'src/lib/logger.js',        // the console sink itself
            'src/lib/consoleBridge.js', // the #426 bridge
            'src/services/dashboard.js' // runs in the browser
        ]);
        const files = ['index.js'];
        const walk = (dir) => {
            for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
                const rel = path.join(dir, e.name);
                if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'vendor') walk(rel); }
                else if (e.name.endsWith('.js')) files.push(rel);
            }
        };
        walk('src');
        const offenders = files.filter(f => !allowed.has(f) &&
            /\bconsole\.(log|info|warn|error|debug|group|groupCollapsed|trace)\s*\(/.test(
                fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
        expect(offenders).toEqual([]);
    });
});
