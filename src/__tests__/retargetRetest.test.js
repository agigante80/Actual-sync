/**
 * Behavioural guards for the retarget re-test (#205, #210, #216, #217).
 *
 * This file used to assert on the WORKFLOW'S TEXT — which strings appeared near
 * which line inside a YAML `run:` block. Two review loops tripped the
 * bad-fix-injection wire on that approach, and every round produced the same
 * shape of finding: the slice did not reach where the defect had moved.
 *
 *     whole-file slice  -> satisfied by the wrong branch, and by comment prose
 *     per-branch slice  -> the sibling branch was unguarded
 *     every branch      -> a status write AFTER the chain evaded them all
 *
 * There is always another indent level, so narrowing slices could not converge.
 * The logic now lives in scripts/retargetRetest.js and these tests drive it with
 * a stubbed `gh`, asserting the status ACTUALLY WRITTEN. "A status write outside
 * the chain" is no longer expressible, because there is no chain to be outside
 * of — there is a single decision and a single write of its result.
 */

const fs = require('fs');
const path = require('path');

const {
    OUTCOME,
    STATUS_CONTEXT,
    CI_WORKFLOW,
    decideOutcome,
    highestRunId,
    retestPullRequest
} = require('../../scripts/retargetRetest');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'retarget-dependabot.yml');

/**
 * A scripted `gh`. Records every call and replies per matcher, so a test states
 * what the world looked like and then asserts what was decided.
 */
function makeGh(handlers) {
    const calls = [];
    const gh = (args) => {
        calls.push(args);
        for (const [match, reply] of handlers) {
            if (match(args)) {
                const value = typeof reply === 'function' ? reply(args, calls) : reply;
                if (value instanceof Error) throw value;
                return value;
            }
        }
        return '';
    };
    gh.calls = calls;
    gh.statuses = () => calls
        .filter((a) => a[0] === 'api' && String(a[3] || '').includes('/statuses/'))
        .map((a) => {
            const state = a.find((x) => String(x).startsWith('state='));
            const desc = a.find((x) => String(x).startsWith('description='));
            return {
                state: String(state).replace('state=', ''),
                description: String(desc).replace('description=', '')
            };
        });
    /** The status a viewer actually sees: last write for the context wins. */
    gh.finalStatus = () => gh.statuses().slice(-1)[0];
    return gh;
}

const isRunList = (a) => a[0] === 'run' && a[1] === 'list';
const isClose = (a) => a[0] === 'pr' && a[1] === 'close';
const isReopen = (a) => a[0] === 'pr' && a[1] === 'reopen';
const runs = (...ids) => JSON.stringify(ids.map((id) => ({ databaseId: id })));

const drive = (handlers, overrides = {}) => {
    const gh = makeGh(handlers);
    const logs = [];
    return retestPullRequest({
        pr: 42,
        repo: 'o/r',
        headSha: 'deadbeef',
        gh,
        sleep: async () => {},
        log: (m) => logs.push(m),
        pollAttempts: 3,
        pollIntervalMs: 0,
        ...overrides
    }).then((result) => ({ result, gh, logs }));
};

describe('decideOutcome — three distinct claims, never two (#216)', () => {
    it('a new run was seen -> success', () => {
        const d = decideOutcome({ snapshotOk: true, newRunFound: true });
        expect(d.outcome).toBe(OUTCOME.RETESTED);
        expect(d.state).toBe('success');
    });

    it('looked and saw none -> failure, hedged about the cause', () => {
        const d = decideOutcome({ snapshotOk: true, newRunFound: false });
        expect(d.outcome).toBe(OUTCOME.NO_RUN);
        expect(d.state).toBe('failure');
        // No run can also mean paths-ignore, a disabled workflow or a stuck
        // queue, so it must not assert a conflict.
        expect(d.description).toMatch(/most likely/i);
        expect(d.note).toMatch(/computed against `main`/);
    });

    it('could not look -> failure, and names no cause', () => {
        const d = decideOutcome({ snapshotOk: false, newRunFound: false });
        expect(d.outcome).toBe(OUTCOME.UNVERIFIED);
        expect(d.state).toBe('failure');
        expect(d.description).toMatch(/could not verify/i);
        // The snapshot is unusable both when the call fails and when it
        // succeeds returning a non-id, so diagnosing it would be wrong half the
        // time — the overclaim #216 was filed for.
        expect(d.note).not.toMatch(/API call failed/i);
        expect(d.note).not.toMatch(/no CI run appeared/i);
    });

    it('never reports success without a run, whatever the inputs', () => {
        for (const snapshotOk of [true, false]) {
            for (const newRunFound of [true, false]) {
                const d = decideOutcome({ snapshotOk, newRunFound });
                if (d.state === 'success') {
                    expect(snapshotOk && newRunFound).toBe(true);
                }
            }
        }
    });
});

describe('highestRunId — fails closed on anything unusable', () => {
    it('returns the maximum id', () => {
        expect(highestRunId(runs(3, 99, 7))).toBe(99);
    });

    it('an empty list is a real answer: zero', () => {
        expect(highestRunId('[]')).toBe(0);
    });

    it.each([['not json', 'garbage'], ['null', 'null'], ['an object', '{}'],
        ['a non-numeric id', '[{"databaseId":"x"}]']])(
        '%s is not a baseline — returns null, never 0', (_label, payload) => {
            // Returning 0 would make the PR's ORIGINAL main-based run (any
            // positive id) look like evidence of a fresh one.
            expect(highestRunId(payload)).toBeNull();
        }
    );
});

describe('retestPullRequest — what status actually gets written', () => {
    it('a newer run appears -> the PR ends GREEN', async () => {
        const { result, gh } = await drive([
            [isRunList, (_a, calls) =>
                calls.filter(isRunList).length === 1 ? runs(100) : runs(100, 101)]
        ]);
        expect(result.outcome).toBe(OUTCOME.RETESTED);
        expect(gh.finalStatus().state).toBe('success');
    });

    it('no new run -> the PR ends RED', async () => {
        const { result, gh } = await drive([[isRunList, runs(100)]]);
        expect(result.outcome).toBe(OUTCOME.NO_RUN);
        expect(gh.finalStatus().state).toBe('failure');
    });

    it('the ORIGINAL main-based run is not evidence (#210)', async () => {
        // The pre-existing run carries the same head SHA, so its presence must
        // not count. Same ids before and after.
        const { result, gh } = await drive([[isRunList, runs(100, 55)]]);
        expect(result.outcome).toBe(OUTCOME.NO_RUN);
        expect(gh.finalStatus().state).toBe('failure');
    });

    it('an unusable snapshot never becomes a baseline of 0', async () => {
        // The live false-green: baseline 0, then any positive id passes.
        const { result, gh } = await drive([
            [isRunList, (_a, calls) =>
                calls.filter(isRunList).length === 1 ? new Error('502') : runs(100)]
        ]);
        expect(result.outcome).toBe(OUTCOME.UNVERIFIED);
        expect(gh.finalStatus().state).toBe('failure');
    });

    it('a snapshot that SUCCEEDS with junk is equally unusable', async () => {
        const { result, gh } = await drive([
            [isRunList, (_a, calls) =>
                calls.filter(isRunList).length === 1 ? 'null' : runs(100)]
        ]);
        expect(result.outcome).toBe(OUTCOME.UNVERIFIED);
        expect(gh.finalStatus().state).toBe('failure');
    });

    it('posts RED before closing, so any failure in between leaves it not-green', async () => {
        const { gh } = await drive([[isRunList, runs(100)]]);
        const firstStatus = gh.calls.findIndex(
            (a) => a[0] === 'api' && String(a[3]).includes('/statuses/'));
        const closeAt = gh.calls.findIndex(isClose);
        expect(firstStatus).toBeGreaterThan(-1);
        expect(closeAt).toBeGreaterThan(-1);
        expect(firstStatus).toBeLessThan(closeAt);
        expect(gh.statuses()[0].state).toBe('failure');
    });

    it('a PR left closed fails loudly and is never reported as re-tested', async () => {
        const { result, logs } = await drive([
            [isRunList, runs(100)],
            [isReopen, new Error('boom')]
        ]);
        expect(result.failed).toBe(true);
        expect(result.reopened).toBe(false);
        expect(result.outcome).toBeNull();
        expect(logs.join('\n')).toMatch(/::error::.*could NOT be reopened/);
    });

    it('retries the reopen before giving up', async () => {
        const { result, gh } = await drive([
            [isRunList, runs(100)],
            [isReopen, (_a, calls) =>
                calls.filter(isReopen).length < 3 ? new Error('flaky') : '']
        ]);
        expect(result.reopened).toBe(true);
        expect(gh.calls.filter(isReopen).length).toBe(3);
    });

    it('a failed close does not leave the PR closed, and does not decide', async () => {
        const { result, gh } = await drive([
            [isRunList, runs(100)],
            [isClose, new Error('nope')]
        ]);
        expect(result.failed).toBe(true);
        expect(result.closed).toBe(false);
        expect(gh.calls.filter(isReopen)).toHaveLength(0);
        expect(gh.finalStatus().state).toBe('failure');
    });

    it('only ci-cd.yml runs count as evidence, never any run on the SHA', async () => {
        const { gh } = await drive([[isRunList, runs(100)]]);
        for (const call of gh.calls.filter(isRunList)) {
            expect(call).toContain('--workflow');
            expect(call[call.indexOf('--workflow') + 1]).toBe(CI_WORKFLOW);
        }
    });

    it('a failed status post never changes the decision (#206)', async () => {
        const { result } = await drive([
            [isRunList, (_a, calls) =>
                calls.filter(isRunList).length === 1 ? runs(100) : runs(100, 101)],
            [(a) => a[0] === 'api', new Error('no statuses: write')]
        ]);
        expect(result.outcome).toBe(OUTCOME.RETESTED);
        expect(result.failed).toBe(false);
    });

    it('every status write uses the one context, so the last write is what shows', async () => {
        const { gh } = await drive([[isRunList, runs(100)]]);
        const contexts = gh.calls
            .filter((a) => a[0] === 'api' && String(a[3]).includes('/statuses/'))
            .map((a) => a.find((x) => String(x).startsWith('context=')));
        expect(contexts.length).toBeGreaterThan(1);
        for (const c of contexts) expect(c).toBe(`context=${STATUS_CONTEXT}`);
    });
});

describe('stdout carries the note and nothing else (#217)', () => {
    // The workflow captures stdout as the PR comment body
    // (`RETEST_NOTE=$(node scripts/retargetRetest.js ...)`), so anything else
    // written there is both LOST from the Actions log and pasted into a public
    // comment. Found in review: the reopen-failure path emitted four
    // ::warning::/::error:: lines straight into the captured note — including
    // the "could NOT be reopened" error that exists to be loud.
    const CLI = path.join(ROOT, 'scripts', 'retargetRetest.js');

    it('writes annotations to stderr, never stdout', () => {
        const src = fs.readFileSync(CLI, 'utf8');
        // console.log would be stdout; the default must be the stderr channel.
        expect(src).toMatch(/log = console\.error/);
        expect(src).not.toMatch(/log = console\.log/);
    });

    it('the only stdout write is the note', () => {
        const src = fs.readFileSync(CLI, 'utf8');
        const writes = [...src.matchAll(/process\.stdout\.write\(([^)]*)\)/g)].map((m) => m[1]);
        expect(writes).toEqual(['result.note']);
    });

    it('nothing anywhere in the module writes to stdout by another route', () => {
        // The describe block above claimed this and did not enforce it: adding
        // `console.log('progress')` inside retestPullRequest left all 30 tests
        // green, and that string would then be captured into the public PR
        // comment and lost from the Actions log — #217, reintroduced (round 2).
        const executable = fs.readFileSync(CLI, 'utf8')
            .split('\n')
            .filter((line) => {
                const t = line.trim();
                return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
            })
            .join('\n');

        expect(executable).not.toMatch(/console\.log\s*\(/);
        // Every stdout reference must be the sanctioned note write.
        const stdoutRefs = [...executable.matchAll(/process\.stdout[.\w]*/g)].map((m) => m[0]);
        for (const ref of stdoutRefs) expect(ref).toBe('process.stdout.write');
    });

    it('every failure path still gives the PR a note to show', () => {
        // Moving annotations to stderr removed the PR-visible signal that used
        // to arrive by accident. A comment with a blank middle section, on a PR
        // that is closed and could not be reopened, is the worst case.
        const src = fs.readFileSync(CLI, 'utf8');
        const returns = [...src.matchAll(/return \{\s*outcome: null[\s\S]*?\};/g)].map((m) => m[0]);
        expect(returns.length).toBeGreaterThan(0);
        for (const r of returns) expect(r).toMatch(/note:/);
    });

    it('does not exit() out from under a pending stdout write', () => {
        // process.exit() can truncate a pending write when stdout is a pipe,
        // which is exactly what `$(...)` makes it.
        //
        // Scoped to main()'s tail and to EXECUTABLE lines. A whole-file match
        // catches this rule's own explanatory comment and the top-level catch
        // handler — which is legitimate, because that path has written nothing
        // to stdout. Broad text matching is what #217 exists to get away from.
        const src = fs.readFileSync(CLI, 'utf8');
        const from = src.indexOf('process.stdout.write(result.note)');
        expect(from).toBeGreaterThan(-1);
        const endOfMain = src.indexOf('\n}', from);
        expect(endOfMain).toBeGreaterThan(from);

        const tail = src.slice(from, endOfMain)
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');

        expect(tail).toMatch(/process\.exitCode\s*=/);
        expect(tail).not.toMatch(/process\.exit\(/);
    });
});

describe('wiring — the workflow must actually call the extracted logic', () => {
    // The unwiring case: every behavioural test above passes if the workflow
    // stops calling this script and keeps its old inline copy.
    const WF = fs.readFileSync(WORKFLOW, 'utf8');

    it('invokes scripts/retargetRetest.js', () => {
        expect(WF).toMatch(/node scripts\/retargetRetest\.js/);
    });

    it('passes the PR, repo and head SHA it decides on', () => {
        expect(WF).toMatch(/--pr /);
        expect(WF).toMatch(/--repo /);
        expect(WF).toMatch(/--sha /);
    });

    it('checks the repo out, or the script it calls would not be there', () => {
        // The job had no checkout before #217 — it only minted a token and ran
        // gh. Calling a file that is not on disk fails at runtime, where the
        // only symptom is a red scheduled job nobody is watching.
        expect(WF).toMatch(/uses: actions\/checkout/);
        const checkoutAt = WF.indexOf('uses: actions/checkout');
        const callAt = WF.indexOf('node scripts/retargetRetest.js');
        expect(checkoutAt).toBeGreaterThan(-1);
        expect(callAt).toBeGreaterThan(-1);
        expect(checkoutAt).toBeLessThan(callAt);
    });

    it('the script needs no dependency install, matching the job that runs it', () => {
        // The job deliberately has no setup-node/npm ci. If the script ever
        // requires a package, this goes red rather than the workflow failing at
        // 03:17 on a MODULE_NOT_FOUND.
        const src = fs.readFileSync(path.join(ROOT, 'scripts', 'retargetRetest.js'), 'utf8');
        const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
        for (const dep of requires) {
            expect(dep.startsWith('.') || require('module').builtinModules.includes(dep)).toBe(true);
        }
    });

    it('no longer decides in shell', () => {
        // If any of these come back, the text-slicing problem comes back with
        // them — that is what #217 exists to end.
        expect(WF).not.toMatch(/RETESTED=/);
        expect(WF).not.toMatch(/SNAPSHOT_OK=/);
        expect(WF).not.toMatch(/post_status /);
    });
});
