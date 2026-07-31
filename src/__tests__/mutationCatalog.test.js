/**
 * Guards the mutation catalog (`scripts/mutations.js`).
 *
 * The catalog's failure mode is silent rot: a refactor moves or rewords the code
 * a mutation anchors to, the anchor stops matching, and that mutation quietly
 * tests nothing. `npm run test:mutation` reports it — but it is deliberately not
 * in CI, so nobody would see it until someone remembered to run it. These checks
 * are cheap (file reads, no jest invocations) and run in the normal suite, so
 * rot is caught the moment it is introduced.
 *
 * This is the same class of gap the catalog itself exists to close: a safety net
 * nobody verifies is not a safety net.
 */
const fs = require('fs');
const path = require('path');
const MUTATIONS = require('../../scripts/mutations');

const ROOT = path.resolve(__dirname, '..', '..');

describe('mutation catalog integrity', () => {
    it('is not empty', () => {
        expect(MUTATIONS.length).toBeGreaterThan(0);
    });

    it('has unique ids', () => {
        const ids = MUTATIONS.map(m => m.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    describe.each(MUTATIONS.map(m => [m.id, m]))('%s', (_id, mutation) => {
        it('names a file that exists', () => {
            expect(fs.existsSync(path.join(ROOT, mutation.file))).toBe(true);
        });

        // The important one: an anchor that no longer matches makes the mutation
        // a no-op, so it would report "caught" for a defect it never introduced.
        it('anchors to text still present in that file', () => {
            const src = fs.readFileSync(path.join(ROOT, mutation.file), 'utf8');
            expect(src.includes(mutation.anchor)).toBe(true);
        });

        it('anchors to text that appears exactly once', () => {
            // String.replace() swaps only the first occurrence, so an ambiguous
            // anchor would mutate a different line than the author intended.
            const src = fs.readFileSync(path.join(ROOT, mutation.file), 'utf8');
            expect(src.split(mutation.anchor).length - 1).toBe(1);
        });

        it('actually changes something', () => {
            expect(mutation.mutant).not.toBe(mutation.anchor);
        });

        // A mutant that breaks syntax makes jest fail to parse the file, which
        // the runner would score as "caught" — proving nothing about coverage.
        it('produces a file that still parses', () => {
            if (!mutation.file.endsWith('.js')) return;
            const src = fs.readFileSync(path.join(ROOT, mutation.file), 'utf8');
            const mutated = src.replace(mutation.anchor, () => mutation.mutant);
            const res = require('child_process').spawnSync(
                process.execPath, ['--check', '-'], { input: mutated, encoding: 'utf8' });
            expect(res.status).toBe(0);
        });

        // String.replace() interprets $&, $1 etc. in the replacement. A mutant
        // containing them would silently produce something else entirely.
        it('has no accidental String.replace substitution patterns', () => {
            expect(mutation.mutant).not.toMatch(/\$[&`'0-9<]/);
        });

        it('carries a ticket and a description', () => {
            expect(mutation.ticket).toMatch(/^#\d+$/);
            expect(String(mutation.desc).length).toBeGreaterThan(10);
        });

        it('names a test pattern that matches a real test file', () => {
            // Used by --fast; a stale hint would silently run zero tests and
            // report the mutation as surviving. Recursive, so a hint targeting a
            // test in a subdirectory is not a false failure.
            const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
                .flatMap(e => e.isDirectory()
                    ? walk(path.join(dir, e.name))
                    : [path.join(dir, e.name)]);
            const testFiles = walk(path.join(ROOT, 'src', '__tests__'));
            expect(testFiles.some(f => f.includes(mutation.tests))).toBe(true);
        });

        // The runner scores a mutation by whether the suite failed. If the only
        // failing test were the catalog guard itself — which asserts anchors
        // exist, and every mutant removes its anchor — every mutation would be
        // "caught" by construction. The runner excludes it; this pins that the
        // guard is the thing that must be excluded.
        it('is not itself the mutation-catalog guard', () => {
            expect(mutation.file).not.toContain('mutationCatalog');
        });
    });

    // Every fix worth shipping in this train should be represented. A ticket
    // dropping out of the catalog means its protection went unverified.
    it('covers every ticket whose fix the catalog is meant to protect', () => {
        const tickets = new Set(MUTATIONS.map(m => m.ticket));
        for (const required of ['#169', '#171', '#172', '#173', '#174', '#177']) {
            expect(tickets).toContain(required);
        }
    });
});
