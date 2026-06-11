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
            // chatId present so botToken is the ONLY missing field — isolates the rule.
            const config = baseConfig({
                notifications: { webhooks: { telegram: [{ name: 'no-token', chatId: '42' }] } }
            });
            expect(validates(config)).toBe(false);
        });

        test('a telegram webhook entry missing chatId is rejected', () => {
            const config = baseConfig({
                notifications: { webhooks: { telegram: [{ name: 'no-chat', botToken: '123456:ABC-def' }] } }
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

        test('a non-http(s) generic webhook url is rejected', () => {
            const config = baseConfig({
                notifications: { webhooks: { generic: [{ name: 'x', url: 'ftp://example.com/hook' }] } }
            });
            expect(validates(config)).toBe(false);
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

        test('a 6-field (with-seconds) cron validates', () => {
            // node-schedule accepts an optional leading seconds field.
            expect(validates(baseConfig({ sync: { schedule: '15 30 * * * *' } }))).toBe(true);
        });

        test('a per-server 6-field cron validates', () => {
            const config = baseConfig();
            config.servers[0].sync = { schedule: '0 0 2 * * *' };
            expect(validates(config)).toBe(true);
        });

        // Schema (validateConfig) is advisory; validateLogic is the hard-fail layer.
        // A 6-field cron must pass BOTH or load() throws despite the schema allowing it.
        test('load() accepts a 6-field cron (schema and validateLogic agree)', () => {
            const tempDir = createTempDir();
            const suppress = suppressConsole();
            try {
                const config = baseConfig({ sync: { schedule: '15 30 * * * *' } });
                config.servers[0].dataDir = path.join(tempDir, 'd');
                const configPath = path.join(tempDir, 'config.json');
                fs.writeFileSync(configPath, JSON.stringify(config));
                const loader = new ConfigLoader(configPath, SCHEMA_PATH);
                expect(() => loader.load()).not.toThrow();
            } finally {
                suppress.restore();
                cleanupTempDir(tempDir);
            }
        });

        test('load() still rejects a 4-field (too-short) cron', () => {
            const tempDir = createTempDir();
            const suppress = suppressConsole();
            try {
                const config = baseConfig({ sync: { schedule: '0 2 * *' } });
                config.servers[0].dataDir = path.join(tempDir, 'd');
                const configPath = path.join(tempDir, 'config.json');
                fs.writeFileSync(configPath, JSON.stringify(config));
                const loader = new ConfigLoader(configPath, SCHEMA_PATH);
                expect(() => loader.load()).toThrow(/cron/i);
            } finally {
                suppress.restore();
                cleanupTempDir(tempDir);
            }
        });
    });
});

describe('config schema hardening (#116 P3)', () => {
    describe('server url rejects an empty authority', () => {
        test('rejects "http://" (nothing after the scheme)', () => {
            const config = baseConfig();
            config.servers[0].url = 'http://';
            expect(validates(config)).toBe(false);
        });

        test('accepts a real url', () => {
            const config = baseConfig();
            config.servers[0].url = 'https://actual.example.com';
            expect(validates(config)).toBe(true);
        });
    });

    describe('log rotation size/interval formats', () => {
        test('rejects an unparseable maxSize', () => {
            // rotating-file-stream rejects this; '10MB' is actually VALID (see below).
            expect(validates(baseConfig({ logging: { rotation: { maxSize: 'tenmegs' } } }))).toBe(false);
        });

        test('rejects a zero-magnitude maxSize', () => {
            expect(validates(baseConfig({ logging: { rotation: { maxSize: '0M' } } }))).toBe(false);
        });

        test('rejects an unparseable interval', () => {
            expect(validates(baseConfig({ logging: { rotation: { interval: '1day' } } }))).toBe(false);
        });

        test('accepts single- and two-letter rfs size units', () => {
            // rfs accepts both '10M' and '10MB' / '10KB' / '10GB' / '512B'.
            for (const maxSize of ['10M', '10MB', '512B', '1GB']) {
                expect(validates(baseConfig({ logging: { rotation: { maxSize } } }))).toBe(true);
            }
        });

        test('accepts rfs-style interval, including monthly (M)', () => {
            for (const interval of ['1d', '12h', '30m', '1M']) {
                expect(validates(baseConfig({ logging: { rotation: { interval } } }))).toBe(true);
            }
        });
    });

    describe('numeric maxima', () => {
        test('rejects an absurd rotation.maxFiles', () => {
            expect(validates(baseConfig({ logging: { rotation: { maxFiles: 100000 } } }))).toBe(false);
        });

        test('rejects an absurd performance threshold', () => {
            expect(validates(baseConfig({ logging: { performance: { thresholds: { slow: 999999999 } } } }))).toBe(false);
        });

        test('rejects an absurd telegram pollInterval', () => {
            expect(validates(baseConfig({ notifications: { telegram: { pollInterval: 999999999 } } }))).toBe(false);
        });
    });

    describe('meaningful strings reject empty values', () => {
        test.each([
            ['syncHistory.dbPath', { syncHistory: { dbPath: '' } }],
            ['healthCheck.host', { healthCheck: { host: '' } }],
            ['logging.syslog.host', { logging: { syslog: { host: '' } } }],
            ['email.host', { notifications: { email: { host: '' } } }]
        ])('rejects empty %s', (_label, overrides) => {
            expect(validates(baseConfig(overrides))).toBe(false);
        });
    });

    describe('array items reject empty strings', () => {
        test('rejects an empty logging.redact item', () => {
            expect(validates(baseConfig({ logging: { redact: [''] } }))).toBe(false);
        });

        test('rejects an empty ntfy.tags item', () => {
            expect(validates(baseConfig({ notifications: { ntfy: { enabled: false, tags: [''] } } }))).toBe(false);
        });

        test('numeric telegram chatIds still validate (minLength applies only to strings)', () => {
            expect(validates(baseConfig({ notifications: { telegram: { chatIds: [123456] } } }))).toBe(true);
        });
    });
});

describe('conditional + pattern rule guards (#116)', () => {
    test('enabled telegram rejects a malformed botToken', () => {
        expect(validates(baseConfig({ notifications: { telegram: { enabled: true, botToken: 'not-a-token', chatId: '42' } } }))).toBe(false);
    });

    test('enabled telegram with a valid botToken + chatId validates', () => {
        expect(validates(baseConfig({ notifications: { telegram: { enabled: true, botToken: '123456:ABC-def', chatId: '42' } } }))).toBe(true);
    });

    test('enabled telegram requires chatId or chatIds', () => {
        expect(validates(baseConfig({ notifications: { telegram: { enabled: true, botToken: '123456:ABC-def' } } }))).toBe(false);
    });

    test('telegram rejects unknown keys (additionalProperties:false)', () => {
        expect(validates(baseConfig({ notifications: { telegram: { enabled: false, botTokn: 'typo' } } }))).toBe(false);
    });

    test('slack webhook url must be a hooks.slack.com url', () => {
        expect(validates(baseConfig({ notifications: { webhooks: { slack: [{ url: 'https://example.com/x' }] } } }))).toBe(false);
        expect(validates(baseConfig({ notifications: { webhooks: { slack: [{ url: 'https://hooks.slack.com/services/T/B/x' }] } } }))).toBe(true);
    });

    test('discord webhook url must be a discord.com webhook url', () => {
        expect(validates(baseConfig({ notifications: { webhooks: { discord: [{ url: 'https://example.com/x' }] } } }))).toBe(false);
        expect(validates(baseConfig({ notifications: { webhooks: { discord: [{ url: 'https://discord.com/api/webhooks/1/x' }] } } }))).toBe(true);
    });

    test('ntfy.icon accepts empty-string opt-out and a uri, rejects garbage', () => {
        expect(validates(baseConfig({ notifications: { ntfy: { enabled: false, icon: '' } } }))).toBe(true);
        expect(validates(baseConfig({ notifications: { ntfy: { enabled: false, icon: 'https://example.com/i.png' } } }))).toBe(true);
        expect(validates(baseConfig({ notifications: { ntfy: { enabled: false, icon: 'not a uri' } } }))).toBe(false);
    });

    test('email validates from/to as emails only when enabled', () => {
        const enabledBad = { notifications: { email: { enabled: true, host: 'smtp.example.com', auth: { user: 'u', pass: 'p' }, from: 'not-an-email', to: ['a@b.com'] } } };
        const disabledBad = { notifications: { email: { enabled: false, from: 'not-an-email', to: ['placeholder'] } } };
        expect(validates(baseConfig(enabledBad))).toBe(false);
        expect(validates(baseConfig(disabledBad))).toBe(true);
    });
});

// Schema-derived coverage of EVERY numeric minimum/maximum, so a wrong or missing
// bound on any field (current or future) is caught — not just the spot-checked
// ones. Derives bounds from the schema itself, so it never drifts. (#116)
const NUMERIC_BOUNDS = collectNumericBounds(schema, '', []);

describe('numeric bounds are enforced for every schema field (#116)', () => {
    test('schema declares a meaningful number of numeric bounds (sanity)', () => {
        expect(NUMERIC_BOUNDS.length).toBeGreaterThan(15);
    });

    test.each(NUMERIC_BOUNDS)('$path enforces [$minimum, $maximum]', ({ path, minimum, maximum }) => {
        if (minimum !== undefined) {
            expect(validates(withPath(baseConfig(), path, minimum - 1))).toBe(false); // below min
            expect(validates(withPath(baseConfig(), path, minimum))).toBe(true);       // at min
        }
        if (maximum !== undefined) {
            expect(validates(withPath(baseConfig(), path, maximum + 1))).toBe(false); // above max
            expect(validates(withPath(baseConfig(), path, maximum))).toBe(true);       // at max
        }
    });
});

describe('unknown keys are flagged but advisory-only (#123)', () => {
    // additionalProperties:false makes AJV flag unknown keys; while schema
    // validation is advisory (#115) this surfaces as a WARNING, not a throw.
    // #121 will later promote it (decision: warn-forever vs hard-fail).

    test('schema rejects an unknown top-level key (would warn now, hard-fail under #121)', () => {
        expect(validates(baseConfig({ notifcations: {} }))).toBe(false); // typo of "notifications"
    });

    test('schema rejects an unknown nested key', () => {
        expect(validates(baseConfig({ sync: { maxRetires: 3 } }))).toBe(false); // typo of "maxRetries"
    });

    test('schema rejects a JSON "_comment" key', () => {
        expect(validates(baseConfig({ _comment: 'note to self' }))).toBe(false);
    });

    test('an unknown key WARNS but still load()s (advisory, not a hard fail)', () => {
        const tempDir = createTempDir();
        const suppress = suppressConsole();
        try {
            const config = baseConfig({ notifcations: {}, _comment: 'hand-edited note' });
            config.servers[0].dataDir = path.join(tempDir, 'd');
            const configPath = path.join(tempDir, 'config.json');
            fs.writeFileSync(configPath, JSON.stringify(config));

            const loader = new ConfigLoader(configPath, SCHEMA_PATH);
            expect(() => loader.load()).not.toThrow();

            const warned = console.warn.mock.calls
                .map(args => String(args[0]))
                .some(msg => msg.includes('does not fully match the schema'));
            expect(warned).toBe(true);
        } finally {
            suppress.restore();
            cleanupTempDir(tempDir);
        }
    });

    test('webhooks.generic[*].headers stays open (arbitrary header names allowed)', () => {
        const config = baseConfig({
            notifications: { webhooks: { generic: [{ url: 'https://example.com/h', headers: { 'X-Anything': 'v', Authorization: 'Bearer x' } }] } }
        });
        expect(validates(config)).toBe(true);
    });
});

describe('config deliverables (#116)', () => {
    test('config.example.json validates clean against the schema (as shipped)', () => {
        const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
        expect(validates(example)).toBe(true);
    });

    test('the root schema declares $schema so the example survives additionalProperties:false (#121)', () => {
        // The example carries a "$schema" editor hint. It is allowed today only
        // because the root has no additionalProperties:false; once #121 tightens
        // that, an undeclared $schema would be wrongly rejected. Declare it now.
        expect(schema.properties.$schema).toBeDefined();
    });

    test('config.example.json load()s with zero advisory schema warnings', () => {
        const tempDir = createTempDir();
        const suppress = suppressConsole();
        try {
            const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
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
        // NOTE: this is a substring smoke test — short generic names (e.g. "to",
        // "host") match trivially and aren't truly proven; it reliably catches
        // distinctive names (the ones that drift via typo). Don't read it as proof
        // that every property is wired up. It scans src/ only (every config
        // consumer lives there today); a key read solely from scripts/ or index.js
        // would not be covered.
        const RESERVED = new Set([
            '$schema' // editor-only hint; intentionally not read at runtime
        ]);

        const srcDir = path.join(PROJECT_ROOT, 'src');
        const code = readAllJs(srcDir).join('\n');

        const names = collectPropertyNames(schema);
        const missing = [...names].filter(name => !RESERVED.has(name) && !code.includes(name));

        expect(missing).toEqual([]);
    });
});

/**
 * Collect every numeric (integer/number) leaf with a minimum and/or maximum,
 * keyed by a dot-path (array items use index 0, e.g. servers.0.sync.maxRetries).
 * Only walks properties + items, so conditional (if/then) blocks aren't double-counted.
 */
function collectNumericBounds(node, path, acc) {
    if (!node || typeof node !== 'object') return acc;
    if (node.properties) {
        for (const [key, sub] of Object.entries(node.properties)) {
            const p = path ? `${path}.${key}` : key;
            if ((sub.type === 'integer' || sub.type === 'number') &&
                (sub.minimum !== undefined || sub.maximum !== undefined)) {
                acc.push({ path: p, minimum: sub.minimum, maximum: sub.maximum });
            }
            collectNumericBounds(sub, p, acc);
        }
    }
    if (node.items) collectNumericBounds(node.items, `${path}.0`, acc);
    return acc;
}

/** Set a dot-path (numeric segments create arrays) on a config object; returns it. */
function withPath(obj, dotPath, value) {
    const parts = dotPath.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (cur[key] === undefined) cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
        cur = cur[key];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
}

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
    for (const kw of ['if', 'then', 'else', 'not']) {
        if (node[kw]) collectPropertyNames(node[kw], acc);
    }
    for (const kw of ['allOf', 'anyOf', 'oneOf']) {
        if (Array.isArray(node[kw])) node[kw].forEach(sub => collectPropertyNames(sub, acc));
    }
    // Subschemas that can also declare named properties as the schema grows.
    for (const kw of ['additionalProperties', 'propertyNames', 'contains']) {
        if (node[kw] && typeof node[kw] === 'object') collectPropertyNames(node[kw], acc);
    }
    for (const kw of ['patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
        if (node[kw] && typeof node[kw] === 'object') {
            Object.values(node[kw]).forEach(sub => collectPropertyNames(sub, acc));
        }
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
