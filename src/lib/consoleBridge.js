/**
 * Console bridge (#426). @actual-app/api prints through the global console and
 * offers no logger hook; its warn and error are not gated by `verbose`. While
 * installed, those calls become one static record on a `component: actual-api`
 * child logger (redaction, level and format apply). The arguments are dropped
 * because they can carry transaction objects or upstream text. With
 * `verbose` (logging.actualApiVerbose) a masked, capped `consolePreview` is
 * added. Records never go to /ws/logs.
 *
 * Scope: install around the Actual session only and call the returned restore
 * in a finally. Our own Logger writes to console too; the logger's prototype `log` is
 * wrapped while installed so those writes pass straight through instead of
 * being captured (and recursing).
 */
const util = require('util');

const METHOD_LEVEL = {
    error: 'error',
    warn: 'warn',
    log: 'info',
    info: 'info',
    group: 'info',
    groupCollapsed: 'info',
    debug: 'debug',
};
const SWALLOWED = ['groupEnd'];
const PREVIEW_MAX = 300;
const MESSAGE = 'Actual API console output';

let depth = 0;
let saved = null; // { console: {method: fn}, log: fn }
let ownWrite = 0;
let active = null; // { logger, child, verbose }

/**
 * Run fn with the bridge bypassed. The logger's own async diagnostics (a
 * syslog send callback, a transport onError) run after log() returned, so the
 * prototype wrap does not cover them; without this they would be captured,
 * logged to the failing sink again and loop for the whole session (#426).
 */
function passThrough(fn) {
    ownWrite++;
    try {
        return fn();
    } finally {
        ownWrite--;
    }
}

function emit(method, args) {
    const { logger, child, verbose } = active;
    const meta = { event: 'third_party.console' };
    if (verbose) {
        const masked = logger.maskSecrets(util.format(...args));
        meta.consolePreview = masked.slice(0, PREVIEW_MAX);
    }
    // Pass-through guard: the child logger writes to console itself.
    ownWrite++;
    try {
        child[METHOD_LEVEL[method]](MESSAGE, meta);
    } finally {
        ownWrite--;
    }
}

function install(logger) {
    // The prototype comes from the instance (not an import) so a stubbed
    // logger, which has no own prototype `log`, is simply left alone.
    const proto = Object.getPrototypeOf(logger);
    const wrap = proto && proto !== Object.prototype && typeof proto.log === 'function';
    saved = { console: {}, proto: wrap ? proto : null, log: wrap ? proto.log : null };
    if (wrap) {
        const origLog = saved.log;
        proto.log = function (...a) {
            ownWrite++;
            try {
                return origLog.apply(this, a);
            } finally {
                ownWrite--;
            }
        };
    }
    for (const method of [...Object.keys(METHOD_LEVEL), ...SWALLOWED]) {
        const original = console[method];
        saved.console[method] = original;
        console[method] = (...args) => {
            if (ownWrite > 0 || !active) return original.apply(console, args);
            if (SWALLOWED.includes(method)) return undefined;
            try {
                emit(method, args);
            } catch (_) {
                // A logging failure must never break the Actual call.
            }
            return undefined;
        };
    }
}

function uninstall() {
    for (const [method, fn] of Object.entries(saved.console)) console[method] = fn;
    if (saved.proto) saved.proto.log = saved.log;
    saved = null;
    active = null;
}

/**
 * @param {Logger} logger root or server logger (its context is kept)
 * @param {{verbose?: boolean}} [options]
 * @returns {() => void} restore; idempotent
 */
function installConsoleBridge(logger, options = {}) {
    if (depth === 0) install(logger);
    depth++;
    // One child per install, not per upstream line: building a logger with a
    // logDir probes the directory on disk each time.
    const child = logger.child({ component: 'actual-api' });
    child.broadcastCallback = null; // never to /ws/logs
    active = { logger, child, verbose: options.verbose === true };
    let done = false;
    return function restore() {
        if (done) return;
        done = true;
        depth--;
        if (depth === 0) uninstall();
    };
}

module.exports = { installConsoleBridge, passThrough };
