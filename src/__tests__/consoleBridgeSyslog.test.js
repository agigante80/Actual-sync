/**
 * #426: a failing syslog sink must not loop through the console bridge. The
 * UDP send callback reports its error with console.error after log() has
 * returned; without the pass-through guard the bridge captured it, logged it to
 * syslog again, and that send failed again, for the whole session.
 */
const { Logger } = require('../lib/logger');
const { installConsoleBridge } = require('../lib/consoleBridge');

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('console bridge with a failing syslog sink (#426)', () => {
    let errors, restore, logger;

    beforeEach(() => {
        errors = [];
        jest.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
        jest.spyOn(console, 'log').mockImplementation(() => {});
        logger = new Logger({
            logDir: null,
            format: 'json',
            syslog: { enabled: true, host: '127.0.0.1', port: 514, protocol: 'udp', facility: 16 }
        });
        // Every send fails asynchronously, like an unresolvable host.
        logger.syslogClient.send = jest.fn((buf, off, len, port, host, cb) => {
            setImmediate(() => cb(new Error('getaddrinfo ENOTFOUND')));
        });
        restore = installConsoleBridge(logger);
    });

    afterEach(() => {
        restore();
        try { logger.syslogClient.close(); } catch (_) { /* ignore */ }
        jest.restoreAllMocks();
    });

    test('one log call gives one syslog send and one raw error line', async () => {
        logger.info('one line');
        for (let i = 0; i < 10; i++) await flush();
        expect(logger.syslogClient.send).toHaveBeenCalledTimes(1);
        expect(errors).toEqual(['Failed to send to syslog: getaddrinfo ENOTFOUND']);
    });
});
