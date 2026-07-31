/**
 * Config example + documentation guards (#177).
 *
 * Two classes of drift this locks down:
 *
 * 1. **Schema resolution parity.** `index.js` resolves the schema from the
 *    image-baked defaults dir, but `scripts/validateConfig.js` looked in
 *    `config/` — which the documented Docker bind mount replaces. It then
 *    silently skipped validation and printed success, so the pre-flight tool
 *    gave a false green exactly when someone was checking whether it was safe
 *    to upgrade. Both must resolve identically, from one shared helper.
 *
 * 2. **Documented config examples must be valid.** A JSON config snippet in the
 *    docs is advice users paste. A wrong one is worse than no advice: the
 *    v1.11.0 migration guide told operators to silence a channel with a key the
 *    schema does not accept, which the loader treats as an advisory unknown key
 *    — so the service booted, ignored it, and the channel kept sending.
 */
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { resolveDefaultsDir } = require('../lib/configBootstrap');
const { createTempDir, cleanupTempDir } = require('./helpers/testHelpers');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SCHEMA = JSON.parse(read('config/config.schema.json'));

function makeValidator() {
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
    addFormats(ajv);
    return ajv.compile(SCHEMA);
}

describe('schema resolution parity (#177)', () => {
    it('resolveDefaultsDir prefers config-defaults when it holds the example', () => {
        const tmp = createTempDir();
        fs.mkdirSync(path.join(tmp, 'config-defaults'));
        fs.mkdirSync(path.join(tmp, 'config'));
        fs.writeFileSync(path.join(tmp, 'config-defaults', 'config.example.json'), '{}');

        expect(resolveDefaultsDir(tmp)).toBe(path.join(tmp, 'config-defaults'));
        cleanupTempDir(tmp);
    });

    it('falls back to config/ when only that holds the example', () => {
        const tmp = createTempDir();
        fs.mkdirSync(path.join(tmp, 'config'));
        fs.writeFileSync(path.join(tmp, 'config', 'config.example.json'), '{}');

        expect(resolveDefaultsDir(tmp)).toBe(path.join(tmp, 'config'));
        cleanupTempDir(tmp);
    });

    it('index.js also resolves its schema through the shared helper', () => {
        // Parity is only meaningful if BOTH sides are checked; asserting on the
        // script alone would stay green if index.js regressed to a hardcoded path.
        expect(read('index.js')).toMatch(/resolveDefaultsDir/);
    });
});

/**
 * Behavioural tests for the pre-flight validator.
 *
 * These deliberately replace the source-text assertions that were here first: a
 * review reintroduced BOTH original #177 defects in ordinary refactor spellings
 * — a path split into segments (`path.join(root, 'config', 'config.schema.json')`)
 * and a brace-less `if (fs.existsSync(schemaPath))` — and every regex still
 * passed. Only real invocations can catch that.
 */
describe('validate-config behaviour (#177)', () => {
    const { runValidation } = require('../../scripts/validateConfig');
    const VALID_CONFIG = {
        servers: [{
            name: 's', url: 'https://example.com', password: 'longenough',
            syncId: 'sync-id', dataDir: '/tmp/x'
        }]
    };

    let root;
    beforeEach(() => {
        root = createTempDir();
    });
    afterEach(() => {
        cleanupTempDir(root);
    });

    /** Lay out a project root the way the image does: config/ plus config-defaults/. */
    function project({ config, schemaIn = 'config-defaults' }) {
        fs.mkdirSync(path.join(root, 'config'), { recursive: true });
        if (config !== undefined) {
            fs.writeFileSync(path.join(root, 'config', 'config.json'), JSON.stringify(config));
        }
        if (schemaIn) {
            const dir = path.join(root, schemaIn);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'config.example.json'), '{}');
            fs.copyFileSync(path.join(ROOT, 'config/config.schema.json'),
                path.join(dir, 'config.schema.json'));
        }
        return root;
    }

    it('accepts a valid config', () => {
        expect(() => runValidation({ projectRoot: project({ config: VALID_CONFIG }) })).not.toThrow();
    });

    it('finds the schema in config-defaults even though config/ has none', () => {
        // The #177 shape: the user's bind mount replaces config/, so a schema
        // sought there is invisible. Validation must still happen.
        const bad = { ...VALID_CONFIG, notifications: { email: { enabled: true, from: 'a@b.com', to: [] } } };
        expect(() => runValidation({ projectRoot: project({ config: bad }) }))
            .toThrow(/must NOT have fewer than 1 items/);
    });

    it('rejects an invalid enum value', () => {
        const bad = { ...VALID_CONFIG, notifications: { notifyOnSuccess: 'sometimes' } };
        expect(() => runValidation({ projectRoot: project({ config: bad }) })).toThrow(/validation failed/i);
    });

    it('throws rather than reporting success when no schema can be found', () => {
        expect(() => runValidation({ projectRoot: project({ config: VALID_CONFIG, schemaIn: null }) }))
            .toThrow(/schema not found/i);
    });

    it('reports a missing config file', () => {
        expect(() => runValidation({ projectRoot: project({ config: undefined }) }))
            .toThrow(/Configuration file not found/);
    });
});

describe('shipped config examples validate against the schema (#177)', () => {
    for (const rel of ['config/config.example.json']) {
        it(`${rel} is valid`, () => {
            const validate = makeValidator();
            const ok = validate(JSON.parse(read(rel)));
            if (!ok) {
                throw new Error(`${rel} invalid:\n` +
                    validate.errors.map(e => `  ${e.instancePath} ${e.message}`).join('\n'));
            }
        });
    }

    it('the example demonstrates notifyOnSuccess without relying on a removed key', () => {
        const example = JSON.parse(read('config/config.example.json'));
        expect(example.notifications.notifyOnSuccess).toBeDefined();
    });
});

/**
 * Extract fenced ```json blocks that are config fragments and validate them.
 *
 * Only blocks whose top-level keys are ALL real config properties are checked —
 * that naturally skips abbreviated fragments (e.g. a bare `{"thresholds": …}`)
 * and non-config payload samples, without needing a hand-maintained skip list.
 */
function configSnippets(markdown) {
    const topLevel = new Set(Object.keys(SCHEMA.properties));
    const notifKeys = new Set(Object.keys(SCHEMA.properties.notifications.properties));
    const serverKeys = new Set(Object.keys(SCHEMA.properties.servers.items.properties));
    const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]);
    const out = [];

    for (const raw of blocks) {
        let parsed;
        for (const candidate of [raw, `{${raw}}`]) {
            try {
                parsed = JSON.parse(candidate);
                break;
            } catch { /* try the wrapped form */ }
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

        const keys = Object.keys(parsed);
        if (keys.length === 0) continue;

        // Docs show config at three nesting levels. Recognise each and lift it to
        // a whole config, so a snippet is EXCLUDED only when it is not config at
        // all (an API payload, a log sample) — never merely because it is nested.
        // Excluding on an unrecognised key would silently skip the single most
        // likely doc error, a typo'd key.
        const looksLikeSection = (v) => v && typeof v === 'object' && !Array.isArray(v) &&
            Object.keys(v).some(k => notifKeys.has(k) || serverKeys.has(k) || topLevel.has(k));

        if (keys.every(k => topLevel.has(k))) {
            out.push(parsed);
        } else if (keys.some(k => notifKeys.has(k))) {
            out.push({ notifications: parsed });
        } else if (keys.some(k => serverKeys.has(k))) {
            out.push({ servers: [parsed] });
        } else if (keys.length === 1 && looksLikeSection(parsed[keys[0]])) {
            // A single unrecognised wrapper around something that is plainly a
            // config section is a typo'd key ("notifcations"), not a payload
            // sample. Validate as-is so additionalProperties reports it.
            out.push(parsed);
        }
    }
    return out;
}

describe('documented config examples are valid (#177)', () => {
    const DOCS = ['docs/NOTIFICATIONS.md', 'docs/CONFIG.md', 'docs/MIGRATION.md',
        'docs/DOCKER_DEPLOYMENT.md', 'README.md'];

    for (const doc of DOCS) {
        const snippets = configSnippets(read(doc));

        it(`${doc} yields config snippets to check`, () => {
            expect(snippets.length).toBeGreaterThan(0);
        });

        snippets.forEach((snippet, i) => {
            it(`${doc} snippet #${i + 1} validates against the schema`, () => {
                const validate = makeValidator();
                // Merge onto a minimal valid base so a fragment about one section
                // is not rejected for omitting unrelated required sections.
                const baseServer = {
                    name: 'guard', url: 'https://example.com',
                    password: 'guardpass', syncId: 'guard-sync-id',
                    dataDir: '/tmp/guard'
                };
                // Server entries in the docs are routinely abbreviated to
                // illustrate one field (a per-server override, an encryption
                // password), so fill in the required scaffolding rather than
                // demanding every snippet be paste-ready. Unknown or wrongly
                // typed keys are still caught, which is what this guards.
                const merged = {
                    ...snippet,
                    servers: (snippet.servers || [{}]).map(s => ({ ...baseServer, ...s }))
                };
                if (!validate(merged)) {
                    throw new Error(
                        `${doc} snippet #${i + 1} is not a valid config:\n` +
                        validate.errors.map(e => `  ${e.instancePath} ${e.message}`).join('\n') +
                        `\n\nSnippet:\n${JSON.stringify(snippet, null, 2)}`
                    );
                }
            });
        });
    }
});
