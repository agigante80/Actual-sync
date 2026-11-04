/**
 * Bootstrap logger (#442, docs/plans/logging-architecture.md D6).
 *
 * Output produced before the root logger exists (startup banner, config
 * validation warnings, load failures) goes through here instead of raw
 * console calls. It needs no config: the built-in redaction (secret key
 * names, token and credential patterns) and control-char escaping apply to
 * every record. Records are buffered, then either flushed into the root
 * logger once it exists (flushTo) or, if startup dies first, written as JSON
 * lines to stderr (dumpToStderr, also run on process exit while records are
 * still buffered, so an early crash never loses them).
 */
const fs = require('fs');
const { Logger } = require('./logger');

const LEVELS = ['error', 'warn', 'info', 'debug'];

let buffer = [];
let engine = null; // lazily built: only used for redact() and serialize()
let exitHookInstalled = false;
let target = null; // root logger once handed off: later records (config re-validation at runtime) go straight to it

function getEngine() {
    if (!engine) engine = new Logger({ logDir: null, format: 'json' });
    return engine;
}

function record(level, message, meta) {
    if (target) {
        target[level](String(message), meta);
        return;
    }
    const e = getEngine();
    buffer.push({
        level,
        message: e.redact(String(message)),
        meta: meta && typeof meta === 'object' ? e.redact(meta) : undefined
    });
}

/** Write buffered records to stderr as JSON lines (synchronously) and clear them. */
function dumpToStderr() {
    const e = getEngine();
    const pending = buffer;
    buffer = [];
    for (const r of pending) {
        const line = e.serialize(r.level, r.message, undefined, r.meta, 'json');
        try {
            fs.writeSync(2, line + '\n');
        } catch (_) {
            // stderr closed: nothing left to report to
        }
    }
}

/**
 * Replay buffered records into the root logger, in order, clear them, and
 * route every later record straight to it.
 */
function flushTo(logger) {
    target = logger;
    const pending = buffer;
    buffer = [];
    for (const r of pending) {
        logger[r.level](r.message, r.meta);
    }
}

/**
 * Dump anything still buffered when the process exits, so a startup that
 * dies before the root logger exists still leaves its records on stderr.
 */
function installExitDump() {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.on('exit', dumpToStderr);
}

/** Buffered records, redacted (copy). */
function records() {
    return buffer.map(r => ({ ...r }));
}

/** Drop buffered records and the handoff (tests). */
function reset() {
    buffer = [];
    target = null;
}

const bootstrapLogger = { dumpToStderr, flushTo, installExitDump, records, reset };
for (const level of LEVELS) {
    bootstrapLogger[level] = (message, meta) => record(level, message, meta);
}

module.exports = bootstrapLogger;
