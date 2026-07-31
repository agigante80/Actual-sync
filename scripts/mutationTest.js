#!/usr/bin/env node
/**
 * Mutation test runner.
 *
 * Reintroduces each shipped defect from scripts/mutations.js one at a time and
 * asserts the test suite FAILS. A surviving mutation is a fix with no test
 * guarding it.
 *
 * Usage:
 *   npm run test:mutation             # full suite per mutation (accurate, slow)
 *   npm run test:mutation -- --fast   # only the hinted test file per mutation
 *   npm run test:mutation -- --ticket '#177'
 *   npm run test:mutation -- --list
 *
 * Safety: the original file contents are held in memory and restored in a
 * finally block, on uncaught errors, and on SIGINT — then verified byte-for-byte.
 * The runner refuses to start if the working tree already has uncommitted
 * changes to a file it would mutate, so a crash can never be confused with your
 * own edits.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MUTATIONS = require('./mutations');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
};

const abs = (rel) => path.join(ROOT, rel);
const restorers = new Map();

function restoreAll() {
    for (const [file, content] of restorers) {
        try {
            fs.writeFileSync(file, content);
        } catch { /* best effort — verified below */ }
    }
    restorers.clear();
}

process.on('uncaughtException', (err) => {
    restoreAll();
    console.error('\nRestored all files after an unexpected error.');
    console.error(err);
    process.exit(2);
});
process.on('SIGINT', () => {
    restoreAll();
    console.error('\nInterrupted — all files restored.');
    process.exit(130);
});

function dirtyFiles() {
    const res = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
    if (res.status !== 0) return [];
    return res.stdout.split('\n')
        .filter(Boolean)
        .map(l => l.slice(3).trim());
}

function runSuite(testPattern) {
    const jestArgs = ['jest', '--forceExit', '--silent'];
    if (testPattern) jestArgs.push(testPattern);
    const res = spawnSync('npx', jestArgs, { cwd: ROOT, encoding: 'utf8', timeout: 900000 });
    return res.status === 0; // true => suite PASSED (mutation survived)
}

function main() {
    if (has('--list')) {
        for (const m of MUTATIONS) console.log(`${m.ticket.padEnd(6)} ${m.id.padEnd(38)} ${m.desc}`);
        console.log(`\n${MUTATIONS.length} mutations`);
        return 0;
    }

    const ticket = valueOf('--ticket');
    const fast = has('--fast');
    const selected = ticket ? MUTATIONS.filter(m => m.ticket === ticket) : MUTATIONS;

    if (selected.length === 0) {
        console.error(`No mutations match ticket ${ticket}`);
        return 2;
    }

    // Never mutate a file the user is already editing — a crash would look like
    // their own change, and restoring would silently discard it.
    const dirty = new Set(dirtyFiles());
    const collide = [...new Set(selected.map(m => m.file))].filter(f => dirty.has(f));
    if (collide.length > 0) {
        console.error('Refusing to run: these files have uncommitted changes and would be mutated:');
        collide.forEach(f => console.error(`  ${f}`));
        console.error('Commit or stash them first.');
        return 2;
    }

    console.log(`Running ${selected.length} mutation(s)${fast ? ' (fast: hinted tests only)' : ''}\n`);

    const survived = [];
    const missing = [];

    for (const m of selected) {
        const file = abs(m.file);
        const original = fs.readFileSync(file, 'utf8');

        if (!original.includes(m.anchor)) {
            missing.push(m);
            console.log(`ANCHOR?   ${m.ticket.padEnd(6)} ${m.id}`);
            continue;
        }

        restorers.set(file, original);
        let caught;
        try {
            fs.writeFileSync(file, original.replace(m.anchor, m.mutant));
            caught = !runSuite(fast ? m.tests : null);
        } finally {
            fs.writeFileSync(file, original);
            restorers.delete(file);
            if (fs.readFileSync(file, 'utf8') !== original) {
                console.error(`\nFATAL: could not restore ${m.file}. Run: git checkout -- ${m.file}`);
                return 3;
            }
        }

        if (!caught) survived.push(m);
        console.log(`${caught ? 'caught  ' : 'SURVIVED'}  ${m.ticket.padEnd(6)} ${m.id}`);
    }

    console.log(`\n${selected.length - survived.length - missing.length}/${selected.length} caught`);

    if (missing.length > 0) {
        console.error('\nAnchors no longer present — the catalog has rotted and these tested nothing:');
        missing.forEach(m => console.error(`  ${m.id} (${m.file})`));
    }
    if (survived.length > 0) {
        console.error('\nSURVIVED — the defect was reintroduced and no test failed:');
        survived.forEach(m => console.error(`  ${m.ticket} ${m.id}: ${m.desc}`));
        console.error('\nEach of these is a fix with no test guarding it.');
    }

    return (survived.length > 0 || missing.length > 0) ? 1 : 0;
}

if (require.main === module) {
    let code = 2;
    try {
        code = main();
    } finally {
        restoreAll();
    }
    process.exit(code);
}

module.exports = { MUTATIONS };
