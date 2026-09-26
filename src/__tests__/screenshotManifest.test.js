/**
 * Screenshot manifest <-> docs drift guard (#263).
 *
 * tests/e2e/screenshots.json is the single source of truth for which dashboard
 * screenshots exist. Two things can drift from it silently: a doc can reference
 * a filename the manifest (and generator) no longer produces, or the manifest
 * can grow a screenshot that no doc ever links to (dead weight nobody sees).
 * Both directions are checked here, unlike the endpoint guards in
 * docDriftGuards.test.js, which are forward-only by design (the README is
 * curated prose, not an exhaustive mirror) - a screenshot filename is not
 * prose, it is either linked correctly or it is a typo.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function listMarkdownFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listMarkdownFiles(full));
        else if (entry.name.endsWith('.md')) out.push(full);
    }
    return out;
}

const MANIFEST = JSON.parse(read('tests/e2e/screenshots.json'));
const MANIFEST_FILES = new Set(MANIFEST.map((entry) => entry.file));

const DOC_PATHS = [
    'README.md',
    ...listMarkdownFiles(path.join(ROOT, 'docs')).map((p) => path.relative(ROOT, p)),
    'docker/description/long.md'
].filter((rel) => fs.existsSync(path.join(ROOT, rel)));

const DOC_CONTENTS = DOC_PATHS.map((rel) => ({ rel, text: read(rel) }));

// Matches "dashboard-something.png" wherever it appears (markdown image syntax,
// a raw GitHub URL, or a bare filename in prose), not just inside ![]() links,
// so a stale reference cannot hide from this guard.
const SCREENSHOT_FILENAME_RE = /dashboard-[a-z0-9-]+\.png/g;

describe('screenshot manifest drift guard (#263)', () => {
    test('every manifest entry has a file, state and description', () => {
        expect(Array.isArray(MANIFEST)).toBe(true);
        expect(MANIFEST.length).toBeGreaterThan(0);
        for (const entry of MANIFEST) {
            expect(typeof entry.file).toBe('string');
            expect(entry.file).toMatch(/^dashboard-[a-z0-9-]+\.png$/);
            expect(typeof entry.state).toBe('string');
            expect(fs.existsSync(path.join(ROOT, 'tests/e2e/fixtures/states', `${entry.state}.js`))).toBe(true);
            expect(typeof entry.description).toBe('string');
            expect(entry.description.length).toBeGreaterThan(0);
        }
    });

    test('scrollToText entries always set fullPage: false', () => {
        // A full-page screenshot ignores scroll position entirely (it resizes
        // the viewport to the whole page height), so this combination is
        // always a mistake - see scripts/generateDashboardScreenshots.js.
        for (const entry of MANIFEST) {
            if (entry.scrollToText) {
                expect(entry.fullPage).toBe(false);
            }
        }
    });

    test('the manifest has no duplicate filenames', () => {
        const files = MANIFEST.map((e) => e.file);
        expect(new Set(files).size).toBe(files.length);
    });

    test('every dashboard-*.png referenced from a doc is in the manifest', () => {
        const unknown = [];
        for (const { rel, text } of DOC_CONTENTS) {
            for (const match of text.matchAll(SCREENSHOT_FILENAME_RE)) {
                if (!MANIFEST_FILES.has(match[0])) unknown.push(`${rel}: ${match[0]}`);
            }
        }
        expect(unknown).toEqual([]);
    });

    test('every manifest screenshot is referenced from at least one doc', () => {
        const referenced = new Set();
        for (const { text } of DOC_CONTENTS) {
            for (const match of text.matchAll(SCREENSHOT_FILENAME_RE)) referenced.add(match[0]);
        }
        const unreferenced = [...MANIFEST_FILES].filter((file) => !referenced.has(file));
        expect(unreferenced).toEqual([]);
    });
});
