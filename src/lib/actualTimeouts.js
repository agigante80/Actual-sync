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
 * slot, and a sync will not open the session while any is still running
 * after one more phase timeout (the time-based rule; see prepareSession).
 *
 * Known limit (#284): the Actual API offers no way to cancel a call, so one
 * that outlives BOTH waits (the finally drain and the next sync's drain) is
 * abandoned and no longer tracked. If it lands after that, it acts on whatever
 * session is open then (a late shutdown can close the following sync's
 * budget). It needs a server that stays unresponsive for over twice the phase
 * timeout and then answers; the affected sync fails and the next one recovers.
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
    /**
     * @param {Object} [options]
     * @param {Object} [options.logger] - receives one line when a late call settles (#284)
     */
    constructor(options = {}) {
        this.pending = new Set();
        this.waiters = new Set(); // drain() callers, woken when the set empties
        this.logger = options.logger || null;
    }

    get size() {
        return this.pending.size;
    }

    /**
     * Track a call that lost its race; it leaves the set when it settles.
     * @param {Promise|*} promise
     * @param {{phase?: string}} [meta] - named in the settle log
     */
    add(promise, meta = {}) {
        const addedAt = Date.now();
        let outcome = 'resolved';
        const settled = Promise.resolve(promise).then(() => {}, () => { outcome = 'rejected'; });
        this.pending.add(settled);
        settled.then(() => {
            this.pending.delete(settled);
            this.logSettled(meta, outcome, Date.now() - addedAt);
            if (this.pending.size === 0) {
                for (const wake of [...this.waiters]) wake();
            }
        });
    }

    logSettled(meta, outcome, msAfterTimeout) {
        if (!this.logger) return;
        try {
            this.logger.info('A timed-out Actual API call finally settled', {
                phase: meta.phase || 'unknown',
                outcome,
                msAfterTimeout
            });
        } catch (e) { /* logging must never break the tracker */ }
    }

    /**
     * Wait up to `timeoutMs` for every tracked call to settle. Holds no
     * subscription on the pending calls once it returns, so giving up on a
     * call that never settles leaks nothing. (#284)
     * @returns {Promise<boolean>} true when none is left running
     */
    async drain(timeoutMs) {
        if (this.pending.size === 0) return true;
        let timer;
        let wake;
        await new Promise(resolve => {
            wake = resolve;
            this.waiters.add(wake);
            timer = setTimeout(resolve, timeoutMs);
        });
        this.waiters.delete(wake);
        clearTimeout(timer);
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
 * Get the shared session clean before a sync opens it. (#272, #284)
 *
 * With nothing late, there is nothing to do. With late calls, wait up to
 * `timeoutMs` for them. If that works, run a bounded shutdown first: a late
 * download that landed after the previous sync's shutdown (between about 2x and
 * 3x the phase timeout) leaves its budget open, and init would then run on top
 * of it. If the calls (or that shutdown) are still running, give up on them:
 * abandon the tracking so one refused sync is the cost, not every sync.
 *
 * @param {Object} args
 * @param {LateCalls} args.lateCalls
 * @param {number} args.timeoutMs
 * @param {Function} args.shutdown - bounded api.shutdown
 * @param {Object} [args.logger]
 * @returns {Promise<{ok: boolean, cleaned: boolean, abandoned: number}>}
 */
async function prepareSession({ lateCalls, timeoutMs, shutdown, logger }) {
    if (lateCalls.size === 0) return { ok: true, cleaned: false, abandoned: 0 };
    let ok = await lateCalls.drain(timeoutMs);
    let cleaned = false;
    if (ok) {
        try {
            await shutdown();
            cleaned = true;
        } catch (error) {
            // A failing shutdown is not fatal (nothing open is the common
            // case); a timed-out one is tracked and re-checked just below.
            if (logger) logger.debug('Shutdown before init failed', { error: error?.message || String(error) });
        }
        ok = await lateCalls.drain(timeoutMs);
    }
    if (ok) return { ok: true, cleaned, abandoned: 0 };
    return { ok: false, cleaned, abandoned: lateCalls.abandon() };
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
            if (lateCalls) lateCalls.add(call, { phase });
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
    prepareSession,
    withTimeout,
    timedActual
};
