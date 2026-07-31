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

function recover() {
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

function acquireLock() {
    try {
        fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
        lockHeld = true;
        return true;
    } catch {
        const owner = fs.existsSync(LOCK) ? fs.readFileSync(LOCK, 'utf8').trim() : '';
        let alive = false;
        try {
            if (owner) {
                process.kill(Number(owner), 0);
                alive = true;
            }
        } catch { /* dead */ }
        if (alive) {
            console.error(`Another mutation run is in progress (pid ${owner}). Refusing to start.`);
            return false;
        }
        console.error(`Removing stale lock from dead pid ${owner || '?'}.`);
        try {
            fs.unlinkSync(LOCK);
        } catch { /* raced with the owner */ }
        return acquireLock();
    }
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
 * Run the suite and report what actually happened.
 *
 * @returns {{ran: number, failed: number}}
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

        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        // jest exits 1 for "no tests found" and for config errors too, so an exit
        // code alone would score those as "caught" having run nothing.
        if (!report.numTotalTests) {
            throw new Error('jest ran zero tests — the pattern matched nothing.');
        }
        return { ran: report.numTotalTests, failed: report.numFailedTests };
    } finally {
        try {
            if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
        } catch { /* temp file */ }
    }
}

function main() {
    const MUTATIONS = require('./mutations');

    if (has('--recover')) return recover();

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
        if (baseline.failed > 0) {
            console.error(`\nThe suite is already failing (${baseline.failed} of ${baseline.ran}).`);
            console.error('Every mutation would score "caught" for the wrong reason. Fix the suite first.');
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
            try {
                fs.writeFileSync(file, mutated);
                const result = runSuite(fast ? m.tests : null);
                verdict = result.failed > 0 ? 'caught' : 'survived';
            } catch (err) {
                unscored.push({ ...m, reason: err.message });
            } finally {
                const now = fs.readFileSync(file, 'utf8');
                if (now === mutated) {
                    fs.writeFileSync(file, original);
                    if (fs.readFileSync(file, 'utf8') !== original) {
                        console.error(`\nFATAL: could not restore ${m.file}.`);
                        console.error(`The journal is kept at ${JOURNAL} — run --recover, or:`);
                        console.error(`  git checkout -- ${m.file}`);
                        return 3; // journal deliberately NOT cleared
                    }
                    clearJournal();
                } else if (now !== original) {
                    contaminated = true;
                } else {
                    clearJournal();
                }
            }

            if (contaminated) {
                console.error(`\n${m.file} changed while the suite was running.`);
                console.error('Your version is left in place and the run is stopping — later');
                console.error('mutations would read the changed file as their original.');
                console.error(`The mutant was NOT reverted. Check: git diff ${m.file}`);
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

module.exports = { buildJestArgs, CATALOG_GUARD };

if (require.main === module) {
    process.exit(main());
}
