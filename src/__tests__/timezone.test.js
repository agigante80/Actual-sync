const fs = require('fs');
const path = require('path');
const { resolveTimezone, isValidTimezone } = require('../lib/timezone');
const ConfigLoader = require('../lib/configLoader');

const validConfig = (timezone) => ({
    servers: [{ name: 'T', url: 'https://t.com', password: 'password123', syncId: 'id', dataDir: '/tmp' }],
    sync: { maxRetries: 3, baseRetryDelayMs: 1000, schedule: '0 0 * * *' },
    ...(timezone === undefined ? {} : { timezone })
});

describe('timezone (#266)', () => {
    describe('resolveTimezone', () => {
        test('the configured timezone wins', () => {
            expect(resolveTimezone({ timezone: 'America/New_York' })).toBe('America/New_York');
        });

        test('without a key it follows the process TZ', () => {
            // A child process: Jest's process.env is a copy that does not reach ICU.
            const { execFileSync } = require('child_process');
            const run = (arg) => execFileSync(process.execPath, ['-e',
                `console.log(require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'timezone.js'))}).resolveTimezone(${arg}))`],
                { env: { ...process.env, TZ: 'Asia/Tokyo' } }).toString().trim();
            expect(run('{}')).toBe('Asia/Tokyo');
            expect(run('undefined')).toBe('Asia/Tokyo');
        });

        test('a blank or invalid process TZ falls back to UTC instead of an unusable zone', () => {
            const { execFileSync } = require('child_process');
            const run = (tz) => execFileSync(process.execPath, ['-e',
                `console.log(require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'timezone.js'))}).resolveTimezone({}))`],
                { env: { ...process.env, TZ: tz } }).toString().trim();
            expect(run('')).toBe('UTC');
            expect(run('Europe/Madird')).toBe('UTC');
        });

        test('describeTimezoneFallback names the bad TZ only when the fallback kicks in', () => {
            const { execFileSync } = require('child_process');
            const run = (tz, cfg) => execFileSync(process.execPath, ['-e',
                `console.log(JSON.stringify(require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'timezone.js'))}).describeTimezoneFallback(${cfg})))`],
                { env: { ...process.env, TZ: tz } }).toString().trim();
            expect(run('Europe/Madird', '{}')).toMatch(/Europe\/Madird.*UTC/);
            // The bad value itself (empty) must be named, not just "using UTC".
            expect(JSON.parse(run('', '{}'))).toMatch(/^TZ="" is blank or not a valid IANA timezone; using UTC/);
            expect(run('Asia/Tokyo', '{}')).toBe('null');
            expect(run('Europe/Madird', '{timezone:"UTC"}')).toBe('null');
        });
    });

    describe('isValidTimezone', () => {
        test.each(['UTC', 'Europe/Madrid', 'America/New_York'])('accepts %s', (name) => {
            expect(isValidTimezone(name)).toBe(true);
        });
        test.each(['Mars/Base', '', 5, null, undefined, 'Europe/'])('rejects %p', (name) => {
            expect(isValidTimezone(name)).toBe(false);
        });
    });

    describe('config validation (independent of CONFIG_STRICT)', () => {
        test('rejects an unknown name, naming the key', () => {
            expect(() => new ConfigLoader().validateLogic(validConfig('Mars/Base')))
                .toThrow(/Invalid timezone.*Mars\/Base/s);
        });
        test('rejects a non-string value', () => {
            expect(() => new ConfigLoader().validateLogic(validConfig(5))).toThrow(/Invalid timezone/);
        });
        test('accepts a valid name and no key', () => {
            expect(() => new ConfigLoader().validateLogic(validConfig('UTC'))).not.toThrow();
            expect(() => new ConfigLoader().validateLogic(validConfig())).not.toThrow();
        });
    });

    describe('schema', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'config.schema.json'), 'utf8'));
        test('declares an optional string timezone at the root', () => {
            expect(schema.properties.timezone.type).toBe('string');
            expect(schema.required).not.toContain('timezone');
        });
        test('config.example.json leaves the key out (copying it must not pin a zone) and CONFIG.md documents it', () => {
            const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'config.example.json'), 'utf8'));
            expect(example).not.toHaveProperty('timezone');
            const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'CONFIG.md'), 'utf8');
            expect(doc).toMatch(/`timezone`/);
        });
    });

    describe('no hardcoded Europe/Madrid in src (guard)', () => {
        function walk(dir) {
            return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
                return /\.(js|html)$/.test(e.name) ? [full] : [];
            });
        }
        // Doc comments may use it as an example; code and strings may not.
        const isCode = (line) => !/^\s*(\*|\/\/|\/\*)/.test(line);
        test('only tests may name Europe/Madrid', () => {
            const offenders = walk(path.join(__dirname, '..'))
                .filter((f) => fs.readFileSync(f, 'utf8').split('\n').some((l) => isCode(l) && l.includes('Europe/Madrid')));
            expect(offenders.map((f) => path.relative(path.join(__dirname, '..'), f))).toEqual([]);
        });
    });
});
