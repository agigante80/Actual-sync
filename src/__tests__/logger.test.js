/**
 * Unit tests for Logger
 */

const fs = require('fs');
const path = require('path');
const { Logger, createLogger, LOG_LEVELS, LEVEL_NAMES } = require('../lib/logger');
const {
    createTempDir,
    cleanupTempDir,
    suppressConsole
} = require('./helpers/testHelpers');

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
            expect(logger.logDir).toBeNull();
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
        test('should generate unique correlation IDs', () => {
            const logger = new Logger();
            const id1 = logger.generateCorrelationId();
            const id2 = logger.generateCorrelationId();
            
            expect(id1).toBeDefined();
            expect(id2).toBeDefined();
            expect(id1).not.toBe(id2);
            expect(id1).toMatch(/^[a-f0-9-]{36}$/); // UUID format
        });

        test('should set and clear correlation ID', () => {
            const logger = new Logger();
            
            expect(logger.correlationId).toBeNull();
            
            const id = logger.setCorrelationId('test-id');
            expect(logger.correlationId).toBe('test-id');
            expect(id).toBe('test-id');
            
            logger.clearCorrelationId();
            expect(logger.correlationId).toBeNull();
        });

        test('should generate correlation ID if none provided to setCorrelationId', () => {
            const logger = new Logger();
            
            const id = logger.setCorrelationId();
            expect(logger.correlationId).toBeDefined();
            expect(id).toMatch(/^[a-f0-9-]{36}$/);
        });
    });

    describe('Format Logging', () => {
        test('should format log in pretty format', () => {
            const logger = new Logger({ format: 'pretty' });
            const formatted = logger.formatLog('INFO', 'Test message', { key: 'value' });
            
            expect(formatted).toContain('[INFO]');
            expect(formatted).toContain('Test message');
            expect(formatted).toContain('"key"');
            expect(formatted).toContain('"value"');
        });

        test('should format log in JSON format', () => {
            const logger = new Logger({ format: 'json' });
            const formatted = logger.formatLog('INFO', 'Test message', { key: 'value' });
            const parsed = JSON.parse(formatted);
            
            expect(parsed.level).toBe('INFO');
            expect(parsed.message).toBe('Test message');
            expect(parsed.service).toBe('actual-sync');
            expect(parsed.key).toBe('value');
            expect(parsed.timestamp).toBeDefined();
        });

        test('should include correlation ID in formatted log', () => {
            const logger = new Logger({ format: 'json' });
            logger.setCorrelationId('test-correlation-id');
            
            const formatted = logger.formatLog('INFO', 'Test message');
            const parsed = JSON.parse(formatted);
            
            expect(parsed.correlationId).toBe('test-correlation-id');
        });

        test('should not include correlation ID if not set', () => {
            const logger = new Logger({ format: 'json' });
            
            const formatted = logger.formatLog('INFO', 'Test message');
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
            const logger = new Logger();
            logger.info('Info message');
            
            expect(console.log).toHaveBeenCalled();
            const call = console.log.mock.calls[0][0];
            expect(call).toContain('[INFO]');
            expect(call).toContain('Info message');
        });

        test('should log debug messages', () => {
            const logger = new Logger({ level: 'DEBUG' });
            logger.debug('Debug message');
            
            expect(console.log).toHaveBeenCalled();
            const call = console.log.mock.calls[0][0];
            expect(call).toContain('[DEBUG]');
            expect(call).toContain('Debug message');
        });

        test('should not log debug when level is INFO', () => {
            const logger = new Logger({ level: 'INFO' });
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
            const logger = new Logger({ logDir: tempDir });
            logger.info('Test log message');
            
            const files = fs.readdirSync(tempDir);
            expect(files.length).toBeGreaterThan(0);
            
            const logFile = files[0];
            const content = fs.readFileSync(path.join(tempDir, logFile), 'utf8');
            expect(content).toContain('Test log message');
            expect(content).toContain('[INFO]');
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
            const logger = new Logger({ logDir: tempDir });
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
            parent.setCorrelationId('parent-id');
            
            const child = parent.child({ component: 'test' });
            
            expect(child.correlationId).toBe('parent-id');
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
            
            const correlationId = logger.setCorrelationId('test-id-123');
            const message = logger.formatSyslog('INFO', 'Test message', { key: 'value' });
            
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

        test('should inherit correlation ID from parent', () => {
            const logger = new Logger({ level: 'INFO' });
            logger.setCorrelationId('parent-id');
            
            const childLogger = logger.child({ component: 'test' });
            
            expect(childLogger.correlationId).toBe('parent-id');
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
});
