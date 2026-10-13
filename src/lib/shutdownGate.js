/**
 * Shutdown gate in front of the sync queue (#273).
 *
 * Waiting on the queue's tail at signal time is not enough: a serial cron loop
 * over [A, B] queues B only after A finishes, so B would start after the wait
 * returned and process.exit would land mid-sync. Once close() is called the
 * gate refuses new work (and work already queued but not started) by resolving
 * { status: 'skipped' }, which the retry policy does not treat as a failure.
 * drain() then waits until nothing is running or waiting, or the deadline.
 */
function createShutdownGate({ queue, pollMs = 100 }) {
    let closed = false;

    function run(key, task) {
        if (closed) return Promise.resolve({ status: 'skipped' });
        return queue.run(key, async () => (closed ? { status: 'skipped' } : task()));
    }

    function close() {
        closed = true;
    }

    /** @returns {Promise<boolean>} true when idle, false when the deadline passed first */
    async function drain(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (queue.size() > 0 || queue.running()) {
            if (Date.now() >= deadline) return false;
            await new Promise((r) => setTimeout(r, pollMs));
        }
        return true;
    }

    return { run, close, drain };
}

// 8000 ms by default: `docker stop` SIGKILLs after 10 s, and a longer wait
// would be killed before the actual.shutdown() fallback ran. An operator who
// raises stop_grace_period can raise this too (keep it about 2 s below).
const DEFAULT_SHUTDOWN_WAIT_MS = 8000;

/** SHUTDOWN_WAIT_MS from the environment, or the default for a missing or invalid value. */
function resolveShutdownWaitMs(env = process.env) {
    const raw = env.SHUTDOWN_WAIT_MS;
    if (raw == null || String(raw).trim() === '') return DEFAULT_SHUTDOWN_WAIT_MS;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_SHUTDOWN_WAIT_MS;
}

module.exports = { createShutdownGate, resolveShutdownWaitMs, DEFAULT_SHUTDOWN_WAIT_MS };
