/**
 * Crash handlers: classified records only, no spread, no raw upstream text (#439)
 */

const {
    describeCrash,
    handleUncaughtException,
    handleUnhandledRejection,
    handleWarning,
    installCrashHandlers,
    setCrashLogger
} = require('../lib/crashHandlers');

const makeLogger = () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() });
const allLogged = (logger) => JSON.stringify(
    ['error', 'warn', 'info', 'debug'].map(l => logger[l].mock.calls)
);

describe('describeCrash', () => {
    test('never carries the message of an Error', () => {
        const e = new Error("Category 'Rent to Marco' already exists");
        const d = describeCrash(e);
        expect(JSON.stringify(d)).not.toMatch(/Marco/);
        // "already exists" is a conflict: the keyword picks the category, its text is not copied.
        expect(d).toEqual(expect.objectContaining({ type: 'Error', category: 'conflict' }));
        expect(typeof d.safeMessage).toBe('string');
    });

    test('keeps a short code and maps timeouts', () => {
        const e = new Error('x');
        e.code = 'ETIMEDOUT';
        expect(describeCrash(e)).toEqual(expect.objectContaining({ code: 'ETIMEDOUT', category: 'timeout' }));
    });

    test('drops a code that is not a short token', () => {
        const e = new Error('x');
        e.code = 'IBAN IT60 X054 2811 1010 0000 0123 456';
        expect(describeCrash(e).code).toBeUndefined();
    });

    test('describes a plain object by type only', () => {
        const d = describeCrash({ payee: 'SENTINEL_PAYEE', amount: 1234 });
        expect(d.type).toBe('object');
        expect(JSON.stringify(d)).not.toMatch(/SENTINEL_PAYEE|1234/);
    });

    test('describes a string reason by type only', () => {
        expect(JSON.stringify(describeCrash('IBAN IT60 secret'))).not.toMatch(/IBAN/);
    });
});

describe('unhandledRejection', () => {
    test('object reason logs only the classified error (no spread)', () => {
        const logger = makeLogger();
        const promise = { toString: () => 'Promise SENTINEL_PROMISE' };
        handleUnhandledRejection(logger, { payee: 'SENTINEL_PAYEE', notes: 'SENTINEL_NOTES' }, promise);
        expect(logger.error).toHaveBeenCalledTimes(1);
        const [message, meta] = logger.error.mock.calls[0];
        expect(message).toBe('Unhandled promise rejection, service continues');
        expect(meta.event).toBe('sys_crash');
        expect(meta.error.type).toBe('object');
        expect(allLogged(logger)).not.toMatch(/SENTINEL/);
    });

    test('Error reason does not log the upstream message or stack text', () => {
        const logger = makeLogger();
        const e = new Error('SENTINEL_MESSAGE');
        e.stack = 'Error: SENTINEL_MESSAGE\n    at ourCode (/app/src/x.js:1:1)';
        handleUnhandledRejection(logger, e, Promise.resolve());
        expect(allLogged(logger)).not.toMatch(/SENTINEL_MESSAGE/);
    });

    test('own errors get frames at DEBUG only, without the message line', () => {
        const logger = makeLogger();
        const e = new Error('SENTINEL_MESSAGE');
        e.stack = 'Error: SENTINEL_MESSAGE\n    at ourCode (/app/src/x.js:1:1)';
        handleUnhandledRejection(logger, e, Promise.resolve());
        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(logger.debug.mock.calls)).toMatch(/ourCode/);
        expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/ourCode/);
    });

    test('api-originated rejection is process.rejection_benign at WARN', () => {
        const logger = makeLogger();
        const e = new Error('SENTINEL_MESSAGE');
        e.stack = 'Error: SENTINEL_MESSAGE\n    at handlers$1.api/bank-sync (/app/node_modules/@actual-app/api/dist/index.js:1:1)';
        handleUnhandledRejection(logger, e, Promise.resolve());
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][1].event).toBe('process.rejection_benign');
        expect(logger.debug).not.toHaveBeenCalled();
        expect(allLogged(logger)).not.toMatch(/SENTINEL_MESSAGE/);
    });
});

describe('uncaughtException', () => {
    test('logs sys_crash with a static message and no raw message or stack', () => {
        const logger = makeLogger();
        const e = new Error('SENTINEL_MESSAGE');
        handleUncaughtException(logger, e);
        const [message, meta] = logger.error.mock.calls[0];
        expect(message).toBe('Uncaught exception, service continues');
        expect(meta.event).toBe('sys_crash');
        expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/SENTINEL_MESSAGE/);
        expect(meta.stack).toBeUndefined();
    });
});

describe('warning', () => {
    test('logs name and code only', () => {
        const logger = makeLogger();
        const w = new Error('SENTINEL_MESSAGE');
        w.name = 'DeprecationWarning';
        w.code = 'DEP0005';
        handleWarning(logger, w);
        expect(logger.warn).toHaveBeenCalledWith('Process warning', expect.objectContaining({ event: 'process.warning' }));
        expect(allLogged(logger)).not.toMatch(/SENTINEL_MESSAGE/);
        expect(allLogged(logger)).toMatch(/DEP0005/);
    });
});

describe('before a logger exists', () => {
    test('a crash writes one classified JSON line to stderr and exits 1', () => {
        const spy = jest.spyOn(require('fs'), 'writeSync').mockImplementation(() => 0);
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
        handleUnhandledRejection(null, { payee: 'SENTINEL_PAYEE' }, Promise.resolve());
        expect(spy).toHaveBeenCalledTimes(1);
        const [fd, line] = spy.mock.calls[0];
        expect(fd).toBe(2);
        expect(JSON.parse(line)).toEqual(expect.objectContaining({ event: 'sys_crash', level: 'ERROR' }));
        expect(line).not.toMatch(/SENTINEL/);
        expect(exit).toHaveBeenCalledWith(1);
        spy.mockRestore();
        exit.mockRestore();
    });

    const { spawnSync } = require('child_process');
    const modPath = require.resolve('../lib/crashHandlers');
    const run = (code) => spawnSync(process.execPath, ['-e',
        `require(${JSON.stringify(modPath)}).installCrashHandlers(); ${code}`], { encoding: 'utf8' });

    test('a throw while loading exits 1 with the frames, as Node did before', () => {
        const r = run("setImmediate(() => { notDefinedSentinel(); });");
        expect(r.status).toBe(1);
        const rec = JSON.parse(r.stderr.trim().split('\n').pop());
        expect(rec.event).toBe('sys_crash');
        expect(rec.stack).toMatch(/^\s*at /);
        expect(r.stderr).not.toMatch(/notDefinedSentinel is not defined/);
    });

    test('an early rejection exits 1', () => {
        const r = run("Promise.reject(new Error('SENTINEL_MESSAGE'));");
        expect(r.status).toBe(1);
        expect(r.stderr).not.toMatch(/SENTINEL_MESSAGE/);
    });

    test('a warning is printed once, without Node\'s raw text', () => {
        const r = run("process.emitWarning('SENTINEL_WARNING text');");
        expect(r.status).toBe(0);
        expect(r.stderr).not.toMatch(/SENTINEL_WARNING/);
        expect(r.stderr.trim().split('\n')).toHaveLength(1);
    });
});

describe('uncaught exception with a logger', () => {
    test('frames go to a separate DEBUG record, never the message', () => {
        const logger = makeLogger();
        const e = new TypeError('SENTINEL_MESSAGE');
        e.stack = 'TypeError: SENTINEL_MESSAGE\n    at ourCode (/app/src/x.js:1:1)';
        handleUncaughtException(logger, e);
        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(logger.debug.mock.calls[0][1]).toEqual({ event: 'sys_crash.stack', frames: '    at ourCode (/app/src/x.js:1:1)' });
        expect(allLogged(logger)).not.toMatch(/SENTINEL_MESSAGE/);
    });
});

describe('installCrashHandlers', () => {
    test('registers each handler once and routes to the late logger', () => {
        const before = process.listenerCount('unhandledRejection');
        installCrashHandlers();
        installCrashHandlers();
        expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
        const logger = makeLogger();
        setCrashLogger(logger);
        const listeners = process.listeners('uncaughtException');
        listeners[listeners.length - 1](new Error('SENTINEL_MESSAGE'));
        expect(logger.error).toHaveBeenCalledTimes(1);
        process.removeListener('uncaughtException', listeners[listeners.length - 1]);
    });
});
