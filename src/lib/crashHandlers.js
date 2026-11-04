/**
 * Process crash handlers (#439, design D5, D6).
 *
 * Records are classified, never echoed: no `{...reason}` spread, no
 * `promise.toString()`, and the upstream message is never logged. A rejection
 * reason can be an @actual-app/api response body carrying payees, notes or
 * amounts, and secret masking does not catch personal data.
 *
 * The handlers are installed first in index.js, before the logger exists.
 * Until setCrashLogger() is called, a crash is written as one JSON line to
 * stderr with a synchronous write and the process exits 1: a crash while
 * the service is still loading (a module that fails to load, a bad top-level
 * statement) cannot be survived, and Node itself would have exited 1. Once
 * the logger is set, the service keeps running afterwards, as before.
 */

const fs = require('fs');
const { classifyRejection } = require('./rejectionClassifier');
const { classifyError, realFrames } = require('./errorClassifier');

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;

let crashLogger = null;
let installed = false;

function setCrashLogger(logger) {
    crashLogger = logger || null;
}

/** One classifier for every error record (#438): see errorClassifier.js. */
const describeCrash = classifyError;

// Frames only: the first stack line repeats the message.
function framesOf(error) {
    if (!(error instanceof Error) || typeof error.stack !== 'string') return undefined;
    const header = String(error);
    return realFrames(error.stack.startsWith(header) ? error.stack.slice(header.length) : '');
}

function writeStderr(level, event, message, error, stack) {
    const line = JSON.stringify({
        timestamp: new Date().toISOString(), level, event, message, error,
        ...(stack ? { stack } : {})
    }) + '\n';
    try {
        fs.writeSync(2, line);
    } catch (_) { /* nothing left to try */ }
}

function emit(logger, level, event, message, error) {
    if (!logger) {
        writeStderr(level.toUpperCase(), event, message, error);
        return;
    }
    logger[level](message, { event, error });
}

// Before the logger exists nothing is loaded yet, so there is no budget data
// to leak: the frames go into the stderr record and the process exits 1.
function crashBeforeLogger(message, reason) {
    writeStderr('ERROR', 'sys_crash', message, describeCrash(reason), framesOf(reason));
    process.exit(1);
}

function logFrames(logger, message, reason) {
    const stack = framesOf(reason);
    if (stack) logger.debug(message, { event: 'sys_crash.stack', stack });
}

function handleUncaughtException(logger, error) {
    if (!logger) return crashBeforeLogger('Uncaught exception during startup, exiting', error);
    emit(logger, 'error', 'sys_crash', 'Uncaught exception, service continues', describeCrash(error));
    logFrames(logger, 'Uncaught exception stack', error);
}

function handleUnhandledRejection(logger, reason) {
    const error = describeCrash(reason);
    // Already-handled @actual-app/api rejections are a WARN of their own event
    // so they are not counted as crashes (#105).
    if (classifyRejection(reason) === 'debug') {
        emit(logger, 'warn', 'process.rejection_benign', 'Unhandled promise rejection already reported by the sync path', error);
        return;
    }
    if (!logger) return crashBeforeLogger('Unhandled promise rejection during startup, exiting', reason);
    emit(logger, 'error', 'sys_crash', 'Unhandled promise rejection, service continues', error);
    logFrames(logger, 'Unhandled promise rejection stack', reason);
}

function handleWarning(logger, warning) {
    emit(logger, 'warn', 'process.warning', 'Process warning',
        { type: String((warning && warning.name) || 'Warning').slice(0, 60),
          ...(warning && SAFE_CODE.test(String(warning.code)) ? { code: warning.code } : {}) });
}

/** Register the handlers once. Safe to call from index.js before any config. */
function installCrashHandlers() {
    if (installed) return;
    installed = true;
    process.on('uncaughtException', (error) => handleUncaughtException(crashLogger, error));
    process.on('unhandledRejection', (reason) => handleUnhandledRejection(crashLogger, reason));
    // Node's own warning printer is a listener too and prints the raw text:
    // remove it so only the classified record is written.
    process.removeAllListeners('warning');
    process.on('warning', (warning) => handleWarning(crashLogger, warning));
}

module.exports = {
    describeCrash,
    handleUncaughtException,
    handleUnhandledRejection,
    handleWarning,
    installCrashHandlers,
    setCrashLogger
};
