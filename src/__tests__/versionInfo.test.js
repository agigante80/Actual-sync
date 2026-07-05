/**
 * Tests for version-compatibility helpers (#154).
 */

const {
    getClientVersion,
    fetchServerVersion,
    compareVersions,
    describeCompatibility,
    _resetClientVersionCache,
} = require('../lib/versionInfo');

describe('getClientVersion (#154)', () => {
    beforeEach(() => _resetClientVersionCache());

    test('reads the installed @actual-app/api version (X.Y.Z)', () => {
        const v = getClientVersion();
        expect(v).toMatch(/^\d+\.\d+\.\d+/);
    });

    test('memoises the result (second call returns the same value)', () => {
        expect(getClientVersion()).toBe(getClientVersion());
    });
});

describe('compareVersions (#154)', () => {
    test('equal versions are compatible', () => {
        expect(compareVersions('26.7.0', '26.7.0')).toBe('compatible');
    });

    test('server minor ahead -> server-ahead', () => {
        expect(compareVersions('26.7.0', '26.9.0')).toBe('server-ahead');
    });

    test('server major ahead -> server-ahead', () => {
        expect(compareVersions('26.7.0', '27.0.0')).toBe('server-ahead');
    });

    test('server behind (minor) -> server-behind', () => {
        expect(compareVersions('26.7.0', '26.6.0')).toBe('server-behind');
    });

    test('server behind (major) -> server-behind', () => {
        expect(compareVersions('27.1.0', '26.9.0')).toBe('server-behind');
    });

    test('patch/prerelease differences do not affect the major.minor verdict', () => {
        expect(compareVersions('26.7.0', '26.7.5')).toBe('compatible');
        expect(compareVersions('26.7.0', '26.7.0-rc.1')).toBe('compatible');
    });

    test('unparseable or missing versions -> unknown', () => {
        expect(compareVersions(null, '26.7.0')).toBe('unknown');
        expect(compareVersions('26.7.0', null)).toBe('unknown');
        expect(compareVersions('not-a-version', '26.7.0')).toBe('unknown');
    });
});

describe('fetchServerVersion (#154)', () => {
    const okResponse = (version) => ({
        ok: true,
        json: async () => ({ build: { name: '@actual-app/sync-server', version } }),
    });

    test('returns build.version from /info', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(okResponse('26.6.0'));
        const v = await fetchServerVersion('http://server:5006', { fetchImpl });
        expect(v).toBe('26.6.0');
        expect(fetchImpl).toHaveBeenCalledWith('http://server:5006/info', expect.any(Object));
    });

    test('strips a trailing slash from the server URL', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(okResponse('26.6.0'));
        await fetchServerVersion('http://server:5006/', { fetchImpl });
        expect(fetchImpl).toHaveBeenCalledWith('http://server:5006/info', expect.any(Object));
    });

    test('non-ok response -> null (non-fatal)', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: false });
        expect(await fetchServerVersion('http://server:5006', { fetchImpl })).toBeNull();
    });

    test('network error -> null (non-fatal)', async () => {
        const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        expect(await fetchServerVersion('http://server:5006', { fetchImpl })).toBeNull();
    });

    test('missing build.version -> null', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
        expect(await fetchServerVersion('http://server:5006', { fetchImpl })).toBeNull();
    });

    test('no fetch implementation available -> null', async () => {
        expect(await fetchServerVersion('http://server:5006', { fetchImpl: null })).toBeNull();
    });
});

describe('describeCompatibility (#154)', () => {
    test('server-ahead is a WARN with an update recommendation', () => {
        const d = describeCompatibility({ serverName: 'Main', serverVersion: '27.0.0', clientVersion: '26.7.0' });
        expect(d.verdict).toBe('server-ahead');
        expect(d.level).toBe('warn');
        expect(d.message).toMatch(/AHEAD/);
        expect(d.message).toMatch(/update Actual-sync/);
        expect(d.testedUpTo).toBe('26.7.0');
        expect(d.serverVersion).toBe('27.0.0');
    });

    test('server-behind is an INFO, compatible', () => {
        const d = describeCompatibility({ serverName: 'Main', serverVersion: '26.6.0', clientVersion: '26.7.0' });
        expect(d.verdict).toBe('server-behind');
        expect(d.level).toBe('info');
        expect(d.message).toMatch(/compatible/);
    });

    test('equal versions -> compatible INFO', () => {
        const d = describeCompatibility({ serverName: 'Main', serverVersion: '26.7.0', clientVersion: '26.7.0' });
        expect(d.verdict).toBe('compatible');
        expect(d.level).toBe('info');
    });

    test('unknown server version -> unknown verdict, INFO, graceful message', () => {
        const d = describeCompatibility({ serverName: 'Main', serverVersion: null, clientVersion: '26.7.0' });
        expect(d.verdict).toBe('unknown');
        expect(d.level).toBe('info');
        expect(d.serverVersion).toBeNull();
        expect(d.message).toMatch(/could not be determined/);
    });
});
