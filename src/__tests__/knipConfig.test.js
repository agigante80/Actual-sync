/**
 * Guards knip.json so a typo in an entry/project glob can't silently disable
 * dead-code detection (a bad entry root makes knip report live code as unused,
 * which then gets "cleaned up"). For every glob we assert the base directory
 * exists and the pattern actually matches at least one file on disk. (#130)
 *
 * Lesson imported from the sibling project (actual-mcp-server #234): a committed
 * knip config is only trustworthy if its entry points are themselves guarded.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const knip = JSON.parse(fs.readFileSync(path.join(ROOT, 'knip.json'), 'utf8'));

/** Base directory of a glob: everything before the first wildcard segment. */
function globBase(pattern) {
    const segments = pattern.split('/');
    const fixed = [];
    for (const seg of segments) {
        if (seg.includes('*') || seg.includes('?') || seg.includes('{')) break;
        fixed.push(seg);
    }
    return fixed.join('/') || '.';
}

/** Trailing extension a glob filters on, e.g. `**​/*.test.js` -> `.test.js`. */
function globExt(pattern) {
    const last = pattern.split('/').pop();
    const star = last.lastIndexOf('*');
    return star === -1 ? '' : last.slice(star + 1);
}

/** Recursively collect files under dir (skips node_modules). */
function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

describe('knip.json config (#130)', () => {
    const patterns = [...(knip.entry || []), ...(knip.project || [])];

    it('declares at least one entry and project pattern', () => {
        expect((knip.entry || []).length).toBeGreaterThan(0);
        expect((knip.project || []).length).toBeGreaterThan(0);
    });

    it.each(patterns)('pattern "%s" resolves to real files on disk', (pattern) => {
        const baseRel = globBase(pattern);
        const baseAbs = path.join(ROOT, baseRel);
        expect(fs.existsSync(baseAbs)).toBe(true);

        const ext = globExt(pattern);
        const matches = walk(baseAbs).filter((f) => (ext ? f.endsWith(ext) : true));
        expect(matches.length).toBeGreaterThan(0);
    });

    it('uses no blanket ignore (suppress at the source instead)', () => {
        // Per the adopted knip best-practice: legitimate exceptions are tagged
        // at the declaration, not hidden behind a broad ignore glob.
        expect(knip.ignore || []).toEqual([]);
    });
});
