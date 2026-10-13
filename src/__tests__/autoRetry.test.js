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

    test('an automated caller that shares a failed manual run (#265 dedupe) still schedules the retry; the manual caller does not', async () => {
        const { retry, timers, syncBank } = setup();
        const manualRun = Promise.resolve({ status: 'failure' }); // what the queue hands both callers
        syncBank.mockReturnValue(manualRun);
        await retry.runAutomated(server);
        expect(timers).toHaveLength(1);
        // A manual caller calls syncBank directly and never touches the retry module.
        await manualRun;
        expect(timers).toHaveLength(1);
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
        expect(src).toContain('syncQueue.idle()');
        expect(src).toContain('autoRetry.cancelAll()');
    });
});
