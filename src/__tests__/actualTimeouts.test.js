/**
 * Bounded Actual API calls (#272).
 */
const {
    DEFAULT_PHASE_TIMEOUT_SECONDS,
    TIMED_METHODS,
    PhaseTimeoutError,
    withTimeout,
    timedActual
} = require('../lib/actualTimeouts');

const never = () => new Promise(() => {});

describe('withTimeout (#272)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('rejects with the phase named once the time is up', async () => {
        const p = withTimeout(never(), 5000, 'downloadBudget');
        jest.advanceTimersByTime(5000);
        await expect(p).rejects.toBeInstanceOf(PhaseTimeoutError);
        await expect(p).rejects.toMatchObject({
            code: 'PHASE_TIMEOUT',
            phase: 'downloadBudget',
            timeoutMs: 5000,
            message: "Actual API call 'downloadBudget' did not finish within 5s"
        });
    });

    test('does not reject a moment early', async () => {
        const settled = jest.fn();
        withTimeout(never(), 5000, 'init').catch(settled);
        jest.advanceTimersByTime(4999);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
    });

    test('passes a result through and clears its timer', async () => {
        await expect(withTimeout(Promise.resolve(42), 5000, 'init')).resolves.toBe(42);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('passes a rejection through unchanged and clears its timer', async () => {
        const err = new Error('boom');
        await expect(withTimeout(Promise.reject(err), 5000, 'sync')).rejects.toBe(err);
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('timedActual (#272)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const fakeApi = () => {
        const api = { q: jest.fn(() => 'query') };
        for (const m of TIMED_METHODS) api[m] = jest.fn(async (...args) => ({ m, args }));
        return api;
    };

    test('bounds every server-facing method, including shutdown', () => {
        expect(TIMED_METHODS).toEqual(
            expect.arrayContaining(['init', 'downloadBudget', 'loadBudget', 'aqlQuery', 'sync', 'shutdown'])
        );
    });

    test('forwards arguments and results', async () => {
        const api = fakeApi();
        const timed = timedActual(api, 1000);
        await expect(timed.downloadBudget('id', { password: 'x' }))
            .resolves.toEqual({ m: 'downloadBudget', args: ['id', { password: 'x' }] });
        expect(timed.q('accounts')).toBe('query');
        expect(api.q).toHaveBeenCalledWith('accounts');
    });

    test.each(TIMED_METHODS)('%s times out when it never settles', async (method) => {
        const api = fakeApi();
        api[method] = jest.fn(never);
        const p = timedActual(api, 1000)[method]();
        jest.advanceTimersByTime(1000);
        await expect(p).rejects.toMatchObject({ code: 'PHASE_TIMEOUT', phase: method });
    });

    test('turns a synchronous throw into a rejection', async () => {
        const api = fakeApi();
        api.init = () => { throw new Error('sync throw'); };
        await expect(timedActual(api, 1000).init()).rejects.toThrow('sync throw');
    });

    test('the default is five minutes', () => {
        expect(DEFAULT_PHASE_TIMEOUT_SECONDS).toBe(300);
    });
});
