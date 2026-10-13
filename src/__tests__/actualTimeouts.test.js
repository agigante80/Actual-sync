/**
 * Bounded Actual API calls (#272).
 */
const {
    DEFAULT_PHASE_TIMEOUT_SECONDS,
    TIMED_METHODS,
    PhaseTimeoutError,
    LateCalls,
    prepareSession,
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

describe('LateCalls: a timed-out call is still tracked until it settles (#272)', () => {
    const deferred = () => {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
    };

    test('a call that times out is recorded, and leaves when it finally settles', async () => {
        const late = new LateCalls();
        const call = deferred();
        await expect(withTimeout(call.promise, 10, 'downloadBudget', late)).rejects.toBeInstanceOf(PhaseTimeoutError);
        expect(late.size).toBe(1);
        call.resolve('done late');
        await expect(late.drain(1000)).resolves.toBe(true);
        expect(late.size).toBe(0);
    });

    test('a call that finishes in time is never recorded', async () => {
        const late = new LateCalls();
        await withTimeout(Promise.resolve(1), 1000, 'init', late);
        expect(late.size).toBe(0);
    });

    test('a late rejection also clears it, without an unhandled rejection', async () => {
        const late = new LateCalls();
        const call = deferred();
        await expect(withTimeout(call.promise, 10, 'sync', late)).rejects.toBeInstanceOf(PhaseTimeoutError);
        call.reject(new Error('socket hang up'));
        await expect(late.drain(1000)).resolves.toBe(true);
    });

    test('drain reports false while a call is still running, and does not wait past its limit', async () => {
        const late = new LateCalls();
        await expect(withTimeout(never(), 10, 'shutdown', late)).rejects.toBeInstanceOf(PhaseTimeoutError);
        const started = Date.now();
        await expect(late.drain(50)).resolves.toBe(false);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(late.size).toBe(1);
    });

    test('abandon drops a call that never settles, so the next drain is clean', async () => {
        const late = new LateCalls();
        await expect(withTimeout(never(), 10, 'runBankSync', late)).rejects.toBeInstanceOf(PhaseTimeoutError);
        expect(late.abandon()).toBe(1);
        expect(late.size).toBe(0);
        await expect(late.drain(0)).resolves.toBe(true);
    });

    test('drain on an empty tracker is immediate', async () => {
        await expect(new LateCalls().drain(0)).resolves.toBe(true);
    });

    test('timedActual records its timed-out calls in the tracker', async () => {
        const late = new LateCalls();
        const api = { q: () => ({}) };
        for (const m of TIMED_METHODS) api[m] = never;
        const wrapped = timedActual(api, 10, late);
        await expect(wrapped.downloadBudget('id')).rejects.toBeInstanceOf(PhaseTimeoutError);
        expect(late.size).toBe(1);
    });
});

describe('LateCalls drain holds no subscription and logs settles (#284)', () => {
    const deferred = () => {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
    };

    test('a drain that gives up leaves no waiter behind', async () => {
        const late = new LateCalls();
        late.add(never(), { phase: 'sync' });
        await expect(late.drain(10)).resolves.toBe(false);
        expect(late.waiters.size).toBe(0);
    });

    test('a drain wakes as soon as the last call settles, not at its limit', async () => {
        const late = new LateCalls();
        const call = deferred();
        late.add(call.promise, { phase: 'sync' });
        const started = Date.now();
        const drained = late.drain(5000);
        call.resolve();
        await expect(drained).resolves.toBe(true);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(late.waiters.size).toBe(0);
    });

    test('a drain keeps waiting while a second call is added and still pending', async () => {
        const late = new LateCalls();
        const first = deferred();
        const second = deferred();
        late.add(first.promise, { phase: 'sync' });
        const drained = late.drain(5000);
        late.add(second.promise, { phase: 'shutdown' });
        first.resolve();
        await new Promise(r => setTimeout(r, 20));
        expect(late.size).toBe(1);
        second.resolve();
        await expect(drained).resolves.toBe(true);
    });

    test('logs phase and outcome when a late call settles', async () => {
        const logger = { info: jest.fn() };
        const late = new LateCalls({ logger });
        const ok = deferred();
        const bad = deferred();
        late.add(ok.promise, { phase: 'downloadBudget' });
        late.add(bad.promise, { phase: 'shutdown' });
        ok.resolve();
        bad.reject(new Error('x'));
        await late.drain(1000);
        const logged = logger.info.mock.calls.map(c => c[1]);
        expect(logged).toEqual(expect.arrayContaining([
            expect.objectContaining({ phase: 'downloadBudget', outcome: 'resolved' }),
            expect.objectContaining({ phase: 'shutdown', outcome: 'rejected' })
        ]));
        expect(logger.info.mock.calls[0][0]).toMatch(/finally settled/);
    });

    test('a throwing logger does not break the tracker', async () => {
        const late = new LateCalls({ logger: { info: () => { throw new Error('log down'); } } });
        const call = deferred();
        late.add(call.promise, { phase: 'sync' });
        call.resolve();
        await expect(late.drain(1000)).resolves.toBe(true);
    });

    test('withTimeout passes its phase to the tracker log', async () => {
        const logger = { info: jest.fn() };
        const late = new LateCalls({ logger });
        const call = deferred();
        await expect(withTimeout(call.promise, 10, 'loadBudget', late)).rejects.toBeInstanceOf(PhaseTimeoutError);
        call.resolve();
        await late.drain(1000);
        expect(logger.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ phase: 'loadBudget' }));
    });
});

describe('prepareSession (#284)', () => {
    const deferred = () => {
        let resolve;
        const promise = new Promise((res) => { resolve = res; });
        return { promise, resolve };
    };

    test('does nothing when no call is late', async () => {
        const r = await prepareSession({ lateCalls: new LateCalls(), timeoutMs: 50 });
        expect(r).toEqual({ ok: true, abandoned: 0 });
    });

    test('is ok when the late call finishes within the wait', async () => {
        const late = new LateCalls();
        const call = deferred();
        late.add(call.promise, { phase: 'downloadBudget' });
        const prepared = prepareSession({ lateCalls: late, timeoutMs: 1000 });
        call.resolve();
        await expect(prepared).resolves.toEqual({ ok: true, abandoned: 0 });
    });

    test('refuses and abandons when the late call is still running', async () => {
        const late = new LateCalls();
        late.add(never(), { phase: 'sync' });
        const r = await prepareSession({ lateCalls: late, timeoutMs: 20 });
        expect(r).toEqual({ ok: false, abandoned: 1 });
        expect(late.size).toBe(0);
    });
});
