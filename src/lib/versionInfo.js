/**
 * Version-compatibility helpers.
 *
 * "Tested up to" = the installed @actual-app/api client version. Actual-sync is
 * validated against whatever client version ships, because the dependency-update
 * workflow only merges a client bump after the full test suite passes against it.
 * So reading the installed version at runtime gives an always-current, self-
 * maintaining "supported" ceiling — no hardcoded constant.
 *
 * The Actual sync server (@actual-app/sync-server) and the client (@actual-app/api)
 * are released in lockstep on the same X.Y.Z scheme, so client-vs-server version
 * comparison is meaningful.
 */

const fs = require('fs');
const path = require('path');

let cachedClientVersion; // resolved once; undefined = not yet attempted, null = unavailable

/**
 * Read the installed @actual-app/api version.
 * `require('@actual-app/api/package.json')` is blocked by the package's `exports`
 * field, so resolve the package main and walk up to its package.json on disk.
 * @returns {string|null} version string (e.g. "26.7.0") or null if unresolvable
 */
function getClientVersion() {
    if (cachedClientVersion !== undefined) {
        return cachedClientVersion;
    }
    cachedClientVersion = null;
    try {
        let dir = path.dirname(require.resolve('@actual-app/api'));
        for (let i = 0; i < 8; i++) {
            const pkgPath = path.join(dir, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (parsed.name === '@actual-app/api' && parsed.version) {
                    cachedClientVersion = parsed.version;
                    break;
                }
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    } catch {
        // leave cachedClientVersion = null
    }
    return cachedClientVersion;
}

/**
 * Fetch the Actual server version from its unauthenticated `/info` endpoint.
 * Non-fatal by design: any failure (unreachable, timeout, unexpected body)
 * resolves to null so a diagnostic never blocks a sync.
 * @param {string} serverUrl
 * @param {{ timeoutMs?: number, fetchImpl?: Function }} [opts]
 * @returns {Promise<string|null>}
 */
async function fetchServerVersion(serverUrl, opts = {}) {
    const { timeoutMs = 5000, fetchImpl = globalThis.fetch } = opts;
    if (!serverUrl || typeof fetchImpl !== 'function') {
        return null;
    }
    const base = String(serverUrl).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(`${base}/info`, { signal: controller.signal });
        if (!res || !res.ok) return null;
        const body = await res.json();
        const version = body?.build?.version;
        return typeof version === 'string' && version ? version : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Parse "X.Y.Z[-suffix]" into {major, minor}; null if not parseable. */
function parseMajorMinor(version) {
    if (typeof version !== 'string') return null;
    const m = version.match(/^(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]) };
}

/**
 * Compare the installed client ("tested up to") against a server version.
 * Only major.minor is compared (patch/prerelease is not compatibility-relevant here).
 * @returns {'compatible'|'server-behind'|'server-ahead'|'unknown'}
 */
function compareVersions(clientVersion, serverVersion) {
    const client = parseMajorMinor(clientVersion);
    const server = parseMajorMinor(serverVersion);
    if (!client || !server) return 'unknown';
    if (server.major > client.major) return 'server-ahead';
    if (server.major < client.major) return 'server-behind';
    if (server.minor > client.minor) return 'server-ahead';
    if (server.minor < client.minor) return 'server-behind';
    return 'compatible';
}

/**
 * Build a per-server compatibility descriptor suitable for logging and the dashboard.
 * @param {{ serverName?: string, serverVersion: string|null, clientVersion?: string|null }} args
 * @returns {{ testedUpTo: string|null, serverVersion: string|null, verdict: string, level: 'info'|'warn', message: string }}
 */
function describeCompatibility({ serverName, serverVersion, clientVersion } = {}) {
    const testedUpTo = clientVersion === undefined ? getClientVersion() : clientVersion;
    const verdict = compareVersions(testedUpTo, serverVersion);
    const who = serverName ? `server "${serverName}"` : 'the server';

    let level = 'info';
    let message;
    switch (verdict) {
        case 'server-ahead':
            level = 'warn';
            message = `Actual-sync is tested up to @actual-app/api ${testedUpTo}; ${who} is running ${serverVersion} — server is AHEAD; update Actual-sync (the budget's migrations may be newer than this client supports).`;
            break;
        case 'server-behind':
            message = `Actual-sync is tested up to @actual-app/api ${testedUpTo}; ${who} is running ${serverVersion} — compatible (server is behind; the client is backward-compatible).`;
            break;
        case 'compatible':
            message = `Actual-sync is tested up to @actual-app/api ${testedUpTo}; ${who} is running ${serverVersion} — compatible.`;
            break;
        default: // unknown
            message = `Actual-sync is tested up to @actual-app/api ${testedUpTo || 'unknown'}; ${who} version could not be determined (${serverVersion || 'unknown'}).`;
            break;
    }
    return { testedUpTo: testedUpTo || null, serverVersion: serverVersion || null, verdict, level, message };
}

// Test seam: reset the memoised client version.
function _resetClientVersionCache() {
    cachedClientVersion = undefined;
}

module.exports = {
    getClientVersion,
    fetchServerVersion,
    compareVersions,
    describeCompatibility,
    _resetClientVersionCache,
};
