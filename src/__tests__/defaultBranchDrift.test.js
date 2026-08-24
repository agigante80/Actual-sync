/**
 * Default-branch-only config guards (#204).
 *
 * GitHub reads several config surfaces ONLY from the default branch. This repo
 * works on `development` and merges to `main` only when asked, so a change to
 * one of those surfaces is committed, green, and completely inert until the
 * merge. #199 is the worked example: `buy_me_a_coffee` was dropped from
 * FUNDING.yml on development and the Sponsor button kept serving main's copy.
 *
 * These guards are HERMETIC — they read only tracked files in this repo. The
 * drift REPORT (`npm run drift:check`) compares against `origin/main` and is
 * therefore fetch-dependent, so it stays report-only and is deliberately not
 * asserted here: a blocking test whose result can change with no commit is
 * misplaced, whichever way it points.
 */
const fs = require('fs');
const path = require('path');

const {
    CATALOGUE,
    DEFAULT_BRANCH_ONLY_TRIGGERS,
    classifyDrift,
    matchesPattern,
    defaultBranchOnlyWorkflows,
    extractDefaultBranchOnlyTriggers,
    readWorkflowCatalogue
} = require('../../scripts/defaultBranchDrift.js');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

describe('extractDefaultBranchOnlyTriggers — pure trigger parsing', () => {
    it('finds a trigger in the mapping form', () => {
        const yaml = 'name: x\non:\n  schedule:\n    - cron: "0 1 * * *"\n\njobs: {}\n';
        expect(extractDefaultBranchOnlyTriggers(yaml)).toEqual(['schedule']);
    });

    it('finds a trigger when `on` is quoted', () => {
        const yaml = "name: x\n'on':\n  pull_request_target:\n    types: [opened]\n";
        expect(extractDefaultBranchOnlyTriggers(yaml)).toEqual(['pull_request_target']);
    });

    it('finds triggers in the inline sequence form', () => {
        const yaml = 'name: x\non: [push, schedule]\njobs: {}\n';
        expect(extractDefaultBranchOnlyTriggers(yaml)).toEqual(['schedule']);
    });

    it('finds several triggers at once', () => {
        const yaml = 'on:\n  push:\n  schedule:\n    - cron: "0 1 * * *"\n  workflow_run:\n    workflows: [CI]\n';
        expect(extractDefaultBranchOnlyTriggers(yaml).sort()).toEqual(['schedule', 'workflow_run']);
    });

    it('returns nothing for a workflow with only ordinary triggers', () => {
        const yaml = 'name: x\non:\n  push:\n    branches: [main]\n  pull_request:\n';
        expect(extractDefaultBranchOnlyTriggers(yaml)).toEqual([]);
    });

    it('does NOT match a trigger name that only appears in the job body', () => {
        // The regression this isolation exists for: `workflow_run` is also a
        // github.event field. A whole-text scan would call this workflow
        // default-branch-only and quietly widen the catalogue.
        const yaml = [
            'on:',
            '  pull_request:',
            'jobs:',
            '  a:',
            '    if: github.event.workflow_run.conclusion == "success"',
            '    steps:',
            '      - run: echo schedule:',
            ''
        ].join('\n');
        expect(extractDefaultBranchOnlyTriggers(yaml)).toEqual([]);
    });

    it('ignores comments and blank lines inside the on: block', () => {
        const yaml = 'on:\n\n  # nightly\n  schedule:\n    - cron: "0 1 * * *"\n';
        expect(extractDefaultBranchOnlyTriggers(yaml)).toEqual(['schedule']);
    });

    it('returns nothing when there is no on: block at all', () => {
        expect(extractDefaultBranchOnlyTriggers('name: x\njobs: {}\n')).toEqual([]);
    });
});

describe('matchesPattern — exact and prefix entries', () => {
    it('matches an exact path', () => {
        expect(matchesPattern('.github/FUNDING.yml', '.github/FUNDING.yml')).toBe(true);
        expect(matchesPattern('.github/FUNDING.yaml', '.github/FUNDING.yml')).toBe(false);
    });

    it('matches a file inside a `/*` prefix entry', () => {
        expect(matchesPattern('.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/*')).toBe(true);
    });

    it('does not let a `/*` entry match the bare directory', () => {
        expect(matchesPattern('.github/ISSUE_TEMPLATE/', '.github/ISSUE_TEMPLATE/*')).toBe(false);
    });

    it('does not let a `/*` entry match a sibling with the same prefix', () => {
        expect(matchesPattern('.github/ISSUE_TEMPLATE_OLD/bug.yml', '.github/ISSUE_TEMPLATE/*')).toBe(false);
    });
});

describe('classifyDrift — which changed paths are inert until merged', () => {
    const catalogue = [{ pattern: '.github/FUNDING.yml', reason: 'sponsor button', docs: 'u' }];

    it('reports a catalogued path that changed', () => {
        const out = classifyDrift(['src/index.js', '.github/FUNDING.yml'], catalogue);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ path: '.github/FUNDING.yml', reason: 'sponsor button' });
    });

    it('ignores ordinary source changes', () => {
        expect(classifyDrift(['src/lib/logger.js', 'README.md'], catalogue)).toEqual([]);
    });

    it('returns nothing for an empty changeset', () => {
        expect(classifyDrift([], catalogue)).toEqual([]);
    });
});

describe('defaultBranchOnlyWorkflows', () => {
    it('selects only workflows carrying a default-branch-only trigger', () => {
        const workflows = [
            { name: 'ci.yml', triggers: ['push', 'pull_request'] },
            { name: 'nightly.yml', triggers: ['schedule'] }
        ];
        expect(defaultBranchOnlyWorkflows(workflows)).toEqual(['nightly.yml']);
    });
});

describe('catalogue integrity guards (hermetic — tracked files only)', () => {
    it('every hand-maintained catalogue path exists in the tree', () => {
        for (const entry of CATALOGUE) {
            const target = entry.pattern.endsWith('/*')
                ? entry.pattern.slice(0, -2)
                : entry.pattern;
            expect({ path: target, exists: fs.existsSync(path.join(ROOT, target)) })
                .toEqual({ path: target, exists: true });
        }
    });

    it('every catalogue entry carries a reason and a docs link', () => {
        for (const entry of CATALOGUE) {
            expect(entry.reason && entry.reason.length).toBeGreaterThan(0);
            expect(entry.docs).toMatch(/^https:\/\/docs\.github\.com\//);
        }
    });

    it('catalogues the two surfaces that have already bitten this repo', () => {
        // FUNDING.yml is #199's failure; dependabot.yml is where a1b9dc1's
        // direct-only security rules sit inert. Losing either from the catalogue
        // would silently reopen a known hole.
        const patterns = CATALOGUE.map((c) => c.pattern);
        expect(patterns).toContain('.github/FUNDING.yml');
        expect(patterns).toContain('.github/dependabot.yml');
    });

    it('detects every workflow that declares a default-branch-only trigger', () => {
        // Independent oracle: re-scan the directory here rather than trusting the
        // module's own result, so a detector that silently stopped matching fails.
        const expected = fs
            .readdirSync(WORKFLOW_DIR)
            .filter((n) => /\.ya?ml$/.test(n))
            .filter((n) => {
                const text = fs.readFileSync(path.join(WORKFLOW_DIR, n), 'utf8');
                const onBlock = text.split(/\n(?=[A-Za-z"'])/)[1] || text;
                return DEFAULT_BRANCH_ONLY_TRIGGERS.some((t) =>
                    new RegExp(`^\\s+${t}\\s*:`, 'm').test(onBlock)
                );
            })
            .sort();

        const detected = readWorkflowCatalogue(ROOT)
            .map((e) => path.basename(e.pattern))
            .sort();

        expect(detected).toEqual(expected);
    });

    it('a workflow added with a default-branch-only trigger cannot escape the catalogue', () => {
        // The rot scenario, exercised directly: the detector is derivation-based,
        // so the guard is that derivation actually fires for a new file shape.
        const yaml = 'name: new\non:\n  schedule:\n    - cron: "0 2 * * *"\njobs: {}\n';
        expect(extractDefaultBranchOnlyTriggers(yaml)).toContain('schedule');
    });
});

describe('npm wiring', () => {
    it('exposes the report as `npm run drift:check`', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        expect(pkg.scripts['drift:check']).toBe('node scripts/defaultBranchDrift.js');
    });

    it('is report-only — the script never advertises a non-zero exit', () => {
        // Drift is the normal steady state of this branch model. If this ever
        // becomes blocking it will fail on every healthy tree and be disabled.
        const src = fs.readFileSync(path.join(ROOT, 'scripts', 'defaultBranchDrift.js'), 'utf8');
        expect(src).not.toMatch(/process\.exit\(\s*1\s*\)/);
        expect(src).toMatch(/ALWAYS EXITS 0/);
    });
});
