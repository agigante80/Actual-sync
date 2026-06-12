'use strict';

const path = require('path');

// Default reader: the version baked into package.json at the repo root.
// Isolated so tests can inject a throwing reader to exercise the unreadable path.
function readPackageVersion() {
    return require(path.join(__dirname, '..', '..', 'package.json')).version;
}

/**
 * Resolve the service version (#132).
 *
 * Prefers an explicit `VERSION` — CI passes the real build version via the
 * Docker `--build-arg`. But the Dockerfile defaults `ARG VERSION=unknown`, so a
 * plain `docker build` with no build-arg leaves `process.env.VERSION` set to the
 * literal "unknown". Treat both unset and "unknown" as "fall back to
 * package.json", so the baked-in version is reported instead. "unknown" is only
 * returned when package.json itself can't be read.
 *
 * @param {string} [envVersion] value of `process.env.VERSION`
 * @param {() => string} [readVersion] package.json version reader (for testing)
 * @returns {string}
 */
function resolveVersion(envVersion = process.env.VERSION, readVersion = readPackageVersion) {
    if (envVersion && envVersion !== 'unknown') return envVersion;
    try {
        return readVersion();
    } catch (error) {
        return 'unknown';
    }
}

module.exports = { resolveVersion };
