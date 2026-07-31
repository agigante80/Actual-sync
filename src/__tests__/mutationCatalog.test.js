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

        it('carries a ticket and a description', () => {
            expect(mutation.ticket).toMatch(/^#\d+$/);
            expect(String(mutation.desc).length).toBeGreaterThan(10);
        });

        it('names a test pattern that matches a real test file', () => {
            // Used by --fast; a stale hint would silently run zero tests and
            // report the mutation as surviving.
            const testFiles = fs.readdirSync(path.join(ROOT, 'src', '__tests__'));
            expect(testFiles.some(f => f.includes(mutation.tests))).toBe(true);
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
