/**
 * Unit tests for Logger
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Logger, createLogger, withCorrelation, currentCorrelationId, LOG_LEVELS, LEVEL_NAMES } = require('../lib/logger');
const {
    createTempDir,
    cleanupTempDir,
    suppressConsole
} = require('./helpers/testHelpers');

/**
 * Log through the REAL entry point and return the line the console writer
 * actually emitted.
 *
 * These assertions used to call `logger.formatLog(...)`, a parallel wrapper no
 * log line went through (#187). The redaction logic was the same — `maskSecrets`
 * and `redact` are shared — but a masking guarantee is only worth what the
 * writing path does, so they now assert on that. `format` is the console
 * serialization format the writer reads from `this.format`.
 */
const emit = (logger, message, meta, format) => {
    if (format) logger.format = format;
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        logger.info(message, meta);
        return spy.mock.calls.at(-1)[0];
    } finally {
        spy.mockRestore();
    }
};

describe('Logger', () => {
    let tempDir;
    let consoleSuppress;

    beforeEach(() => {
        tempDir = createTempDir();
    });

    afterEach(() => {
        cleanupTempDir(tempDir);
    });

    describe('Constructor', () => {
        test('should create logger with default options', () => {
            const logger = new Logger();
            
            expect(logger.level).toBe('INFO');
            expect(logger.format).toBe('pretty');
            expect(logger.logDir).toBeNull(); // In test environment, defaults to null
            expect(logger.serviceName).toBe('actual-sync');
        });

        test('should create logger with custom options', () => {
            const logger = new Logger({
                level: 'DEBUG',
                format: 'json',
                logDir: tempDir,
                serviceName: 'test-service'
            });
            
            expect(logger.level).toBe('DEBUG');
            expect(logger.format).toBe('json');
            expect(logger.logDir).toBe(tempDir);
            expect(logger.serviceName).toBe('test-service');
        });

        test('should create log directory if it does not exist', () => {
            const logDir = path.join(tempDir, 'logs');
            expect(fs.existsSync(logDir)).toBe(false);
            
            new Logger({ logDir });
            
            expect(fs.existsSync(logDir)).toBe(true);
        });
    });

    describe('Log Levels', () => {
        test('should have correct numeric log levels', () => {
            expect(LOG_LEVELS.ERROR).toBe(0);
            expect(LOG_LEVELS.WARN).toBe(1);
            expect(LOG_LEVELS.INFO).toBe(2);
            expect(LOG_LEVELS.DEBUG).toBe(3);
        });

        test('should convert level names to numbers', () => {
            const logger = new Logger();
            
            expect(logger.getNumericLevel('ERROR')).toBe(0);
            expect(logger.getNumericLevel('WARN')).toBe(1);
            expect(logger.getNumericLevel('INFO')).toBe(2);
            expect(logger.getNumericLevel('DEBUG')).toBe(3);
        });

        test('should handle lowercase level names', () => {
            const logger = new Logger();
            
            expect(logger.getNumericLevel('error')).toBe(0);
            expect(logger.getNumericLevel('info')).toBe(2);
        });

        test('should default to INFO for unknown levels', () => {
            const logger = new Logger();
            
            expect(logger.getNumericLevel('UNKNOWN')).toBe(2);
        });
    });

    describe('shouldLog', () => {
        test('should respect log level filtering - INFO level', () => {
            const logger = new Logger({ level: 'INFO' });
            
            expect(logger.shouldLog('ERROR')).toBe(true);
            expect(logger.shouldLog('WARN')).toBe(true);
            expect(logger.shouldLog('INFO')).toBe(true);
            expect(logger.shouldLog('DEBUG')).toBe(false);
        });

        test('should respect log level filtering - ERROR level', () => {
            const logger = new Logger({ level: 'ERROR' });
            
            expect(logger.shouldLog('ERROR')).toBe(true);
            expect(logger.shouldLog('WARN')).toBe(false);
            expect(logger.shouldLog('INFO')).toBe(false);
            expect(logger.shouldLog('DEBUG')).toBe(false);
        });

        test('should respect log level filtering - DEBUG level', () => {
            const logger = new Logger({ level: 'DEBUG' });
            
            expect(logger.shouldLog('ERROR')).toBe(true);
            expect(logger.shouldLog('WARN')).toBe(true);
            expect(logger.shouldLog('INFO')).toBe(true);
            expect(logger.shouldLog('DEBUG')).toBe(true);
        });
    });

    describe('Correlation IDs', () => {
        test('a logger holds no id of its own; the running scope supplies it (#441)', () => {
            const logger = new Logger();
            expect(logger.correlationId).toBeNull();
            withCorrelation(() => expect(logger.correlationId).toBe('test-id'), 'test-id');
            expect(logger.correlationId).toBeNull();
        });

        test('withCorrelation generates a UUID when none is given', () => {
            let id1; let id2;
            withCorrelation(() => { id1 = currentCorrelationId(); });
            withCorrelation(() => { id2 = currentCorrelationId(); });
            expect(id1).toMatch(/^[a-f0-9-]{36}$/);
            expect(id1).not.toBe(id2);
        });
    });

    describe('Format Logging', () => {
        test('should format log in pretty format', () => {
            const logger = new Logger({ format: 'pretty' });
            const formatted = emit(logger, 'Test message', { key: 'value' });
            
            expect(formatted).toContain('[INFO]');
            expect(formatted).toContain('Test message');
            expect(formatted).toContain('"key"');
            expect(formatted).toContain('"value"');
        });

        test('should format log in JSON format', () => {
            const logger = new Logger({ format: 'json' });
            const formatted = emit(logger, 'Test message', { key: 'value' });
            const parsed = JSON.parse(formatted);
            
            expect(parsed.level).toBe('INFO');
            expect(parsed.message).toBe('Test message');
            expect(parsed.service).toBe('actual-sync');
            expect(parsed.key).toBe('value');
            expect(parsed.timestamp).toBeDefined();
        });

        test('should include correlation ID in formatted log', () => {
            const logger = new Logger({ format: 'json' });
            const formatted = withCorrelation(() => emit(logger, 'Test message'), 'test-correlation-id');
            const parsed = JSON.parse(formatted);
            
            expect(parsed.correlationId).toBe('test-correlation-id');
        });

        test('should not include correlation ID if not set', () => {
            const logger = new Logger({ format: 'json' });
            
            const formatted = emit(logger, 'Test message');
            const parsed = JSON.parse(formatted);
            
            expect(parsed.correlationId).toBeUndefined();
        });
    });

    describe('Logging Methods', () => {
        beforeEach(() => {
            consoleSuppress = suppressConsole();
        });

        afterEach(() => {
            consoleSuppress.restore();
        });

        test('should log error messages', () => {
            const logger = new Logger();
            logger.error('Error message', { code: 500 });
            
            expect(console.error).toHaveBeenCalled();
            const call = console.error.mock.calls[0][0];
            expect(call).toContain('[ERROR]');
            expect(call).toContain('Error message');
        });

        test('should log warn messages', () => {
            const logger = new Logger();
            logger.warn('Warning message');
            
            expect(console.warn).toHaveBeenCalled();
            const call = console.warn.mock.calls[0][0];
            expect(call).toContain('[WARN]');
            expect(call).toContain('Warning message');
        });

        test('should log info messages', () => {
            const logger = new Logger({ logDir: null }); // Disable file logging for test
            console.log.mockClear(); // Clear any constructor logs
            logger.info('Info message');
            
            expect(console.log).toHaveBeenCalled();
            const call = console.log.mock.calls[0][0];
            expect(call).toContain('[INFO]');
            expect(call).toContain('Info message');
        });

        test('should log debug messages', () => {
            const logger = new Logger({ level: 'DEBUG', logDir: null }); // Disable file logging for test
            console.log.mockClear(); // Clear any constructor logs
            logger.debug('Debug message');
            
            expect(console.log).toHaveBeenCalled();
            const call = console.log.mock.calls[0][0];
            expect(call).toContain('[DEBUG]');
            expect(call).toContain('Debug message');
        });

        test('should not log debug when level is INFO', () => {
            const logger = new Logger({ level: 'INFO', logDir: null }); // Disable file logging for test
            console.log.mockClear(); // Clear any constructor logs
            logger.debug('Debug message');
            
            expect(console.log).not.toHaveBeenCalled();
        });

        test('should handle Error objects in error()', () => {
            const logger = new Logger({ format: 'json' });
            const error = new Error('Test error');
            error.code = 'TEST_CODE';
            
            logger.error(error);
            
            expect(console.error).toHaveBeenCalled();
            const call = console.error.mock.calls[0][0];
            const parsed = JSON.parse(call);
            expect(parsed.errorMessage).toBe('Test error');
            expect(parsed.errorCode).toBe('TEST_CODE');
            expect(parsed.errorStack).toBeDefined();
        });
    });

    describe('File Logging', () => {
        beforeEach(() => {
            consoleSuppress = suppressConsole();
        });

        afterEach(() => {
            consoleSuppress.restore();
        });

        test('should write logs to file when logDir is set', () => {
            const logger = new Logger({ 
                logDir: tempDir,
                rotation: { enabled: false } // Disable rotation for simpler test
            });
            logger.info('Test log message');
            
            const files = fs.readdirSync(tempDir);
            expect(files.length).toBeGreaterThan(0);
            
            const logFile = files[0];
            const content = fs.readFileSync(path.join(tempDir, logFile), 'utf8');
            expect(content).toContain('Test log message');
            // File output is single-line JSON by default (#104)
            const parsed = JSON.parse(content.trim());
            expect(parsed.level).toBe('INFO');
            expect(parsed.message).toBe('Test log message');
        });

        test('should not write to file when logDir is null', () => {
            const logger = new Logger({ logDir: null });
            logger.info('Test log message');
            
            // tempDir should be empty or not have log files
            if (fs.existsSync(tempDir)) {
                const files = fs.readdirSync(tempDir);
                expect(files.length).toBe(0);
            }
        });

        test('should create log file with date in name', () => {
            const logger = new Logger({ 
                logDir: tempDir,
                rotation: { enabled: false } // Disable rotation for simpler test
            });
            logger.info('Test log message');
            
            const files = fs.readdirSync(tempDir);
            const date = new Date().toISOString().split('T')[0];
            expect(files[0]).toContain(date);
            expect(files[0]).toContain('actual-sync');
            expect(files[0]).toContain('.log');
        });
    });

    describe('Child Logger', () => {
        test('should create child logger with parent context', () => {
            const parent = new Logger({ level: 'DEBUG' });
            const child = withCorrelation(() => parent.child({ component: 'test' }), 'parent-id');
            
            expect(child.correlationId).toBeNull();
            expect(child.level).toBe('DEBUG');
            expect(child.context).toEqual({ component: 'test' });
        });
    });

    describe('createLogger Factory', () => {
        test('should create logger with defaults', () => {
            const logger = createLogger();
            
            expect(logger).toBeInstanceOf(Logger);
            expect(logger.serviceName).toBe('actual-sync');
        });

        test('should create logger with custom options', () => {
            const logger = createLogger({ level: 'ERROR' });
            
            expect(logger.level).toBe('ERROR');
        });
    });

    describe('Broadcast Callback', () => {
        test('should set broadcast callback', () => {
            const logger = new Logger();
            const callback = jest.fn();
            
            logger.setBroadcastCallback(callback);
            
            expect(logger.broadcastCallback).toBe(callback);
        });

        test('should call broadcast callback on log', () => {
            const callback = jest.fn();
            const logger = new Logger({
                level: 'INFO',
                broadcastCallback: callback
            });
            
            const suppress = suppressConsole();
            logger.info('Test message', { key: 'value' });
            suppress.restore();
            
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith('INFO', 'Test message', { key: 'value' });
        });

        test('should not break logging if broadcast callback throws', () => {
            const callback = jest.fn(() => {
                throw new Error('Broadcast error');
            });
            const logger = new Logger({
                level: 'INFO',
                broadcastCallback: callback
            });
            
            const suppress = suppressConsole();
            expect(() => {
                logger.info('Test message');
            }).not.toThrow();
            suppress.restore();
            
            expect(callback).toHaveBeenCalledTimes(1);
        });

        test('should not call broadcast callback if not set', () => {
            const logger = new Logger({ level: 'INFO' });
            
            const suppress = suppressConsole();
            expect(() => {
                logger.info('Test message');
            }).not.toThrow();
            suppress.restore();
        });

        test('should broadcast all log levels', () => {
            const callback = jest.fn();
            const logger = new Logger({
                level: 'DEBUG',
                broadcastCallback: callback
            });
            
            const suppress = suppressConsole();
            logger.error('Error message');
            logger.warn('Warn message');
            logger.info('Info message');
            logger.debug('Debug message');
            suppress.restore();
            
            expect(callback).toHaveBeenCalledTimes(4);
            expect(callback).toHaveBeenNthCalledWith(1, 'ERROR', 'Error message', {});
            expect(callback).toHaveBeenNthCalledWith(2, 'WARN', 'Warn message', {});
            expect(callback).toHaveBeenNthCalledWith(3, 'INFO', 'Info message', {});
            expect(callback).toHaveBeenNthCalledWith(4, 'DEBUG', 'Debug message', {});
        });
    });

    describe('Secret Redaction (#103)', () => {
        beforeEach(() => { consoleSuppress = suppressConsole(); });
        afterEach(() => { consoleSuppress.restore(); });

        test('masks a top-level secret key in JSON format', () => {
            const logger = new Logger({ format: 'json', logDir: null });
            const line = emit(logger, 'auth', { password: 'hunter2', user: 'bob' }, 'json');
            const parsed = JSON.parse(line);
            expect(parsed.password).toBe('[REDACTED]');
            expect(parsed.user).toBe('bob');
            expect(line).not.toContain('hunter2');
        });

        test('masks a secret key in pretty format', () => {
            const logger = new Logger({ format: 'pretty', logDir: null });
            const line = emit(logger, 'auth', { password: 'hunter2' }, 'pretty');
            expect(line).toContain('"password":"[REDACTED]"');
            expect(line).not.toContain('hunter2');
        });

        test('masks nested secrets without mutating the input object', () => {
            const logger = new Logger({ logDir: null });
            const meta = { server: { name: 'A', encryptionPassword: 'e2e-secret' } };
            const line = emit(logger, 'x', meta, 'json');
            expect(line).not.toContain('e2e-secret');
            expect(line).toContain('[REDACTED]');
            expect(meta.server.encryptionPassword).toBe('e2e-secret'); // original untouched
        });

        test.each([
            ['Slack hook', 'POST https://hooks.slack.com/services/T0AAA/B0BBB/SECRETxyz failed', 'SECRETxyz'],
            ['Discord hook', 'https://discord.com/api/webhooks/123456789/SECRETxyz', 'SECRETxyz'],
            ['Slack trigger', 'https://hooks.slack.com/triggers/E0AAA/12345/SECRETxyz', 'SECRETxyz'],
            ['Slack workflow', 'https://hooks.slack.com/workflows/T0AAA/A0BBB/12345/SECRETxyz', 'SECRETxyz'],
            ['Slack gov hook', 'https://hooks.slack-gov.com/services/T0AAA/B0BBB/SECRETxyz', 'SECRETxyz'],
            ['Discord slack-compat hook', 'https://discord.com/api/webhooks/123456789/SECRETxyz/slack', 'SECRETxyz'],
            ['discordapp hook','https://discordapp.com/api/v10/webhooks/123456789/SECRETxyz?wait=true', 'SECRETxyz']
        ])('masks path-style %s secret (#431)', (_n, text, secret) => {
            const logger = new Logger({ logDir: null });
            const line = emit(logger, text, { url: text }, 'json');
            expect(line).not.toContain(secret);
            expect(line).toContain('[REDACTED]');
        });

        test('masks bot-token URLs embedded in string values', () => {
            const logger = new Logger({ logDir: null });
            const line = emit(logger, 'x', {
                url: 'https://api.telegram.org/bot123456:ABC-def_77/getUpdates'
            }, 'json');
            expect(JSON.parse(line).url).toBe('https://api.telegram.org/bot[REDACTED]/getUpdates');
        });

        test('honors custom logging.redact keys while keeping the defaults', () => {
            const logger = new Logger({ logDir: null, redact: ['ssn'] });
            const parsed = JSON.parse(emit(logger, 'x', { ssn: '123-45', password: 'p' }, 'json'));
            expect(parsed.ssn).toBe('[REDACTED]');
            expect(parsed.password).toBe('[REDACTED]');
        });

        test('does not throw on circular metadata', () => {
            const logger = new Logger({ logDir: null });
            const meta = { a: 1 };
            meta.self = meta;
            expect(() => logger.info('x', meta)).not.toThrow();
        });

        test('preserves Date values instead of flattening them to {}', () => {
            const logger = new Logger({ logDir: null });
            const when = new Date('2026-06-10T00:00:00.000Z');
            const parsed = JSON.parse(emit(logger, 'x', { when }, 'json'));
            expect(parsed.when).toBe('2026-06-10T00:00:00.000Z');
        });

        test('does not mark a shared (non-circular) reference as [Circular]', () => {
            const logger = new Logger({ logDir: null });
            const shared = { v: 1 };
            const parsed = JSON.parse(emit(logger, 'x', { a: shared, b: shared }, 'json'));
            expect(parsed.a).toEqual({ v: 1 });
            expect(parsed.b).toEqual({ v: 1 });
        });

        test('masks a secret embedded in the MESSAGE, not only in metadata', () => {
            // Every redaction test here operated on `meta`. Removing
            // maskSecrets(message) from the write path broke nothing — a secret
            // interpolated into the message string was unguarded. (#187)
            const logger = new Logger({ level: 'INFO', logDir: null });
            const line = emit(logger, 'calling https://api.telegram.org/bot123456:ABC-def_77/getUpdates', {}, 'json');

            expect(line).not.toContain('ABC-def_77');
            expect(JSON.parse(line).message).toContain('bot[REDACTED]');
        });

        test('masks a key=value secret written into the message', () => {
            const logger = new Logger({ level: 'INFO', logDir: null });
            const line = emit(logger, 'retrying with password=hunter2 for bob', {}, 'json');

            expect(line).not.toContain('hunter2');
            expect(JSON.parse(line).message).toContain('password=[REDACTED]');
        });

        test('redacts the logger CONTEXT, which child loggers carry', () => {
            // Context is attached to every line a child logger emits, so an
            // unredacted context leaks on each one. Dropping redact(this.context)
            // from the write path also broke nothing. (#187)
            const logger = new Logger({
                level: 'INFO', logDir: null, context: { server: 'Main', encryptionPassword: 'e2e-secret' }
            });
            const line = emit(logger, 'sync', {}, 'json');

            expect(line).not.toContain('e2e-secret');
            expect(JSON.parse(line).encryptionPassword).toBe('[REDACTED]');
            expect(JSON.parse(line).server).toBe('Main');
        });

        test('redacts context inherited through child()', () => {
            const parent = new Logger({ level: 'INFO', logDir: null });
            const child = parent.child({ botToken: 'abc123secret', server: 'Main' });
            const line = emit(child, 'sync', {}, 'json');

            expect(line).not.toContain('abc123secret');
            expect(JSON.parse(line).botToken).toBe('[REDACTED]');
        });

        test('redacts what is written to the log FILE, not just the console', () => {
            // The file uses `fileFormat`, a separate serialization from the
            // console's `format` — and fileFormat was unreachable once already
            // (#116). A secret reaching disk is the durable version of this bug,
            // so assert on the bytes actually written.
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-redact-file-'));
            try {
                // Rotation off so the writer takes the synchronous appendFileSync
                // branch: the rotating stream flushes async and would make this
                // racy. Both branches serialize through the same
                // safeSerialize(..., this.fileFormat) call, which is what is
                // under test here.
                const logger = new Logger({
                    level: 'INFO', logDir: dir, fileFormat: 'json', rotation: { enabled: false }
                });
                logger.info('auth', { password: 'hunter2', token: 'tok-abc', user: 'bob' });

                const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
                expect(files).toHaveLength(1);
                const written = fs.readFileSync(path.join(dir, files[0]), 'utf8');

                expect(written).not.toContain('hunter2');
                expect(written).not.toContain('tok-abc');
                expect(written).toContain('[REDACTED]');
                expect(JSON.parse(written.trim()).user).toBe('bob');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        test('redacts the metadata passed to the broadcast callback', () => {
            const callback = jest.fn();
            const logger = new Logger({ level: 'INFO', logDir: null, broadcastCallback: callback });
            logger.info('x', { password: 'hunter2', ok: 1 });
            expect(callback).toHaveBeenCalledWith('INFO', 'x', { password: '[REDACTED]', ok: 1 });
        });

        test('redacts secrets in the syslog payload', () => {
            const logger = new Logger({ logDir: null });
            const sendSpy = jest.fn();
            logger.syslog = { enabled: true, host: 'localhost', port: 514, protocol: 'udp', facility: 16 };
            logger.syslogClient = { send: sendSpy };
            logger.info('x', { botToken: 'abc123secret' });
            const sent = sendSpy.mock.calls[0][0].toString();
            expect(sent).not.toContain('abc123secret');
            expect(sent).toContain('REDACTED');
        });

        test('a throwing getter in metadata never crashes the log call (C1)', () => {
            const logger = new Logger({ logDir: null });
            const meta = { get boom() { throw new Error('getter exploded'); } };
            expect(() => logger.info('x', meta)).not.toThrow();
            const parsed = JSON.parse(emit(logger, 'x', meta, 'json'));
            expect(parsed.boom).toBe('[unreadable]');
        });

        test('a BigInt in metadata does not crash and serializes as a string', () => {
            const logger = new Logger({ logDir: null });
            expect(() => logger.info('x', { big: 10n })).not.toThrow();
            const parsed = JSON.parse(emit(logger, 'x', { big: 42n }, 'json'));
            expect(parsed.big).toBe('42');
        });

        test('a value with a throwing toJSON never crashes the log call', () => {
            const logger = new Logger({ logDir: null });
            const meta = { obj: { toJSON() { throw new Error('toJSON exploded'); } } };
            expect(() => logger.info('x', meta)).not.toThrow();
        });

        test('masks Authorization Bearer tokens in string values (H3)', () => {
            const logger = new Logger({ logDir: null });
            const parsed = JSON.parse(emit(logger, 'x', { h: 'Authorization: Bearer abc.def.ghi' }, 'json'));
            expect(parsed.h).toBe('Authorization: Bearer [REDACTED]');
        });

        test('masks credentials embedded in URL userinfo (H3)', () => {
            const logger = new Logger({ logDir: null });
            const parsed = JSON.parse(emit(logger, 'x', { u: 'https://admin:S3cr3t@host:5006/budget' }, 'json'));
            expect(parsed.u).toBe('https://admin:[REDACTED]@host:5006/budget');
        });

        test('masks a bare password= even without a query-string prefix (H3)', () => {
            const logger = new Logger({ logDir: null });
            const parsed = JSON.parse(emit(logger, 'x', { b: 'user=bob password=hunter2 done' }, 'json'));
            expect(parsed.b).toBe('user=bob password=[REDACTED] done');
        });

        test('redacts token/secret key variants (refreshToken, accessToken, clientSecret) (H3)', () => {
            const logger = new Logger({ logDir: null });
            const parsed = JSON.parse(emit(logger, 'x', {
                refreshToken: 'rt', accessToken: 'at', clientSecret: 's'
            }, 'json'));
            expect(parsed.refreshToken).toBe('[REDACTED]');
            expect(parsed.accessToken).toBe('[REDACTED]');
            expect(parsed.clientSecret).toBe('[REDACTED]');
        });

        test('preserves an Error value in metadata (name/message/stack) (M4)', () => {
            const logger = new Logger({ logDir: null });
            const err = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
            const parsed = JSON.parse(emit(logger, 'x', { cause: err }, 'json'));
            expect(parsed.cause.name).toBe('Error');
            expect(parsed.cause.message).toBe('connection refused');
            expect(parsed.cause.code).toBe('ECONNREFUSED');
            expect(typeof parsed.cause.stack).toBe('string');
        });

        test('syslog encodes nested objects instead of [object Object] (M5)', () => {
            const logger = new Logger({ logDir: null });
            const sendSpy = jest.fn();
            logger.syslog = { enabled: true, host: 'localhost', port: 514, protocol: 'udp', facility: 16 };
            logger.syslogClient = { send: sendSpy };
            logger.info('x', { detail: { a: 1, b: 2 } });
            const sent = sendSpy.mock.calls[0][0].toString();
            expect(sent).not.toContain('[object Object]');
            // RFC 5424 escaping backslash-escapes the JSON quotes
            expect(sent).toContain('\\"a\\":1');
        });

        test('escapes RFC 5424 structured-data chars in syslog values (quotes/brackets)', () => {
            const logger = new Logger({ logDir: null });
            const sendSpy = jest.fn();
            logger.syslog = { enabled: true, host: 'localhost', port: 514, protocol: 'udp', facility: 16 };
            logger.syslogClient = { send: sendSpy };
            logger.info('x', { nested: { a: 'has"quote' } });
            const sent = sendSpy.mock.calls[0][0].toString();
            // The JSON quote inside the value must be backslash-escaped so it cannot
            // terminate the SD-PARAM early.
            expect(sent).toContain('\\"');
        });

        test('preserves Error custom fields (statusCode/errno) and cause; masks code (M4+)', () => {
            const logger = new Logger({ logDir: null });
            const err = Object.assign(new Error('connection refused'), {
                statusCode: 429, errno: -111, syscall: 'connect'
            });
            err.cause = Object.assign(new Error('root'), { code: 'EROOT' });
            const e = JSON.parse(emit(logger, 'x', { err }, 'json')).err;
            expect(e.statusCode).toBe(429);
            expect(e.errno).toBe(-111);
            expect(e.syscall).toBe('connect');
            expect(e.cause.message).toBe('root');

            const masked = JSON.parse(emit(logger, 'x', {
                err: Object.assign(new Error('x'), { code: 'token=leak123' })
            }, 'json')).err;
            expect(masked.code).toBe('token=[REDACTED]');
        });

        test('does not infinitely recurse / crash on a circular error cause chain', () => {
            const logger = new Logger({ logDir: null });
            const a = new Error('a');
            const b = new Error('b');
            a.cause = b;
            b.cause = a;
            expect(() => logger.info('x', { a })).not.toThrow();
        });

        test('masks quoted key="value" secrets in strings (M-H3+)', () => {
            const logger = new Logger({ logDir: null });
            const parsed = JSON.parse(emit(logger, 'x', { s: 'password="hunter2" ok' }, 'json'));
            expect(parsed.s).toBe('password=[REDACTED] ok');
        });

        test('masks JSON-style "key":"value" secrets in stringified blobs (M-H3+)', () => {
            const logger = new Logger({ logDir: null });
            const parsed = JSON.parse(emit(logger, 'x', { s: '{"refreshToken":"rt123","keep":1}' }, 'json'));
            expect(parsed.s).toBe('{"refreshToken":"[REDACTED]","keep":1}');
        });

        test('does not crash on a circular reference inside a class instance', () => {
            const logger = new Logger({ logDir: null });
            class Node { constructor() { this.name = 'n'; } }
            const n = new Node();
            n.self = n;
            expect(() => logger.info('x', { n })).not.toThrow();
        });
    });

    describe('File Format (#104)', () => {
        beforeEach(() => { consoleSuppress = suppressConsole(); });
        afterEach(() => { consoleSuppress.restore(); });

        test('file output is single-line valid JSON even when console format is pretty', () => {
            const logger = new Logger({ format: 'pretty', logDir: tempDir, rotation: { enabled: false } });
            logger.info('hello', { a: 1, nested: { b: 2 } });
            const files = fs.readdirSync(tempDir);
            const content = fs.readFileSync(path.join(tempDir, files[0]), 'utf8');
            const lines = content.trim().split('\n');
            expect(lines).toHaveLength(1);
            const parsed = JSON.parse(lines[0]);
            expect(parsed.message).toBe('hello');
            expect(parsed.a).toBe(1);
        });

        test('defaults fileFormat to json when omitted', () => {
            const logger = new Logger({ format: 'pretty', logDir: null });
            expect(logger.fileFormat).toBe('json');
        });

        test('multi-key metadata still produces exactly one file line', () => {
            const logger = new Logger({ logDir: tempDir, rotation: { enabled: false } });
            logger.info('m', { one: 1, two: 2, three: 3 });
            const files = fs.readdirSync(tempDir);
            const content = fs.readFileSync(path.join(tempDir, files[0]), 'utf8');
            expect(content.trim().split('\n')).toHaveLength(1);
        });

        test('child logger inherits fileFormat from the parent', () => {
            const parent = new Logger({ fileFormat: 'json', logDir: null });
            expect(parent.child({ scope: 'x' }).fileFormat).toBe('json');
        });

        test('createLogger forwards fileFormat to file output', () => {
            const logger = createLogger({ fileFormat: 'json', logDir: tempDir, rotation: { enabled: false } });
            logger.info('viaFactory');
            const files = fs.readdirSync(tempDir);
            const content = fs.readFileSync(path.join(tempDir, files[0]), 'utf8');
            expect(() => JSON.parse(content.trim())).not.toThrow();
        });

        test('a file-write failure does not propagate', () => {
            const logger = new Logger({ logDir: tempDir, rotation: { enabled: false } });
            const spy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('disk full'); });
            expect(() => logger.info('x')).not.toThrow();
            spy.mockRestore();
        });

        test('broadcast is unaffected when fileFormat is json', () => {
            const callback = jest.fn();
            const logger = new Logger({ level: 'INFO', fileFormat: 'json', logDir: null, broadcastCallback: callback });
            logger.info('x', { k: 'v' });
            expect(callback).toHaveBeenCalledWith('INFO', 'x', { k: 'v' });
        });
    });

    describe('Log Rotation', () => {
        test('should support rotation configuration', () => {
            const logger = new Logger({
                logDir: tempDir,
                rotation: {
                    enabled: true,
                    maxSize: '5M',
                    maxFiles: 5,
                    compress: 'gzip'
                }
            });
            
            expect(logger.rotation.enabled).toBe(true);
            expect(logger.rotation.maxSize).toBe('5M');
            expect(logger.rotation.maxFiles).toBe(5);
            expect(logger.rotation.compress).toBe('gzip');
        });

        test('should create rotating stream when enabled', () => {
            const logger = new Logger({
                logDir: tempDir,
                rotation: {
                    enabled: true,
                    maxSize: '10M',
                    maxFiles: 10,
                    compress: 'gzip'
                }
            });
            
            expect(logger.rotatingStream).toBeDefined();
            
            // Cleanup
            logger.close();
        });

        test('should not create rotating stream when disabled', () => {
            const logger = new Logger({
                logDir: tempDir,
                rotation: {
                    enabled: false
                }
            });
            
            expect(logger.rotatingStream).toBeNull();
        });
    });

    describe('Syslog Support', () => {
        test('should support syslog configuration', () => {
            const logger = new Logger({
                syslog: {
                    enabled: true,
                    host: 'syslog.example.com',
                    port: 514,
                    protocol: 'udp',
                    facility: 16
                }
            });
            
            expect(logger.syslog.enabled).toBe(true);
            expect(logger.syslog.host).toBe('syslog.example.com');
            expect(logger.syslog.port).toBe(514);
            expect(logger.syslog.protocol).toBe('udp');
            expect(logger.syslog.facility).toBe(16);
            
            logger.close();
        });

        test('should convert log level to syslog severity', () => {
            const logger = new Logger();
            
            expect(logger.levelToSyslogSeverity('ERROR')).toBe(3);
            expect(logger.levelToSyslogSeverity('WARN')).toBe(4);
            expect(logger.levelToSyslogSeverity('INFO')).toBe(6);
            expect(logger.levelToSyslogSeverity('DEBUG')).toBe(7);
        });

        test('should format syslog message correctly', () => {
            const logger = new Logger({
                syslog: { facility: 16 }
            });
            
            const message = withCorrelation(() => logger.formatSyslog('INFO', 'Test message', { key: 'value' }), 'test-id-123');
            
            expect(message).toContain('<134>'); // priority: facility*8 + severity
            expect(message).toContain('actual-sync');
            expect(message).toContain('Test message');
            expect(message).toContain('correlationId="test-id-123"');
            expect(message).toContain('key="value"');
        });

        test('should not create syslog client when disabled', () => {
            const logger = new Logger({
                syslog: {
                    enabled: false
                }
            });
            
            expect(logger.syslogClient).toBeNull();
        });
    });

    describe('Performance Tracking', () => {
        test('should support performance configuration', () => {
            const logger = new Logger({
                performance: {
                    enabled: true,
                    thresholds: {
                        slow: 500,
                        verySlow: 2000
                    }
                }
            });
            
            expect(logger.performanceEnabled).toBe(true);
            expect(logger.performanceThresholds.slow).toBe(500);
            expect(logger.performanceThresholds.verySlow).toBe(2000);
        });

        test('should track operation duration', (done) => {
            const logger = new Logger({
                level: 'DEBUG',
                performance: {
                    enabled: true,
                    thresholds: {
                        slow: 100,
                        verySlow: 200
                    }
                }
            });
            
            const suppress = suppressConsole();
            const endTimer = logger.startTimer('test-operation');
            
            setTimeout(() => {
                const duration = endTimer({ status: 'success' });
                suppress.restore();
                
                expect(duration).toBeGreaterThan(50);
                expect(duration).toBeLessThan(150);
                done();
            }, 75);
        });

        test('should log WARN for very slow operations', (done) => {
            const logger = new Logger({
                level: 'WARN',
                performance: {
                    enabled: true,
                    thresholds: {
                        slow: 10,
                        verySlow: 20
                    }
                }
            });
            
            const suppress = suppressConsole();
            const endTimer = logger.startTimer('slow-operation');
            
            setTimeout(() => {
                endTimer();
                suppress.restore();
                done();
            }, 50);
        });

        test('should return no-op function when performance disabled', () => {
            const logger = new Logger({
                performance: {
                    enabled: false
                }
            });
            
            const endTimer = logger.startTimer('test-operation');
            const result = endTimer();
            
            expect(result).toBeUndefined();
        });
    });

    describe('Child Logger', () => {
        test('should create child logger with additional context', () => {
            const logger = new Logger({
                level: 'INFO',
                format: 'json'
            });
            
            const childLogger = logger.child({ server: 'test-server' });
            
            expect(childLogger).toBeInstanceOf(Logger);
            expect(childLogger.context).toEqual({ server: 'test-server' });
            expect(childLogger.level).toBe('INFO');
            expect(childLogger.format).toBe('json');
        });

        test('should merge parent and child context', () => {
            const logger = new Logger({
                level: 'INFO',
                context: { app: 'sync-service' }
            });
            
            const childLogger = logger.child({ server: 'test-server' });
            
            expect(childLogger.context).toEqual({
                app: 'sync-service',
                server: 'test-server'
            });
        });

        test('should include context in log output', () => {
            const logger = new Logger({
                level: 'INFO',
                format: 'json'
            });
            
            const childLogger = logger.child({ server: 'test-server', env: 'prod' });
            
            const suppress = suppressConsole();
            const logSpy = jest.spyOn(console, 'log');
            
            childLogger.info('Test message');
            
            suppress.restore();
            
            const logOutput = logSpy.mock.calls[0][0];
            const parsed = JSON.parse(logOutput);
            
            expect(parsed.server).toBe('test-server');
            expect(parsed.env).toBe('prod');
            expect(parsed.message).toBe('Test message');
            
            logSpy.mockRestore();
        });

        test('a child resolves the id from the running scope, not from its parent (#441)', () => {
            const logger = new Logger({ level: 'INFO' });
            const childLogger = logger.child({ component: 'test' });
            
            expect(childLogger.correlationId).toBeNull();
            withCorrelation(() => expect(childLogger.correlationId).toBe('scope-id'), 'scope-id');
        });

        test('should share streams with parent', () => {
            const logger = new Logger({
                logDir: tempDir,
                rotation: {
                    enabled: true,
                    maxSize: '10M',
                    maxFiles: 10,
                    compress: 'gzip'
                }
            });
            
            const childLogger = logger.child({ component: 'test' });
            
            expect(childLogger.rotatingStream).toBe(logger.rotatingStream);
            
            logger.close();
        });
    });

    describe('Logger Cleanup', () => {
        test('should close rotating stream on cleanup', () => {
            const logger = new Logger({
                logDir: tempDir,
                rotation: {
                    enabled: true,
                    maxSize: '10M',
                    maxFiles: 10,
                    compress: 'gzip'
                }
            });
            
            const endSpy = jest.spyOn(logger.rotatingStream, 'end');
            
            logger.close();
            
            expect(endSpy).toHaveBeenCalled();
        });

        test('should close syslog client on cleanup', () => {
            const logger = new Logger({
                syslog: {
                    enabled: true,
                    host: 'localhost',
                    port: 514
                }
            });
            
            const closeSpy = jest.spyOn(logger.syslogClient, 'close');
            
            logger.close();
            
            expect(closeSpy).toHaveBeenCalled();
        });
    });

    describe('reserved keys (#433)', () => {
        const emit = (logger, level, msg, meta) =>
            JSON.parse(logger.serialize(level, msg, logger.context, meta, 'json'));

        test('context and meta cannot overwrite reserved keys', () => {
            const logger = new Logger({
                serviceName: 'svc',
                context: { level: 'debug', service: 'evil', timestamp: 'x', message: 'ctx', severity: 'z', seq: 9, schema: 's', event: 'e', version: 'v', component: 'c' }
            });
            const out = emit(logger, 'WARN', 'real', { level: 'trace', message: 'meta', service: 'm', component: 'm2' });
            expect(out.level).toBe('WARN');
            expect(out.message).toBe('real');
            expect(out.service).toBe('svc');
            expect(out.timestamp).not.toBe('x');
            for (const k of ['severity', 'seq', 'schema', 'version']) {
                expect(out).not.toHaveProperty(k);
            }
        });

        test('event and component are caller-set: they pass through (D1, D7)', () => {
            const logger = new Logger({ context: { component: 'telegram' } });
            const out = emit(logger, 'WARN', 'm', { event: 'authz_fail' });
            expect(out.event).toBe('authz_fail');
            expect(out.component).toBe('telegram');
        });

        test('non-reserved context and meta still pass through', () => {
            const logger = new Logger({ context: { server: 'A' } });
            const out = emit(logger, 'INFO', 'm', { a: 1 });
            expect(out.server).toBe('A');
            expect(out.a).toBe(1);
        });

        test('child() level option sets the level without touching context', () => {
            const parent = new Logger({ level: 'INFO' });
            const child = parent.child({ server: 'A' }, { level: 'DEBUG' });
            expect(child.level).toBe('DEBUG');
            expect(child.context).toEqual({ server: 'A' });
            expect(parent.level).toBe('INFO');
        });

        test('child() without options inherits the level', () => {
            expect(new Logger({ level: 'WARN' }).child({}).level).toBe('WARN');
        });
    });
});

describe('control character escaping (#447)', () => {
    const { escapeControlChars } = require('../lib/logger');
    const forged = 'Sync for a\x1b[31mRED\n2026-11-04T00:00:00Z [ERROR] forged';

    test('pretty: ticket string yields one line with visible escapes', () => {
        const line = emit(new Logger({ format: 'pretty' }), forged);
        expect(line.split('\n')).toHaveLength(1);
        expect(line).toContain('a\\x1b[31mRED\\x0a2026-11-04T00:00:00Z [ERROR] forged');
        expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    });

    test('pretty: context and meta values stay on one line', () => {
        const line = emit(new Logger({ format: 'pretty' }), 'm', { a: 'x\r\ny\u2028z\u202e', b: { c: '\u0085' } });
        expect(line.split('\n')).toHaveLength(1);
        expect(line).not.toMatch(/[\r\u0085\u2028\u202e]/);
    });

    test('escapes every listed class', () => {
        const all = '\x00\x1f\x7f\x80\x9f\u2028\u2029\u202a\u202e\u2066\u2069';
        expect(escapeControlChars(all)).toBe('\\x00\\x1f\\x7f\\x80\\x9f\\u2028\\u2029\\u202a\\u202e\\u2066\\u2069');
        expect(escapeControlChars('plain text é')).toBe('plain text é');
    });

    test('json: no raw U+2028/2029, bidi, DEL or C1; still parses', () => {
        const msg = 'a\u2028b\u2029c\u202ed\u2066e\x7ff\x85g\nh';
        const line = emit(new Logger({ format: 'json' }), msg);
        expect(line).not.toMatch(/[\u2028\u2029\u202a-\u202e\u2066-\u2069\x7f-\x9f]/);
        expect(JSON.parse(line).message).toBe(msg);
    });
});

describe('escaping on the fallback and syslog paths (#447 review)', () => {
    const forged = 'Sync for a\x1b[31mRED\n2026-11-04T00:00:00Z [ERROR] forged';
    class Boom { toJSON() { throw new Error('bad\nline'); } }

    test.each(['pretty', 'json'])('serialization fallback (%s) stays one escaped line', (format) => {
        const logger = new Logger({ logDir: null });
        const line = logger.safeSerialize('info', forged, {}, { b: new Boom() }, format);
        expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
        if (format === 'json') {
            const rec = JSON.parse(line);
            expect(rec.message).toBe(forged);
            expect(rec.level).toBe('INFO');
        }
    });

    test('syslog message and structured data carry no raw control characters', () => {
        const logger = new Logger({ logDir: null });
        logger.syslog = { facility: 16 };
        const line = logger.formatSyslog('info', forged, {}, { a: 'x\ny' });
        expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
        expect(line).toContain('a="x\\\\x0ay"');
    });
});
