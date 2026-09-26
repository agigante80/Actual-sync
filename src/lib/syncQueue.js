/**
 * Serialise every sync that touches @actual-app/api. (#265)
 *
 * The Actual API is one process-wide session: init, downloadBudget and
 * shutdown act on shared global state with no lock of their own. Two syncs
 * running at once interleave on that state, so one server's sync can run
 * against another server's budget or be shut down mid-run. This queue runs
 * tasks strictly one at a time, in the order they were requested.
 *
 * A key (the server name) that is already waiting or running is not queued a
 * second time: the caller gets the promise of the pending run instead. A task
 * that throws still releases the queue, so a failing server never blocks the
 * ones behind it.
 */
class SyncQueue {
    /**
     * @param {object} [options]
     * @param {object} [options.logger] logger with info(); queue events are logged when given
     */
    constructor(options = {}) {
        this.logger = options.logger || null;
        this.tail = Promise.resolve();
        this.pending = new Map(); // key -> promise of its run, while waiting or running
    }

    /**
     * Run `task` after every task queued before it.
     * @param {string} key identifies the work, e.g. the server name
     * @param {Function} task async function to run
     * @returns {Promise<*>} settles with the task's own result or error
     */
    run(key, task) {
        if (this.pending.has(key)) {
            this.log('Sync already queued', { server: key });
            return this.pending.get(key);
        }

        const ahead = this.pending.size;
        if (ahead > 0) {
            this.log('Sync queued', { server: key, ahead });
        }

        const result = this.tail.then(() => task());
        // The queue itself must never reject, or one failure would skip the rest.
        this.tail = result.then(() => {}, () => {});
        // `tracked` rejects with the task's error; the caller handles it. No extra
        // catch here: a caller that ignores the error should still surface it.
        const tracked = result.finally(() => this.pending.delete(key));
        this.pending.set(key, tracked);
        return tracked;
    }

    /**
     * @param {string} key
     * @returns {boolean} true while `key` is waiting or running
     */
    has(key) {
        return this.pending.has(key);
    }

    log(message, context) {
        if (this.logger) this.logger.info(message, context);
    }
}

module.exports = { SyncQueue };
