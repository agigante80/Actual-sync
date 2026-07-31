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
 * Correctness notes, each earned the hard way:
 *
 * - mutationCatalog.test.js asserts every anchor still exists. Since a mutant
 *   REPLACES its anchor, leaving that guard in the suite made every mutation
 *   "caught" by construction — the runner scored its own self-check and could
 *   never report a survivor. It is excluded from the run.
 * - A non-zero exit is not enough: spawnSync yields status null on ENOENT, on a
 *   signal kill and on timeout, so a broken toolchain scored a perfect green.
 *   Only an actual jest failure (status 1) counts as caught.
 * - Restores are journalled to disk before the file is touched, so even SIGKILL
 *   or a power loss is recoverable via --recover. Signal handlers alone are not
 *   enough, because spawnSync blocks the event loop while jest runs.
 * - A lockfile prevents two concurrent runs from interleaving, which corrupted
 *   the tree and produced phantom survivors.
 * - Before restoring, the file is compared against the mutant that was written.
 *   If it differs, someone edited it mid-run and their work is left alone.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
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

function writeJournal(file, original) {
    fs.writeFileSync(JOURNAL, JSON.stringify({ file, original, pid: process.pid }));
}
function clearJournal() {
    if (fs.existsSync(JOURNAL)) fs.unlinkSync(JOURNAL);
}

/** Restore from a journal left behind by a killed run. */
function recover() {
    if (!fs.existsSync(JOURNAL)) {
        console.log('No journal found — nothing to recover.');
        return 0;
    }
    const { file, original } = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    fs.writeFileSync(file, original);
    clearJournal();
    if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
    console.log(`Restored ${path.relative(ROOT, file)} from journal.`);
    return 0;
}

/* ------------------------------------------------------------------- lock -- */

function acquireLock() {
    try {
        fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
        return true;
    } catch {
        const owner = fs.existsSync(LOCK) ? fs.readFileSync(LOCK, 'utf8').trim() : '?';
        let alive = true;
        try {
            process.kill(Number(owner), 0);
        } catch {
            alive = false;
        }
        if (alive) {
            console.error(`Another mutation run is in progress (pid ${owner}). Refusing to start.`);
            return false;
        }
        console.error(`Removing stale lock from dead pid ${owner}.`);
        fs.unlinkSync(LOCK);
        return acquireLock();
    }
}
function releaseLock() {
    try {
        if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
    } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ setup -- */

let active = null; // { file, original, mutated }

function emergencyRestore() {
    if (!active) return;
    try {
        if (fs.readFileSync(active.file, 'utf8') === active.mutated) {
            fs.writeFileSync(active.file, active.original);
        }
    } catch { /* journal remains for --recover */ }
    active = null;
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
        emergencyRestore();
        clearJournal();
        releaseLock();
        console.error(`\n${sig} — restored and exited. If a file looks wrong, run: npm run test:mutation -- --recover`);
        process.exit(130);
    });
}
process.on('uncaughtException', (err) => {
    emergencyRestore();
    clearJournal();
    releaseLock();
    console.error('\nRestored after an unexpected error.');
    console.error(err);
    process.exit(2);
});

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
 * @returns {'caught'|'survived'} — anything else throws, because a run that did
 * not actually execute the suite must never be scored.
 */
function runSuite(testPattern) {
    const jestArgs = ['jest', '--forceExit', '--silent',
        '--testPathIgnorePatterns', CATALOG_GUARD];
    if (testPattern) jestArgs.push(testPattern);

    const res = spawnSync('npx', jestArgs, { cwd: ROOT, encoding: 'utf8', timeout: 900000 });

    if (res.error) throw new Error(`Could not run jest: ${res.error.message}`);
    if (res.status === null) {
        throw new Error(`jest did not complete (killed by ${res.signal || 'timeout'}). `
            + 'Refusing to score this mutation.');
    }
    if (res.status === 0) return 'survived';
    if (res.status === 1) return 'caught';
    throw new Error(`jest exited ${res.status}, which is neither pass nor test-failure. `
        + 'Refusing to score this mutation.');
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

    console.log(`Running ${selected.length} mutation(s)${fast ? ' (fast: hinted tests only)' : ''}`);
    console.log(`(${CATALOG_GUARD} is excluded — it asserts anchors exist, which every mutant breaks)\n`);

    const survived = [];
    const missing = [];
    const unscored = [];

    try {
        for (const m of selected) {
            const file = abs(m.file);
            const original = fs.readFileSync(file, 'utf8');

            if (!original.includes(m.anchor)) {
                missing.push(m);
                console.log(`ANCHOR?   ${m.ticket.padEnd(6)} ${m.id}`);
                continue;
            }

            const mutated = original.replace(m.anchor, () => m.mutant);
            writeJournal(file, original);
            active = { file, original, mutated };

            let verdict;
            try {
                fs.writeFileSync(file, mutated);
                verdict = runSuite(fast ? m.tests : null);
            } catch (err) {
                unscored.push({ ...m, reason: err.message });
                verdict = null;
            } finally {
                // Never clobber an edit made while the suite was running.
                const now = fs.readFileSync(file, 'utf8');
                if (now === mutated) {
                    fs.writeFileSync(file, original);
                } else if (now !== original) {
                    console.error(`\n${m.file} changed during the run — leaving your version in place.`);
                    console.error('The mutation was NOT reverted by the runner. Check `git diff`.');
                }
                active = null;
                clearJournal();
            }

            if (verdict === null) {
                console.log(`UNSCORED  ${m.ticket.padEnd(6)} ${m.id}`);
            } else {
                if (verdict === 'survived') survived.push(m);
                console.log(`${verdict === 'caught' ? 'caught  ' : 'SURVIVED'}  ${m.ticket.padEnd(6)} ${m.id}`);
            }
        }
    } finally {
        emergencyRestore();
        clearJournal();
        releaseLock();
    }

    const scored = selected.length - missing.length - unscored.length;
    console.log(`\n${scored - survived.length}/${scored} caught` +
        (scored === selected.length ? '' : ` (${selected.length - scored} not scored)`));

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

    return (survived.length > 0 || missing.length > 0 || unscored.length > 0) ? 1 : 0;
}

if (require.main === module) {
    let code = 2;
    try {
        code = main();
    } finally {
        emergencyRestore();
        releaseLock();
    }
    process.exit(code);
}
