/**
 * No workflow may run a third-party action from a floating branch (#248).
 *
 * `uses: owner/action@master` runs whatever that branch holds when the job
 * starts, with no review on our side, inside jobs that hold registry
 * credentials and security-events: write. Tags are still mutable but need an
 * explicit move; the full SHA pin is the target for anything security-relevant.
 */
const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '..', '.github', 'workflows');
const workflows = fs.readdirSync(WORKFLOW_DIR).filter(f => /\.ya?ml$/.test(f));

function usesLines(file) {
    return fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => /^-?\s*uses:\s*/.test(line));
}

describe('workflow action pins (#248)', () => {
    it('finds workflows to check', () => {
        expect(workflows.length).toBeGreaterThan(0);
    });

    it.each(workflows)('%s references no action by a floating branch', (file) => {
        const floating = usesLines(file)
            .filter(({ line }) => /@(master|main|develop|development|HEAD)(\s|$)/.test(line))
            .map(({ line, n }) => `${file}:${n} ${line}`);
        expect(floating).toEqual([]);
    });

    it('pins trivy-action to a full commit SHA', () => {
        const trivy = workflows.flatMap(file => usesLines(file)
            .filter(({ line }) => line.includes('aquasecurity/trivy-action@')));
        expect(trivy.length).toBeGreaterThan(0);
        for (const { line } of trivy) {
            expect(line).toMatch(/aquasecurity\/trivy-action@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+/);
        }
    });
});
