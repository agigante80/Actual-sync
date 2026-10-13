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

module.exports = { createShutdownGate };
