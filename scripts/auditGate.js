#!/usr/bin/env node
/**
 * auditGate.js
 *
 * Blocking `npm audit` gate with an expiring allowlist (#250).
 *
 * Usage:
 *   node scripts/auditGate.js [--allowlist <file>] [--level high] [--today YYYY-MM-DD] [--stdin]
 *
 * Reads an `npm audit --json` report (audit report v2) from stdin with
 * --stdin, otherwise runs `npm audit --json` itself. Exits 1 when any advisory at or above the
 * level is neither allowlisted nor covered by a LIVE entry, or when the
 * allowlist itself is malformed. Exits 0 otherwise.
 *
 * Allowlist file (.github/audit-allowlist.json):
 *   { "entries": [ { "id": "GHSA-xxxx-xxxx-xxxx", "reason": "...", "expires": "2026-12-31" } ] }
 *
 * An entry suppresses its advisory through the whole of its `expires` day
 * (UTC) and not after: on the next day the advisory fails the gate again, so
 * an accepted risk is re-decided on a date instead of living forever.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ALLOWLIST = path.join(__dirname, '..', '.github', 'audit-allowlist.json');
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const GHSA_RE = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Advisory id: the GHSA id from the advisory url, else the numeric source. */
function advisoryId(via) {
    const m = /\/advisories\/(GHSA-[\w-]+)/.exec(via.url || '');
    return m ? m[1] : String(via.source);
}

/** Validates the parsed allowlist; returns an array of error strings. */
function validateAllowlist(list) {
    if (!list || !Array.isArray(list.entries)) return ['allowlist must be {"entries": [...]}'];
    const errors = [];
    list.entries.forEach((e, i) => {
        const where = `entries[${i}]`;
        if (!e || typeof e.id !== 'string' || !GHSA_RE.test(e.id)) errors.push(`${where}: id must be a GHSA id`);
        if (!e || typeof e.reason !== 'string' || !e.reason.trim()) errors.push(`${where}: reason is required`);
        if (!e || typeof e.expires !== 'string' || !DATE_RE.test(e.expires) || Number.isNaN(Date.parse(e.expires))) {
            errors.push(`${where}: expires must be a YYYY-MM-DD date`);
        }
    });
    return errors;
}

/** Returns error strings when `report` is not a usable npm audit v2 report. */
function validateReport(report) {
    const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
    if (!isObj(report)) return ['npm audit returned no report'];
    if (report.error) {
        const e = report.error;
        // npm puts the readable reason of a registry outage in the top-level
        // `message` and leaves `error.summary` empty, so read that first.
        const why = (typeof report.message === 'string' && report.message)
            || (isObj(e) && (e.code || e.summary)) || JSON.stringify(e);
        return [`npm audit failed: ${why}`];
    }
    if (report.auditReportVersion !== 2) return ['unsupported npm audit report version (expected 2)'];
    if (!isObj(report.vulnerabilities)) return ['npm audit report has no vulnerabilities object'];
    return [];
}

/**
 * Pure gate. `today` is a YYYY-MM-DD string (compared lexically, UTC).
 * Returns { failures, suppressed, expired, errors }.
 */
function evaluate(report, allowlist, { level = 'high', today } = {}) {
    const errors = validateAllowlist(allowlist);
    if (errors.length) return { failures: [], suppressed: [], expired: [], errors };
    // Fail closed: a report that is not a real v2 audit (registry down, network
    // error, changed format) must never read as "no advisories".
    const reportErrors = validateReport(report);
    if (reportErrors.length) return { failures: [], suppressed: [], expired: [], errors: reportErrors };
    const min = SEVERITY_RANK[level];
    const live = new Map();
    const expiredIds = new Map();
    for (const e of allowlist.entries) {
        (e.expires >= today ? live : expiredIds).set(e.id, e);
    }
    const seen = new Set();
    const failures = [];
    const suppressed = [];
    const expired = [];
    for (const [pkg, v] of Object.entries(report.vulnerabilities)) {
        for (const via of v.via || []) {
            if (typeof via !== 'object' || !(SEVERITY_RANK[via.severity] >= min)) continue;
            const id = advisoryId(via);
            const key = `${pkg}|${id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const row = { package: pkg, id, severity: via.severity, title: via.title };
            if (live.has(id)) suppressed.push(row);
            else {
                failures.push(row);
                if (expiredIds.has(id)) expired.push({ ...row, expires: expiredIds.get(id).expires });
            }
        }
    }
    return { failures, suppressed, expired, errors };
}

function parseArgs(argv) {
    const out = { allowlist: DEFAULT_ALLOWLIST, level: 'high', today: new Date().toISOString().slice(0, 10), stdin: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--allowlist') out.allowlist = argv[++i];
        else if (argv[i] === '--level') out.level = argv[++i];
        else if (argv[i] === '--today') out.today = argv[++i];
        else if (argv[i] === '--stdin') out.stdin = true;
    }
    return out;
}

function main(argv) {
    const args = parseArgs(argv);
    if (!(args.level in SEVERITY_RANK) || !DATE_RE.test(args.today)) {
        console.error('auditGate: bad --level or --today');
        return 1;
    }
    const allowlist = JSON.parse(fs.readFileSync(args.allowlist, 'utf8'));
    const raw = args.stdin
        ? fs.readFileSync(0, 'utf8')
        : spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        console.error('auditGate: npm audit produced no parseable JSON report');
        return 1;
    }
    const res = evaluate(parsed, allowlist, args);
    if (res.errors.length) {
        res.errors.forEach(e => console.error(`auditGate: ${e}`));
        return 1;
    }
    res.suppressed.forEach(s => console.log(`allowlisted: ${s.id} (${s.package}, ${s.severity})`));
    res.failures.forEach(f => console.error(`FAIL: ${f.id} ${f.package} ${f.severity}: ${f.title}`));
    res.expired.forEach(x => console.error(`allowlist entry for ${x.id} expired on ${x.expires}; re-decide or fix it`));
    if (res.failures.length) return 1;
    console.log(`npm audit gate passed at level ${args.level}`);
    return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { evaluate, validateReport, validateAllowlist, advisoryId, parseArgs };
