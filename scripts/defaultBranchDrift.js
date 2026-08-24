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
 * Every failure path here degrades to an honest message and exit 0; it must
 * never report "no drift" for a run that did not actually establish that.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_BASE = 'origin/main';
const WORKFLOW_PREFIX = '.github/workflows/';

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
 * from the tree, so a new one needs a human to notice it. Workflow paths are NOT
 * listed here — they are resolved per-run from their triggers, on both sides of
 * the diff (see collectWorkflowReasons).
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

const WORKFLOW_DOCS = 'https://docs.github.com/actions/using-workflows/events-that-trigger-workflows';

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
 * The `on:` key is located by name, never by position — ci-cd.yml puts a
 * top-level `permissions:` block first, so "the second block" is not `on:`.
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

/** Pure. Every trigger name declared in a workflow's `on:` block. */
function extractAllTriggers(text) {
    const lines = text.split('\n');
    const startIdx = lines.findIndex((l) => /^(on|'on'|"on")\s*:/.test(l));
    if (startIdx === -1) return [];

    const header = lines[startIdx];
    const inline = header.slice(header.indexOf(':') + 1).trim();
    const found = new Set();

    if (inline) {
        for (const t of inline.replace(/[[\]]/g, ' ').split(/[\s,]+/)) {
            if (/^[a-z_]+$/.test(t)) found.add(t);
        }
    }

    // Only keys at the block's own indent level are triggers; anything deeper is
    // a trigger's config (`branches:`, `types:`, `cron:`).
    let indent = null;
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
        if (!/^\s/.test(line)) break;
        const m = line.match(/^(\s+)([a-z_]+)\s*:/);
        if (!m) continue;
        if (indent === null) indent = m[1].length;
        if (m[1].length === indent) found.add(m[2]);
    }

    return [...found];
}

/**
 * Pure. Why a workflow is default-branch-only, or [] if it is not.
 *
 * `workflow_dispatch` is a special case worth the extra rule. GitHub only offers
 * the "Run workflow" button for a workflow present on the default branch, so a
 * dispatch-ONLY workflow added on development is simply unrunnable. It is not
 * treated as default-branch-only when other triggers exist, because then the
 * workflow still runs here and reporting every `workflow_dispatch:` in the repo
 * — five of seven carry one — would bury the real signal.
 */
function workflowDriftReasons(text) {
    const specific = extractDefaultBranchOnlyTriggers(text);
    if (specific.length) return [`${specific.join(', ')} runs the default-branch copy`];

    const all = extractAllTriggers(text);
    if (all.length === 1 && all[0] === 'workflow_dispatch') {
        return ['workflow_dispatch is only offered for workflows on the default branch'];
    }
    return [];
}

/**
 * Pure. Argument parsing, split out so its edge cases are testable.
 *
 * `--base` must be followed by a ref, not another flag: `--base --json` used to
 * set the ref to "--json" and silently drop JSON mode, which is the class of
 * quiet wrongness this whole script exists to complain about.
 */
function parseArgs(argv) {
    const out = { base: DEFAULT_BASE, json: false, errors: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json') {
            out.json = true;
        } else if (arg === '--base') {
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                out.errors.push('--base requires a git ref, e.g. --base origin/main');
            } else {
                out.base = next;
                i++;
            }
        } else {
            out.errors.push(`unrecognised argument: ${arg}`);
        }
    }
    return out;
}

/** Thin git edge. Isolated so the pure core above stays testable. */
function git(args, cwd) {
    // stderr is captured rather than inherited: git writes its own "unknown
    // revision" text to the terminal AND execFileSync copies it into err.message,
    // so inheriting prints the same failure twice around our explanation of it.
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

/** Keeps git's actual reason and drops its multi-line usage hint. */
function gitReason(err) {
    return (err.stderr || err.message || '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('fatal:') || l.startsWith('error:'))
        || 'git command failed';
}

/**
 * Reasons a changed workflow path is default-branch-only, considering BOTH sides
 * of the diff.
 *
 * The base side is not optional. Deleting a scheduled workflow here, or removing
 * just its `schedule:` key, leaves nothing in the working tree to detect — while
 * main's copy keeps firing on its old schedule. Looking only at the current tree
 * would print "no drift" for exactly that case, which is the false all-clear the
 * error paths above are careful never to produce.
 */
function collectWorkflowReasons(relPath, base, root) {
    const sides = [];

    let headText = null;
    try {
        headText = fs.readFileSync(path.join(root, relPath), 'utf8');
    } catch {
        headText = null; // deleted on this branch
    }
    if (headText !== null) {
        sides.push(...workflowDriftReasons(headText));
    }

    let baseText = null;
    try {
        baseText = git(['show', `${base}:${relPath}`], root);
    } catch {
        baseText = null; // not on the base branch yet
    }
    if (baseText !== null) {
        const triggers = extractDefaultBranchOnlyTriggers(baseText);
        if (triggers.length) {
            const note = headText === null
                ? `deleted here, but ${base} still fires it on ${triggers.join(', ')}`
                : `${base}'s copy fires on ${triggers.join(', ')}`;
            sides.push(note);
        }
    }
    if (headText === null && baseText === null) {
        // Neither side readable: say nothing rather than guess.
        return [];
    }

    return sides;
}

function report(drifted, base, asJson, root) {
    if (asJson) {
        // `ok` is not decoration: without it a consumer checking
        // `drifted.length === 0` reads a FAILED run as a clean one, which is the
        // machine-readable version of the false all-clear this tool exists for.
        console.log(JSON.stringify({ ok: true, base, drifted }, null, 2));
        return;
    }
    if (drifted.length === 0) {
        console.log(`\n  No default-branch-only config differs from ${base}.\n`);
        return;
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
    console.log(`\n  These take effect only when this branch is merged to ${base}.\n`);
}

/** Prints an honest failure and returns 0. Never claims "no drift". */
function bail(message, base, asJson) {
    if (asJson) {
        console.log(JSON.stringify({ ok: false, base, error: message, drifted: null }, null, 2));
    } else {
        console.error(`\n  ${message}\n`);
    }
    return 0;
}

function main(argv) {
    const root = path.resolve(__dirname, '..');
    const { base, json: asJson, errors } = parseArgs(argv);

    if (errors.length) {
        return bail(`${errors.join('; ')}. NOT reporting "no drift" — this run proved nothing.`, base, asJson);
    }

    let changed;
    try {
        // Compare against the MERGE BASE, not the base tip, and include the
        // working tree and untracked files:
        //
        //  - merge base, because a two-dot diff against the tip also surfaces
        //    changes made only on main (a web-UI issue-template edit always
        //    commits to the default branch) as "written here but not in
        //    effect" — backwards, and the implied action would revert main.
        //  - working tree, because an uncommitted edit is still not in effect.
        //  - untracked, because a BRAND-NEW FUNDING.yml or scheduled workflow is
        //    the most inert case of all, and `git diff` never lists it.
        const mergeBase = git(['merge-base', base, 'HEAD'], root);
        const tracked = git(['diff', '--name-only', mergeBase], root).split('\n');
        const untracked = git(['ls-files', '--others', '--exclude-standard'], root).split('\n');
        changed = [...new Set([...tracked, ...untracked])].filter(Boolean);
    } catch (err) {
        return bail(
            `Could not diff against ${base} — ${gitReason(err)} `
            + 'Run `git fetch origin` and retry. NOT reporting "no drift" — this run proved nothing.',
            base, asJson
        );
    }

    const drifted = [];
    for (const relPath of changed) {
        if (relPath.startsWith(WORKFLOW_PREFIX)) {
            const reasons = collectWorkflowReasons(relPath, base, root);
            if (reasons.length) {
                drifted.push({ path: relPath, reason: reasons.join('; '), docs: WORKFLOW_DOCS });
            }
            continue;
        }
        drifted.push(...classifyDrift([relPath], CATALOGUE));
    }

    report(drifted, base, asJson, root);
    return 0;
}

if (require.main === module) {
    // Any unexpected throw (an unreadable workflow, a git binary that is not
    // there) must still leave a report-only tool at exit 0.
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        process.exitCode = bail(
            `drift:check failed unexpectedly: ${err && err.message}. `
            + 'NOT reporting "no drift" — this run proved nothing.',
            DEFAULT_BASE,
            process.argv.includes('--json')
        );
    }
}

module.exports = {
    CATALOGUE,
    DEFAULT_BRANCH_ONLY_TRIGGERS,
    classifyDrift,
    matchesPattern,
    extractDefaultBranchOnlyTriggers,
    extractAllTriggers,
    workflowDriftReasons,
    parseArgs,
    collectWorkflowReasons
};
