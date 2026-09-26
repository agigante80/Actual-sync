/**
 * Bounded calls into @actual-app/api. (#272)
 *
 * Since #265 every sync runs through one queue, so an Actual API call that
 * never settles (a server that accepts the connection and never answers)
 * would block every later sync until restart. Each call is raced against a
 * timer instead; on timeout the sync fails with the phase named and the queue
 * moves on.
 *
 * The queue slot itself is deliberately NOT timed out: releasing it while the
 * old call still runs would let the next sync's init() interleave with it,
 * which is exactly #265. A timed-out call may still be running in the
 * background; runSyncBank's finally still calls shutdown() (itself bounded)
 * before the slot is released.
 */

const DEFAULT_PHASE_TIMEOUT_SECONDS = 300;

// The calls runSyncBank makes that talk to the server or the budget file.
// runBankSync keeps its own shorter per-account timeout; q() is a sync builder.
const TIMED_METHODS = ['init', 'downloadBudget', 'loadBudget', 'aqlQuery', 'sync', 'shutdown'];

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
 * Race `promise` against a timer. The timer is cleared when either settles,
 * so a finished call leaves nothing pending.
 * @param {Promise|*} promise
 * @param {number} timeoutMs
 * @param {string} phase - named in the error
 * @returns {Promise<*>}
 */
function withTimeout(promise, timeoutMs, phase) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PhaseTimeoutError(phase, timeoutMs)), timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wrap the Actual API so each server-facing call is bounded.
 * @param {Object} api - the @actual-app/api module
 * @param {number} timeoutMs - per call
 * @returns {Object} the same methods, each returning a bounded promise; q() passed through
 */
function timedActual(api, timeoutMs) {
    const wrapped = { q: (...args) => api.q(...args) };
    for (const method of TIMED_METHODS) {
        wrapped[method] = (...args) => withTimeout(
            // Call inside a function so a synchronous throw becomes a rejection.
            Promise.resolve().then(() => api[method](...args)),
            timeoutMs,
            method
        );
    }
    return wrapped;
}

module.exports = {
    DEFAULT_PHASE_TIMEOUT_SECONDS,
    TIMED_METHODS,
    PhaseTimeoutError,
    withTimeout,
    timedActual
};
