/**
 * Tests for buildLoggerConfig (#116) — the mapping from a config.logging block
 * to logger options. Guards against logging.* options being silently dropped on
 * the way to createLogger() (redact and fileFormat were both previously lost).
 */

const { buildLoggerConfig } = require('../lib/loggerConfig');

describe('buildLoggerConfig (#116)', () => {
    test('forwards logging.redact (previously dropped)', () => {
        expect(buildLoggerConfig({ redact: ['ssn'] })).toEqual({ redact: ['ssn'] });
    });

    test('forwards logging.fileFormat (previously dropped)', () => {
        expect(buildLoggerConfig({ fileFormat: 'json' })).toEqual({ fileFormat: 'json' });
    });

    test('forwards every logger-consumed logging field', () => {
        const logging = {
            level: 'DEBUG',
            format: 'json',
            fileFormat: 'pretty',
            logDir: '/var/log',
            rotation: { enabled: true },
            syslog: { enabled: false },
            performance: { enabled: true },
            redact: ['x']
        };
        expect(buildLoggerConfig(logging)).toEqual(logging);
    });

    test('omits undefined fields so logger defaults apply', () => {
        expect(buildLoggerConfig({ level: 'INFO' })).toEqual({ level: 'INFO' });
    });

    test('returns an empty object for empty / missing logging', () => {
        expect(buildLoggerConfig({})).toEqual({});
        expect(buildLoggerConfig(undefined)).toEqual({});
        expect(buildLoggerConfig(null)).toEqual({});
    });

    test('does not forward runtime-only / unknown keys', () => {
        const logging = { serviceName: 'x', broadcastCallback: () => {}, level: 'WARN' };
        expect(buildLoggerConfig(logging)).toEqual({ level: 'WARN' });
    });
});
