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
const { resolveDefaultsDir, resolveSchemaPath } = require('../lib/configBootstrap');
const { createTempDir, cleanupTempDir } = require('./helpers/testHelpers');
const { buildSnippetExtractor } = require('./helpers/configSnippets');

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
        try {
            fs.mkdirSync(path.join(tmp, 'config-defaults'));
            fs.mkdirSync(path.join(tmp, 'config'));
            fs.writeFileSync(path.join(tmp, 'config-defaults', 'config.example.json'), '{}');
            expect(resolveDefaultsDir(tmp)).toBe(path.join(tmp, 'config-defaults'));
        } finally {
            cleanupTempDir(tmp);
        }
    });

    it('falls back to config/ when only that holds the example', () => {
        const tmp = createTempDir();
        try {
            fs.mkdirSync(path.join(tmp, 'config'));
            fs.writeFileSync(path.join(tmp, 'config', 'config.example.json'), '{}');
            expect(resolveDefaultsDir(tmp)).toBe(path.join(tmp, 'config'));
        } finally {
            cleanupTempDir(tmp);
        }
    });

    // A regex for the helper NAME does not work: a review regressed index.js to a
    // hardcoded path while leaving the import in place — ordinary refactor debris —
    // and the suite stayed green, because the surviving `require` satisfied it.
    // Keying on the absence of the literal is what bites: any hand-rolled path
    // must reintroduce the filename.
    it.each(['index.js', 'src/lib/configLoader.js', 'scripts/validateConfig.js'])(
        '%s builds no schema path of its own', (file) => {
            const src = read(file).replace(/^\s*\*.*$/gm, ''); // ignore doc comments
            expect(src).not.toMatch(/config\.schema\.json/);
            expect(src).toMatch(/resolveSchemaPath/);
        });

    it('resolveSchemaPath points at the defaults dir, not the mounted config dir', () => {
        const tmp = createTempDir();
        try {
            fs.mkdirSync(path.join(tmp, 'config-defaults'));
            fs.mkdirSync(path.join(tmp, 'config'));
            fs.writeFileSync(path.join(tmp, 'config-defaults', 'config.example.json'), '{}');
            expect(resolveSchemaPath(tmp))
                .toBe(path.join(tmp, 'config-defaults', 'config.schema.json'));
        } finally {
            cleanupTempDir(tmp);
        }
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

const configSnippets = buildSnippetExtractor(SCHEMA);

describe('documented config examples are valid (#177)', () => {
    const DOCS = ['docs/NOTIFICATIONS.md', 'docs/CONFIG.md', 'docs/MIGRATION.md',
        'docs/DOCKER_DEPLOYMENT.md', 'README.md'];

    for (const doc of DOCS) {
        const snippets = configSnippets(read(doc));

        // A bare `> 0` would not notice the extractor narrowing from 17 blocks to
        // 1. Floors are per-doc and deliberately a little below current counts so
        // ordinary doc edits do not trip them.
        const FLOOR = { 'docs/NOTIFICATIONS.md': 15, 'docs/CONFIG.md': 5,
            'docs/MIGRATION.md': 4, 'docs/DOCKER_DEPLOYMENT.md': 2, 'README.md': 4 };
        it(`${doc} yields at least ${FLOOR[doc]} config snippets to check`, () => {
            expect(snippets.length).toBeGreaterThanOrEqual(FLOOR[doc]);
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

/**
 * Unit tests for the extraction rules themselves.
 *
 * A review proved the headline branch — the typo'd-wrapper heuristic — had zero
 * coverage: deleting it left the whole suite green, because no block in any
 * guarded doc reaches it. These pin each branch against synthetic markdown so
 * the rules are protected independently of what the docs happen to contain.
 */
describe('snippet extraction rules (#177)', () => {
    const fence = (obj) => '```json\n' + (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n```\n';

    it('takes a whole-config block', () => {
        expect(configSnippets(fence({ notifications: { notifyOnSuccess: 'never' } })))
            .toEqual([{ notifications: { notifyOnSuccess: 'never' } }]);
    });

    it('lifts a notifications-level fragment', () => {
        expect(configSnippets(fence({ email: { enabled: true } })))
            .toEqual([{ notifications: { email: { enabled: true } } }]);
    });

    it('lifts a bare server entry', () => {
        expect(configSnippets(fence({ name: 'Main', url: 'https://a.b' })))
            .toEqual([{ servers: [{ name: 'Main', url: 'https://a.b' }] }]);
    });

    it('keeps a typo\'d top-level wrapper so the schema can reject it', () => {
        // The branch that previously had no coverage at all.
        expect(configSnippets(fence({ notifcations: { email: { enabled: true } } })))
            .toEqual([{ notifcations: { email: { enabled: true } } }]);
    });

    it('accepts a fragment written without enclosing braces', () => {
        expect(configSnippets('```json\n"notifications": {"notifyOnSuccess": "never"}\n```'))
            .toEqual([{ notifications: { notifyOnSuccess: 'never' } }]);
    });

    it('skips blocks that are not configuration', () => {
        expect(configSnippets(fence({ event: 'sync', status: 'success', timestamp: 'x' }))).toEqual([]);
    });

    // Guards looksLikeSection specifically. The three-key case above never
    // reaches the `keys.length === 1` branch, so it cannot exercise the
    // predicate — stubbing it to `() => true` left the whole suite green.
    it('skips a single-key wrapper whose contents are not a config section', () => {
        expect(configSnippets(fence({ data: { id: 1, total: 7 } }))).toEqual([]);
    });

    // Guards the Array.isArray check. `[1,2]` passes even without it, because
    // Object.keys gives ['0','1'] which matches no branch; a one-element array
    // of a config-shaped object is what actually reaches the guard.
    it('skips a single-element array of a config-like object', () => {
        expect(configSnippets(fence([{ name: 'A', url: 'https://a.b' }]))).toEqual([]);
    });

    it('skips arrays, empty objects and unparseable blocks', () => {
        expect(configSnippets(fence([1, 2]))).toEqual([]);
        expect(configSnippets(fence({}))).toEqual([]);
        expect(configSnippets('```json\nnot json at all\n```')).toEqual([]);
    });

    it('honours an explicit opt-out marker', () => {
        const md = '<!-- config-guard: skip -->\n' + fence({ name: 'Main', url: 'https://a.b' });
        expect(configSnippets(md)).toEqual([]);
    });

    it('does not let the opt-out marker leak to a later block', () => {
        const md = '<!-- config-guard: skip -->\n' + fence({ name: 'A', url: 'https://a.b' })
            + '\ntext\n' + fence({ name: 'B', url: 'https://b.c' });
        expect(configSnippets(md)).toEqual([{ servers: [{ name: 'B', url: 'https://b.c' }] }]);
    });
});
