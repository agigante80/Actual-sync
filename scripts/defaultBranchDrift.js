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
const yaml = require('js-yaml');

const DEFAULT_BASE = 'origin/main';
const WORKFLOW_PREFIX = '.github/workflows/';

// A path under .github/workflows/ is only a WORKFLOW if GitHub would parse it as
// one. Without this the runtime scan YAML-parsed every changed path there, so a
// README or helper script placed alongside the workflows was reported as "could
// not parse this workflow's `on:` block" (#213). Harmless, but it devalues a
// message that is supposed to mean something. The hermetic guard in
// defaultBranchDrift.test.js already filters this way; this is the runtime path
// catching up.
const isWorkflowFile = (relPath) =>
    relPath.startsWith(WORKFLOW_PREFIX) && /\.ya?ml$/.test(relPath);

/**
 * Triggers that resolve the workflow file from a REF rather than from the
 * default branch.
 *
 * Deliberately an allow-list, because the previous deny-list
 * (schedule/pull_request_target/workflow_run) silently under-reported: GitHub
 * resolves essentially every other event from the default branch, so an
 * `issue_comment`, `release`, `label` or `repository_dispatch` workflow added on
 * `development` is fully inert and was reported clean. Inverting means a GitHub
 * event nobody here has heard of is treated as default-branch-only by default,
 * which is the safe direction for a tool whose whole job is not emitting false
 * all-clears.
 *
 * `workflow_dispatch` is ref-scoped (you pick the branch), but GitHub only
 * OFFERS it for workflows on the default branch — handled as a special case in
 * workflowDriftReasons rather than listed here.
 */
const REF_SCOPED_TRIGGERS = ['push', 'pull_request', 'merge_group', 'workflow_dispatch', 'workflow_call'];

/**
 * `pull_request_target` resolves from the pull request's BASE branch, not
 * unconditionally from the default branch. It is still called out, because the
 * case that matters here is a PR based on `main` — but the reason says base
 * branch so nobody mistakes it for a blanket rule.
 */
const BASE_REF_TRIGGERS = ['pull_request_target'];

/** Kept for the guard and for reporting: the historically-known offenders. */
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
    },
    {
        pattern: '.github/badges/*',
        // Not a GitHub platform rule, unlike the entries above — this one is
        // self-inflicted and there is no GitHub doc to cite. The README points
        // Shields at raw.githubusercontent.com/.../main/.github/badges/*.json,
        // so a regenerated badge is inert until merge purely because the URL
        // pins `main`. Say so, or the next reader hunts for a doc that does not
        // exist.
        reason: 'README pins these badge URLs to /main/, so regenerated badges are stale until merge',
        source: 'README.md'
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
            out.push({
                path: relPath,
                reason: entry.reason,
                docs: entry.docs,
                source: entry.source
            });
        }
    }
    return out;
}

/**
 * Pure. Every trigger name a workflow declares, or null when the YAML will not
 * parse.
 *
 * Uses a real YAML parser. This was hand-rolled with regexes at first, reasoning
 * that js-yaml reached this repo only as a transitive of jest and the Dependency
 * Policy forbids requiring transitive-only packages. The fact was right and the
 * conclusion was wrong: the answer was to DECLARE js-yaml, not to write a parser.
 *
 * Four consecutive reviews each found another `on:` shape the regexes got wrong
 * — inline comments, block sequences, flow mappings, zero-indent sequences — and
 * every miss was a false all-clear for an inert workflow. Parsing YAML with
 * regexes is a defect generator; this ends the class instead of patching the
 * next instance.
 *
 * `on` is the YAML 1.1 boolean true, so a bare `on:` key parses as `true`. Both
 * spellings are accepted.
 *
 * Returns null rather than [] on a parse failure: "no triggers" and "could not
 * read it" must not look the same to the caller.
 */
function extractAllTriggers(text) {
    let doc;
    try {
        doc = yaml.load(text);
    } catch {
        return null;
    }
    if (!doc || typeof doc !== 'object') return [];

    const on = doc.on !== undefined ? doc.on : doc[true];
    if (on === undefined || on === null) return [];
    if (typeof on === 'string') return [on];
    if (Array.isArray(on)) return on.filter((t) => typeof t === 'string');
    if (typeof on === 'object') return Object.keys(on);
    return [];
}

/**
 * Pure. The default-branch-only triggers a workflow declares.
 *
 * Named export because the mutation catalog and the guards both reference it.
 */
function extractDefaultBranchOnlyTriggers(text) {
    const all = extractAllTriggers(text);
    if (all === null) return [];
    return DEFAULT_BRANCH_ONLY_TRIGGERS.filter((t) => all.includes(t));
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
    const all = extractAllTriggers(text);
    // null means the YAML would not parse. An unreadable workflow is not a
    // workflow known to be fine, so say so rather than returning [].
    if (all === null) return ['could not parse this workflow\'s `on:` block — check it by hand'];
    if (all.length === 0) return [];

    const reasons = [];

    // Anything not ref-scoped resolves from the default branch. Allow-list, so a
    // GitHub event this code has never heard of lands on the safe side.
    const defaultBranchOnly = all.filter(
        (t) => !REF_SCOPED_TRIGGERS.includes(t) && !BASE_REF_TRIGGERS.includes(t)
    );
    if (defaultBranchOnly.length) {
        reasons.push(`${defaultBranchOnly.sort().join(', ')} runs the default-branch copy`);
    }

    const baseRef = all.filter((t) => BASE_REF_TRIGGERS.includes(t));
    if (baseRef.length) {
        reasons.push(
            `${baseRef.join(', ')} runs the copy on the pull request's BASE branch `
            + '(the default-branch copy for PRs based on main)'
        );
    }

    // Ref-scoped, but GitHub only offers the Run workflow button for a workflow
    // on the default branch — so a dispatch-ONLY workflow added here is simply
    // unrunnable. Not reported alongside other triggers: five of seven workflows
    // here carry a workflow_dispatch and flagging them all would bury the signal.
    if (all.length === 1 && all[0] === 'workflow_dispatch') {
        reasons.push('workflow_dispatch is only offered for workflows on the default branch');
    }

    return reasons;
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

/**
 * Pure. -1 / 0 / 1 comparing two `x.y.z` strings, numerically per component.
 *
 * String comparison is the trap here: "1.10.0" < "1.9.0" lexically, which would
 * report a NEWER branch as behind and send someone to back-merge over their own
 * release. Returns null when either side is not parseable, so callers can say
 * "could not tell" rather than guess.
 */
function compareVersions(a, b) {
    const parse = (v) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return null;
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
}

/**
 * Pure. The message for a branch sitting behind the latest released tag, or
 * null when it is level, ahead, or undeterminable.
 *
 * This is the same question as the rest of the file — something here is not in
 * effect — asked about the version rather than a config file. It exists because
 * the drift is otherwise discovered during a release: `version:bump` refuses to
 * run, or auto-release aborts flagging a regression (#208).
 */
function versionDriftMessage(localVersion, latestTag) {
    const cmp = compareVersions(localVersion, latestTag);
    if (cmp === null || cmp >= 0) return null;
    return `This branch is on ${localVersion} but the latest release is ${latestTag}. `
        + 'Back-merge before bumping or merging to main: `git merge origin/main` '
        + '(auto-release patch-bumps on main only, so development is left behind).';
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
/**
 * Order-insensitive equality for two reason lists.
 *
 * Deliberately compares the reason ARRAYS rather than their joined forms: the
 * joined string is what gets prefixed for display, and comparing prefixed or
 * joined strings is what defeated the two previous attempts at this dedupe
 * (#213). Order-insensitive because the two sides are produced by independent
 * parses and a reordered `on:` block is not a drift.
 */
function sameReasons(a, b) {
    if (a.length !== b.length) return false;
    const left = [...a].sort();
    const right = [...b].sort();
    return left.every((reason, i) => reason === right[i]);
}

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
        // Same allow-list logic as the head side. These used to differ — the base
        // side kept the old three-name deny-list — so deleting an issue_comment
        // or release workflow here left main's copy firing, unreported. That is
        // precisely the case this function exists for.
        const headReasons = headText === null ? [] : workflowDriftReasons(headText);
        const reasons = workflowDriftReasons(baseText);
        if (reasons.length) {
            const why = reasons.join('; ');
            if (headText === null) {
                sides.push(`deleted here, but ${base} still has it: ${why}`);
            } else if (!sameReasons(headReasons, reasons)) {
                // Only worth saying when the base DIFFERS from the head. A
                // modified workflow carrying the same trigger on both sides
                // printed the identical reason twice, and deduping the FINAL
                // strings could never catch it — the base copy is prefixed, so
                // the two strings were never equal.
                //
                // Third attempt (#213). The second compared the base's JOINED
                // reasons against `sides`, which holds INDIVIDUAL reason
                // strings, so it matched only when the head produced exactly
                // one. A workflow with both a default-branch-only trigger and a
                // base-ref trigger yields two, and printed them twice. Compare
                // the ARRAYS, before any prefixing.
                sides.push(`${base}'s copy: ${why}`);
            }
        }
    }
    if (headText === null && baseText === null) {
        // Neither side readable: say nothing rather than guess.
        return [];
    }

    return [...new Set(sides)];
}

/**
 * How old the local copy of the base ref is.
 *
 * The whole report is computed against the LOCAL copy of `origin/main` and local
 * tags. If those are stale, every answer here is stale too — and silently so,
 * which is the one thing this tool is not allowed to be. Printing the date makes
 * "I last fetched three weeks ago" visible instead of assumed.
 */
function baseFreshness(base, root) {
    try {
        const when = git(['log', '-1', '--format=%cs', base], root);
        return when ? `comparing against local ${base} (last commit ${when}); run \`git fetch --tags origin\` if that looks old` : null;
    } catch {
        return null;
    }
}

function report(drifted, base, asJson, root, version) {
    if (asJson) {
        // `ok` is not decoration: without it a consumer checking
        // `drifted.length === 0` reads a FAILED run as a clean one, which is the
        // machine-readable version of the false all-clear this tool exists for.
        console.log(JSON.stringify({
            ok: true,
            base,
            baseFreshness: baseFreshness(base, root),
            drifted,
            version: version || null
        }, null, 2));
        return;
    }
    if (drifted.length === 0) {
        console.log(`\n  No default-branch-only config differs from ${base}.`);
        printVersion(version);
        const fresh = baseFreshness(base, root);
        if (fresh) console.log(`\n  (${fresh})`);
        console.log('');
        return;
    }
    console.log(`\n  ${drifted.length} file(s) written here but NOT IN EFFECT until merged to ${base}:\n`);
    for (const d of drifted) {
        // The changed set deliberately includes working-tree and untracked files,
        // so a commit date is often the WRONG answer: an uncommitted edit would
        // be stamped with the previous commit's date, and an untracked file has
        // no commit at all. Say which it is instead of implying a stale date.
        let age = '';
        // `ls-files --error-unmatch` is checked on its own: it is the ONLY call
        // here whose failure means "untracked". Wrapping all three together
        // meant a git log or git diff failure printed "(untracked — never
        // committed)" for a perfectly ordinary committed file.
        let tracked;
        try {
            tracked = Boolean(git(['ls-files', '--error-unmatch', '--', d.path], root));
        } catch {
            tracked = false;
        }
        try {
            if (!tracked) {
                age = '  (untracked — never committed)';
            } else if (git(['diff', '--name-only', 'HEAD', '--', d.path], root)) {
                // Against HEAD, not the index: a STAGED edit is still
                // uncommitted, and plain `git diff` does not list it — so it
                // used to be stamped with the previous commit's date, the exact
                // stale date this branch exists to avoid.
                age = '  (uncommitted change)';
            } else {
                const when = git(['log', '-1', '--format=%cs', '--', d.path], root);
                if (when) age = `  (last changed here ${when})`;
            }
        } catch {
            // A git log/diff failure says nothing about tracking status, so say
            // nothing rather than guessing. The annotation is a nicety; the
            // drift finding above it is the point.
            age = '';
        }
        console.log(`  - ${d.path}${age}`);
        console.log(`      ${d.reason}`);
        // Collected and guarded, so print it: the difference between "this is
        // inert" and "this is inert, and here is where that rule is written".
        if (d.docs || d.source) console.log(`      see: ${d.docs || d.source}`);
    }
    console.log(`\n  These take effect only when this branch is merged to ${base}.`);
    printVersion(version);
    const fresh = baseFreshness(base, root);
    if (fresh) console.log(`\n  (${fresh})`);
    console.log('');
}

/** Renders the version-drift line, including an honest "could not tell". */
function printVersion(version) {
    if (!version) return;
    if (version.error) {
        console.log(`\n  Version check inconclusive: ${version.error}`);
        return;
    }
    console.log(`\n  ${version.message}`);
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
        if (isWorkflowFile(relPath)) {
            const reasons = collectWorkflowReasons(relPath, base, root);
            if (reasons.length) {
                drifted.push({ path: relPath, reason: reasons.join('; '), docs: WORKFLOW_DOCS });
            }
            continue;
        }
        drifted.push(...classifyDrift([relPath], CATALOGUE));
    }

    report(drifted, base, asJson, root, versionDrift(root));
    return 0;
}

/**
 * Git/fs edge for the version check. Returns null (silent) when it cannot tell —
 * except that "cannot tell" is reported by the caller, never swallowed as clean.
 */
function versionDrift(root) {
    let localVersion;
    try {
        localVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    } catch {
        return { error: 'could not read package.json' };
    }
    // An absent or malformed version used to fall through compareVersions as
    // null and print nothing — indistinguishable from "you are up to date".
    if (!/^\d+\.\d+\.\d+/.test(String(localVersion || ''))) {
        return { error: `package.json version is missing or unparseable (${localVersion})` };
    }

    let latestTag;
    try {
        // NOT `git describe`: it only sees tags REACHABLE FROM HEAD, which makes
        // this blind in the exact scenario it exists for. auto-release tags a
        // commit that lives only on main, so from development `describe` returns
        // the PREVIOUS tag, compares equal to package.json, and reports nothing.
        // Verified: describe from 684d5c7 gives v1.12.0 while v1.12.1 is latest.
        //
        // `--sort=-v:refname` is a version sort, so v1.10.0 ranks above v1.9.0.
        latestTag = git(['tag', '--list', 'v*', '--sort=-v:refname'], root)
            .split('\n')[0]
            .trim();
    } catch {
        latestTag = '';
    }
    if (!latestTag) {
        return { error: 'no v* tag found locally — run `git fetch --tags` before trusting this' };
    }

    const message = versionDriftMessage(localVersion, latestTag);
    return message ? { message } : null;
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
    REF_SCOPED_TRIGGERS,
    BASE_REF_TRIGGERS,
    classifyDrift,
    matchesPattern,
    extractDefaultBranchOnlyTriggers,
    extractAllTriggers,
    workflowDriftReasons,
    parseArgs,
    collectWorkflowReasons,
    isWorkflowFile,
    sameReasons,
    compareVersions,
    versionDriftMessage,
};
