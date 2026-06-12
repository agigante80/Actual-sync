/**
 * Tests for version resolution (#132).
 *
 * The Dockerfile defaults `ARG VERSION=unknown`, so a plain `docker build` with
 * no `--build-arg` sets `process.env.VERSION` to the literal string "unknown" —
 * which is truthy and used to short-circuit the package.json fallback, making the
 * service report "unknown" everywhere despite the real version being baked in.
 * resolveVersion() treats unset OR "unknown" as "fall back to package.json".
 */
const { resolveVersion } = require('../lib/version');
const pkgVersion = require('../../package.json').version;

describe('resolveVersion (#132)', () => {
    it('uses an explicit VERSION when set to a real value', () => {
        expect(resolveVersion('1.2.3')).toBe('1.2.3');
        expect(resolveVersion('1.8.6-dev+abc1234')).toBe('1.8.6-dev+abc1234');
    });

    it('falls back to package.json when VERSION is unset', () => {
        expect(resolveVersion(undefined)).toBe(pkgVersion);
    });

    it('falls back to package.json when VERSION is the literal "unknown"', () => {
        expect(resolveVersion('unknown')).toBe(pkgVersion);
    });

    it('falls back to package.json when VERSION is an empty string', () => {
        expect(resolveVersion('')).toBe(pkgVersion);
    });

    it('returns "unknown" only when package.json is unreadable', () => {
        const boom = () => {
            throw new Error('ENOENT');
        };
        expect(resolveVersion(undefined, boom)).toBe('unknown');
        // an explicit value still wins even if package.json is unreadable
        expect(resolveVersion('9.9.9', boom)).toBe('9.9.9');
    });
});
