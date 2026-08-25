#!/usr/bin/env node
/**
 * retargetRetest.js
 *
 * Re-tests a Dependabot PR that `retarget-dependabot.yml` has just moved from
 * `main` to `development`, and reports whether that re-test actually happened.
 *
 * WHY THIS IS A MODULE AND NOT SHELL (#217)
 *
 * This logic lived in a YAML `run:` block, where the only way to test it was to
 * read the workflow's text and assert which strings appeared near which line.
 * Two review loops tripped the bad-fix-injection wire on exactly that, and every
 * round produced the same shape of finding — the guard's slice did not reach
 * where the defect had moved:
 *
 *   whole-file slice   -> satisfied by the wrong branch, and by comment prose
 *   per-branch slice   -> the sibling branch was unguarded
 *   every branch       -> a status write AFTER the chain evaded them all
 *
 * There is always another indent level, so patching slice boundaries could not
 * converge. Here the decision is a pure function over observations, and the
 * effects are performed by an injected `gh`, so a test asserts what status was
 * ACTUALLY WRITTEN rather than which strings sit near which line. A status
 * write "outside the chain" is not expressible.
 *
 * WHAT IT DOES, and why each step is the way it is:
 *
 *  1. Post a RED status first, and clear it only on evidence. Every failure
 *     path in between therefore leaves the PR visibly not-green rather than
 *     showing the stale check it earned against `main` (#205).
 *  2. Snapshot the highest `ci-cd.yml` run id already on the head SHA. The PR's
 *     ORIGINAL main-based runs carry the SAME sha, so "a run exists" proves
 *     nothing; only "a run NEWER than this one" does. Scoped to ci-cd.yml
 *     because codeql-analysis.yml also fires on pull_request and carries no
 *     paths-ignore, so "any run" would go green on a skipped suite.
 *  3. Close and reopen. Changing a base fires `edited`, which ci-cd.yml does not
 *     listen for; `reopened` is in GitHub's default set, so this needs no change
 *     to ci-cd.yml — and that matters, because the earlier attempt DID edit it
 *     and an all-skipped run turned a red PR green.
 *  4. Poll for a newer run, then decide. A CONFLICTING PR produces NO run at all
 *     (GitHub never computes refs/pull/N/merge), and that is the NORMAL state of
 *     a retargeted PR, so "no run" must not be read as failure of this job.
 *
 * Fails CLOSED throughout: an unusable observation is never evidence.
 */
'use strict';

const { execFileSync } = require('child_process');

const STATUS_CONTEXT = 'retarget/re-tested-against-development';
const CI_WORKFLOW = 'ci-cd.yml';
const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 5000;
const REOPEN_ATTEMPTS = 3;

/** Outcomes of the re-test, as distinct claims. */
const OUTCOME = {
    RETESTED: 'retested',
    NO_RUN: 'no_run',
    UNVERIFIED: 'unverified'
};

/**
 * Pure. The whole decision, as a function of what was observed.
 *
 * The three outcomes are deliberately distinct claims and must never collapse
 * into two:
 *   - retested   we saw a new ci-cd run
 *   - no_run     we looked and saw none — most likely a conflict
 *   - unverified we could not look, so we know nothing either way
 *
 * "I could not check" and "I checked and found nothing" being merged is the
 * defect that #216 was filed for.
 */
function decideOutcome({ snapshotOk, newRunFound }) {
    if (!snapshotOk) {
        return {
            outcome: OUTCOME.UNVERIFIED,
            // Names no cause. The snapshot is unusable both when the call FAILS
            // and when it SUCCEEDS returning something that is not a run id, so
            // diagnosing it would be right half the time.
            state: 'failure',
            description:
                'Could not verify whether CI re-ran after retargeting. '
                + "Check this PR's checks by hand before merging.",
            note:
                'This PR was **closed and reopened** to re-trigger CI (#205), but this job '
                + '**could not verify** whether a run started — the run snapshot was unusable, '
                + 'so nothing was observed either way. **Check this PR\'s checks by hand before '
                + 'merging**, and treat any check older than the reopen as computed against '
                + '`main`.',
            warning:
                'the re-test could not be VERIFIED (the run snapshot was unusable) — '
                + 'this is not evidence that CI did or did not run. Check by hand.'
        };
    }

    if (newRunFound) {
        return {
            outcome: OUTCOME.RETESTED,
            state: 'success',
            description: 'Re-tested against development after retargeting.',
            note:
                'This PR was **closed and reopened** to re-trigger CI, because changing a base '
                + 'does not do so on its own (#205). The checks now on it were computed against '
                + '`development`. If you see it briefly closed, that is this workflow, not a human.',
            warning: null
        };
    }

    return {
        outcome: OUTCOME.NO_RUN,
        state: 'failure',
        // Hedged on purpose: no run can also mean paths-ignore, a disabled
        // workflow, or a stuck queue. Asserting "conflict" would be the same
        // overclaiming in a new coat.
        description:
            'No CI run appeared after retargeting — most likely a merge conflict '
            + 'with development. Resolve it, then re-run CI.',
        note:
            'This PR was **closed and reopened** to re-trigger CI (#205), but **no CI run '
            + 'appeared** — most likely it now conflicts with `development`, and a conflicting '
            + 'PR cannot be tested at all because GitHub never computes its merge ref (#210). '
            + '**The checks shown here were computed against `main`.** Resolve the conflict, '
            + 're-run CI before merging.',
        warning:
            'no CI run appeared within the poll window. Most likely it conflicts with the '
            + 'base — a conflicting PR cannot be tested at all. Its commit status is left red.'
    };
}

/**
 * Pure. Highest run id in a `gh run list --json databaseId` payload, or null
 * when the payload cannot be trusted.
 *
 * Returning null rather than 0 is the fail-closed rule: a baseline of 0 would
 * make the PR's original main-based run (any positive id) look like evidence of
 * a fresh one.
 */
function highestRunId(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    if (parsed.length === 0) return 0;

    let max = 0;
    for (const run of parsed) {
        const id = run && run.databaseId;
        if (typeof id !== 'number' || !Number.isFinite(id)) return null;
        if (id > max) max = id;
    }
    return max;
}

/** Default `gh` runner. Throws on non-zero exit, which callers treat as "unusable". */
function runGh(args) {
    return execFileSync('gh', args, { encoding: 'utf8' });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Perform the whole re-test for one PR.
 *
 * `gh`, `sleep` and `log` are injected so the behaviour can be exercised
 * without a network — the point of #217. Returns a result object rather than
 * printing conclusions, so a test asserts the decision instead of parsing text.
 */
async function retestPullRequest({
    pr,
    repo,
    headSha,
    gh = runGh,
    sleep = wait,
    // STDERR, not stdout. The workflow captures stdout as the PR comment body
    // (`RETEST_NOTE=$(node scripts/retargetRetest.js ...)`), so annotations
    // written to stdout would be swallowed from the Actions log AND pasted
    // verbatim into a public comment — including the "could NOT be reopened"
    // error that exists to be loud. Verified: the reopen-failure path emitted
    // four ::warning::/::error:: lines straight into the captured note (#217).
    log = console.error,
    pollAttempts = POLL_ATTEMPTS,
    pollIntervalMs = POLL_INTERVAL_MS
}) {
    const warn = (msg) => log(`::warning::PR #${pr}: ${msg}`);

    // Best-effort (#206): the App may lack `statuses: write`. Losing the marker
    // must not cost a retarget that has already happened and been verified.
    const postStatus = (state, description) => {
        try {
            gh(['api', '-X', 'POST', `repos/${repo}/statuses/${headSha}`,
                '-f', `state=${state}`,
                '-f', `context=${STATUS_CONTEXT}`,
                '-f', `description=${description}`]);
            return true;
        } catch {
            warn(`could not post commit status '${state}'.`);
            return false;
        }
    };

    const listRuns = () => {
        try {
            return highestRunId(gh(['run', 'list', '--repo', repo, '--commit', headSha,
                '--workflow', CI_WORKFLOW, '--limit', '100', '--json', 'databaseId']));
        } catch {
            return null;
        }
    };

    // Red first. Cleared only on evidence, so every path in between is visibly
    // not-green rather than showing main's stale check.
    postStatus('failure',
        'Base moved to development; awaiting a re-run. '
        + 'The existing check was computed against main.');

    const runsBefore = listRuns();
    const snapshotOk = runsBefore !== null;
    if (!snapshotOk) {
        warn('could not snapshot existing runs; the re-test cannot be verified.');
    }

    try {
        gh(['pr', 'close', String(pr), '--repo', repo]);
    } catch {
        warn('could not close it to re-trigger CI; it keeps its stale check and the red status.');
        return { outcome: null, closed: false, reopened: false, failed: true };
    }

    let reopened = false;
    for (let attempt = 1; attempt <= REOPEN_ATTEMPTS; attempt += 1) {
        try {
            gh(['pr', 'reopen', String(pr), '--repo', repo]);
            reopened = true;
            break;
        } catch {
            warn(`reopen attempt ${attempt} failed; retrying.`);
            if (attempt < REOPEN_ATTEMPTS) await sleep(pollIntervalMs);
        }
    }

    if (!reopened) {
        // The one genuinely bad outcome: a security PR left closed, which
        // Dependabot may decline to recreate. Must never exit 0.
        log(`::error::PR #${pr} was closed to re-trigger CI and could NOT be reopened. `
            + 'Reopen it by hand — a closed security PR may not be recreated by Dependabot.');
        return { outcome: null, closed: true, reopened: false, failed: true };
    }

    let newRunFound = false;
    if (snapshotOk) {
        for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
            await sleep(pollIntervalMs);
            const latest = listRuns();
            if (latest !== null && latest > runsBefore) {
                newRunFound = true;
                break;
            }
        }
    }

    const decision = decideOutcome({ snapshotOk, newRunFound });
    postStatus(decision.state, decision.description);
    if (decision.warning) warn(decision.warning);

    return { ...decision, closed: true, reopened: true, failed: false };
}

/* istanbul ignore next -- CLI wiring, exercised by the workflow itself */
async function main(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
        args[argv[i].replace(/^--/, '')] = argv[i + 1];
    }
    if (!args.pr || !args.repo || !args.sha) {
        console.error('usage: retargetRetest.js --pr <n> --repo <owner/name> --sha <headSha>');
        process.exit(2);
    }

    const result = await retestPullRequest({
        pr: args.pr, repo: args.repo, headSha: args.sha
    });

    // The note is the ONLY thing on stdout — the workflow captures it as the PR
    // comment body. Everything else goes to stderr; see `log` above.
    if (result.note) process.stdout.write(result.note);
    // exitCode, not exit(): process.exit() can truncate a pending stdout write
    // when stdout is a pipe, which is exactly what `$(...)` makes it.
    process.exitCode = result.failed ? 1 : 0;
}

/* istanbul ignore next */
if (require.main === module) {
    main(process.argv.slice(2)).catch((err) => {
        console.error(`::error::retargetRetest failed: ${err && err.message}`);
        process.exit(1);
    });
}

module.exports = {
    OUTCOME,
    STATUS_CONTEXT,
    CI_WORKFLOW,
    decideOutcome,
    highestRunId,
    retestPullRequest
};
