/**
 * Tests for log dir and file permissions (#446, D10).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('Logger file permissions (#446)', () => {
    let tmpDir;
    let Logger;

    const mode = (p) => fs.statSync(p).mode & 0o777;
    const flush = (logger) => new Promise((resolve) => {
        if (logger.rotatingStream) logger.rotatingStream.end(() => setTimeout(resolve, 50));
        else resolve();
    });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logperm-'));
        jest.resetModules();
        Logger = require('../lib/logger').Logger;
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('creates a new dir 0700 and rotating file 0600', async () => {
        const dir = path.join(tmpDir, 'new');
        const logger = new Logger({ logDir: dir, rotation: { enabled: true, maxSize: '10M', maxFiles: 5 } });
        logger.info('hello');
        await flush(logger);
        expect(mode(dir)).toBe(0o700);
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) expect(mode(path.join(dir, f))).toBe(0o600);
    });

    test('creates the plain daily file 0600 when rotation is off', () => {
        const dir = path.join(tmpDir, 'plain');
        const logger = new Logger({ logDir: dir, rotation: { enabled: false } });
        logger.info('hello');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
        expect(files.length).toBe(1);
        expect(mode(path.join(dir, files[0]))).toBe(0o600);
    });

    test('tightens an existing dir and existing log files at startup', () => {
        const dir = path.join(tmpDir, 'old');
        fs.mkdirSync(dir, { mode: 0o775 });
        fs.chmodSync(dir, 0o775);
        const file = path.join(dir, 'svc-2026-01-01.log');
        fs.writeFileSync(file, 'x\n');
        fs.chmodSync(file, 0o664);
        const other = path.join(dir, 'notes.txt');
        fs.writeFileSync(other, 'x');
        fs.chmodSync(other, 0o664);
        new Logger({ logDir: dir, rotation: { enabled: false } });
        expect(mode(dir)).toBe(0o700);
        expect(mode(file)).toBe(0o600);
        expect(mode(other)).toBe(0o664);
    });

    test('a chmod failure never throws and warns once with a static message', () => {
        const dir = path.join(tmpDir, 'fail');
        fs.mkdirSync(dir);
        jest.spyOn(fs, 'chmodSync').mockImplementation(() => { throw new Error(`EPERM ${dir}`); });
        expect(() => new Logger({ logDir: dir, rotation: { enabled: false } })).not.toThrow();
        expect(() => new Logger({ logDir: dir, rotation: { enabled: false } })).not.toThrow();
        const warns = console.warn.mock.calls.filter((c) => /permissions/.test(c[0]));
        expect(warns).toHaveLength(1);
        expect(warns[0]).toHaveLength(1);
        expect(warns[0][0]).not.toContain(dir);
    });
});
