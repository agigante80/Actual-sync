const { SyncQueue } = require('../lib/syncQueue');
const { createShutdownGate } = require('../lib/shutdownGate');

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('shutdown gate (#273)', () => {
    test('a sync that would start after the signal is skipped, and the drain waits only for the running one', async () => {
        const queue = new SyncQueue();
        const gate = createShutdownGate({ queue, pollMs: 1 });
        const a = deferred();
        const started = [];
        const runA = gate.run('A', async () => { started.push('A'); await a.promise; return { status: 'success' }; });
        await tick();
        // Serial cron loop: B is requested only after A finishes.
        const loop = runA.then(() => gate.run('B', async () => { started.push('B'); return { status: 'success' }; }));

        gate.close();
        let drained = false;
        const drain = gate.drain(5000).then((r) => { drained = true; return r; });
        await tick();
        expect(drained).toBe(false); // A still running

        a.resolve();
        expect(await loop).toEqual({ status: 'skipped' });
        expect(await drain).toBe(true);
        expect(started).toEqual(['A']);
    });

    test('a task queued before the signal but not yet started is skipped too', async () => {
        const queue = new SyncQueue();
        const gate = createShutdownGate({ queue, pollMs: 1 });
        const a = deferred();
        const started = [];
        gate.run('A', async () => { started.push('A'); await a.promise; });
        const runB = gate.run('B', async () => { started.push('B'); return { status: 'success' }; });
        await tick();
        gate.close();
        a.resolve();
        expect(await runB).toEqual({ status: 'skipped' });
        expect(await gate.drain(5000)).toBe(true);
        expect(started).toEqual(['A']);
    });

    test('drain gives up at the deadline when a sync hangs', async () => {
        const queue = new SyncQueue();
        const gate = createShutdownGate({ queue, pollMs: 1 });
        gate.run('A', () => new Promise(() => {}));
        await tick();
        gate.close();
        expect(await gate.drain(30)).toBe(false);
    });

    test('before close, tasks run normally', async () => {
        const gate = createShutdownGate({ queue: new SyncQueue(), pollMs: 1 });
        expect(await gate.run('A', async () => ({ status: 'success' }))).toEqual({ status: 'success' });
    });
});
