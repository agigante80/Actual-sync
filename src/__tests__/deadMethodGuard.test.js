/**
 * Closes knip's blind spot: class methods (#176).
 *
 * knip flags unused files and exports, but not an unused **method on a class it
 * can see is used**. That gap let `notifyError()` survive several sweeps (#175)
 * and then let the whole `formatErrorNotification` family survive one more
 * (#176) — the second instance in a single release train, which is what made
 * the gap more interesting than either instance.
 *
 * Deadness here means: no reference anywhere in PRODUCTION code — including the
 * method's own file — once every already-dead method is discounted. That last
 * clause matters. `formatErrorNotification` was called by nothing, but its four
 * private helpers were each called by it, so a single pass sees them as live.
 * The scan iterates to a fixpoint so a dead *family* collapses entirely, which
 * is the shape this bug actually had.
 *
 * Tests are deliberately not counted as references. A method exercised only by
 * its own tests is the exact thing being looked for.
 *
 * This lives in its own file rather than in knipConfig.test.js (which the
 * ticket suggested) because it is ~100 lines of scanning with a reviewed
 * allowlist, and folding it in would make that file about two unrelated things.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Methods that are unreferenced in production and have not been dealt with yet,
 * each naming the ticket that owns the decision. Anything not listed here must
 * be deleted or justified — that is the whole point of the gate.
 *
 * These predate the guard and are recorded rather than silently tolerated.
 * Tracked by #181, split into #186 (mechanical deletions), #187 (formatLog and
 * its redaction tests) and #188 (a product call on getStats).
 *
 * Note this project is NOT a library — no `bin`, no `files`, not on npm — so
 * "public accessor" is not a reason to keep an uncalled method. Nothing outside
 * this repository can reach them.
 */
const REVIEWED_KEPT = new Map([
    ['src/lib/logger.js:logWithContext', '#186 — no reference at all, not even a test'],
    ['src/services/syncHistory.js:getAccountMetadata', '#186 — superseded by getAllAccountMetadata(), which the dashboard calls'],
    ['src/services/syncHistory.js:getDbPath', '#186 — unused accessor'],
    ['src/lib/configLoader.js:getServer', '#186 — unused accessor'],
    ['src/lib/logger.js:formatLog', '#187 — 13 redaction tests reach masking through this dead wrapper; re-point them first'],
    ['src/services/notificationService.js:reset', '#186 — reset affordance with no production caller'],
    ['src/services/notificationService.js:getStats', '#188 — unwired rather than dead; wire to the dashboard or delete']
]);

// The body may start on the same line; a guard that only saw multi-line
// methods would miss a one-line one, which is no less capable of being dead.
const METHOD = /^\s{2,4}(static\s+)?(async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/;
const NOT_A_METHOD = new Set(['constructor', 'if', 'for', 'while', 'switch', 'catch', 'get', 'set', 'function', 'return']);

/**
 * Locate class methods and their body ranges in one file.
 * @returns {Array<{file: string, name: string, line: number, end: number}>}
 */
function methodsIn(file, text) {
    const lines = text.split('\n');
    if (!/^\s*class\s/m.test(text)) return [];
    const found = [];
    lines.forEach((line, i) => {
        const m = line.match(METHOD);
        if (!m || NOT_A_METHOD.has(m[3])) return;
        // Walk to the matching close brace so references inside a dead method
        // can be discounted when it is removed.
        let depth = 0;
        let end = i;
        for (let j = i; j < lines.length; j++) {
            depth += (lines[j].match(/\{/g) || []).length;
            depth -= (lines[j].match(/\}/g) || []).length;
            if (depth <= 0) { end = j; break; }
        }
        found.push({ file, name: m[3], line: i + 1, end: end + 1 });
    });
    return found;
}

/**
 * Methods with no production reference, iterated to a fixpoint so a dead family
 * collapses rather than propping itself up.
 *
 * @param {Map<string, string>} fileMap production file path -> source
 * @returns {Array<{file: string, name: string, line: number}>}
 */
function findUnreferencedMethods(fileMap) {
    const all = [...fileMap].flatMap(([f, t]) => methodsIn(f, t));
    const dead = new Set();
    for (let pass = 0; pass < 20; pass++) {
        let grew = false;
        for (const m of all) {
            if (dead.has(m)) continue;
            const re = new RegExp('[.\\[\'"`]' + m.name + '\\b');
            let refs = 0;
            for (const [f, t] of fileMap) {
                t.split('\n').forEach((line, idx) => {
                    const n = idx + 1;
                    if (f === m.file && n === m.line) return;           // the definition itself
                    // Inside the body of a method already known to be dead?
                    // `>=` not `>`: a one-line method's body IS its definition
                    // line, so `>` would keep counting the calls it makes and
                    // its helpers would never collapse.
                    const inDead = all.some((d) => dead.has(d) && d.file === f && n >= d.line && n <= d.end);
                    if (inDead) return;
                    if (re.test(line)) refs++;
                });
            }
            if (refs === 0) { dead.add(m); grew = true; }
        }
        if (!grew) break;
    }
    return [...dead].map(({ file, name, line }) => ({ file, name, line }));
}

/** Every production .js file: src/ (minus tests) plus scripts/ and index.js. */
function productionFiles() {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
        return p.endsWith('.js') ? [p] : [];
    });
    return [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts')), path.join(ROOT, 'index.js')]
        .filter((p) => fs.existsSync(p));
}

/**
 * Drop the reviewed-and-kept entries, keep everything else.
 *
 * Extracted and tested because an allowlist is the natural place for a guard to
 * go quietly useless: widen the filter and every finding disappears while the
 * production assertion still passes, green and meaningless.
 *
 * @param {Array<{key: string}>} found
 * @returns {Array<{key: string}>} findings that nobody has signed off
 */
function unreviewed(found) {
    return found.filter((m) => !REVIEWED_KEPT.has(m.key));
}

describe('no class method is dead in production (knip cannot see these)', () => {
    let scanError = null;
    let files = [];
    try {
        files = productionFiles();
    } catch (err) {
        scanError = err;
    }

    const fileMap = new Map(files.map((p) => [p, fs.readFileSync(p, 'utf8')]));
    const findings = scanError ? [] : unreviewed(findUnreferencedMethods(fileMap)
        .map((m) => ({ ...m, key: `${path.relative(ROOT, m.file)}:${m.name}` })));

    it('could enumerate production files at all', () => {
        // Otherwise every assertion below is vacuous rather than passing.
        expect(scanError && scanError.message).toBeNull();
        expect(fileMap.size).toBeGreaterThan(10);
    });

    it('finds no unreferenced class method outside the reviewed list', () => {
        expect(findings.map((f) => `${path.relative(ROOT, f.file)}:${f.line} ${f.name}`)).toEqual([]);
    });

    it('keeps the reviewed list honest — every entry is still unreferenced', () => {
        // A kept method that gains a caller should drop off the list, otherwise
        // the allowlist rots into a place where real findings hide.
        const stillDead = new Set(findUnreferencedMethods(fileMap)
            .map((m) => `${path.relative(ROOT, m.file)}:${m.name}`));
        for (const key of REVIEWED_KEPT.keys()) expect(stillDead).toContain(key);
    });
});

/**
 * The gate is only worth having if it fails on the thing it claims to catch.
 * These drive the scan directly with synthetic sources.
 */
describe('the reviewed-kept allowlist', () => {
    it('drops a reviewed entry but keeps a novel one', () => {
        // A filter widened to match everything would make the production
        // assertion pass with zero findings — green, and worthless.
        const someReviewed = [...REVIEWED_KEPT.keys()][0];
        const kept = unreviewed([{ key: someReviewed }, { key: 'src/lib/brandNew.js:orphan' }]);
        expect(kept.map((m) => m.key)).toEqual(['src/lib/brandNew.js:orphan']);
    });

    it('is not empty, so the entries above are real sign-offs', () => {
        expect(REVIEWED_KEPT.size).toBeGreaterThan(0);
    });

    it('gives a reason for every entry', () => {
        for (const [key, reason] of REVIEWED_KEPT) {
            expect(typeof reason === 'string' && reason.length > 10).toBe(true);
            expect(key).toMatch(/^src\/.+\.js:[A-Za-z_][A-Za-z0-9_]*$/);
        }
    });
});

describe('the dead-method scan itself', () => {
    const f = '/repo/thing.js';

    it('flags a method nothing calls', () => {
        const src = ['class A {', '  used() { return 1; }', '  orphan() { return 2; }', '}', 'new A().used();'].join('\n');
        expect(findUnreferencedMethods(new Map([[f, src]])).map((m) => m.name)).toEqual(['orphan']);
    });

    it('does not flag a method called through this', () => {
        const src = ['class A {', '  outer() { return this.inner(); }', '  inner() { return 1; }', '}', 'new A().outer();'].join('\n');
        expect(findUnreferencedMethods(new Map([[f, src]])).map((m) => m.name)).toEqual([]);
    });

    it('does not flag a method called from another file', () => {
        const a = ['class A {', '  ping() { return 1; }', '}', 'module.exports = A;'].join('\n');
        const b = 'const A = require("./a"); new A().ping();';
        expect(findUnreferencedMethods(new Map([[f, a], ['/repo/b.js', b]]))).toEqual([]);
    });

    it('collapses a transitively dead family, not just its entry point', () => {
        // Exactly #176: the public method was called by nothing, but each
        // private helper was called by it, so one pass sees them all as live.
        const src = [
            'class A {',
            '  live() { return this.shared(); }',
            '  shared() { return 1; }',
            '  deadEntry() { return this.deadHelperA() + this.deadHelperB(); }',
            '  deadHelperA() { return 2; }',
            '  deadHelperB() { return 3; }',
            '}',
            'new A().live();'
        ].join('\n');
        const names = findUnreferencedMethods(new Map([[f, src]])).map((m) => m.name).sort();
        expect(names).toEqual(['deadEntry', 'deadHelperA', 'deadHelperB']);
    });

    it('would have caught the #176 family', () => {
        // The real shape, reduced: an entry point reachable only from tests,
        // fanning out to four private formatters.
        const src = [
            'class MessageFormatter {',
            '  static formatSyncNotification(r) { return this._formatPlainText(r); }',
            '  static _formatPlainText(c) { return c; }',
            '  static formatErrorNotification(e) {',
            '    return { text: this._formatErrorPlainText(e), html: this._formatErrorHtml(e) };',
            '  }',
            '  static _formatErrorPlainText(c) { return c; }',
            '  static _formatErrorHtml(c) { return c; }',
            '}',
            'MessageFormatter.formatSyncNotification({});'
        ].join('\n');
        const names = findUnreferencedMethods(new Map([[f, src]])).map((m) => m.name).sort();
        expect(names).toEqual(['_formatErrorHtml', '_formatErrorPlainText', 'formatErrorNotification']);
    });
});
