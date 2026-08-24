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
    extractDefaultBranchOnlyTriggers,
    extractAllTriggers,
    workflowDriftReasons,
    parseArgs,
    compareVersions,
    versionDriftMessage,
    REF_SCOPED_TRIGGERS
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

describe('extractAllTriggers — every declared trigger', () => {
    it('lists mapping-form triggers and ignores their config keys', () => {
        const yaml = 'on:\n  push:\n    branches: [main]\n    types: [x]\n  workflow_dispatch:\njobs: {}\n';
        expect(extractAllTriggers(yaml).sort()).toEqual(['push', 'workflow_dispatch']);
    });

    it('lists inline sequence triggers', () => {
        expect(extractAllTriggers('on: [push, workflow_dispatch]\n').sort())
            .toEqual(['push', 'workflow_dispatch']);
    });

    it('returns nothing without an on: block', () => {
        expect(extractAllTriggers('name: x\n')).toEqual([]);
    });
});

describe('workflowDriftReasons — including the workflow_dispatch special case', () => {
    it('reports a schedule-triggered workflow', () => {
        const r = workflowDriftReasons('on:\n  schedule:\n    - cron: "0 1 * * *"\n');
        expect(r).toHaveLength(1);
        expect(r[0]).toMatch(/schedule/);
    });

    it('reports a workflow whose ONLY trigger is workflow_dispatch', () => {
        // GitHub only offers "Run workflow" for a workflow on the default
        // branch, so a dispatch-only workflow added here is simply unrunnable.
        const r = workflowDriftReasons('on:\n  workflow_dispatch:\njobs: {}\n');
        expect(r).toHaveLength(1);
        expect(r[0]).toMatch(/workflow_dispatch/);
    });

    it('does NOT report workflow_dispatch when other triggers exist', () => {
        // Five of seven workflows here carry a workflow_dispatch. Reporting all
        // of them would bury the real signal, and they run on this branch fine.
        expect(workflowDriftReasons('on:\n  push:\n    branches: [x]\n  workflow_dispatch:\n')).toEqual([]);
    });

    it('reports nothing for an ordinary push/PR workflow', () => {
        expect(workflowDriftReasons('on:\n  push:\n  pull_request:\n')).toEqual([]);
    });
});

describe('inline comments cannot fake or hide a trigger', () => {
    it('does not read a trigger name out of a comment on the on: line', () => {
        // Regression: this made a push-only workflow look scheduled, which both
        // over-reported AND broke the EXPECTED guard on a correct tree.
        const yaml = 'on:  # replaces the old schedule: job\n  push:\n    branches: [x]\n';
        expect(extractDefaultBranchOnlyTriggers(yaml)).toEqual([]);
    });

    it('does not inject comment words as trigger names', () => {
        // `on:  # manual only` used to yield ['manual','only'], which defeated
        // the dispatch-only detection by making the trigger set look larger.
        const yaml = 'on:  # manual only\n  workflow_dispatch:\n';
        expect(extractAllTriggers(yaml)).toEqual(['workflow_dispatch']);
        expect(workflowDriftReasons(yaml)).toHaveLength(1);
    });

    it('ignores a comment on an indented trigger line', () => {
        const yaml = 'on:\n  push:  # only main\n    branches: [main]\n';
        expect(extractDefaultBranchOnlyTriggers(yaml)).toEqual([]);
    });
});

describe('non-ref-scoped events are default-branch-only by default', () => {
    it.each([
        ['issue_comment'],
        ['repository_dispatch'],
        ['release'],
        ['label'],
        ['discussion']
    ])('reports a %s workflow', (trigger) => {
        // The old deny-list knew only schedule/pull_request_target/workflow_run,
        // so all of these were reported clean while being completely inert.
        const r = workflowDriftReasons(`on:\n  ${trigger}:\n    types: [created]\n`);
        expect(r.join(' ')).toMatch(trigger);
    });

    it('reports an event this code has never heard of', () => {
        // The point of inverting to an allow-list: unknown means unsafe.
        expect(workflowDriftReasons('on:\n  some_future_event:\n')).toHaveLength(1);
    });

    it('stays silent for purely ref-scoped triggers', () => {
        expect(workflowDriftReasons('on:\n  push:\n  pull_request:\n  merge_group:\n')).toEqual([]);
    });

    it('describes pull_request_target by its BASE branch, not the default branch', () => {
        // It resolves from the PR's base ref. Saying "default branch" flatly
        // over-reports for PRs based on development.
        const r = workflowDriftReasons('on:\n  pull_request_target:\n    types: [opened]\n');
        expect(r.join(' ')).toMatch(/BASE branch/);
    });

    it('keeps push and pull_request ref-scoped', () => {
        expect(REF_SCOPED_TRIGGERS).toEqual(expect.arrayContaining(['push', 'pull_request']));
    });
});

describe('the two trigger parsers must agree', () => {
    // They disagreed: extractDefaultBranchOnlyTriggers found `schedule` in the
    // block-sequence form while extractAllTriggers returned [], so
    // workflowDriftReasons trusted the blind one and emitted a false all-clear
    // for an inert scheduled workflow.
    const FORMS = [
        ['mapping', 'on:\n  schedule:\n    - cron: "0 1 * * *"\njobs: {}\n'],
        ['inline sequence', 'on: [schedule, push]\njobs: {}\n'],
        ['block sequence', 'on:\n  - schedule\n  - push\njobs: {}\n']
    ];

    it.each(FORMS)('finds schedule in the %s form via both parsers', (_name, yaml) => {
        expect(extractDefaultBranchOnlyTriggers(yaml)).toContain('schedule');
        expect(extractAllTriggers(yaml)).toContain('schedule');
    });

    it.each(FORMS)('reports drift for the %s form', (_name, yaml) => {
        expect(workflowDriftReasons(yaml)).not.toEqual([]);
    });

    it('reads every trigger in a block sequence, not just the first', () => {
        expect(extractAllTriggers('on:\n  - schedule\n  - push\n').sort())
            .toEqual(['push', 'schedule']);
    });
});

describe('every YAML `on:` shape parses — the class the regexes kept missing', () => {
    // Each of these was a real miss found by a separate review round while this
    // was hand-rolled with regexes. They are kept as a set so a future change to
    // the parsing strategy has to satisfy all of them at once.
    const SHAPES = [
        ['mapping', 'on:\n  schedule:\n    - cron: "0 1 * * *"\n', ['schedule']],
        ['block sequence', 'on:\n  - schedule\n', ['schedule']],
        ['zero-indent sequence', 'on:\n- schedule\n- push\n', ['push', 'schedule']],
        ['inline sequence', 'on: [push, schedule]\n', ['push', 'schedule']],
        ['flow mapping', 'on: {schedule: [{cron: "x"}]}\n', ['schedule']],
        ['scalar', 'on: schedule\n', ['schedule']],
        ['quoted key', "'on':\n  schedule:\n    - cron: x\n", ['schedule']]
    ];

    it.each(SHAPES)('reads the %s form', (_name, yaml, expected) => {
        expect(extractAllTriggers(yaml).sort()).toEqual(expected);
    });

    it.each(SHAPES)('reports drift for the %s form', (_name, yaml) => {
        expect(workflowDriftReasons(yaml)).not.toEqual([]);
    });

    it('does not mistake nested config for a trigger', () => {
        // `on: {push: {branches: [main]}}` once yielded `main` as a trigger.
        expect(extractAllTriggers('on: {push: {branches: [main]}}')).toEqual(['push']);
    });

    it('distinguishes "cannot parse" from "no triggers"', () => {
        // Returning [] for unparseable YAML would clear a workflow nobody can
        // read — the false all-clear this whole tool exists to avoid.
        expect(extractAllTriggers('on:\n  push:\n   bad: [unclosed')).toBeNull();
        expect(workflowDriftReasons('on:\n  push:\n   bad: [unclosed')[0]).toMatch(/could not parse/);
        expect(extractAllTriggers('name: x\njobs: {}\n')).toEqual([]);
    });
});

describe('versionDriftMessage refuses to be silently wrong', () => {
    it('is silent rather than wrong when the local version is unparseable', () => {
        expect(versionDriftMessage('', 'v1.0.0')).toBeNull();
        expect(versionDriftMessage(undefined, 'v1.0.0')).toBeNull();
    });
});

describe('workflow_call is resolved from the caller ref, not the default branch', () => {
    it('does not report a reusable workflow', () => {
        expect(workflowDriftReasons('on:\n  workflow_call:\n    inputs: {}\n')).toEqual([]);
    });

    it('is listed as ref-scoped', () => {
        expect(REF_SCOPED_TRIGGERS).toContain('workflow_call');
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

describe('parseArgs', () => {
    it('defaults to origin/main and prose output', () => {
        expect(parseArgs([])).toMatchObject({ base: 'origin/main', json: false, errors: [] });
    });

    it('reads a base ref and the json flag in any order', () => {
        expect(parseArgs(['--json', '--base', 'upstream/main']))
            .toMatchObject({ base: 'upstream/main', json: true, errors: [] });
    });

    it('rejects --base followed by another flag instead of silently eating it', () => {
        // Regression: this used to set base to "--json" AND drop json mode, so
        // the tool quietly did something other than what was asked — the exact
        // class of quiet wrongness it exists to report.
        const out = parseArgs(['--base', '--json']);
        expect(out.errors).toHaveLength(1);
        expect(out.base).toBe('origin/main');
    });

    it('rejects --base with nothing after it', () => {
        expect(parseArgs(['--base']).errors).toHaveLength(1);
    });

    it('rejects an unknown argument rather than ignoring it', () => {
        expect(parseArgs(['--wat']).errors).toHaveLength(1);
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

    it('every catalogue entry carries a reason and points at where the rule is written', () => {
        for (const entry of CATALOGUE) {
            expect(entry.reason && entry.reason.length).toBeGreaterThan(0);
            // Most entries cite a GitHub doc. `.github/badges/*` cannot: it is
            // default-branch-only because OUR README pins /main/ in the badge
            // URL, and there is no GitHub doc for that. Requiring a docs.github
            // .com link would have forced a wrong URL to satisfy the guard's
            // shape, which is worse than a guard that accepts either.
            expect(Boolean(entry.docs || entry.source)).toBe(true);
            if (entry.docs) expect(entry.docs).toMatch(/^https:\/\/docs\.github\.com\//);
        }
    });

    it('catalogues .github/badges, which the README pins to /main/', () => {
        expect(CATALOGUE.map((c) => c.pattern)).toContain('.github/badges/*');
    });

    it('the badge entry names a real README pin, so the reason is checkable', () => {
        const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
        // If the README ever stops pinning /main/, the entry's justification is
        // gone and it should be re-examined rather than left asserting a
        // constraint that no longer exists.
        expect(readme).toMatch(/raw\.githubusercontent\.com\/[^)\s"]*\/main\/\.github\/badges\//);
    });

    it('catalogues the two surfaces that have already bitten this repo', () => {
        // FUNDING.yml is #199's failure; dependabot.yml is where a1b9dc1's
        // direct-only security rules sit inert. Losing either from the catalogue
        // would silently reopen a known hole.
        const patterns = CATALOGUE.map((c) => c.pattern);
        expect(patterns).toContain('.github/FUNDING.yml');
        expect(patterns).toContain('.github/dependabot.yml');
    });

    it('accounts for every workflow, so a default-branch-only trigger is a deliberate choice', () => {
        // Explicit expectations, NOT a re-implementation of the detector.
        //
        // This started life as an "independent oracle" that re-scanned the
        // directory — and it was wrong: it took the SECOND top-level YAML block
        // as `on:`, which for ci-cd.yml is `permissions:`. It would have gone red
        // on correct code and could never have caught a regression in that file.
        // A guard that reimplements the thing it guards inherits its bugs.
        //
        // Listing the answer means adding a schedule/pull_request_target/
        // workflow_run workflow fails here until someone says so on purpose —
        // the same "a new one is a deliberate choice" shape as the #180/#183
        // script guard. The runtime catalogue is still derived, so the tool
        // itself needs no update.
        // Scanned with workflowDriftReasons — the SAME function the report
        // uses. It previously scanned with the legacy three-name deny-list, so
        // an issue_comment/release/label-only workflow passed silently while
        // CLAUDE.md advertised this as "the invariant that is genuinely
        // enforceable". It was not enforcing it.
        const EXPECTED = {
            'auto-release.yml': ['workflow_run'],
            'codeql-analysis.yml': ['schedule'],
            'dependency-update.yml': ['schedule'],
            'retarget-dependabot.yml': ['schedule']
        };

        const actual = {};
        for (const name of fs.readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n))) {
            const text = fs.readFileSync(path.join(WORKFLOW_DIR, name), 'utf8');
            if (workflowDriftReasons(text).length === 0) continue;
            const all = extractAllTriggers(text) || [];
            actual[name] = all
                .filter((t) => !REF_SCOPED_TRIGGERS.includes(t))
                .sort();
        }

        expect(actual).toEqual(EXPECTED);
    });

    it('no workflow is dispatch-only today, so adding one is a deliberate choice', () => {
        const dispatchOnly = fs.readdirSync(WORKFLOW_DIR)
            .filter((n) => /\.ya?ml$/.test(n))
            .filter((n) => {
                // `|| []` matters: extractAllTriggers returns null for
                // unparseable YAML, and dereferencing .length would throw a
                // TypeError instead of letting the parse failure be reported.
                const t = extractAllTriggers(fs.readFileSync(path.join(WORKFLOW_DIR, n), 'utf8')) || [];
                return t.length === 1 && t[0] === 'workflow_dispatch';
            });
        expect(dispatchOnly).toEqual([]);
    });

    it('does not mistake ci-cd.yml for a default-branch-only workflow', () => {
        // ci-cd.yml declares `permissions:` before `on:` and references
        // github.event.workflow_run in a job body. Both have already fooled a
        // positional or whole-text scan.
        const text = fs.readFileSync(path.join(WORKFLOW_DIR, 'ci-cd.yml'), 'utf8');
        expect(extractDefaultBranchOnlyTriggers(text)).toEqual([]);
    });

    it('a workflow added with a default-branch-only trigger cannot escape the catalogue', () => {
        // The rot scenario, exercised directly: the detector is derivation-based,
        // so the guard is that derivation actually fires for a new file shape.
        const yaml = 'name: new\non:\n  schedule:\n    - cron: "0 2 * * *"\njobs: {}\n';
        expect(extractDefaultBranchOnlyTriggers(yaml)).toContain('schedule');
    });
});

describe('compareVersions — numeric, not lexical', () => {
    it('orders by numeric component, not string', () => {
        // The trap: "1.10.0" < "1.9.0" lexically. Getting this wrong would
        // report a newer branch as behind and send someone to back-merge over
        // their own release.
        expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
        expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    });

    it('treats equal versions as equal, with or without a v prefix', () => {
        expect(compareVersions('1.13.0', 'v1.13.0')).toBe(0);
    });

    it('returns null rather than guessing on unparseable input', () => {
        expect(compareVersions('not-a-version', 'v1.0.0')).toBeNull();
        expect(compareVersions('1.0.0', '')).toBeNull();
    });
});

describe('versionDriftMessage', () => {
    it('reports a branch behind the latest release and names the fix', () => {
        const msg = versionDriftMessage('1.12.0', 'v1.12.1');
        expect(msg).toMatch(/1\.12\.0/);
        expect(msg).toMatch(/v1\.12\.1/);
        expect(msg).toMatch(/git merge origin\/main/);
    });

    it('is silent when level with the latest release', () => {
        expect(versionDriftMessage('1.13.0', 'v1.13.0')).toBeNull();
    });

    it('is silent when ahead — the normal state after a manual minor bump', () => {
        expect(versionDriftMessage('1.13.0', 'v1.12.1')).toBeNull();
    });

    it('is silent rather than wrong when the tag is unparseable', () => {
        expect(versionDriftMessage('1.13.0', 'not-a-tag')).toBeNull();
    });
});

describe('wiring guards — the pure cores are tested, the CALL SITES are not', () => {
    // Mutation testing caught both of these: the fixes below live in the git/fs
    // edge, which no unit test reaches, so reverting either left every test
    // green. docs/TESTING.md calls this out — a pure, unit-tested helper needs
    // a source-reading wiring test or its call site is unguarded.
    const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'defaultBranchDrift.js'), 'utf8');

    it('resolves the latest tag by listing tags, never by `git describe`', () => {
        // `git describe` only sees tags REACHABLE FROM HEAD. auto-release tags a
        // commit that lives only on main, so from development it returns the
        // PREVIOUS tag and the version check goes silent in the one scenario it
        // exists for.
        expect(SRC).toMatch(/git\(\[\s*'tag',\s*'--list',\s*'v\*',\s*'--sort=-v:refname'\s*\]/);
        expect(SRC).not.toMatch(/git\(\[\s*'describe'/);
    });

    it('scans the BASE side with the same allow-list logic as the head side', () => {
        // Reverting this to extractDefaultBranchOnlyTriggers means deleting an
        // issue_comment or release workflow here leaves main's copy firing,
        // unreported — the exact case collectWorkflowReasons exists for.
        const fn = SRC.slice(SRC.indexOf('function collectWorkflowReasons'));
        const body = fn.slice(0, fn.indexOf('\nfunction '));
        expect(body).toMatch(/workflowDriftReasons\(baseText\)/);
        expect(body).not.toMatch(/extractDefaultBranchOnlyTriggers\(baseText\)/);
    });

    it('parses workflow YAML with a real parser, not regexes', () => {
        // The regression that matters most: four review rounds each found
        // another `on:` shape a regex parser got wrong, every miss a false
        // all-clear. Going back to hand-rolled parsing reopens the whole class.
        expect(SRC).toMatch(/require\('js-yaml'\)/);
        expect(SRC).toMatch(/yaml\.load\(text\)/);
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
        // The script exits via `process.exitCode = main(...)`, so grepping only
        // for a literal process.exit(1) proved nothing: a `return 1` added to
        // main() would make it blocking with this guard still green.
        expect(src).not.toMatch(/process\.exit\(\s*[1-9]/);
        // Scoped to main()'s returns, not the whole file: the old whole-file ban
        // on any `return <positive int>;` would fail an ordinary refactor of
        // compareVersions to `if (a > b) return 1;` with a misleading
        // "script is blocking" message.
        const mainFn = src.slice(src.indexOf('function main(argv)'));
        const mainBody = mainFn.slice(0, mainFn.indexOf('\nfunction '));
        expect(mainBody).not.toMatch(/\breturn\s+[1-9]\d*\s*;/);
        expect(src).toMatch(/ALWAYS EXITS 0/);
    });
});
