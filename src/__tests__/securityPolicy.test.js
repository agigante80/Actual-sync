/**
 * Security policy guards (#254).
 *
 * GitHub only shows a policy and the "Report a vulnerability" button when
 * SECURITY.md sits at the root, .github/ or docs/. Placeholders rot silently,
 * so fail the suite if the policy goes missing, is hollowed out, or an
 * unfilled "configure this" marker comes back anywhere in the docs.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function markdownFiles() {
    const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md'));
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .flatMap((e) => (e.isDirectory()
            ? walk(path.join(dir, e.name))
            : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []));
    return [...files, ...walk('docs')];
}

describe('security policy (#254)', () => {
    it('has a non-trivial SECURITY.md at the repository root', () => {
        const policy = read('SECURITY.md');
        expect(policy.length).toBeGreaterThan(1000);
        expect(policy).toMatch(/security\/advisories\/new/);
        expect(policy).toMatch(/Supported versions/i);
        expect(policy).toMatch(/AI-generated/i);
    });

    it('is linked from the README', () => {
        expect(read('README.md')).toMatch(/\]\(SECURITY\.md\)/);
    });

    it('is linked from the security issue template', () => {
        expect(read('.github/ISSUE_TEMPLATE/security.yml')).toMatch(/SECURITY\.md/);
    });

    it('leaves no unfilled contact placeholder in any markdown file', () => {
        const hits = markdownFiles().filter((rel) =>
            /\[Configure|configure in your project/i.test(read(rel)));
        expect(hits).toEqual([]);
    });
});
