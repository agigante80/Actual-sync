'use strict';

/**
 * The `sys_startup` record (#443, design D8 in docs/plans/logging-architecture.md).
 *
 * One record replaces the banner and the scattered startup lines, so an
 * operator reading a pasted log can see the version, timezone, sinks and
 * privacy flags. Privacy rules:
 *   - booleans, counts and names from fixed sets only: no URLs, no
 *     credentials, no paths (a path under /home/<user> is personal data);
 *   - the config schema VERSION, never a hash of the values (a hash over a
 *     short password is an offline guessing oracle);
 *   - the only operator text is the cron schedules.
 * Every value is built here, field by field. Nothing is copied wholesale from
 * the config, so a new config key cannot leak into the record.
 */

const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const { getClientVersion } = require('./versionInfo');
const { resolveVersion } = require('./version');
const { resolveTimezone } = require('./timezone');
const { DEFAULT_PHASE_TIMEOUT_SECONDS } = require('./actualTimeouts');

// Bump when config/config.schema.json changes in a way that matters to an
// operator comparing two logs (a key added, removed or re-typed).
const CONFIG_SCHEMA_VERSION = 1;

const DEFAULT_LOG_DIR = './logs';
const DEFAULT_RETENTION_DAYS = 30; // the logger's default rotation.maxFiles

function isContainer() {
    try {
        return fs.existsSync('/.dockerenv');
    } catch {
        return false;
    }
}

function hasEntries(list) {
    return Array.isArray(list) && list.some((entry) => entry && entry.enabled !== false);
}

function enabledChannels(notifications = {}) {
    const webhooks = notifications.webhooks || {};
    return {
        email: notifications.email?.enabled === true,
        telegram: notifications.telegram?.enabled === true,
        slack: hasEntries(webhooks.slack),
        discord: hasEntries(webhooks.discord),
        webhook: hasEntries(webhooks.generic),
        ntfy: notifications.ntfy?.enabled === true
    };
}

function usesCustomDataDir(servers) {
    const defaultRoot = path.resolve('data');
    return servers.some((s) => {
        if (typeof s.dataDir !== 'string') return false;
        const rel = path.relative(defaultRoot, path.resolve(s.dataDir));
        return rel.startsWith('..') || path.isAbsolute(rel);
    });
}

function uniqueSchedules(config) {
    const set = new Set();
    for (const s of config.servers) {
        const cron = s.sync?.schedule ?? config.sync?.schedule;
        if (typeof cron === 'string') set.add(cron);
    }
    return [...set];
}

/**
 * @param {Object} config loaded and defaulted config
 * @param {Object} logger the root logger (its activeSinks() is reported)
 * @param {Object} [opts] test seams: container, now
 * @returns {Object} flat, privacy-safe fields for logger.security('sys_startup', ...)
 */
function buildStartupRecord(config, logger, opts = {}) {
    const servers = Array.isArray(config.servers) ? config.servers : [];
    const cfg = { ...config, servers };
    const logging = config.logging || {};
    const timezone = resolveTimezone(config);
    // Effective state from the logger, not the raw config: the logger turns file
    // logging off when the directory is not writable (#443 review L1).
    const fileLogging = Boolean(logger.logDir);
    const rotation = logging.rotation || {};
    const dashboard = config.healthCheck?.dashboard || {};

    return {
        appVersion: resolveVersion() || 'unknown',
        nodeVersion: process.version,
        actualApiVersion: getClientVersion(),
        pid: process.pid,
        platform: process.platform,
        container: opts.container !== undefined ? opts.container : isContainer(),
        timezone,
        utcOffset: moment.tz(opts.now || new Date(), timezone).format('Z'),
        logLevel: String(logging.level || 'INFO').toUpperCase(),
        actualApiVerbose: logging.actualApiVerbose === true,
        // Configured sinks. With the dashboard off, /ws/logs refuses every client,
        // so websocket is not a sink (#443 review L2).
        sinks: logger.activeSinks().filter((s) => s !== 'websocket' || dashboard.enabled !== false),
        customLogDir: fileLogging && path.resolve(logger.logDir) !== path.resolve(DEFAULT_LOG_DIR),
        customDataDir: usesCustomDataDir(servers),
        retentionDays: fileLogging && rotation.enabled !== false ? (rotation.maxFiles ?? DEFAULT_RETENTION_DAYS) : null,
        // The logger's own gate, not the raw config: a logger built without the
        // option omits names whatever the config says (#448).
        includeAccountNames: logger.includeAccountNames === true,
        serverCount: servers.length,
        cronSchedules: uniqueSchedules(cfg),
        channelsEnabled: enabledChannels(config.notifications),
        dashboardEnabled: dashboard.enabled !== false,
        dashboardBind: `${config.healthCheck?.host || '0.0.0.0'}:${config.healthCheck?.port || 3000}`,
        dashboardAuth: dashboard.auth?.type || 'none',
        tls: false, // the HTTP server is plain http; TLS is terminated by a proxy
        timeouts: { phaseTimeoutSeconds: config.sync?.phaseTimeoutSeconds ?? DEFAULT_PHASE_TIMEOUT_SECONDS },
        configSchemaVersion: CONFIG_SCHEMA_VERSION
    };
}

module.exports = { buildStartupRecord, CONFIG_SCHEMA_VERSION };
