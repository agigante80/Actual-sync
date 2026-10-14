/**
 * The blocking npm audit gate and its expiring allowlist (#250).
 * An expired entry must stop suppressing its advisory; a live one must.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluate, validateAllowlist, advisoryId } = require('../../scripts/auditGate');

const ID = 'GHSA-2222-3333-cccc';
const report = {
    auditReportVersion: 2,
    vulnerabilities: {
        lodashish: {
            via: [{ source: 1, name: 'lodashish', title: 'Prototype pollution', severity: 'high', url: `https://github.com/advisories/${ID}` }],
        },
        parent: { via: ['lodashish'] },
        modest: {
            via: [{ source: 2, name: 'modest', title: 'minor', severity: 'moderate', url: 'https://github.com/advisories/GHSA-ffff-gggg-hhhh' }],
        },
    },
};
const entry = (expires) => ({ entries: [{ id: ID, reason: 'no upstream fix', expires }] });

describe('auditGate fails closed on a missing report', () => {
    const none = { entries: [] };
    const today = '2026-06-01';

    test('an npm audit error report fails', () => {
        const r = evaluate({ error: { code: 'ENOTFOUND', summary: 'request failed' } }, none, { today });
        expect(r.errors).toHaveLength(1);
    });

    test('a report without vulnerabilities fails', () => {
        expect(evaluate({ auditReportVersion: 2 }, none, { today }).errors).toHaveLength(1);
        expect(evaluate({ auditReportVersion: 1, vulnerabilities: {} }, none, { today }).errors).toHaveLength(1);
        expect(evaluate({ auditReportVersion: 2, vulnerabilities: [] }, none, { today }).errors).toHaveLength(1);
    });

    test('a valid empty v2 report passes', () => {
        const r = evaluate({ auditReportVersion: 2, vulnerabilities: {} }, none, { today });
        expect(r.errors).toEqual([]);
        expect(r.failures).toEqual([]);
    });

    test('the CLI exits 1 for an error report and for empty stdout', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditgate-'));
        const file = path.join(dir, 'allow.json');
        fs.writeFileSync(file, JSON.stringify(none));
        const run = (input) => spawnSync(process.execPath, [
            path.join(__dirname, '..', '..', 'scripts', 'auditGate.js'), '--allowlist', file, '--stdin',
        ], { input, encoding: 'utf8' });
        expect(run('{"error":{"code":"ENOTFOUND"}}').status).toBe(1);
        expect(run('').status).toBe(1);
        expect(run('{"auditReportVersion":2,"vulnerabilities":{}}').status).toBe(0);
        fs.rmSync(dir, { recursive: true });
    });
});

describe('auditGate', () => {
    test('with no allowlist a high advisory fails and a moderate one does not', () => {
        const r = evaluate(report, { entries: [] }, { today: '2026-06-01' });
        expect(r.failures.map(f => f.id)).toEqual([ID]);
    });

    test('a live entry suppresses the advisory, through its expiry day', () => {
        for (const today of ['2026-06-01', '2026-12-31']) {
            const r = evaluate(report, entry('2026-12-31'), { today });
            expect(r.failures).toEqual([]);
            expect(r.suppressed.map(s => s.id)).toEqual([ID]);
        }
    });

    test('an expired entry no longer suppresses the advisory', () => {
        const r = evaluate(report, entry('2026-12-31'), { today: '2027-01-01' });
        expect(r.failures.map(f => f.id)).toEqual([ID]);
        expect(r.suppressed).toEqual([]);
        expect(r.expired.map(x => x.id)).toEqual([ID]);
    });

    test('an entry for a different advisory suppresses nothing', () => {
        const other = { entries: [{ id: 'GHSA-cccc-cccc-cccc', reason: 'r', expires: '2099-01-01' }] };
        expect(evaluate(report, other, { today: '2026-06-01' }).failures).toHaveLength(1);
    });

    test('malformed entries are rejected rather than silently ignored', () => {
        expect(validateAllowlist({ entries: [{ id: ID, expires: '2099-01-01' }] })).toHaveLength(1);
        expect(validateAllowlist({ entries: [{ id: ID, reason: 'r', expires: 'soon' }] })).toHaveLength(1);
        expect(validateAllowlist({ entries: [{ id: 'lodash', reason: 'r', expires: '2099-01-01' }] })).toHaveLength(1);
        expect(validateAllowlist({})).toHaveLength(1);
    });

    test('advisoryId reads the GHSA id from the url', () => {
        expect(advisoryId({ source: 7, url: `https://github.com/advisories/${ID}` })).toBe(ID);
        expect(advisoryId({ source: 7 })).toBe('7');
    });

    test('the CLI exits 1 on an expired entry and 0 on a live one', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditgate-'));
        const file = path.join(dir, 'allow.json');
        fs.writeFileSync(file, JSON.stringify(entry('2026-12-31')));
        const run = (today) => spawnSync(process.execPath, [
            path.join(__dirname, '..', '..', 'scripts', 'auditGate.js'), '--allowlist', file, '--today', today, '--stdin',
        ], { input: JSON.stringify(report), encoding: 'utf8' });
        expect(run('2026-06-01').status).toBe(0);
        expect(run('2027-01-01').status).toBe(1);
        fs.rmSync(dir, { recursive: true });
    });

    test('the committed allowlist is valid', () => {
        const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'audit-allowlist.json'), 'utf8'));
        expect(validateAllowlist(committed)).toEqual([]);
    });
});
