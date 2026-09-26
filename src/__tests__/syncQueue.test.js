/**
 * SyncQueue (#265): every sync touching @actual-app/api runs one at a time.
 */
const fs = require('fs');
const path = require('path');
const { SyncQueue } = require('../lib/syncQueue');

/** A task whose completion the test controls, recording start/end into `log`. */
function controlledTask(name, log) {
    let resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    const task = async () => {
        log.push(`${name}-start`);
        try {
            return await done;
        } finally {
            log.push(`${name}-end`);
        }
    };
    return { task, resolve, reject };
}

const flush = () => new Promise(setImmediate);

describe('SyncQueue (#265)', () => {
    test('runs tasks one at a time in request order', async () => {
        const queue = new SyncQueue();
        const log = [];
        const a = controlledTask('A', log);
        const b = controlledTask('B', log);

        const pa = queue.run('A', a.task);
        const pb = queue.run('B', b.task);
        await flush();
        expect(log).toEqual(['A-start']);

        a.resolve('a');
        await flush();
        expect(log).toEqual(['A-start', 'A-end', 'B-start']);

        b.resolve('b');
        await expect(pa).resolves.toBe('a');
        await expect(pb).resolves.toBe('b');
        expect(log).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
    });

    test('a failing task releases the queue and only its own caller sees the error', async () => {
        const queue = new SyncQueue();
        const log = [];
        const a = controlledTask('A', log);
        const b = controlledTask('B', log);

        const pa = queue.run('A', a.task);
        const pb = queue.run('B', b.task);
        a.reject(new Error('A broke'));
        await expect(pa).rejects.toThrow('A broke');

        b.resolve('b');
        await expect(pb).resolves.toBe('b');
        expect(log).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
    });

    test('a task that throws synchronously also releases the queue', async () => {
        const queue = new SyncQueue();
        const pa = queue.run('A', () => { throw new Error('sync throw'); });
        const pb = queue.run('B', async () => 'b');
        await expect(pa).rejects.toThrow('sync throw');
        await expect(pb).resolves.toBe('b');
    });

    test('a key that is already waiting is not queued twice', async () => {
        const queue = new SyncQueue();
        const log = [];
        const a = controlledTask('A', log);
        const b = controlledTask('B', log);
        const bAgain = jest.fn();

        queue.run('A', a.task);
        const pb = queue.run('B', b.task);
        const pbAgain = queue.run('B', bAgain);
        expect(pbAgain).toBe(pb);

        a.resolve();
        await flush();
        b.resolve('b');
        await expect(pbAgain).resolves.toBe('b');
        expect(bAgain).not.toHaveBeenCalled();
    });

    test('a key that is running is not queued twice', async () => {
        const queue = new SyncQueue();
        const log = [];
        const a = controlledTask('A', log);
        const pa = queue.run('A', a.task);
        await flush();
        expect(log).toEqual(['A-start']);

        const second = jest.fn();
        expect(queue.run('A', second)).toBe(pa);
        a.resolve('a');
        await pa;
        expect(second).not.toHaveBeenCalled();
    });

    test('has() is true while waiting or running and false once settled', async () => {
        const queue = new SyncQueue();
        const log = [];
        const a = controlledTask('A', log);
        const pa = queue.run('A', a.task);
        expect(queue.has('A')).toBe(true);
        await flush();
        expect(queue.has('A')).toBe(true);
        a.resolve();
        await pa;
        await flush();
        expect(queue.has('A')).toBe(false);

        // The key can be queued again once its run has settled.
        await expect(queue.run('A', async () => 'again')).resolves.toBe('again');
    });

    test('has() is false after a failed run too', async () => {
        const queue = new SyncQueue();
        await expect(queue.run('A', async () => { throw new Error('x'); })).rejects.toThrow('x');
        await flush();
        expect(queue.has('A')).toBe(false);
    });

    test('logs when a sync waits behind others and when a duplicate is dropped', async () => {
        const logger = { info: jest.fn() };
        const queue = new SyncQueue({ logger });
        const log = [];
        const a = controlledTask('A', log);
        queue.run('A', a.task);
        queue.run('B', async () => {});
        queue.run('B', async () => {});

        expect(logger.info).toHaveBeenCalledWith('Sync queued', { server: 'B', ahead: 1 });
        expect(logger.info).toHaveBeenCalledWith('Sync already queued', { server: 'B' });
        a.resolve();
    });

    test('a duplicate request whose run fails does not raise an unhandled rejection', async () => {
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const queue = new SyncQueue();
            const first = queue.run('A', async () => { throw new Error('boom'); });
            queue.run('A', async () => {}); // same promise, never awaited by this caller
            await expect(first).rejects.toThrow('boom');
            await flush();
            await flush();
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
});

describe('syncService routes every sync through the queue (#265)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'syncService.js'), 'utf8');

    test('runSyncBank, the unlocked sync, is only called from the queue wrapper', () => {
        const calls = source.match(/runSyncBank\(/g) || [];
        // One definition plus one call inside syncBank's queue.run.
        expect(calls).toHaveLength(2);
        expect(source).toMatch(/syncQueue\.run\(server\.name, \(\) => runSyncBank\(server, options\)\)/);
    });

    test('the Actual API is only used inside runSyncBank and its helpers, never around the queue', () => {
        const wrapper = source.match(/function syncBank\(server, options = \{\}\) \{[\s\S]*?\n\}/);
        expect(wrapper).not.toBeNull();
        expect(wrapper[0]).not.toMatch(/actual\./);
    });
});
