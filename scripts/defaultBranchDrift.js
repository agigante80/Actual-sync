#!/usr/bin/env node
/**
 * defaultBranchDrift.js
 *
 * Reports configuration that is written on this branch but NOT YET IN EFFECT,
 * because GitHub reads it only from the DEFAULT branch (#204).
 *
 * The branch model here is "work lands on development; main is merged into only
 * when asked". For ordinary source that is fine. For the surfaces below it is a
 * silent no-op: the change is committed, reviewed and green, and does nothing at
 * all until it reaches main. #199 is the worked example — `buy_me_a_coffee` was
 * removed from FUNDING.yml on development, and the Sponsor button kept serving
 * the old file from main. The ticket even warned about the trap; that was not
 * enough, so this reports it instead.
 *
 * Usage:
 *   node scripts/defaultBranchDrift.js [--base <ref>] [--json]
 *
 * npm script:
 *   npm run drift:check
 *
 * ALWAYS EXITS 0. Drift between development and main is the normal steady state
 * of this branch model, not an error — a blocking check would fail on every
 * healthy tree and be trained away within a week. The signal is the report.
 * The genuinely invariant half (the catalogue cannot silently omit a workflow)
 * is enforced by the hermetic guard in src/__tests__/defaultBranchDrift.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_BASE = 'origin/main';

/**
 * Workflow triggers that GitHub resolves against the default branch. A workflow
 * fired by any of these runs the copy of the file on the default branch, so
 * editing it anywhere else has no effect on the next run.
 */
const DEFAULT_BRANCH_ONLY_TRIGGERS = ['schedule', 'pull_request_target', 'workflow_run'];

/**
 * Non-workflow surfaces GitHub reads only from the default branch.
 *
 * Hand-maintained on purpose: these are platform behaviours, not facts derivable
 * from the tree, so a new one needs a human to notice it. The workflow entries
 * ARE derivable, and the guard keeps those honest automatically.
 *
 * `pattern` is an exact repo-relative path, or a prefix ending in `/*`.
 */
const CATALOGUE = [
    {
        pattern: '.github/FUNDING.yml',
        reason: 'the Sponsor button is read from the default branch',
        docs: 'https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository'
    },
    {
        pattern: '.github/dependabot.yml',
        reason: '"You must store this file in the .github directory of your repository in the default branch"',
        docs: 'https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file'
    },
    {
        pattern: '.github/ISSUE_TEMPLATE/*',
        reason: 'issue templates are served from the default branch',
        docs: 'https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository'
    }
];

/** True when `relPath` is matched by a catalogue `pattern`. */
function matchesPattern(relPath, pattern) {
    if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -1); // keep the trailing slash
        return relPath.startsWith(prefix) && relPath.length > prefix.length;
    }
    return relPath === pattern;
}

/**
 * Pure. Given the changed paths and a catalogue, return one entry per changed
 * path that GitHub would read only from the default branch.
 *
 * Kept free of git and fs so the guard can exercise it hermetically — a test
 * that shells out to git can go red with no commit, which is exactly the
 * misplacement docs/TESTING.md warns about.
 */
function classifyDrift(changedPaths, catalogue) {
    const out = [];
    for (const relPath of changedPaths) {
        const entry = catalogue.find((c) => matchesPattern(relPath, c.pattern));
        if (entry) {
            out.push({ path: relPath, reason: entry.reason, docs: entry.docs });
        }
    }
    return out;
}

/**
 * Pure. Returns the workflow file names (not paths) that declare a
 * default-branch-only trigger, given [{ name, triggers }].
 */
function defaultBranchOnlyWorkflows(workflows) {
    return workflows
        .filter((w) => w.triggers.some((t) => DEFAULT_BRANCH_ONLY_TRIGGERS.includes(t)))
        .map((w) => w.name);
}

/** Thin git edge. Isolated so the pure core above stays testable. */
function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function main(argv) {
    const root = path.resolve(__dirname, '..');
    const baseIdx = argv.indexOf('--base');
    const base = baseIdx !== -1 && argv[baseIdx + 1] ? argv[baseIdx + 1] : DEFAULT_BASE;
    const asJson = argv.includes('--json');

    let changed;
    try {
        // Two-dot: what differs between the effective (default-branch) copy and
        // this branch right now. Three-dot would hide changes made on main since
        // the merge base, and it is precisely "what main is serving" we want.
        changed = git(['diff', '--name-only', base, 'HEAD'], root).split('\n').filter(Boolean);
    } catch (err) {
        // A missing ref is the common case on a fresh clone or a stale fetch.
        // Say so plainly rather than reporting a clean tree, which would be a
        // false all-clear — the same silent-no-op failure this script exists for.
        const message = `Could not diff against ${base}: ${err.message.trim()}. `
            + 'Run `git fetch origin` and retry. NOT reporting "no drift" — this run proved nothing.';
        if (asJson) {
            console.log(JSON.stringify({ base, error: message, drifted: [] }, null, 2));
        } else {
            console.error(`\n  ${message}\n`);
        }
        return 0;
    }

    // Workflow entries are derived, not hand-listed, so a new scheduled workflow
    // is covered the moment it exists.
    const workflowEntries = readWorkflowCatalogue(root);
    const catalogue = CATALOGUE.concat(workflowEntries);
    const drifted = classifyDrift(changed, catalogue);

    if (asJson) {
        console.log(JSON.stringify({ base, drifted }, null, 2));
        return 0;
    }

    if (drifted.length === 0) {
        console.log(`\n  No default-branch-only config differs from ${base}.\n`);
        return 0;
    }

    console.log(`\n  ${drifted.length} file(s) written here but NOT IN EFFECT until merged to ${base}:\n`);
    for (const d of drifted) {
        let age = '';
        try {
            const when = git(['log', '-1', '--format=%cs', '--', d.path], root);
            if (when) age = `  (last changed here ${when})`;
        } catch {
            // Age is a nicety; never let it break the report.
        }
        console.log(`  - ${d.path}${age}`);
        console.log(`      ${d.reason}`);
    }
    console.log('\n  These take effect only when development is merged to main.\n');
    return 0;
}

/**
 * Pure. Returns the default-branch-only trigger names declared by one workflow's
 * YAML text.
 *
 * Deliberately not a YAML parse: js-yaml reaches this repo only as a transitive
 * of jest, and the Dependency Policy forbids require()ing transitive-only
 * packages. So this isolates the `on:` block and scans it, which is enough
 * because it only ever answers "which of three known keys appear as triggers".
 *
 * Isolating the block matters — `workflow_run` also appears as a `github.event`
 * field deeper in a file, and a whole-text scan would report a workflow that
 * merely mentions it. Both block styles GitHub accepts are handled: the mapping
 * form (`on:` then indented keys) and the inline/sequence forms (`on: [push]`).
 */
function extractDefaultBranchOnlyTriggers(text) {
    const lines = text.split('\n');
    // `on` is the YAML 1.1 boolean `true`, so it is often quoted. Accept all forms.
    const startIdx = lines.findIndex((l) => /^(on|'on'|"on")\s*:/.test(l));
    if (startIdx === -1) return [];

    const header = lines[startIdx];
    const inline = header.slice(header.indexOf(':') + 1).trim();
    const block = [];
    if (inline) block.push(inline); // `on: [push, schedule]` / `on: push`

    // Indented continuation lines belong to the `on:` mapping; the first line at
    // column 0 that is not blank or a comment ends it.
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
        if (!/^\s/.test(line)) break;
        block.push(line);
    }

    const blockText = block.join('\n');
    return DEFAULT_BRANCH_ONLY_TRIGGERS.filter((t) =>
        new RegExp(`(^|[\\s,[])${t}\\s*(:|,|\\]|$)`, 'm').test(blockText)
    );
}

/** Builds catalogue entries for every workflow declaring a default-branch-only trigger. */
function readWorkflowCatalogue(root) {
    const dir = path.join(root, '.github', 'workflows');
    if (!fs.existsSync(dir)) return [];
    const entries = [];
    for (const name of fs.readdirSync(dir).sort()) {
        if (!/\.ya?ml$/.test(name)) continue;
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        const triggers = extractDefaultBranchOnlyTriggers(text);
        if (triggers.length > 0) {
            entries.push({
                pattern: `.github/workflows/${name}`,
                reason: `${triggers.join(', ')} runs the default-branch copy of the workflow`,
                docs: 'https://docs.github.com/actions/using-workflows/events-that-trigger-workflows'
            });
        }
    }
    return entries;
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}

module.exports = {
    CATALOGUE,
    DEFAULT_BRANCH_ONLY_TRIGGERS,
    classifyDrift,
    matchesPattern,
    defaultBranchOnlyWorkflows,
    extractDefaultBranchOnlyTriggers,
    readWorkflowCatalogue
};
