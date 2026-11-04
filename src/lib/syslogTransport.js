/**
 * Stream syslog transport: TCP (RFC 6587) and TLS (RFC 5425).
 *
 * Messages use octet-counting framing ("<len> <msg>", len in bytes). The
 * transport never throws into the logging path: connection errors schedule a
 * reconnect with exponential backoff, and messages written while disconnected
 * wait in a bounded queue (oldest dropped first, drops counted). TLS always
 * verifies the server certificate; an optional `ca` file adds a trust anchor.
 */

const net = require('net');
const tls = require('tls');
const fs = require('fs');

/** RFC 6587 3.4.1 octet-counting frame. Length is in bytes, not characters. */
function frameMessage(message) {
    const body = Buffer.from(String(message), 'utf8');
    return Buffer.concat([Buffer.from(`${body.length} `, 'ascii'), body]);
}

class SyslogStreamTransport {
    /**
     * @param {object} opts host, port, protocol ('tcp'|'tls'), ca (path, optional),
     *   maxQueue, minBackoffMs, maxBackoffMs, onError (fn)
     */
    constructor(opts = {}) {
        this.host = opts.host || 'localhost';
        this.port = opts.port || 514;
        this.useTls = opts.protocol === 'tls';
        this.maxQueue = opts.maxQueue || 1000;
        this.minBackoffMs = opts.minBackoffMs || 1000;
        this.maxBackoffMs = opts.maxBackoffMs || 30000;
        this.stallTimeoutMs = opts.stallTimeoutMs || 30000;
        this.waitingDrain = false;
        this.onError = opts.onError || (() => {});
        this.queue = [];
        this.dropped = 0;
        this.closed = false;
        this.connected = false;
        this.socket = null;
        this.timer = null;
        this.backoff = this.minBackoffMs;
        this.ca = null;
        if (this.useTls && opts.ca) {
            try {
                this.ca = fs.readFileSync(opts.ca);
            } catch (err) {
                this.onError(new Error(`syslog ca file unreadable: ${err.message}`));
            }
        }
        this._connect();
    }

    _connect() {
        if (this.closed) return;
        let socket;
        try {
            if (this.useTls) {
                // Verification stays on (Node default). Never set rejectUnauthorized false.
                const options = { host: this.host, port: this.port };
                if (!net.isIP(this.host)) options.servername = this.host;
                if (this.ca) options.ca = [...tls.rootCertificates, this.ca.toString()];
                socket = tls.connect(options);
            } else {
                socket = net.connect({ host: this.host, port: this.port });
            }
        } catch (err) {
            this._report(err);
            this._scheduleReconnect();
            return;
        }
        this.socket = socket;
        this.waitingDrain = false;
        socket.setKeepAlive(true);
        socket.on('drain', () => {
            if (this.socket !== socket) return;
            this.waitingDrain = false;
            this._flush();
        });
        // A collector that accepts the connection but stops reading would hold
        // frames in the socket buffer for ever: destroy on a write stall, which
        // triggers 'close' and the normal reconnect.
        socket.setTimeout(this.stallTimeoutMs, () => {
            // Decide on bytes actually pending, not the drain flag: small writes
            // below the high-water mark never set it. An idle healthy socket has 0.
            if (this.socket === socket && socket.writableLength > 0) {
                this._report(new Error('syslog collector stalled; reconnecting'));
                socket.destroy();
            }
        });
        socket.on(this.useTls ? 'secureConnect' : 'connect', () => {
            if (this.socket !== socket) return;
            this.connected = true;
            this.backoff = this.minBackoffMs;
            this._flush();
        });
        socket.on('error', (err) => this._report(err));
        socket.on('close', () => {
            if (this.socket !== socket) return;
            this.connected = false;
            this.socket = null;
            this._scheduleReconnect();
        });
    }

    _report(err) {
        try { this.onError(err); } catch (_) { /* never throw into logging */ }
    }

    _scheduleReconnect() {
        if (this.closed || this.timer) return;
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
        this.timer = setTimeout(() => {
            this.timer = null;
            this._connect();
        }, delay);
        if (this.timer.unref) this.timer.unref();
    }

    _flush() {
        // Respect backpressure: once write() returns false, leave the rest in the
        // bounded queue (so maxQueue and the drop counter apply) until 'drain'.
        while (this.connected && !this.waitingDrain && this.queue.length > 0 && this.socket) {
            const frame = this.queue.shift();
            try {
                if (!this.socket.write(frame)) this.waitingDrain = true;
            } catch (err) {
                this.queue.unshift(frame);
                this._report(err);
                return;
            }
        }
    }

    /** Queue one syslog message (string). Never throws. */
    write(message) {
        if (this.closed) return;
        try {
            this.queue.push(frameMessage(message));
            while (this.queue.length > this.maxQueue) {
                this.queue.shift();
                this.dropped++;
            }
            this._flush();
        } catch (err) {
            this._report(err);
        }
    }

    close() {
        this.closed = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.socket) {
            const s = this.socket;
            this.socket = null;
            try { s.end(); } catch (_) { /* ignore */ }
            setTimeout(() => { try { s.destroy(); } catch (_) { /* ignore */ } }, 1000).unref();
        }
        this.connected = false;
    }
}

module.exports = { SyslogStreamTransport, frameMessage };
