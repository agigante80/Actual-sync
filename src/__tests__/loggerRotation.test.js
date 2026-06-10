/**
 * Tests for time-based log rotation interval (#106).
 *
 * Kept in a separate file so `rotating-file-stream` can be mocked at the module
 * level without affecting the real-stream rotation tests in logger.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Logger rotation interval (#106)', () => {
    let createStreamMock;
    let Logger;
    let tmpDir;
    let consoleLogSpy;
    let consoleErrorSpy;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-'));
        jest.resetModules();
        createStreamMock = jest.fn(() => ({ write: jest.fn(), end: jest.fn() }));
        jest.doMock('rotating-file-stream', () => ({ createStream: createStreamMock }));
        Logger = require('../lib/logger').Logger;
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        jest.resetModules();
        jest.clearAllMocks();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('passes interval "1d" to createStream by default (interval key absent)', () => {
        new Logger({ logDir: tmpDir, rotation: { enabled: true, maxSize: '10M', maxFiles: 30 } });
        expect(createStreamMock).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({ interval: '1d', maxFiles: 30 })
        );
    });

    test('honors a custom rotation.interval', () => {
        new Logger({ logDir: tmpDir, rotation: { enabled: true, maxSize: '10M', maxFiles: 30, interval: '1h' } });
        expect(createStreamMock).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({ interval: '1h' })
        );
    });

    test('passes maxFiles alongside interval (retention applies)', () => {
        new Logger({ logDir: tmpDir, rotation: { enabled: true, maxFiles: 7 } });
        expect(createStreamMock).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({ interval: '1d', maxFiles: 7 })
        );
    });

    test('sets rotatingStream to null and logs an error when createStream throws', () => {
        createStreamMock.mockImplementation(() => { throw new Error('rfs boom'); });
        const logger = new Logger({ logDir: tmpDir, rotation: { enabled: true } });
        expect(logger.rotatingStream).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalled();
    });

    test('child shares the parent rotating stream without opening its own', () => {
        const parent = new Logger({ logDir: tmpDir, rotation: { enabled: true } });
        const child = parent.child({ scope: 'x' });
        expect(child.rotatingStream).toBe(parent.rotatingStream);
        // createStream is called once (parent only); the child must not open and
        // orphan a second stream + rotation timer on every child() call. (#106)
        expect(createStreamMock).toHaveBeenCalledTimes(1);
    });
});
