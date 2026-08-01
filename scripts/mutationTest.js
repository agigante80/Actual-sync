#!/usr/bin/env node
/**
 * Mutation test runner.
 *
 * Reintroduces each shipped defect from scripts/mutations.js one at a time and
 * asserts the test suite FAILS. A surviving mutation is a fix with no test
 * guarding it.
 *
 * Usage:
 *   npm run test:mutation
 *   npm run test:mutation -- --fast          # only the hinted test file
 *   npm run test:mutation -- --ticket '#177'
 *   npm run test:mutation -- --list
 *   npm run test:mutation -- --recover       # restore after a hard kill
 *
 * Every correctness note below is a bug this tool actually had. A tool that
 * reports false confidence is worse than no tool, and this one has produced a
 * false green three separate ways:
 *
 * 1. mutationCatalog.test.js asserts every anchor exists, and a mutant replaces
 *    its anchor — so with that guard in the suite, everything was "caught" by
 *    construction. It is excluded, and a test pins the exclusion.
 * 2. Scoring on a non-zero exit counted a missing toolchain, a timeout and a
 *    signal kill as caught. Scoring is now driven by jest's --json report, and
 *    requires that tests actually RAN (jest exits 1 for "no tests found" and for
 *    a config error too).
 * 3. A suite that was already red made every mutation "caught". The runner now
 *    establishes a green baseline before mutating anything and refuses to start
 *    without one.
 * 4. A suite that fails to LOAD is invisible to both of the guards above: jest
 *    reports numFailedTests: 0 with numTotalTests non-zero for a suite that
 *    throws on import, so the baseline printed "green" while `npm test` exited
 *    1, and a mutant scored a false SURVIVED for a defect that IS guarded.
 *    Scoring now reads success and numRuntimeErrorTestSuites too, and a load
 *    error under a mutant is UNSCORED rather than a verdict.
 * 5. --recover ran before the lock was consulted, so recovering mid-flight
 *    reverted the mutant underneath a running suite, which then passed against
 *    unmutated code and scored SURVIVED. --recover now refuses while a live pid
 *    holds the lock, and a file back at its original content when the mutant
 *    write SUCCEEDED is contamination, not the benign failed-write case.
 *
 * Safety: the original AND the mutant are journalled to disk (atomically) before
 * a file is touched, so a hard kill is recoverable via --recover — and --recover
 * refuses to clobber content that is neither, which is how it would otherwise
 * destroy a repair the user made by hand. Signal handlers are deliberately NOT
 * installed: main() is synchronous, so they could never fire during a run, and
 * registering them only removed the default terminate behaviour — leaving a
 * runner that could not be stopped. The journal is the recovery mechanism.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOCK = path.join(ROOT, '.mutation-test.lock');
const JOURNAL = path.join(ROOT, '.mutation-test.journal.json');
const CATALOG_GUARD = 'mutationCatalog';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
};
const abs = (rel) => path.join(ROOT, rel);

/* ---------------------------------------------------------------- journal -- */

/** Atomic, so a kill mid-write cannot leave a truncated journal. */
function writeJournal(entry) {
    const tmp = `${JOURNAL}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, JOURNAL);
}
function clearJournal() {
    try {
        if (fs.existsSync(JOURNAL)) fs.unlinkSync(JOURNAL);
    } catch { /* leaving it is safer than throwing */ }
}

/**
 * Whether --recover may write, given who holds the lock.
 *
 * Recovery rewrites a file the runner mutated. Doing that while a run is live
 * restores the original underneath the suite currently testing the mutant — the
 * suite then passes against unmutated code and the mutation is scored SURVIVED.
 * That is a false coverage gap reported by the tool built to rule them out.
 *
 * @param {string|null} owner pid holding the lock, or null if nobody live does
 * @param {number} self
 * @returns {string|null} the refusal, or null if recovery may proceed
 */
function recoveryRefusal(owner, self) {
    if (owner && owner !== String(self)) {
        return `A mutation run is in progress (pid ${owner}). Recovering now would revert `
            + 'its mutant mid-suite, so it would score unmutated code as SURVIVED. '
            + 'Wait for that run to finish, or kill it and re-run --recover.';
    }
    return null;
}

function recover() {
    const refusal = recoveryRefusal(liveLockOwner(), process.pid);
    if (refusal) {
        console.error(refusal);
        return 2;
    }

    if (!fs.existsSync(JOURNAL)) {
        console.log('No journal found — nothing to recover.');
        return 0;
    }

    let entry;
    try {
        entry = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    } catch (err) {
        console.error(`The journal is unreadable: ${err.message}`);
        console.error(`Left in place at ${JOURNAL} so you can inspect it. Nothing was written.`);
        return 2;
    }

    const { file, original, mutated } = entry;
    // A journal carried across a repo move must never write into the old
    // checkout, and must never resurrect a file deleted since.
    if (!file || !path.resolve(file).startsWith(ROOT + path.sep)) {
        console.error(`Journal points outside this repo (${file}). Refusing to write.`);
        return 2;
    }
    if (!fs.existsSync(file)) {
        console.error(`${path.relative(ROOT, file)} no longer exists. Refusing to recreate it.`);
        console.error(`The original content is in ${JOURNAL} if you want it.`);
        return 2;
    }

    const current = fs.readFileSync(file, 'utf8');
    if (current === original) {
        clearJournal();
        console.log(`${path.relative(ROOT, file)} is already back to its original content.`);
        return 0;
    }
    // The whole point: if the file is neither the mutant we wrote nor the
    // original, someone repaired or edited it. Overwriting would destroy that.
    if (current !== mutated) {
        const backup = `${file}.mutation-backup`;
        fs.writeFileSync(backup, current);
        console.error(`${path.relative(ROOT, file)} is neither the mutant nor the original —`);
        console.error('someone changed it since the run died. Refusing to overwrite.');
        console.error(`Your version has been copied to ${path.relative(ROOT, backup)}.`);
        console.error(`The original is in ${JOURNAL}; restore it by hand if that is what you want.`);
        return 2;
    }

    fs.writeFileSync(file, original);
    clearJournal();
    console.log(`Restored ${path.relative(ROOT, file)} from journal.`);
    return 0;
}

/* ------------------------------------------------------------------- lock -- */

let lockHeld = false;

/**
 * process.kill(pid, 0) throws EPERM for a live process owned by another user.
 * Reading that as "dead" clears a lock a running mutation still holds, so only
 * ESRCH — no such process — counts as dead.
 */
function pidIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code !== 'ESRCH';
    }
}

/** @returns {string|null} the pid in the lock file, if that process is alive. */
function liveLockOwner() {
    let owner;
    try {
        owner = fs.readFileSync(LOCK, 'utf8').trim();
    } catch {
        return null; // no lock, or unreadable — treat as unheld
    }
    return owner && pidIsAlive(Number(owner)) ? owner : null;
}

function acquireLock() {
    // Bounded: an unlinkable stale lock (read-only ROOT) recursed until the
    // stack overflowed, burying the real cause under a stack trace.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
            lockHeld = true;
            return true;
        } catch {
            const owner = liveLockOwner();
            if (owner) {
                console.error(`Another mutation run is in progress (pid ${owner}). Refusing to start.`);
                return false;
            }
            console.error('Removing stale lock from a dead pid.');
            try {
                fs.unlinkSync(LOCK);
            } catch { /* raced with the owner, or we cannot write here at all */ }
        }
    }
    console.error(`Could not take the lock at ${LOCK}. Remove it by hand if no run is active.`);
    return false;
}

/** Only ever remove a lock this process actually holds. */
function releaseLock() {
    if (!lockHeld) return;
    try {
        if (fs.existsSync(LOCK) && fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) {
            fs.unlinkSync(LOCK);
        }
    } catch { /* best effort */ }
    lockHeld = false;
}

/* ------------------------------------------------------------------- work -- */

/** Repo-relative paths of everything git considers changed. Fails closed. */
function dirtyFiles() {
    const res = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
    if (res.error || res.status !== 0) {
        throw new Error('Could not run `git status` to check for uncommitted changes. '
            + 'Refusing to mutate files without knowing what is already modified.');
    }
    return res.stdout.split('\n').filter(Boolean).map(l => l.slice(3).trim());
}

/**
 * Build the jest argv. Extracted so the ordering can be unit-tested — getting it
 * wrong silently inverted --fast rather than failing loudly.
 *
 * @param {string|null} testPattern
 * @param {string} reportFile
 * @returns {string[]}
 */
function buildJestArgs(testPattern, reportFile) {
    // Argument ORDER is load-bearing. --testPathIgnorePatterns is variadic, so a
    // positional pattern placed after it is swallowed as another ignore pattern —
    // which silently EXCLUDED the very test file --fast was meant to run, turning
    // every --fast result into a false "survived". The positional must come first.
    const jestArgs = ['jest'];
    if (testPattern) jestArgs.push(testPattern);
    jestArgs.push('--forceExit', '--silent', '--json', `--outputFile=${reportFile}`,
        // Passing this on the CLI REPLACES jest's default, so restate node_modules.
        '--testPathIgnorePatterns', '/node_modules/', CATALOG_GUARD);
    return jestArgs;
}

/**
 * Normalise a jest --json report into the four facts scoring depends on.
 *
 * numFailedTests alone is not one of them: a suite that throws while LOADING
 * contributes zero failed tests, so a report can show "0 failed" for a run that
 * never executed whole files.
 *
 * @returns {{ran: number, failed: number, success: boolean, loadErrors: number}}
 * @throws if the run executed nothing at all.
 */
function readReport(report) {
    // jest exits 1 for "no tests found" and for config errors too, so an exit
    // code alone would score those as "caught" having run nothing.
    if (!report.numTotalTests) {
        throw new Error('jest ran zero tests — the pattern matched nothing.');
    }
    return {
        ran: report.numTotalTests,
        failed: report.numFailedTests || 0,
        success: report.success === true,
        loadErrors: report.numRuntimeErrorTestSuites || 0
    };
}

/**
 * @param {{ran: number, failed: number, success: boolean, loadErrors: number}} result
 * @returns {string|null} why the baseline cannot be trusted, or null if green
 */
function baselineProblem(result) {
    if (result.loadErrors > 0) {
        return `${result.loadErrors} test suite(s) failed to LOAD. jest counts no failed `
            + 'tests for those, so the run looks green while the suite is broken.';
    }
    if (result.failed > 0) {
        return `the suite is already failing (${result.failed} of ${result.ran}). `
            + 'Every mutation would score "caught" for the wrong reason.';
    }
    if (!result.success) {
        return 'jest reported the run as unsuccessful despite zero failed tests.';
    }
    return null;
}

/**
 * @param {{ran: number, failed: number, success: boolean, loadErrors: number}} result
 * @returns {'caught'|'survived'}
 * @throws if the run cannot honestly be scored — the caller records it UNSCORED.
 */
function scoreMutant(result) {
    if (result.loadErrors > 0) {
        throw new Error(`${result.loadErrors} test suite(s) failed to load. A suite that `
            + 'cannot be imported reports zero failed tests, which reads as SURVIVED for '
            + 'a defect that may well be guarded.');
    }
    if (!result.success && result.failed === 0) {
        throw new Error('jest reported failure with zero failed tests and no load errors. '
            + 'Refusing to turn that into a verdict.');
    }
    return result.failed > 0 ? 'caught' : 'survived';
}

/**
 * Run the suite and report what actually happened.
 *
 * @returns {{ran: number, failed: number, success: boolean, loadErrors: number}}
 * @throws if the suite did not run to completion — such a run must never be scored.
 */
function runSuite(testPattern) {
    const reportFile = path.join(os.tmpdir(), `mutation-report-${process.pid}.json`);
    try {
        const res = spawnSync('npx', buildJestArgs(testPattern, reportFile),
            { cwd: ROOT, encoding: 'utf8', timeout: 900000 });

        if (res.error) throw new Error(`Could not run jest: ${res.error.message}`);
        if (res.status === null) {
            throw new Error(`jest did not complete (killed by ${res.signal || 'timeout'}).`);
        }
        if (!fs.existsSync(reportFile)) {
            throw new Error(`jest exited ${res.status} without producing a report `
                + '(a config error or no test files matched).');
        }

        return readReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
    } finally {
        try {
            if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
        } catch { /* temp file */ }
    }
}

/**
 * What became of the mutated file while the suite was running.
 *
 * `now === original` is only benign when we never managed to write the mutant.
 * When the write SUCCEEDED, something reverted it underneath the run — which is
 * exactly what a concurrent --recover does — and the verdict just measured
 * unmutated code.
 *
 * @returns {'mutant-intact'|'contaminated'|'never-mutated'}
 */
function postRunState({ now, original, mutated, mutantWritten }) {
    if (now === mutated) return 'mutant-intact';
    if (now !== original) return 'contaminated';
    return mutantWritten ? 'contaminated' : 'never-mutated';
}

function main() {
    // Before requiring the catalog: a broken catalog must not block recovery of
    // a file an earlier run left mutated.
    if (has('--recover')) return recover();

    const MUTATIONS = require('./mutations');

    if (has('--list')) {
        for (const m of MUTATIONS) console.log(`${m.ticket.padEnd(6)} ${m.id.padEnd(38)} ${m.desc}`);
        console.log(`\n${MUTATIONS.length} mutations`);
        return 0;
    }

    if (fs.existsSync(JOURNAL)) {
        console.error('A previous run was killed and left a journal behind.');
        console.error('Run: npm run test:mutation -- --recover');
        return 2;
    }

    const ticket = valueOf('--ticket');
    const fast = has('--fast');
    const selected = ticket ? MUTATIONS.filter(m => m.ticket === ticket) : MUTATIONS;
    if (selected.length === 0) {
        console.error(`No mutations match ticket ${ticket}`);
        return 2;
    }

    const dirty = new Set(dirtyFiles());
    const collide = [...new Set(selected.map(m => m.file))].filter(f => dirty.has(f));
    if (collide.length > 0) {
        console.error('Refusing to run: these files have uncommitted changes and would be mutated:');
        collide.forEach(f => console.error(`  ${f}`));
        console.error('Commit or stash them first.');
        return 2;
    }

    if (!acquireLock()) return 2;

    try {
        // Without this, a suite that is ALREADY red makes every mutation "caught"
        // by construction — the same tautology as the catalog guard, reached from
        // a different direction.
        process.stdout.write('Establishing a green baseline... ');
        const baseline = runSuite(null);
        const problem = baselineProblem(baseline);
        if (problem) {
            console.error(`\nNo usable baseline: ${problem}`);
            console.error('Fix the suite first — until it is green, no verdict here means anything.');
            return 2;
        }
        console.log(`green (${baseline.ran} tests)\n`);

        console.log(`Running ${selected.length} mutation(s)${fast ? ' (fast: hinted tests only)' : ''}`);
        console.log(`(${CATALOG_GUARD} is excluded — it asserts anchors exist, which every mutant breaks)\n`);

        const survived = [];
        const missing = [];
        const unscored = [];

        for (const m of selected) {
            const file = abs(m.file);
            const original = fs.readFileSync(file, 'utf8');

            if (!original.includes(m.anchor)) {
                missing.push(m);
                console.log(`ANCHOR?   ${m.ticket.padEnd(6)} ${m.id}`);
                continue;
            }

            const mutated = original.replace(m.anchor, () => m.mutant);
            writeJournal({ file, original, mutated, pid: process.pid });

            let verdict = null;
            let contaminated = false;
            let mutantWritten = false;
            try {
                fs.writeFileSync(file, mutated);
                mutantWritten = true;
                verdict = scoreMutant(runSuite(fast ? m.tests : null));
            } catch (err) {
                unscored.push({ ...m, reason: err.message });
            } finally {
                const now = fs.readFileSync(file, 'utf8');
                const state = postRunState({ now, original, mutated, mutantWritten });
                if (state === 'mutant-intact') {
                    fs.writeFileSync(file, original);
                    if (fs.readFileSync(file, 'utf8') !== original) {
                        console.error(`\nFATAL: could not restore ${m.file}.`);
                        console.error(`The journal is kept at ${JOURNAL} — run --recover, or:`);
                        console.error(`  git checkout -- ${m.file}`);
                        return 3; // journal deliberately NOT cleared
                    }
                    clearJournal();
                } else if (state === 'contaminated') {
                    contaminated = true;
                } else {
                    clearJournal();
                }
            }

            if (contaminated) {
                const reverted = fs.readFileSync(file, 'utf8') === original;
                console.error(`\n${m.file} changed while the suite was running.`);
                if (reverted) {
                    console.error('It is back at its original content even though the mutant was');
                    console.error('written — something (a concurrent --recover?) reverted it, so the');
                    console.error('suite just scored UNMUTATED code. Any verdict here is meaningless.');
                } else {
                    console.error('Your version is left in place and the run is stopping — later');
                    console.error('mutations would read the changed file as their original.');
                    console.error(`The mutant was NOT reverted. Check: git diff ${m.file}`);
                }
                unscored.push({ ...m, reason: 'file changed mid-run' });
                return 3; // journal deliberately NOT cleared
            }

            if (verdict === null) {
                console.log(`UNSCORED  ${m.ticket.padEnd(6)} ${m.id}`);
            } else {
                if (verdict === 'survived') survived.push(m);
                console.log(`${verdict === 'caught' ? 'caught  ' : 'SURVIVED'}  ${m.ticket.padEnd(6)} ${m.id}`);
            }
        }

        const scored = selected.length - missing.length - unscored.length;
        const bad = survived.length > 0 || missing.length > 0 || unscored.length > 0;

        console.log(`\n${scored - survived.length}/${scored} caught`);
        if (unscored.length > 0) console.log(`UNSCORED: ${unscored.length} — RUN INVALID`);
        if (missing.length > 0) console.log(`STALE ANCHORS: ${missing.length} — RUN INVALID`);

        if (missing.length > 0) {
            console.error('\nAnchors no longer present — these tested nothing:');
            missing.forEach(m => console.error(`  ${m.id} (${m.file})`));
        }
        if (unscored.length > 0) {
            console.error('\nCould not be scored — the suite did not run to completion:');
            unscored.forEach(m => console.error(`  ${m.id}: ${m.reason}`));
        }
        if (survived.length > 0) {
            console.error('\nSURVIVED — the defect was reintroduced and no test failed:');
            survived.forEach(m => console.error(`  ${m.ticket} ${m.id}: ${m.desc}`));
            console.error('\nEach of these is a fix with no test guarding it.');
        }

        return bad ? 1 : 0;
    } finally {
        releaseLock();
    }
}

/**
 * Exit-code discipline. 1 means "mutations survived" — a claim about coverage.
 * An internal crash reported as 1 asserts something the run never established,
 * so anything unexpected exits 2 instead.
 *
 * @param {() => number} [run] the runner to invoke; injectable so the failure
 *   path can be tested without breaking the real catalog.
 */
function cli(run = main) {
    try {
        return run();
    } catch (err) {
        console.error(`\nThe mutation runner itself failed: ${err && err.stack || err}`);
        console.error('If a file was left mutated: npm run test:mutation -- --recover');
        return 2;
    }
}

module.exports = {
    buildJestArgs,
    CATALOG_GUARD,
    readReport,
    baselineProblem,
    scoreMutant,
    postRunState,
    recoveryRefusal,
    pidIsAlive,
    cli
};

if (require.main === module) {
    process.exit(cli());
}
