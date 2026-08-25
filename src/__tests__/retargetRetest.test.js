/**
 * Guards the #205 re-test wiring in .github/workflows/retarget-dependabot.yml.
 *
 * Source-reading, like the other workflow guards here: the behaviour lives in a
 * GitHub-hosted job, so the property that can rot locally is the ORDER of the
 * steps, not their runtime result. The runtime result was verified once, by
 * hand, on scratch PR #214 — retarget alone fired no run, close+reopen fired a
 * `pull_request` run whose base was `development`, and a deliberately failing
 * PR stayed red across it.
 *
 * What can silently rot afterwards is the fail-safe ordering. The red status is
 * posted BEFORE the close and cleared only after a confirmed reopen, so every
 * failure path in between leaves the PR visibly not-green. Reordering those
 * three calls reintroduces exactly the #205 defect — a stale green from `main`
 * on a PR about to be merged into `development` — while every test still
 * passes and the workflow still "works" on the happy path.
 */

const fs = require('fs');
const path = require('path');

const WORKFLOW = path.join(
    __dirname,
    '..',
    '..',
    '.github',
    'workflows',
    'retarget-dependabot.yml'
);

describe('retarget-dependabot.yml re-tests against the new base (#205)', () => {
    let text;

    beforeAll(() => {
        text = fs.readFileSync(WORKFLOW, 'utf8');
    });

    it('closes and reopens the PR to re-trigger CI', () => {
        // The trigger itself. `edited` is not a ci-cd.yml trigger, so without
        // this nothing re-runs and the PR keeps main's check.
        expect(text).toMatch(/gh pr close "\$PR"/);
        expect(text).toMatch(/gh pr reopen "\$PR"/);
    });

    it('posts the red status BEFORE closing, and clears it only after reopening', () => {
        // The fail-safe ordering — the property this file exists to protect.
        const failureAt = text.indexOf('post_status "failure"');
        const closeAt = text.indexOf('gh pr close "$PR"');
        const reopenAt = text.indexOf('gh pr reopen "$PR"');
        const successAt = text.indexOf('post_status "success"');

        expect(failureAt).toBeGreaterThan(-1);
        expect(closeAt).toBeGreaterThan(-1);
        expect(reopenAt).toBeGreaterThan(-1);
        expect(successAt).toBeGreaterThan(-1);

        expect(failureAt).toBeLessThan(closeAt);
        expect(reopenAt).toBeLessThan(successAt);
    });

    it('fails the job loudly if a closed PR cannot be reopened', () => {
        // The one genuinely bad outcome: a security PR left closed, which
        // Dependabot may decline to recreate. It must never exit 0.
        expect(text).toMatch(/could NOT be reopened/i);
        const marker = text.indexOf('could NOT be reopened');
        const after = text.slice(marker, marker + 400);
        expect(after).toMatch(/FAILED=1/);
    });

    it('retries the reopen rather than giving up on the first failure', () => {
        expect(text).toMatch(/for attempt in 1 2 3/);
    });

    it('clears the status only on EVIDENCE that a new run started (#210)', () => {
        // The defect this replaced: `post_status "success"` fired on a
        // successful reopen alone. A conflicting PR produces no CI run at all
        // (verified on scratch PR #215), and conflicting is the NORMAL state of
        // a retargeted PR — so that posted a green "re-tested" marker on a PR
        // with no CI whatsoever.
        const successAt = text.indexOf('post_status "success"');
        const retestedGuard = text.indexOf('if [ "$RETESTED" -eq 1 ]; then');

        expect(retestedGuard).toBeGreaterThan(-1);
        expect(successAt).toBeGreaterThan(retestedGuard);
    });

    it('compares against a pre-close snapshot, not the mere existence of a run', () => {
        // The subtle trap: the PR's ORIGINAL main-based runs carry the same head
        // SHA, so `gh run list --commit <sha>` is non-empty before anything is
        // re-triggered. Only a run id GREATER than the pre-close maximum is
        // evidence of a new run.
        expect(text).toMatch(/RUNS_BEFORE=/);
        expect(text).toMatch(/\[ "\$LATEST" -gt "\$RUNS_BEFORE" \]/);

        const snapshotAt = text.indexOf('RUNS_BEFORE=');
        const closeAt = text.indexOf('gh pr close "$PR"');
        expect(snapshotAt).toBeLessThan(closeAt);
    });

    it('fails CLOSED when the run snapshot cannot be taken', () => {
        // Review finding on 0d5da08, and a live false-green path: `|| echo 0`
        // on the snapshot meant a transient gh failure set the baseline to 0,
        // so the first poll returned the max id of the PR's ORIGINAL main-based
        // runs, `> 0` passed, and a green "re-tested" was posted with no new
        // run. That is mutation 210-existence-not-freshness, reachable at
        // runtime rather than only by editing the file.
        expect(text).toMatch(/SNAPSHOT_OK=1/);
        expect(text).toMatch(/SNAPSHOT_OK=0/);
        expect(text).toMatch(/if \[ "\$SNAPSHOT_OK" -eq 1 \]; then/);

        // The snapshot assignment must not swallow a failure into a default.
        const snapshotBlock = text.slice(
            text.indexOf('SNAPSHOT_OK=1'),
            text.indexOf('RETESTED=0')
        );
        expect(snapshotBlock).not.toMatch(/\|\| echo 0/);

        // Non-numeric output is not a run id either.
        expect(text).toMatch(/\*\[!0-9\]\*/);
    });

    it('distinguishes "could not check" from "checked and found nothing"', () => {
        // Review finding on the fail-closed fix itself: with the snapshot
        // failed, control fell through to the else, which told the maintainer in
        // a PUBLIC comment that no run appeared and a conflict needed resolving
        // — when nothing had been observed and CI may have run green. A
        // transient 502, or an App without `actions: read`, produced a confident
        // false diagnosis.
        const branchAt = text.indexOf('elif [ "$SNAPSHOT_OK" -ne 1 ]; then');
        expect(branchAt).toBeGreaterThan(-1);

        const successAt = text.indexOf('if [ "$RETESTED" -eq 1 ]; then');
        const elseAt = text.indexOf('\n            else\n', branchAt);
        // `-1 < branchAt` holds, so an absent marker would satisfy the ordering
        // assertion below without the chain existing at all (#216).
        expect(successAt).toBeGreaterThan(-1);
        expect(elseAt).toBeGreaterThan(-1);
        expect(successAt).toBeLessThan(branchAt);
        expect(elseAt).toBeGreaterThan(branchAt);

        // Its wording must not assert an observation it did not make. Scanned
        // over EXECUTABLE lines only: the branch's own comment explains the bug
        // it fixes and necessarily quotes the wording being ruled out, so a
        // whole-slice match tests the prose rather than the behaviour.
        const branch = text.slice(branchAt, elseAt)
            .split('\n')
            .filter((line) => !line.trim().startsWith('#'))
            .join('\n');
        expect(branch).toMatch(/could not verify/i);
        expect(branch).not.toMatch(/no CI run appeared/i);
    });

    it('accepts only a ci-cd.yml run as evidence, not any run on the SHA', () => {
        // codeql-analysis.yml also fires on pull_request and carries no
        // paths-ignore, while ci-cd.yml's does. Without this scoping, a
        // paths-ignore hit would yield a fresh CodeQL run id and a green marker
        // although the suite never ran.
        const occurrences = text.match(/--workflow ci-cd\.yml/g) || [];
        expect(occurrences.length).toBeGreaterThanOrEqual(2); // snapshot + poll
    });

    /**
     * The FINAL `else` of the RETESTED chain — executable lines only (#216).
     *
     * These guards used to slice from `if [ "$RETESTED" -eq 1 ]` to end of file,
     * which spans all THREE branches. Two of the three were then satisfied by
     * the `elif` no matter what the `else` did, and one of those by the elif's
     * COMMENT prose rather than its code — the comment quotes "no CI run
     * appeared" while explaining the bug it fixed.
     *
     * Measured, not assumed: an `else` posting an unconditional success with an
     * unconditional "computed against development" note — the exact #210
     * false-green — passed all 14 tests, provided it kept the words "most
     * likely". Comments are stripped for the same reason they were stripped in
     * the sibling guard: prose that discusses a defect must not satisfy the
     * assertion that rules it out.
     */
    const elseBranchOf = (src) => {
        const chainAt = src.indexOf('if [ "$RETESTED" -eq 1 ]; then');
        expect(chainAt).toBeGreaterThan(-1);
        const elseAt = src.indexOf('\n            else\n', chainAt);
        expect(elseAt).toBeGreaterThan(-1);
        const fiAt = src.indexOf('\n            fi\n', elseAt);
        expect(fiAt).toBeGreaterThan(elseAt);

        return src.slice(elseAt, fiAt)
            .split('\n')
            .filter((line) => !line.trim().startsWith('#'))
            .join('\n');
    };

    it('the PR comment agrees with the status instead of asserting a re-test', () => {
        // It used to state "the checks now on it were computed against
        // development" unconditionally, so on the normal conflicting-PR case
        // the comment contradicted the red status beside it.
        expect(text).toMatch(/RETEST_NOTE=/);
        expect(text).toMatch(/"\$RETEST_NOTE"/);

        const elseBranch = elseBranchOf(text);
        expect(elseBranch).toMatch(/no CI run appeared/i);
        expect(elseBranch).toMatch(/computed against \\`main\\`/);
    });

    it('leaves the status red and warns when no run appears', () => {
        const elseBranch = elseBranchOf(text);
        expect(elseBranch).toMatch(/post_status "failure"/);
        expect(elseBranch).toMatch(/::warning::/);
    });

    it('reports what was observed rather than asserting a conflict', () => {
        // No run can also mean paths-ignore, a disabled workflow or a stuck
        // queue. The message must hedge, or it becomes the next false claim.
        const elseBranch = elseBranchOf(text);
        expect(elseBranch).toMatch(/most likely/i);
    });

    it('keeps the status post non-fatal, like the comment step (#206)', () => {
        // The App may lack `statuses: write`. Losing the marker must not cost
        // the retarget, which has already happened and been verified by then.
        const fnAt = text.indexOf('post_status()');
        expect(fnAt).toBeGreaterThan(-1);
        expect(text.slice(fnAt, fnAt + 500)).toMatch(/\|\|\s*echo "::warning::/);
    });

    it('does not require any change to ci-cd.yml, whose defaults supply `reopened`', () => {
        // ci-cd.yml declares no `types:` for pull_request, so it gets GitHub's
        // default set (opened, synchronize, reopened). If someone adds an
        // explicit `types:` that omits `reopened`, this re-test silently stops
        // firing — and the previous #205 attempt showed that editing this file
        // to add `edited` let an all-skipped run turn a red PR green (5aaf131).
        const ciCd = fs.readFileSync(
            path.join(path.dirname(WORKFLOW), 'ci-cd.yml'),
            'utf8'
        );
        const prBlock = ciCd.slice(ciCd.indexOf('  pull_request:'));
        const nextTopLevel = prBlock.search(/\n  [a-z_]+:/);
        const scoped = nextTopLevel === -1 ? prBlock : prBlock.slice(0, nextTopLevel);

        if (/types:/.test(scoped)) {
            expect(scoped).toMatch(/reopened/);
        } else {
            expect(scoped).not.toMatch(/types:/);
        }
    });
});
