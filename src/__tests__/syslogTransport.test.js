const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SyslogStreamTransport, frameMessage } = require('../lib/syslogTransport');
const { Logger } = require('../lib/logger');

const waitFor = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn()) return;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('timeout');
};

const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

describe('frameMessage (RFC 6587 octet counting)', () => {
    test('prefixes byte length and a space', () => {
        expect(frameMessage('hello').toString()).toBe('5 hello');
    });
    test('counts bytes, not characters', () => {
        expect(frameMessage('café').toString('utf8')).toBe('5 café');
    });
});

describe('SyslogStreamTransport over TCP', () => {
    let server, port, received, sockets;
    const makeServer = () => net.createServer((s) => {
        sockets.push(s);
        s.on('data', d => { received += d.toString(); });
    });
    beforeEach(async () => {
        received = '';
        sockets = [];
        server = makeServer();
        port = await listen(server);
    });
    afterEach(async () => {
        sockets.forEach(s => s.destroy());
        await new Promise(r => server.close(r));
    });

    test('delivers framed messages in order', async () => {
        const t = new SyslogStreamTransport({ host: '127.0.0.1', port, protocol: 'tcp' });
        t.write('one');
        t.write('two');
        await waitFor(() => received === '3 one3 two');
        t.close();
    });

    test('Logger with protocol tcp sends framed RFC 5424 and does not throw', async () => {
        const logger = new Logger({
            logDir: null,
            syslog: { enabled: true, host: '127.0.0.1', port, protocol: 'tcp', facility: 16 }
        });
        const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
        expect(() => logger.info('hello', { a: 'x"y]z\\' })).not.toThrow();
        spy.mockRestore();
        await waitFor(() => received.includes('hello'));
        expect(received).toMatch(/^\d+ <134>1 /);
        expect(received).toContain('a="x\\"y\\]z\\\\"');
        const len = parseInt(received.split(' ')[0], 10);
        expect(Buffer.byteLength(received.slice(received.indexOf(' ') + 1))).toBe(len);
        logger.close();
    });

    test('queues while disconnected, bounds it, counts drops, then reconnects and flushes', async () => {
        await new Promise(r => server.close(r));
        sockets.forEach(s => s.destroy());
        const errors = [];
        const t = new SyslogStreamTransport({
            host: '127.0.0.1', port, protocol: 'tcp', maxQueue: 2,
            minBackoffMs: 20, maxBackoffMs: 50, onError: e => errors.push(e)
        });
        t.write('a'); t.write('b'); t.write('c');
        expect(t.queue.length).toBe(2);
        expect(t.dropped).toBe(1);
        await waitFor(() => errors.length > 0);
        server = makeServer();
        await new Promise(r => server.listen(port, '127.0.0.1', r));
        await waitFor(() => received === '1 b1 c');
        t.close();
    });

    test('write never throws, even after close or with odd input, or if onError throws', () => {
        const t = new SyslogStreamTransport({ host: '127.0.0.1', port, protocol: 'tcp', onError: () => { throw new Error('x'); } });
        expect(() => t.write(undefined)).not.toThrow();
        t.close();
        expect(() => t.write('x')).not.toThrow();
    });
});

describe('SyslogStreamTransport over TLS', () => {
    let dir, keyFile, certFile, available = true;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syslog-tls-'));
        keyFile = path.join(dir, 'server.key');
        certFile = path.join(dir, 'server.crt');
        try {
            execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
                '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
        } catch (_) { available = false; }
    });

    test('verifies the certificate: delivers with the CA, refuses without it', async () => {
        if (!available) return; // openssl not present: skip
        let received = '';
        const server = tls.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (s) => {
            s.on('data', d => { received += d.toString(); });
            s.on('error', () => {});
        });
        server.on('tlsClientError', () => {});
        const port = await listen(server);

        const bad = new SyslogStreamTransport({ host: '127.0.0.1', port, protocol: 'tls', onError: () => {} });
        bad.write('untrusted');
        await new Promise(r => setTimeout(r, 400));
        expect(received).toBe('');
        expect(bad.connected).toBe(false);
        bad.close();

        const good = new SyslogStreamTransport({ host: '127.0.0.1', port, protocol: 'tls', ca: certFile });
        good.write('secure');
        await waitFor(() => received === '6 secure');
        good.close();
        await new Promise(r => server.close(r));
    });
});
