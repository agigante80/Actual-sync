'use strict';

const { enhanceActualApiError } = require('../lib/actualApiError');

const makeLogger = () => ({ warn: jest.fn(), debug: jest.fn() });

const ctx = (overrides = {}) => ({
    phase: 'download',
    serverUrl: 'http://localhost:5006',
    syncId: 'test-sync-id',
    isEncrypted: false,
    ...overrides,
});

describe('enhanceActualApiError', () => {
    describe('empty / generic error handling', () => {
        test('download + encrypted → encryption key message', () => {
            const logger = makeLogger();
            const err = enhanceActualApiError(new Error(''), ctx({ isEncrypted: true }), logger);
            expect(err.message).toContain('network-failure during encryption key validation');
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('encryption key'));
        });

        test('download + not encrypted → budget download failed', () => {
            const logger = makeLogger();
            const err = enhanceActualApiError(new Error(''), ctx(), logger);
            expect(err.message).toContain('budget download failed');
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('budget download'));
        });

        test('other phase → sync operation failed', () => {
            const logger = makeLogger();
            const err = enhanceActualApiError(new Error(''), ctx({ phase: 'sync' }), logger);
            expect(err.message).toContain('sync operation failed');
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sync phase'));
        });

        test('null error → treated as empty', () => {
            const logger = makeLogger();
            const err = enhanceActualApiError(null, ctx(), logger);
            expect(err.message).toContain('budget download failed');
        });
    });

    describe('PostError detection', () => {
        test('error.type === PostError with reason → uses reason', () => {
            const logger = makeLogger();
            const error = Object.assign(new Error('raw'), { type: 'PostError', reason: 'budget not found' });
            const err = enhanceActualApiError(error, ctx(), logger);
            expect(err.message).toContain('budget not found');
            expect(logger.debug).toHaveBeenCalledWith('PostError detected with reason', { reason: 'budget not found' });
        });

        test('toString includes PostError: PostError: → extracts inner message', () => {
            const logger = makeLogger();
            const error = new Error('PostError: PostError: remote sync failed');
            const err = enhanceActualApiError(error, ctx(), logger);
            expect(err.message).toContain('remote sync failed');
        });

        test('stack includes PostError: PostError: → extracts from stack', () => {
            const logger = makeLogger();
            const error = new Error('outer');
            error.stack = 'Error: outer\n    at PostError: PostError: stack sync failed\n    at fn (x.js:1)';
            const err = enhanceActualApiError(error, ctx(), logger);
            expect(err.message).toContain('stack sync failed');
        });
    });

    describe('download phase troubleshooting details', () => {
        test('Could not get remote files → includes syncId and serverUrl, encryption hint when not encrypted', () => {
            const logger = makeLogger();
            const error = new Error('Could not get remote files');
            const err = enhanceActualApiError(error, ctx({ syncId: 'my-sync', serverUrl: 'http://srv' }), logger);
            expect(err.message).toContain('my-sync');
            expect(err.message).toContain('http://srv');
            expect(err.message).toContain('encryptionPassword');
        });

        test('Could not get remote files → no encryption hint when already encrypted', () => {
            const logger = makeLogger();
            const error = new Error('Could not get remote files');
            const err = enhanceActualApiError(error, ctx({ isEncrypted: true }), logger);
            expect(err.message).not.toContain('encryptionPassword');
        });

        test('network-failure + encrypted → encrypted server tips', () => {
            const logger = makeLogger();
            const error = new Error('network-failure during encryption key validation');
            const err = enhanceActualApiError(error, ctx({ isEncrypted: true, serverUrl: 'http://srv' }), logger);
            expect(err.message).toContain('encryptionPassword');
            expect(err.message).toContain('http://srv');
        });

        test('network-failure + not encrypted → plain server tips', () => {
            const logger = makeLogger();
            const error = new Error('network-failure: timeout');
            const err = enhanceActualApiError(error, ctx({ serverUrl: 'http://srv' }), logger);
            expect(err.message).toContain('http://srv');
            expect(err.message).toContain('server password');
        });

        test('decrypt-failure → password hint', () => {
            const logger = makeLogger();
            const error = new Error('decrypt-failure: bad key');
            const err = enhanceActualApiError(error, ctx(), logger);
            expect(err.message).toContain('encryptionPassword');
        });

        test('unauthorized → auth failure hint', () => {
            const logger = makeLogger();
            const error = new Error('unauthorized access');
            const err = enhanceActualApiError(error, ctx(), logger);
            expect(err.message).toContain('Authentication failed');
        });
    });

    describe('sync phase troubleshooting details', () => {
        test('network-failure during sync → network hint', () => {
            const logger = makeLogger();
            const error = new Error('network-failure during sync');
            const err = enhanceActualApiError(error, ctx({ phase: 'sync' }), logger);
            expect(err.message).toContain('Network connection lost during file synchronization');
        });

        test('sync-error → conflict hint', () => {
            const logger = makeLogger();
            const error = new Error('sync-error: conflict');
            const err = enhanceActualApiError(error, ctx({ phase: 'sync' }), logger);
            expect(err.message).toContain('conflict');
        });
    });

    describe('no troubleshooting detail', () => {
        test('unrecognised error message → returns original message unchanged', () => {
            const logger = makeLogger();
            const error = new Error('some totally unknown error');
            const err = enhanceActualApiError(error, ctx(), logger);
            expect(err.message).toBe('some totally unknown error');
        });
    });

    describe('error metadata preserved', () => {
        test('sets .phase, .originalError, .code, .errorCode', () => {
            const logger = makeLogger();
            const error = Object.assign(new Error('fail'), { code: 'ECONNREFUSED', errorCode: 'NET_ERR' });
            const err = enhanceActualApiError(error, ctx({ phase: 'download' }), logger);
            expect(err.phase).toBe('download');
            expect(err.originalError).toBe(error);
            expect(err.code).toBe('ECONNREFUSED');
            expect(err.errorCode).toBe('NET_ERR');
        });

        test('code and errorCode are undefined when original error has none', () => {
            const logger = makeLogger();
            const err = enhanceActualApiError(new Error('x'), ctx(), logger);
            expect(err.code).toBeUndefined();
            expect(err.errorCode).toBeUndefined();
        });
    });
});
