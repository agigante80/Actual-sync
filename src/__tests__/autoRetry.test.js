const { createAutoRetry } = require('../lib/autoRetry');

function setup({ results, autoRetry = { enabled: true, maxAttempts: 2, delayMinutes: 31 } } = {}) {
    const logger = { info: jest.fn(), error: jest.fn() };
    const queue = [...(results || [])];
    const syncBank = jest.fn(async () => {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
    });
    const timers = [];
    const setTimer = jest.fn((fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; });
    const clearTimer = jest.fn((t) => { t.cleared = true; });
    const retry = createAutoRetry({ syncBank, getSyncConfig: () => ({ autoRetry }), logger, setTimer, clearTimer });
    return { retry, syncBank, timers, setTimer, logger };
}
const server = { name: 'Main' };

describe('autoRetry (#273)', () => {
    test('a failed automated sync schedules one retry after the configured delay', async () => {
        const { retry, timers } = setup({ results: [{ status: 'failure' }] });
        await retry.runAutomated(server);
        expect(timers).toHaveLength(1);
        expect(timers[0].ms).toBe(31 * 60 * 1000);
    });

    test.each([{ status: 'success' }, { status: 'partial' }, undefined])('no retry after %p', async (result) => {
        const { retry, timers } = setup({ results: [result] });
        await retry.runAutomated(server);
        expect(timers).toHaveLength(0);
    });

    test('a rejection counts as a failure', async () => {
        const { retry, timers } = setup({ results: [new Error('boom')] });
        await retry.runAutomated(server);
        expect(timers).toHaveLength(1);
    });

    test('the retry runs as retry attempt 1 and chains the next one until maxAttempts', async () => {
        const { retry, syncBank, timers } = setup({ results: [{ status: 'failure' }, { status: 'failure' }, { status: 'failure' }] });
        await retry.runAutomated(server);
        await timers[0].fn();
        expect(syncBank).toHaveBeenLastCalledWith(server, { isAutomated: true, retryAttempt: 1 });
        expect(timers).toHaveLength(2);
        await timers[1].fn();
        expect(syncBank).toHaveBeenLastCalledWith(server, { isAutomated: true, retryAttempt: 2 });
        expect(timers).toHaveLength(2); // attempts exhausted
    });

    test('a successful retry schedules nothing more', async () => {
        const { retry, timers } = setup({ results: [{ status: 'failure' }, { status: 'success' }] });
        await retry.runAutomated(server);
        await timers[0].fn();
        expect(timers).toHaveLength(1);
    });

    test('autoRetry disabled or maxAttempts 0 schedules nothing', async () => {
        for (const autoRetry of [{ enabled: false, maxAttempts: 2, delayMinutes: 1 }, { enabled: true, maxAttempts: 0, delayMinutes: 1 }]) {
            const { retry, timers } = setup({ results: [{ status: 'failure' }], autoRetry });
            await retry.runAutomated(server);
            expect(timers).toHaveLength(0);
        }
    });

    test('a new scheduled run cancels a pending retry first', async () => {
        const { retry, timers } = setup({ results: [{ status: 'failure' }, { status: 'success' }] });
        await retry.runAutomated(server);
        await retry.runAutomated(server);
        expect(timers[0].cleared).toBe(true);
    });

    test('cancelAll clears every pending retry', async () => {
        const { retry, timers } = setup({ results: [{ status: 'failure' }] });
        await retry.runAutomated(server);
        retry.cancelAll();
        expect(timers[0].cleared).toBe(true);
        expect(retry.cancel('Main')).toBe(false);
    });

    describe('with the real SyncQueue (#265 dedupe)', () => {
        const { SyncQueue } = require('../lib/syncQueue');
        function queued() {
            const queue = new SyncQueue();
            const timers = [];
            const gate = {};
            gate.promise = new Promise((r) => { gate.open = r; });
            // The task is held until gate.open so both callers can join one run.
            const syncBank = (server) => queue.run(server.name, async () => { await gate.promise; return { status: 'failure' }; });
            const retry = createAutoRetry({
                syncBank,
                getSyncConfig: () => ({ autoRetry: { enabled: true, maxAttempts: 2, delayMinutes: 31 } }),
                logger: { info: jest.fn(), error: jest.fn() },
                setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
                clearTimer: () => {}
            });
            return { queue, syncBank, retry, timers, gate };
        }

        test('manual run queued first, automated caller joins it: exactly one retry timer', async () => {
            const { syncBank, retry, timers, gate } = queued();
            const manual = syncBank(server);
            const automated = retry.runAutomated(server);
            gate.open();
            expect(await manual).toEqual({ status: 'failure' });
            await automated;
            expect(timers).toHaveLength(1);
        });

        test('automated run pending first, manual caller joins it: the automated owner schedules exactly one retry', async () => {
            const { syncBank, retry, timers, gate } = queued();
            const automated = retry.runAutomated(server);
            const manual = syncBank(server);
            gate.open();
            expect(await manual).toEqual({ status: 'failure' });
            await automated;
            expect(timers).toHaveLength(1);
        });

    });

    test('a skipped result (shutdown) is not a failure and schedules nothing', async () => {
        const { retry, timers } = setup({ results: [{ status: 'skipped' }] });
        await retry.runAutomated(server);
        expect(timers).toHaveLength(0);
    });
});

// Wiring guard: syncService.js is a script and cannot be required, so these
// check the call sites that make the retry live. The policy itself is tested above.
describe('syncService wiring (#273)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'syncService.js'), 'utf8');

    test('runSyncBank returns the status it recorded, not undefined', () => {
        expect(src).toContain('syncOutcome = syncStatus;');
        expect(src).toContain("return { status: syncOutcome };");
    });

    test('the cron job goes through autoRetry.runAutomated', () => {
        expect(src).toContain('await autoRetry.runAutomated(server);');
    });

    test('shutdown waits for the queue and stops pending retries', () => {
        expect(src).toContain('shutdownGate.drain(SHUTDOWN_WAIT_MS)');
        expect(src).toContain('shutdownGate.close()');
        expect(src).toContain('autoRetry.cancelAll()');
        expect(src).toContain('shutdownGate.run(server.name');
        expect(src).toContain('const SHUTDOWN_WAIT_MS = resolveShutdownWaitMs();');
        expect(src).toContain("process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));");
        expect(src).toContain("process.on('SIGINT', () => gracefulShutdown('SIGINT'));");
    });
});
