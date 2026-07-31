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
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cfgres-'));
        fs.mkdirSync(path.join(tmp, 'config-defaults'));
        fs.mkdirSync(path.join(tmp, 'config'));
        fs.writeFileSync(path.join(tmp, 'config-defaults', 'config.example.json'), '{}');

        expect(resolveDefaultsDir(tmp)).toBe(path.join(tmp, 'config-defaults'));
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('falls back to config/ when only that holds the example', () => {
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cfgres-'));
        fs.mkdirSync(path.join(tmp, 'config'));
        fs.writeFileSync(path.join(tmp, 'config', 'config.example.json'), '{}');

        expect(resolveDefaultsDir(tmp)).toBe(path.join(tmp, 'config'));
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('validateConfig.js resolves its schema through the shared helper, like index.js', () => {
        const script = read('scripts/validateConfig.js');
        expect(script).toMatch(/resolveDefaultsDir/);
        // The bind-mounted config dir must not be the source of the schema.
        expect(script).not.toMatch(/['"]config\/config\.schema\.json['"]/);
    });

    it('validateConfig.js treats a missing schema as an error, not a silent skip', () => {
        const script = read('scripts/validateConfig.js');
        // A validator that cannot find its schema must never reach the success path.
        expect(script).not.toMatch(/if\s*\(\s*fs\.existsSync\(schemaPath\)\s*\)\s*\{/);
        expect(script).toMatch(/Configuration schema not found|schema not found/i);
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
    const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]);
    const out = [];

    for (const raw of blocks) {
        for (const candidate of [raw, `{${raw}}`]) {
            let parsed;
            try {
                parsed = JSON.parse(candidate);
            } catch {
                continue;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) break;
            const keys = Object.keys(parsed);
            if (keys.length > 0 && keys.every(k => topLevel.has(k))) out.push(parsed);
            break;
        }
    }
    return out;
}

describe('documented config examples are valid (#177)', () => {
    const DOCS = ['docs/NOTIFICATIONS.md', 'docs/CONFIG.md', 'docs/MIGRATION.md', 'README.md'];

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
