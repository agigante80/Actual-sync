#!/usr/bin/env node
/**
 * version-bump.js
 *
 * Bumps the project version and keeps VERSION, package.json, and
 * package-lock.json in sync — the single source of truth is package.json's
 * `version` field.
 *
 * Usage:
 *   node scripts/version-bump.js [major|minor|patch] [--force]
 *
 * npm script:
 *   npm run version:bump -- patch
 *
 * --force skips the production-tag freshness check (see below). Only use it
 * when you know the remote tags are wrong.
 *
 * Freshness check: before bumping, the script queries origin's tags and aborts
 * if the local version is BEHIND the latest released `vX.Y.Z` tag. This guards
 * against two independent bumps colliding on the same number (e.g. a scheduled
 * auto-release and a local manual bump producing the same version).
 */
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const VERSION_FILE = 'VERSION';
const PKG_FILE = 'package.json';
const LOCK_FILE = 'package-lock.json';

const bumpType = process.argv[2] || 'patch';
const force = process.argv.includes('--force');

if (!['major', 'minor', 'patch'].includes(bumpType)) {
  console.error(`✖ Unknown bump type "${bumpType}". Use major, minor, or patch.`);
  process.exit(1);
}

const parseSemver = (v) => {
  const parts = String(v).trim().replace(/^v/, '').split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`Invalid semver: "${v}"`);
  }
  return parts;
};

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const currentVersion = pkg.version;
const [maj, min, pat] = parseSemver(currentVersion);

// Warn (and self-heal) if VERSION has drifted from package.json.
const versionFile = fs.existsSync(VERSION_FILE)
  ? fs.readFileSync(VERSION_FILE, 'utf8').trim()
  : null;
if (versionFile && versionFile !== currentVersion) {
  console.warn(`⚠ VERSION (${versionFile}) differs from package.json (${currentVersion}); both will be set to the new version.`);
}

// ── Production-tag freshness check ───────────────────────────────────────────
if (!force) {
  try {
    const lsRemote = execFileSync('git', ['ls-remote', '--tags', 'origin', 'refs/tags/v*.*.*'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const remote = [...new Set(
      lsRemote.split('\n')
        .map((l) => (l.match(/refs\/tags\/(v\d+\.\d+\.\d+)(?:\^\{\})?$/) || [])[1])
        .filter(Boolean),
    )]
      .map((t) => parseSemver(t))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

    if (remote.length) {
      const latest = remote[remote.length - 1];
      const cmp = (maj - latest[0]) || (min - latest[1]) || (pat - latest[2]);
      if (cmp < 0) {
        console.error(`✖ Local version ${currentVersion} is behind the latest released tag v${latest.join('.')}.`);
        console.error('  Merge origin/main locally first, or re-run with --force if the tag is wrong.');
        process.exit(1);
      }
    }
  } catch (err) {
    console.warn(`⚠ Could not query origin tags (${(err && err.message) || err}); skipping freshness check.`);
  }
}

let next;
if (bumpType === 'major') next = `${maj + 1}.0.0`;
else if (bumpType === 'minor') next = `${maj}.${min + 1}.0`;
else next = `${maj}.${min}.${pat + 1}`;

// Write VERSION
fs.writeFileSync(VERSION_FILE, `${next}\n`);

// Write package.json
pkg.version = next;
fs.writeFileSync(PKG_FILE, `${JSON.stringify(pkg, null, 2)}\n`);

// Write package-lock.json (both version fields, if present)
if (fs.existsSync(LOCK_FILE)) {
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(`✅ Bumped version ${currentVersion} → ${next} (${bumpType})`);
console.log('   Updated: VERSION, package.json' + (fs.existsSync(LOCK_FILE) ? ', package-lock.json' : ''));
