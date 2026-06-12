/**
 * Map a `config.logging` block to the options object passed to createLogger().
 *
 * Only the keys the logger actually consumes are forwarded, and undefined ones
 * are dropped so the logger's own defaults apply. Centralising this mapping
 * stops a documented `logging.*` option from being silently lost on the way to
 * the logger — which is exactly how `redact` and `fileFormat` were unreachable
 * before (the inline assembly copied a hand-picked subset). (#116)
 */

// Keys of config.logging the logger reads. Runtime-only logger options
// (serviceName, broadcastCallback, context, inheritStreams) are NOT config and
// are intentionally excluded.
const LOGGER_CONFIG_KEYS = [
    'level',
    'format',
    'fileFormat',
    'logDir',
    'rotation',
    'syslog',
    'performance',
    'redact'
];

/**
 * @param {object} [logging] the `config.logging` object (may be undefined)
 * @returns {object} logger options with only defined, logger-consumed keys
 */
function buildLoggerConfig(logging = {}) {
    const cfg = {};
    if (!logging || typeof logging !== 'object') return cfg;
    for (const key of LOGGER_CONFIG_KEYS) {
        if (logging[key] !== undefined) cfg[key] = logging[key];
    }
    return cfg;
}

module.exports = { buildLoggerConfig };
