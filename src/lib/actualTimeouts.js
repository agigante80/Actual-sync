/**
 * Bounded calls into @actual-app/api. (#272)
 *
 * Since #265 every sync runs through one queue, so an Actual API call that
 * never settles (a server that accepts the connection and never answers)
 * would block every later sync until restart. Each call is raced against a
 * timer instead; on timeout the sync fails with the phase named and the queue
 * moves on.
 *
 * A timeout only stops WAITING; the call itself keeps running. @actual-app/api
 * is one process-wide session, so a late call (a slow download that lands, a
 * shutdown that finally closes the budget) would act on whichever sync runs
 * next, which is exactly #265. So every timed-out call is recorded in a
 * LateCalls tracker: runSyncBank waits for them before releasing the queue
 * slot, and a sync refuses to open the session while any is still running.
 */

const DEFAULT_PHASE_TIMEOUT_SECONDS = 300;

// The calls runSyncBank makes that talk to the server or the budget file.
// runBankSync keeps its own shorter per-account timeout; q() is a sync builder.
// getSchedules (#258) reads the same open budget file as aqlQuery, so it gets
// the same protection.
const TIMED_METHODS = ['init', 'downloadBudget', 'loadBudget', 'aqlQuery', 'sync', 'shutdown', 'getSchedules'];

class PhaseTimeoutError extends Error {
    constructor(phase, timeoutMs) {
        super(`Actual API call '${phase}' did not finish within ${Math.round(timeoutMs / 1000)}s`);
        this.name = 'PhaseTimeoutError';
        this.code = 'PHASE_TIMEOUT';
        this.phase = phase;
        this.timeoutMs = timeoutMs;
    }
}

/**
 * Calls that timed out but have not settled yet. (#272)
 */
class LateCalls {
    constructor() {
        this.pending = new Set();
    }

    get size() {
        return this.pending.size;
    }

    /** Track a call that lost its race; it leaves the set when it settles. */
    add(promise) {
        const settled = Promise.resolve(promise).then(() => {}, () => {});
        this.pending.add(settled);
        settled.then(() => this.pending.delete(settled));
    }

    /**
     * Wait up to `timeoutMs` for every tracked call to settle.
     * @returns {Promise<boolean>} true when none is left running
     */
    async drain(timeoutMs) {
        if (this.pending.size === 0) return true;
        let timer;
        const expired = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); });
        const allDone = (async () => {
            // A call may be added while we wait (e.g. a shutdown that times out).
            while (this.pending.size > 0) await Promise.all([...this.pending]);
        })();
        await Promise.race([allDone, expired]);
        clearTimeout(timer);
        // Let the settled calls' own cleanup (the delete above) run first.
        await Promise.resolve();
        return this.pending.size === 0;
    }

    /**
     * Stop tracking every pending call. Used once a call has outlived the
     * busy check, so a call that never settles (as runBankSync has been seen
     * to do) costs one refused sync instead of every sync until restart.
     * @returns {number} how many calls were dropped
     */
    abandon() {
        const dropped = this.pending.size;
        this.pending.clear();
        return dropped;
    }
}

/**
 * Race `promise` against a timer. The timer is cleared when either settles,
 * so a finished call leaves nothing pending.
 * @param {Promise|*} promise
 * @param {number} timeoutMs
 * @param {string} phase - named in the error
 * @param {LateCalls} [lateCalls] - receives the call if it times out
 * @returns {Promise<*>}
 */
function withTimeout(promise, timeoutMs, phase, lateCalls) {
    let timer;
    const call = Promise.resolve(promise);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (lateCalls) lateCalls.add(call);
            reject(new PhaseTimeoutError(phase, timeoutMs));
        }, timeoutMs);
    });
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wrap the Actual API so each server-facing call is bounded.
 * @param {Object} api - the @actual-app/api module
 * @param {number} timeoutMs - per call
 * @param {LateCalls} [lateCalls] - receives every call that times out
 * @returns {Object} the same methods, each returning a bounded promise; q() passed through
 */
function timedActual(api, timeoutMs, lateCalls) {
    const wrapped = { q: (...args) => api.q(...args) };
    for (const method of TIMED_METHODS) {
        wrapped[method] = (...args) => withTimeout(
            // Call inside a function so a synchronous throw becomes a rejection.
            Promise.resolve().then(() => api[method](...args)),
            timeoutMs,
            method,
            lateCalls
        );
    }
    return wrapped;
}

module.exports = {
    DEFAULT_PHASE_TIMEOUT_SECONDS,
    TIMED_METHODS,
    PhaseTimeoutError,
    LateCalls,
    withTimeout,
    timedActual
};
