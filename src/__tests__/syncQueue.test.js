/**
 * SyncQueue (#265): every sync touching @actual-app/api runs one at a time.
 */
const fs = require('fs');
const path = require('path');
const { SyncQueue } = require('../lib/syncQueue');
const { withTimeout } = require('../lib/actualTimeouts');

/** A task whose completion the test controls, recording start/end into `log`. */
function controlledTask(name, log) {
    let resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    const task = async () => {
        log.push(`${name}-start`);
        try {
            return await done;
        } finally {
            log.push(`${name}-end`);
        }
    };
    return { task, resolve, reject };
}

const flush = () => new Promise(setImmediate);

describe('SyncQueue (#265)', () => {
    test('runs tasks one at a time in request order', async () => {
        const queue = new SyncQueue();
        const log = [];
        const a = controlledTask('A', log);
        const b = controlledTask('B', log);

        const pa = queue.run('A', a.task);
        const pb = queue.run('B', b.task);
        await flush();
        expect(log).toEqual(['A-start']);

        a.resolve('a');
        await flush();
        expect(log).toEqual(['A-start', 'A-end', 'B-start']);

        b.resolve('b');
        await expect(pa).resolves.toBe('a');
        await expect(pb).resolves.toBe('b');
        expect(log).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
    });

    test('a failing task releases the queue and only its own caller sees the error', async () => {
        const queue = new SyncQueue();
        const log = [];
        const a = controlledTask('A', log);
        const b = controlledTask('B', log);

        const pa = queue.run('A', a.task);
        const pb = queue.run('B', b.task);
        a.reject(new Error('A broke'));
        await expect(pa).rejects.toThrow('A broke');

        b.resolve('b');
        await expect(pb).resolves.toBe('b');
        expect(log).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
    });

    test('a task that throws synchronously also releases the queue', async () => {
        const queue = new SyncQueue();
        const pa = queue.run('A', () => { throw new Error('sync throw'); });
        const pb = queue.run('B', async () => 'b');
        await expect(pa).rejects.toThrow('sync throw');
        await expect(pb).resolves.toBe('b');
    });

    test('a key that is already waiting is not queued twice', async () => {
        const queue = new SyncQueue();
        const log = [];
        const a = controlledTask('A', log);
        const b = controlledTask('B', log);
        const bAgain = jest.fn();

        queue.run('A', a.task);
        const pb = queue.run('B', b.task);
        const pbAgain = queue.run('B', bAgain);
        expect(pbAgain).toBe(pb);

        a.resolve();
        await flush();
        b.resolve('b');
        await expect(pbAgain).resolves.toBe('b');
        expect(bAgain).not.toHaveBeenCalled();
    });

    test('a key that is running is not queued twice', async () => {
        const queue = new SyncQueue();
        const log = [];
        const a = controlledTask('A', log);
        const pa = queue.run('A', a.task);
        await flush();
        expect(log).toEqual(['A-start']);

        const second = jest.fn();
        expect(queue.run('A', second)).toBe(pa);
        a.resolve('a');
        await pa;
        expect(second).not.toHaveBeenCalled();
    });

    test('has() is true while waiting or running and false once settled', async () => {
        const queue = new SyncQueue();
        const log = [];
        const a = controlledTask('A', log);
        const pa = queue.run('A', a.task);
        expect(queue.has('A')).toBe(true);
        await flush();
        expect(queue.has('A')).toBe(true);
        a.resolve();
        await pa;
        await flush();
        expect(queue.has('A')).toBe(false);

        // The key can be queued again once its run has settled.
        await expect(queue.run('A', async () => 'again')).resolves.toBe('again');
    });

    test('has() is false after a failed run too', async () => {
        const queue = new SyncQueue();
        await expect(queue.run('A', async () => { throw new Error('x'); })).rejects.toThrow('x');
        await flush();
        expect(queue.has('A')).toBe(false);
    });

    test('logs when a sync waits behind others and when a duplicate is dropped', async () => {
        const logger = { info: jest.fn() };
        const queue = new SyncQueue({ logger });
        const log = [];
        const a = controlledTask('A', log);
        queue.run('A', a.task);
        queue.run('B', async () => {});
        queue.run('B', async () => {});

        expect(logger.info).toHaveBeenCalledWith('Sync queued', { server: 'B', ahead: 1 });
        expect(logger.info).toHaveBeenCalledWith('Sync already queued', { server: 'B' });
        a.resolve();
    });

    test('a duplicate request whose run fails does not raise an unhandled rejection', async () => {
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const queue = new SyncQueue();
            const first = queue.run('A', async () => { throw new Error('boom'); });
            queue.run('A', async () => {}); // same promise, never awaited by this caller
            await expect(first).rejects.toThrow('boom');
            await flush();
            await flush();
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
});

describe('syncService routes every sync through the queue (#265)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'syncService.js'), 'utf8');

    test('runSyncBank, the unlocked sync, is only called from the queue wrapper', () => {
        const calls = source.match(/runSyncBank\(/g) || [];
        // One definition plus one call inside syncBank's queue.run.
        expect(calls).toHaveLength(2);
        expect(source).toMatch(/syncQueue\.run\(server\.name, \(\) => runSyncBank\(server, options\)\)/);
    });

    test('the Actual API is only used inside runSyncBank and its helpers, never around the queue', () => {
        const wrapper = source.match(/function syncBank\(server, options = \{\}\) \{[\s\S]*?\n\}/);
        expect(wrapper).not.toBeNull();
        expect(wrapper[0]).not.toMatch(/actual\./);
    });
});

describe('SyncQueue running state (#272)', () => {
    test('reports the running task with its start time, and null when idle', async () => {
        const queue = new SyncQueue({ now: () => new Date('2026-09-26T01:00:00.000Z') });
        const log = [];
        const a = controlledTask('A', log);
        const b = controlledTask('B', log);
        expect(queue.running()).toBeNull();

        const pa = queue.run('A', a.task);
        const pb = queue.run('B', b.task);
        await flush();
        expect(queue.running()).toEqual({ key: 'A', startedAt: '2026-09-26T01:00:00.000Z' });

        a.resolve();
        await pa;
        await flush();
        expect(queue.running()).toMatchObject({ key: 'B' });

        b.reject(new Error('fail'));
        await expect(pb).rejects.toThrow('fail');
        expect(queue.running()).toBeNull();
    });

    test('running() returns a copy the caller cannot use to change the queue', async () => {
        const queue = new SyncQueue();
        const a = controlledTask('A', []);
        const pa = queue.run('A', a.task);
        await flush();
        queue.running().key = 'tampered';
        expect(queue.running().key).toBe('A');
        a.resolve();
        await pa;
    });

    test('a task that times out on a hung call releases the queue for the next one', async () => {
        const queue = new SyncQueue();
        const log = [];
        const hung = queue.run('A', async () => {
            log.push('A-start');
            await withTimeout(new Promise(() => {}), 20, 'downloadBudget');
        });
        const next = queue.run('B', async () => { log.push('B-start'); });

        await expect(hung).rejects.toMatchObject({ code: 'PHASE_TIMEOUT', phase: 'downloadBudget' });
        await next;
        expect(log).toEqual(['A-start', 'B-start']);
        expect(queue.running()).toBeNull();
    });
});

describe('runSyncBank bounds every Actual API call (#272)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'syncService.js'), 'utf8');
    const body = source.match(/async function runSyncBank\(server, options = \{\}\) \{[\s\S]*?\n\}/);

    test('makes no raw actual.* call except runBankSync, which has its own timeout', () => {
        expect(body).not.toBeNull();
        const raw = body[0].match(/\bactual\.\w+/g) || [];
        expect(raw).toEqual(['actual.runBankSync']);
        expect(body[0]).toMatch(/withTimeout\(\s*actual\.runBankSync\(/);
    });

    test('routes the calls through timedActual with the configured timeout', () => {
        expect(body[0]).toMatch(/const phaseTimeoutMs = syncConfig\.phaseTimeoutSeconds \* 1000;\s*const api = timedActual\(actual, phaseTimeoutMs, lateActualCalls\)/);
        for (const m of ['init', 'downloadBudget', 'sync', 'shutdown']) {
            expect(body[0]).toMatch(new RegExp(`api\\.${m}\\(`));
        }
    });

    test('a download timeout is not retried or swallowed', () => {
        expect(body[0]).toMatch(/if \(error instanceof PhaseTimeoutError\) throw error;/);
    });

    // Each catch that could swallow a timeout must re-throw it. A missing one
    // either retries a download that may still be writing, clears dataDir under
    // it, or carries on with no budget loaded. Pinned one by one, since the
    // service cannot be imported to drive them. (#272)
    test('the retry download re-throws a timeout instead of clearing the cache', () => {
        expect(body[0]).toMatch(/catch \(err\) \{\s*if \(err instanceof PhaseTimeoutError\) throw err;/);
    });

    test('a loadBudget timeout is not skipped as "not a budget directory"', () => {
        expect(body[0]).toMatch(/catch \(entryErr\) \{[^}]*if \(entryErr instanceof PhaseTimeoutError\) throw entryErr;/);
    });

    test('the loadBudget workaround does not swallow a timeout', () => {
        expect(body[0]).toMatch(/catch \(loadErr\) \{\s*if \(loadErr instanceof PhaseTimeoutError\) throw loadErr;/);
    });

    test('timed-out calls are tracked, drained before the slot is released, and checked before init', () => {
        expect(body[0]).toMatch(/timedActual\(actual, phaseTimeoutMs, lateActualCalls\)/);
        expect(body[0]).toMatch(/withTimeout\(\s*actual\.runBankSync\([^)]*\), 60000, 'runBankSync', lateActualCalls/);
        const busyCheck = body[0].indexOf('if (!(await lateActualCalls.drain(phaseTimeoutMs)))');
        const init = body[0].indexOf('await api.init(');
        expect(busyCheck).toBeGreaterThan(-1);
        expect(busyCheck).toBeLessThan(init);
        const fin = body[0].slice(body[0].lastIndexOf('} finally {'));
        expect(fin).toMatch(/if \(sessionOpened\) \{/);
        expect(fin).toMatch(/lateActualCalls\.drain\(phaseTimeoutMs\)/);
        // Drain first: a download landing after shutdown would leave its budget open.
        expect(fin.indexOf('lateActualCalls.drain(')).toBeLessThan(fin.indexOf('await api.shutdown()'));
    });

    test('a refused busy sync stops tracking the stuck call, so later syncs proceed', () => {
        const busyBlock = body[0].slice(
            body[0].indexOf('if (!(await lateActualCalls.drain(phaseTimeoutMs)))'),
            body[0].indexOf("busy.code = 'ACTUAL_SESSION_BUSY'")
        );
        expect(busyBlock).toMatch(/lateActualCalls\.abandon\(\)/);
    });

    test('a sync that never opened the session does not shut it down', () => {
        const opened = body[0].indexOf('sessionOpened = true;');
        expect(opened).toBeGreaterThan(-1);
        expect(opened).toBeLessThan(body[0].indexOf('await api.init('));
        expect(opened).toBeGreaterThan(body[0].indexOf("busy.code = 'ACTUAL_SESSION_BUSY'"));
    });
});
