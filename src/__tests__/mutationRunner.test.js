/**
 * Guards the mutation runner's own scoring decisions (`scripts/mutationTest.js`).
 *
 * These live HERE and not in `mutationCatalog.test.js` on purpose: the runner
 * excludes the catalog guard from the scored suite (it asserts anchors exist,
 * which every mutant breaks), so a mutation of the runner guarded only from
 * there would be scored against a suite that never runs it — reported SURVIVED
 * no matter what. This file is inside the scored suite, so mutations of the
 * runner are honestly scored.
 *
 * Every case below is a way the runner reported a verdict it had not earned.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    readReport,
    baselineProblem,
    baselineTargets,
    scoreMutant,
    postRunState,
    recoveryRefusal,
    pidIsAlive,
    makeReportDir,
    cli
} = require('../../scripts/mutationTest');

/** A jest --json report for a run where everything passed. */
const greenReport = {
    success: true,
    numTotalTests: 1120,
    numFailedTests: 0,
    numRuntimeErrorTestSuites: 0
};

describe('reading a jest report', () => {
    it('refuses a run that executed no tests', () => {
        // jest exits 1 for "no tests found" and for a config error, so an exit
        // code alone scored those as "caught" having run nothing.
        expect(() => readReport({ ...greenReport, numTotalTests: 0 }))
            .toThrow(/zero tests/);
    });

    it('carries through the suite-level success flag', () => {
        expect(readReport(greenReport).success).toBe(true);
        expect(readReport({ ...greenReport, success: false }).success).toBe(false);
    });

    it('carries through suites that failed to load', () => {
        // The fact the whole load-error blindness turns on. jest reports
        // numFailedTests: 0 for a suite that throws on import.
        expect(readReport({ ...greenReport, numRuntimeErrorTestSuites: 2 }).loadErrors).toBe(2);
    });

    it('defaults a missing load-error count to zero rather than undefined', () => {
        const { numRuntimeErrorTestSuites, ...withoutField } = greenReport;
        expect(readReport(withoutField).loadErrors).toBe(0);
    });
});

describe('deciding whether the baseline is usable', () => {
    it('accepts a genuinely green suite', () => {
        expect(baselineProblem(readReport(greenReport))).toBeNull();
    });

    it('rejects a suite that is already failing', () => {
        // Otherwise every mutation is "caught" by construction.
        expect(baselineProblem(readReport({ ...greenReport, numFailedTests: 3 })))
            .toMatch(/already failing/);
    });

    it('rejects a baseline where a suite failed to LOAD', () => {
        // The bug: an unresolvable import gives numFailedTests: 0 with a
        // non-zero numTotalTests, so the "tests actually ran" guard passed and
        // the runner printed "green" while `npm test` exited 1.
        const report = { ...greenReport, success: false, numRuntimeErrorTestSuites: 1 };
        expect(baselineProblem(readReport(report))).toMatch(/failed to LOAD/);
    });

    it('rejects a baseline jest itself calls unsuccessful', () => {
        expect(baselineProblem(readReport({ ...greenReport, success: false })))
            .toMatch(/unsuccessful/);
    });
});

describe('choosing which suites to baseline (#179)', () => {
    const catalog = [
        { id: 'a', tests: 'notificationService' },
        { id: 'b', tests: 'notificationService' },
        { id: 'c', tests: 'telegramBot' }
    ];

    it('baselines the whole suite in normal mode', () => {
        expect(baselineTargets(catalog, false)).toEqual([null]);
    });

    it('baselines each hinted file in --fast mode, since that is what it scores', () => {
        // The baseline rules out "already red, so everything scores caught".
        // --fast scores a scoped run, so a full-suite baseline does not rule
        // that out for the suite actually being measured — a file that passes
        // in the full suite but fails standalone would score every one of its
        // mutations as caught, having proven nothing.
        expect(baselineTargets(catalog, true).sort())
            .toEqual(['notificationService', 'telegramBot']);
    });

    it('baselines each distinct pattern once, not once per mutation', () => {
        expect(baselineTargets(catalog, true)).toHaveLength(2);
    });

    it('falls back to the full suite for a mutation with no hint', () => {
        expect(baselineTargets([{ id: 'd' }], true)).toEqual([null]);
    });
});

describe('allocating somewhere for jest to write its report (#178)', () => {
    const made = [];
    const make = () => {
        const dir = makeReportDir();
        made.push(dir);
        return dir;
    };
    afterAll(() => made.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

    it('never hands out the same path twice', () => {
        // The old path was os.tmpdir()/mutation-report-<pid>.json. pids are
        // reused, and the file was only unlinked after the run — so a run that
        // died hard left a report that a later run could read as its own.
        expect(make()).not.toBe(make());
    });

    it('hands out a directory that exists and is empty', () => {
        // Empty is the point: "jest produced no report" must stay detectable,
        // and a stale file from a previous run defeats exactly that check.
        const dir = make();
        expect(fs.existsSync(dir)).toBe(true);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
});

describe('scoring a mutant run', () => {
    it('calls a mutation caught when a test failed', () => {
        expect(scoreMutant(readReport({ ...greenReport, success: false, numFailedTests: 1 })))
            .toBe('caught');
    });

    it('calls a mutation survived when the suite passed intact', () => {
        expect(scoreMutant(readReport(greenReport))).toBe('survived');
    });

    it('refuses to score a run where a suite failed to load', () => {
        // Verified symptom: making telegramBot.test.js unloadable produced a
        // false SURVIVED for #172, which IS guarded — the exact phantom
        // coverage gap this runner exists to rule out. Unscored, not a verdict.
        const report = { ...greenReport, success: false, numRuntimeErrorTestSuites: 1 };
        expect(() => scoreMutant(readReport(report))).toThrow(/failed to load/);
    });

    it('refuses to score a failed run that reports no failed tests and no load errors', () => {
        expect(() => scoreMutant(readReport({ ...greenReport, success: false })))
            .toThrow(/zero failed tests/);
    });
});

describe('checking the file after the suite ran', () => {
    const base = { original: 'ORIGINAL', mutated: 'MUTANT' };

    it('sees the mutant still in place on the normal path', () => {
        expect(postRunState({ ...base, now: 'MUTANT', mutantWritten: true }))
            .toBe('mutant-intact');
    });

    it('flags a third version as contamination', () => {
        expect(postRunState({ ...base, now: 'EDITED BY HAND', mutantWritten: true }))
            .toBe('contaminated');
    });

    it('treats a mutant reverted underneath the run as contamination', () => {
        // The bug: `--recover` run mid-flight restored the original while the
        // suite was still running, so the suite passed against unmutated code
        // and scored SURVIVED. The loop read now === original as the benign
        // "the mutant write threw" case and said nothing.
        expect(postRunState({ ...base, now: 'ORIGINAL', mutantWritten: true }))
            .toBe('contaminated');
    });

    it('leaves the benign failed-write case alone', () => {
        expect(postRunState({ ...base, now: 'ORIGINAL', mutantWritten: false }))
            .toBe('never-mutated');
    });
});

describe('whether --recover may proceed', () => {
    it('refuses while another live process holds the lock', () => {
        // Verified: --recover mid-flight reverted the mutant underneath the
        // running suite, inverting its verdict to SURVIVED.
        expect(recoveryRefusal('4321', 1234)).toMatch(/in progress \(pid 4321\)/);
    });

    it('proceeds when nothing holds the lock', () => {
        expect(recoveryRefusal(null, 1234)).toBeNull();
    });

    it('proceeds when the lock is our own', () => {
        expect(recoveryRefusal('1234', 1234)).toBeNull();
    });
});

describe('deciding whether a pid is alive', () => {
    it('recognises this very process', () => {
        expect(pidIsAlive(process.pid)).toBe(true);
    });

    it('recognises a process that has exited', () => {
        const res = spawnSync(process.execPath, ['-e', '']);
        expect(pidIsAlive(res.pid)).toBe(false);
    });

    it('treats a process owned by another user as alive, not dead', () => {
        // process.kill throws EPERM for a pid we may not signal. Reading that
        // as "dead" removes a lock that a live run still holds. pid 1 is not
        // ours in any environment this runs in.
        expect(pidIsAlive(1)).toBe(true);
    });

    it('treats an unusable pid as dead rather than throwing', () => {
        expect(pidIsAlive(NaN)).toBe(false);
        expect(pidIsAlive(0)).toBe(false);
    });
});

/**
 * The decisions above are pure functions, which makes them testable — and makes
 * it possible to delete the call and leave every test above green. `recover()`
 * and `main()` do file IO against the real lock and journal, so exercising them
 * from the suite would fight the very run that spawned it. Reading the call
 * sites is the honest compromise: it proves the wiring exists, and it is the
 * only claim being made.
 */
describe('the scoring decisions are actually wired into the runner', () => {
    const SRC = fs.readFileSync(
        path.join(__dirname, '..', '..', 'scripts', 'mutationTest.js'), 'utf8');

    /** Source of one top-level function, up to its column-0 closing brace. */
    const bodyOf = (name) => {
        const start = SRC.indexOf(`function ${name}(`);
        expect(start).toBeGreaterThan(-1);
        const end = SRC.indexOf('\n}', start);
        expect(end).toBeGreaterThan(start);
        return SRC.slice(start, end);
    };

    it('has runSuite normalise its report through readReport', () => {
        expect(bodyOf('runSuite')).toContain('readReport');
    });

    it('has recover consult the lock before it writes', () => {
        expect(bodyOf('recover')).toContain('recoveryRefusal');
        expect(bodyOf('recover')).toContain('liveLockOwner');
    });

    it('has main gate the baseline, the verdict and the file state', () => {
        const body = bodyOf('main');
        expect(body).toContain('baselineProblem');
        expect(body).toContain('scoreMutant');
        expect(body).toContain('postRunState');
    });

    it('has main pick its baseline targets rather than assuming the full suite', () => {
        expect(bodyOf('main')).toContain('baselineTargets');
    });

    it('has runSuite allocate a fresh report directory', () => {
        expect(bodyOf('runSuite')).toContain('makeReportDir');
    });
});

describe('the exit code when the runner itself breaks', () => {
    it('passes a clean run through as 0', () => {
        expect(cli(() => 0)).toBe(0);
    });

    it('passes "mutations survived" through as 1', () => {
        expect(cli(() => 1)).toBe(1);
    });

    it('reports an internal failure as 2, never as 1', () => {
        // 1 means "mutations survived" — a claim about coverage. An internal
        // crash reported as 1 asserts something the run never established.
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(cli(() => { throw new Error('boom'); })).toBe(2);
        } finally {
            spy.mockRestore();
        }
    });

    it('tells the user how to recover a file left mutated', () => {
        const seen = [];
        const spy = jest.spyOn(console, 'error').mockImplementation(m => seen.push(String(m)));
        try {
            cli(() => { throw new Error('boom'); });
        } finally {
            spy.mockRestore();
        }
        expect(seen.join('\n')).toMatch(/--recover/);
    });
});
