#!/usr/bin/env node
/**
 * Generate Shields "endpoint" badge JSON for live coverage + test count, so the
 * README never carries hardcoded (rotting) numbers. (#131)
 *
 * Self-contained: runs Jest once (coverage + JSON results), derives the numbers,
 * and writes .github/badges/{coverage,tests}.json. The README points Shields
 * endpoint badges at those files on `main`; CI regenerates + commits them per
 * release (.github/workflows/metrics-badges.yml). No external service or secret.
 *
 * Coverage is statement coverage over the unit-tested modules — Jest's config
 * excludes src/syncService.js and index.js from collection (see package.json),
 * so the badge label says "coverage" rather than implying whole-repo.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const COVERAGE_DIR = path.join(ROOT, 'coverage'); // gitignored
const RESULTS = path.join(COVERAGE_DIR, 'jest-results.json');
const SUMMARY = path.join(COVERAGE_DIR, 'coverage-summary.json');
const BADGE_DIR = path.join(ROOT, '.github', 'badges');

fs.mkdirSync(COVERAGE_DIR, { recursive: true });

// One Jest run yields both the test results (--json) and the coverage summary
// (--coverageReporters=json-summary). --ci keeps it deterministic. execFileSync
// with an arg array avoids the shell (no injection, handles paths with spaces).
execFileSync(
    'npx',
    ['jest', '--ci', '--coverage', '--coverageReporters=json-summary', '--json', '--outputFile', RESULTS],
    { cwd: ROOT, stdio: 'inherit' }
);

const results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
const summary = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));

const passed = results.numPassedTests;
const total = results.numTotalTests;
const pct = summary.total.statements.pct;

const covColor =
    pct >= 80 ? 'brightgreen' :
    pct >= 70 ? 'green' :
    pct >= 60 ? 'yellowgreen' :
    pct >= 50 ? 'yellow' : 'orange';

const badges = {
    'coverage.json': { schemaVersion: 1, label: 'coverage', message: `${pct}%`, color: covColor },
    'tests.json': { schemaVersion: 1, label: 'tests', message: `${passed} passing`, color: passed === total ? 'brightgreen' : 'red' },
};

fs.mkdirSync(BADGE_DIR, { recursive: true });
for (const [file, body] of Object.entries(badges)) {
    fs.writeFileSync(path.join(BADGE_DIR, file), JSON.stringify(body, null, 2) + '\n');
    console.log(`wrote .github/badges/${file}: ${JSON.stringify(body)}`);
}

// Clean the transient results file (coverage/ is gitignored, but keep it tidy).
fs.rmSync(RESULTS, { force: true });
