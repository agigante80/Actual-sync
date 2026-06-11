/**
 * Config schema reconciliation tests (#116).
 *
 * These assert that config/config.schema.json accurately describes the real
 * configuration surface the code accepts, so that when validation is promoted
 * from advisory to hard-fail (#121) it neither wrongly rejects a valid config
 * nor wrongly accepts a bad one. Validates against the REAL schema + the REAL
 * example config (not test fixtures).
 */

const fs = require('fs');
const path = require('path');
const ConfigLoader = require('../lib/configLoader');
const { createTempDir, cleanupTempDir, suppressConsole } = require('./helpers/testHelpers');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(PROJECT_ROOT, 'config', 'config.schema.json');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, 'config', 'config.example.json');

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

/** Minimal config that satisfies every root + server required field. */
function baseConfig(overrides = {}) {
    return {
        servers: [
            {
                name: 'Main',
                url: 'https://actual.example.com',
                password: 'a-strong-password',
                syncId: '11111111-2222-3333-4444-555555555555',
                dataDir: '/data/main'
            }
        ],
        ...overrides
    };
}

/** True when `config` passes the real schema; false otherwise. */
function validates(config) {
    const loader = new ConfigLoader();
    try {
        loader.validateConfig(config, schema);
        return true;
    } catch {
        return false;
    }
}

describe('config schema reconciliation (#116)', () => {
    describe('notifications.ntfy.url is conditionally required', () => {
        test('a disabled ntfy stub validates without a url', () => {
            const config = baseConfig({ notifications: { ntfy: { enabled: false } } });
            expect(validates(config)).toBe(true);
        });

        test('an enabled ntfy without a url is rejected', () => {
            const config = baseConfig({ notifications: { ntfy: { enabled: true } } });
            expect(validates(config)).toBe(false);
        });

        test('an enabled ntfy with a url validates', () => {
            const config = baseConfig({
                notifications: { ntfy: { enabled: true, url: 'https://ntfy.sh/my-topic' } }
            });
            expect(validates(config)).toBe(true);
        });
    });

    describe('per-server sync.autoRetry is described in the schema', () => {
        test('a valid per-server autoRetry override validates', () => {
            const config = baseConfig();
            config.servers[0].sync = { autoRetry: { enabled: false, maxAttempts: 2, delayMinutes: 5 } };
            expect(validates(config)).toBe(true);
        });

        test('an out-of-range per-server autoRetry.maxAttempts is rejected', () => {
            const config = baseConfig();
            config.servers[0].sync = { autoRetry: { maxAttempts: 999 } };
            expect(validates(config)).toBe(false);
        });
    });

    describe('notifications.webhooks.telegram is described in the schema', () => {
        test('a valid telegram webhook entry validates', () => {
            const config = baseConfig({
                notifications: { webhooks: { telegram: [{ botToken: '123456:ABC-def', chatId: '42' }] } }
            });
            expect(validates(config)).toBe(true);
        });

        test('a telegram webhook entry missing botToken is rejected', () => {
            const config = baseConfig({
                notifications: { webhooks: { telegram: [{ name: 'no-token' }] } }
            });
            expect(validates(config)).toBe(false);
        });
    });

    describe('healthCheck.dashboard.auth conditional requirements', () => {
        test('type none validates without credentials', () => {
            const config = baseConfig({ healthCheck: { dashboard: { auth: { type: 'none' } } } });
            expect(validates(config)).toBe(true);
        });

        test('type basic without username/password is rejected', () => {
            const config = baseConfig({ healthCheck: { dashboard: { auth: { type: 'basic' } } } });
            expect(validates(config)).toBe(false);
        });

        test('type basic with username and password validates', () => {
            const config = baseConfig({
                healthCheck: { dashboard: { auth: { type: 'basic', username: 'admin', password: 'secret' } } }
            });
            expect(validates(config)).toBe(true);
        });

        test('type token without a token is rejected', () => {
            const config = baseConfig({ healthCheck: { dashboard: { auth: { type: 'token' } } } });
            expect(validates(config)).toBe(false);
        });
    });

    describe('webhooks.generic[*].url rejects empty strings', () => {
        test('an empty generic webhook url is rejected', () => {
            const config = baseConfig({
                notifications: { webhooks: { generic: [{ name: 'x', url: '' }] } }
            });
            expect(validates(config)).toBe(false);
        });

        test('a real generic webhook url validates', () => {
            const config = baseConfig({
                notifications: { webhooks: { generic: [{ name: 'x', url: 'https://example.com/hook' }] } }
            });
            expect(validates(config)).toBe(true);
        });
    });

    describe('cron schedule accepts valid named/extended syntax', () => {
        test('a named day-of-week cron validates', () => {
            const config = baseConfig({ sync: { schedule: '0 2 * * MON' } });
            expect(validates(config)).toBe(true);
        });

        test('a numeric 5-field cron validates', () => {
            const config = baseConfig({ sync: { schedule: '*/30 * * * *' } });
            expect(validates(config)).toBe(true);
        });
    });
});

describe('config deliverables (#116)', () => {
    test('config.example.json validates clean against the schema', () => {
        const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
        delete example.$schema; // editor hint, not part of the config surface
        expect(validates(example)).toBe(true);
    });

    test('config.example.json load()s with zero advisory schema warnings', () => {
        const tempDir = createTempDir();
        const suppress = suppressConsole();
        try {
            const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
            delete example.$schema;
            // Make the weak/default-password warning irrelevant to this assertion.
            example.servers.forEach((s, i) => {
                s.password = `strong-password-${i}`;
                s.dataDir = path.join(tempDir, `data-${i}`);
            });
            const configPath = path.join(tempDir, 'config.json');
            fs.writeFileSync(configPath, JSON.stringify(example));

            const loader = new ConfigLoader(configPath, SCHEMA_PATH);
            loader.load();

            // console.warn is a jest.fn() while suppressed.
            const schemaWarnings = console.warn.mock.calls
                .map(args => String(args[0]))
                .filter(msg => msg.includes('does not fully match the schema'));
            expect(schemaWarnings).toEqual([]);
        } finally {
            suppress.restore();
            cleanupTempDir(tempDir);
        }
    });

    test('every schema-declared property is consumed by code (no dead schema)', () => {
        // Guard against schema drift: a property nobody reads is either dead or a
        // typo. Anything legitimately not grep-able from src/ must be justified here.
        const RESERVED = new Set([
            // none today
        ]);

        const srcDir = path.join(PROJECT_ROOT, 'src');
        const code = readAllJs(srcDir).join('\n');

        const names = collectPropertyNames(schema);
        const missing = [...names].filter(name => !RESERVED.has(name) && !code.includes(name));

        expect(missing).toEqual([]);
    });
});

/** Recursively collect every declared property name in a JSON schema. */
function collectPropertyNames(node, acc = new Set()) {
    if (!node || typeof node !== 'object') return acc;
    if (node.properties && typeof node.properties === 'object') {
        for (const key of Object.keys(node.properties)) {
            acc.add(key);
            collectPropertyNames(node.properties[key], acc);
        }
    }
    if (node.items) collectPropertyNames(node.items, acc);
    for (const kw of ['if', 'then', 'else']) {
        if (node[kw]) collectPropertyNames(node[kw], acc);
    }
    for (const kw of ['allOf', 'anyOf', 'oneOf']) {
        if (Array.isArray(node[kw])) node[kw].forEach(sub => collectPropertyNames(sub, acc));
    }
    return acc;
}

/** Read every .js file under dir (excluding __tests__) as an array of contents. */
function readAllJs(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) readAllJs(full, out);
        else if (entry.name.endsWith('.js')) out.push(fs.readFileSync(full, 'utf8'));
    }
    return out;
}
