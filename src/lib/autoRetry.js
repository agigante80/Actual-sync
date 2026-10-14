/**
 * Automatic retry after a failed automated sync (#273).
 *
 * runSyncBank never rejects: it catches its own errors, records them and
 * notifies. So the retry code that waited for syncBank to reject was dead and
 * no retry ever ran. runSyncBank now RETURNS `{ status }` ('success',
 * 'partial' or 'failure'), and this module reads it. A rejection is still
 * treated as a failure, in case a caller joins a run that threw.
 *
 * Only automated runs (cron, retry timer) come through runAutomated, so a
 * failed manual sync never schedules a retry. With the #265 queue, an
 * automated caller can be handed the result of a manual run already waiting
 * for the same server; the automated caller still owns the retry decision,
 * because it is the one that asked for an automated run.
 *
 * Effects (timers, the sync itself, config lookup) are injected so the policy
 * is testable without the service script.
 */
function createAutoRetry({
    syncBank,
    getSyncConfig,
    logger,
    setTimer = setTimeout,
    clearTimer = clearTimeout
}) {
    const timers = new Map();

    function cancel(serverName) {
        const timer = timers.get(serverName);
        if (!timer) return false;
        clearTimer(timer);
        timers.delete(serverName);
        logger.info('Cancelled pending retry', { server: serverName });
        return true;
    }

    function cancelAll() {
        for (const serverName of [...timers.keys()]) cancel(serverName);
    }

    function schedule(server, attemptNumber, maxAttempts, delayMinutes) {
        if (attemptNumber > maxAttempts) {
            logger.info('Maximum auto-retry attempts reached', {
                server: server.name,
                attempts: attemptNumber - 1
            });
            return;
        }

        cancel(server.name);

        const delayMs = delayMinutes * 60 * 1000;
        logger.info('Scheduling automatic retry', {
            server: server.name,
            attemptNumber,
            maxAttempts,
            delayMinutes,
            retryTime: new Date(Date.now() + delayMs).toISOString()
        });

        const timer = setTimer(() => {
            timers.delete(server.name);
            logger.info('Executing automatic retry', { server: server.name, attemptNumber });
            // runAutomated never rejects.
            return runAutomated(server, attemptNumber);
        }, delayMs);
        timers.set(server.name, timer);
    }

    /**
     * Run an automated sync (attempt 0 = the scheduled run, n = retry n) and
     * schedule the next retry when it failed and attempts remain.
     */
    async function runAutomated(server, attemptNumber = 0) {
        if (attemptNumber === 0) cancel(server.name);

        let failed = false;
        let reason;
        try {
            const result = await syncBank(server, { isAutomated: true, retryAttempt: attemptNumber });
            failed = result?.status === 'failure';
            if (failed) reason = 'sync reported failure';
        } catch (error) {
            failed = true;
            reason = error?.message || String(error);
        }
        if (!failed) return;

        logger.error(attemptNumber === 0 ? 'Scheduled sync failed' : 'Auto-retry failed', {
            server: server.name,
            attemptNumber,
            error: reason
        });
        const { autoRetry } = getSyncConfig(server);
        if (autoRetry.enabled && attemptNumber < autoRetry.maxAttempts) {
            schedule(server, attemptNumber + 1, autoRetry.maxAttempts, autoRetry.delayMinutes);
        }
    }

    return { runAutomated, schedule, cancel, cancelAll };
}

module.exports = { createAutoRetry };
