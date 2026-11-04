/**
 * Structured Logger
 * Provides structured logging with levels, correlation IDs, JSON output, rotation, and syslog support
 */

const fs = require('fs');
const path = require('path');
// Node's built-in v4 UUID generator — no external dependency (replaces `uuid`,
// which went ESM-only at v14 and could not be required under the CJS test runner). (#56)
const { randomUUID } = require('crypto');
const { createStream } = require('rotating-file-stream');

// Log dir owner-only, log files owner read/write (D10, #446).
const LOG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;
let permissionWarningShown = false;

/**
 * chmod the log dir to 0700 and every existing log file in it to 0600.
 * Never throws: a failure (not the owner, read-only mount) warns once with a
 * static message, so no path or error text reaches the console.
 */
function tightenLogPermissions(logDir) {
    if (process.platform === 'win32') return;
    let failed = false;
    // fchmod on an O_NOFOLLOW descriptor: no symlink is ever followed (CWE-59)
    // and the check and the chmod act on the same inode (no TOCTOU, CWE-367).
    const fchmodNoFollow = (target, flags, mode, wantDir) => {
        let fd;
        try {
            fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | flags);
            const st = fs.fstatSync(fd);
            if (wantDir ? !st.isDirectory() : !st.isFile()) { failed = true; return false; }
            fs.fchmodSync(fd, mode);
            return true;
        } catch (error) {
            failed = true;
            return false;
        } finally {
            if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
        }
    };
    try {
        // A symlinked log dir is a normal Docker setup (a volume mount), and we
        // write into its target anyway, so tighten the resolved directory. A
        // symlink planted inside it would need write access to a dir that is
        // 0700 and ours, so the write path is not hardened further here (#446).
        const dir = fs.realpathSync(path.resolve(logDir));
        fchmodNoFollow(dir, fs.constants.O_DIRECTORY, LOG_DIR_MODE, true);
        for (const name of fs.readdirSync(dir)) {
            if (!/\.(log|gz)$/.test(name)) continue;
            // A non-regular .log/.gz entry (symlink, fifo) counts as a failure.
            fchmodNoFollow(path.join(dir, name), 0, LOG_FILE_MODE, false);
        }
    } catch (error) {
        failed = true;
    }
    if (failed && !permissionWarningShown) {
        permissionWarningShown = true;
        console.warn('Could not tighten log directory permissions to 0700/0600');
    }
}
const dgram = require('dgram');
const { SyslogStreamTransport } = require('./syslogTransport');

// Log levels
const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

// Security audit floor (D7, #444): at most this many records per event and
// source in a window; the rest are counted and reported in one
// security.suppressed record. The table of sources is bounded.
const SECURITY_LIMIT = 10;
const SECURITY_WINDOW_MS = 60 * 1000;
const SECURITY_MAX_SOURCES = 1000;
const SECURITY_INFO_EVENTS = new Set(['authn_login_success', 'sys_startup', 'sys_shutdown', 'sys_config_change']);

const LEVEL_NAMES = {
    0: 'ERROR',
    1: 'WARN',
    2: 'INFO',
    3: 'DEBUG'
};

// Keys owned by the logger; context and meta cannot set them (#433, design D1).
const RESERVED_KEYS = new Set([
    'timestamp', 'level', 'severity', 'message', 'event',
    'service', 'version', 'component', 'seq', 'schema'
]);

// `event` and `component` are reserved names in the record shape, but the
// caller sets them (D1 component children, D7 audit events such as
// authz_fail), so they pass through. Only the keys the logger itself writes
// are stripped from context and meta.
const CALLER_SET_KEYS = new Set(['event', 'component']);
const LOGGER_OWNED_KEYS = new Set([...RESERVED_KEYS].filter((k) => !CALLER_SET_KEYS.has(k)));

const withoutReserved = (obj) => Object.fromEntries(
    Object.entries(obj || {}).filter(([k]) => !LOGGER_OWNED_KEYS.has(k))
);

class Logger {
    constructor(options = {}) {
        this.level = options.level || 'INFO';
        this.format = options.format || 'pretty'; // console format: 'pretty' or 'json'
        // File/production format is single-line JSON by default so logs are
        // machine-parseable and shippable, independent of the console format. (#104)
        this.fileFormat = options.fileFormat || 'json';

        // Secret redaction (#103). A property is masked when its (lower-cased) key
        // contains any of these indicators, so variants like refreshToken,
        // accessToken, clientSecret, and encryptionPassword are all caught.
        // Callers may add indicators via logging.redact. Applied at any depth before
        // writing to console, file, syslog, or the dashboard WebSocket.
        const DEFAULT_REDACT_INDICATORS = [
            'password', 'passwd', 'token', 'secret', 'apikey', 'api_key',
            'authorization', 'credential', 'chatid'
        ];
        this.redactIndicators = [
            ...DEFAULT_REDACT_INDICATORS,
            ...(Array.isArray(options.redact) ? options.redact.map(k => String(k).toLowerCase()) : [])
        ];
        // Default logDir logic:
        // - If logDir is explicitly provided and not undefined, use it (including null to disable)
        // - If in test environment (NODE_ENV=test or Jest), use null (no file logging)
        // - Otherwise, use ./logs (works in both local and Docker)
        let defaultLogDir = './logs';
        if (process.env.NODE_ENV === 'test' || typeof jest !== 'undefined') {
            defaultLogDir = null;
        }
        // Only use provided logDir if it's not undefined (null is valid for disabling)
        this.logDir = (options.logDir !== undefined) ? options.logDir : defaultLogDir;
        this.serviceName = options.serviceName || 'actual-sync';
        this.correlationId = null;
        this.broadcastCallback = options.broadcastCallback || null;
        this.context = options.context || {};
        // Rate-limit state for security(); children share the parent's. (#444)
        this.securityState = { sources: new Map() };

        // Rotation settings (defaults align with schema)
        this.rotation = options.rotation || {
            enabled: true,
            maxSize: '10M',
            maxFiles: 30,
            compress: 'gzip'
        };
        
        // Syslog settings
        this.syslog = options.syslog || {
            enabled: false,
            host: 'localhost',
            port: 514,
            protocol: 'udp',
            facility: 16 // local0
        };
        
        // Performance tracking
        this.performanceEnabled = options.performance?.enabled || false;
        this.performanceThresholds = options.performance?.thresholds || {
            slow: 1000,  // Log if operation takes > 1s
            verySlow: 5000  // Log as warning if > 5s
        };
        
        // Ensure log directory exists
        if (this.logDir) {
            try {
                if (!fs.existsSync(this.logDir)) {
                    fs.mkdirSync(this.logDir, { recursive: true, mode: LOG_DIR_MODE });
                    console.log(`✅ Created log directory: ${this.logDir}`);
                }
                // Test write permissions
                const testFile = path.join(this.logDir, '.write-test');
                fs.writeFileSync(testFile, 'test', 'utf8');
                fs.unlinkSync(testFile);
            } catch (error) {
                console.error(`❌ Cannot write to log directory ${this.logDir}: ${error.message}`);
                console.error('   Logs will only be output to console.');
                console.error('   Check directory permissions and user/group ownership.');
                this.logDir = null; // Disable file logging if directory is not writable
            }
        }
        
        // Tighten an existing dir and existing log files (D10, #446).
        if (this.logDir && !options.inheritStreams) {
            tightenLogPermissions(this.logDir);
        }

        // Setup rotating file stream if enabled. Child loggers inherit the parent's
        // stream (see child()), so they must not open their own here: doing so would
        // orphan a stream — and, with time-based rotation, a never-cleared rotation
        // timer — on every child() call. (#106)
        this.rotatingStream = null;
        if (this.logDir && this.rotation.enabled && !options.inheritStreams) {
            try {
                const streamOptions = {
                    path: this.logDir,
                    size: this.rotation.maxSize,
                    // Time-based rotation so low-volume deployments still rotate daily
                    // and maxFiles behaves as documented (days of retention). Rotation
                    // fires on whichever trigger comes first: the interval or the size. (#106)
                    interval: this.rotation.interval || '1d',
                    maxFiles: this.rotation.maxFiles,
                    mode: LOG_FILE_MODE
                };
                
                // Add compress option if enabled
                if (this.rotation.compress === 'gzip') {
                    streamOptions.compress = 'gzip';
                }
                
                this.rotatingStream = createStream(
                    (time, index) => {
                        if (!time) return `${this.serviceName}.log`;
                        const date = time.toISOString().split('T')[0];
                        return `${this.serviceName}-${date}.log`;
                    },
                    streamOptions
                );
                console.log(`✅ Rotating log stream enabled: ${this.logDir}/${this.serviceName}-*.log`);
            } catch (error) {
                console.error(`❌ Failed to setup rotating log stream: ${error.message}`);
                this.rotatingStream = null;
            }
        }
        
        // Setup syslog client if enabled (child loggers inherit the parent's).
        this.syslogClient = null;
        if (this.syslog.enabled && !options.inheritStreams) {
            const proto = this.syslog.protocol;
            if (proto === 'tcp' || proto === 'tls') {
                // Stream transports use net/tls (dgram has no tcp type). (#432)
                this.syslogClient = new SyslogStreamTransport({
                    host: this.syslog.host,
                    port: this.syslog.port,
                    protocol: proto,
                    ca: this.syslog.ca,
                    onError: (err) => console.error('Syslog transport error:', err.message)
                });
            } else {
                this.syslogClient = dgram.createSocket('udp4');
            }
        }
    }
    
    /**
     * Set broadcast callback for WebSocket log streaming
     */
    setBroadcastCallback(callback) {
        this.broadcastCallback = callback;
    }

    /**
     * Get numeric log level
     */
    getNumericLevel(level) {
        return LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.INFO;
    }

    /**
     * Check if message should be logged based on level
     */
    shouldLog(messageLevel) {
        const configLevel = this.getNumericLevel(this.level);
        const msgLevel = this.getNumericLevel(messageLevel);
        return msgLevel <= configLevel;
    }

    /**
     * Set correlation ID for tracking related log entries
     */
    setCorrelationId(id) {
        this.correlationId = id || randomUUID();
        return this.correlationId;
    }

    /**
     * Clear correlation ID
     */
    clearCorrelationId() {
        this.correlationId = null;
    }

    /**
     * Generate correlation ID
     */
    generateCorrelationId() {
        return randomUUID();
    }

    /**
     * Mask secret-looking tokens embedded in a string value (#103).
     * Covers Telegram bot-token URLs and generic token/secret query params.
     */
    maskSecrets(str) {
        if (typeof str !== 'string') {
            return str;
        }
        return str
            // https://api.telegram.org/bot<id>:<token>/...  ->  bot[REDACTED]
            .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]')
            // Path-style webhook secrets (#431): Slack /services/T/B/<secret>,
            // Discord /api[/vN]/webhooks/<id>/<token> (discord.com, discordapp.com)
            .replace(/(hooks\.slack(?:-gov)?\.com\/)[^\s"'?#<>]+/gi, '$1[REDACTED]')
            .replace(/(discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/)[^\s"'?#<>]+/gi, '$1[REDACTED]')
            // URL userinfo credentials: scheme://user:secret@host  ->  user:[REDACTED]@host
            .replace(/(\/\/[^/:@\s]+):[^/@\s]+@/g, '$1:[REDACTED]@')
            // Authorization: Bearer <token>
            .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
            // key=value anywhere (query string, form body, free text), value may be
            // bare or quoted: password=hunter2, token="abc", secret='x'
            .replace(/\b((?:access_|refresh_)?token|api[_-]?key|password|passwd|secret)=("[^"]*"|'[^']*'|[^&\s"']+)/gi, '$1=[REDACTED]')
            // JSON-style "key":"value" where the key name contains a secret indicator
            // (e.g. a stringified config blob logged as a message/value)
            .replace(/("[A-Za-z0-9_]*(?:password|token|secret|api[_-]?key|authorization|credential)[A-Za-z0-9_]*"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
    }

    /**
     * Whether a property key should be masked (case-insensitive substring match
     * against the configured secret indicators). (#103)
     */
    shouldRedactKey(key) {
        const lower = String(key).toLowerCase();
        return this.redactIndicators.some(indicator => lower.includes(indicator));
    }

    /**
     * Deep-clone a value, masking any property whose key looks secret and any
     * secret-looking token in string values. Never mutates the input, preserves
     * non-plain objects (Date/Buffer/Error/class instances), is safe against
     * circular references, and never throws (a throwing getter is masked, not
     * propagated, so a bad metadata object can never crash a log call). (#103)
     */
    redact(value, seen = new WeakSet()) {
        if (typeof value === 'string') {
            return this.maskSecrets(value);
        }
        // BigInt cannot be JSON-serialized; render it as a string so a log call
        // never fails downstream in serialize().
        if (typeof value === 'bigint') {
            return value.toString();
        }
        if (value === null || typeof value !== 'object') {
            return value;
        }
        // Errors serialize to {} via JSON (message/stack are non-enumerable), so
        // lift the useful fields explicitly. message/stack are masked; code, cause,
        // and enumerable custom fields (statusCode, errno, syscall, ...) are kept
        // and redacted. cause is followed cycle-safely.
        if (value instanceof Error) {
            if (seen.has(value)) {
                return '[Circular]';
            }
            seen.add(value);
            const out = {
                name: value.name,
                message: this.maskSecrets(value.message),
                stack: this.maskSecrets(value.stack)
            };
            if (value.code !== undefined) out.code = this.redactSafe(value.code, seen);
            if (value.cause !== undefined) out.cause = this.redactSafe(value.cause, seen);
            for (const key of Object.keys(value)) {
                if (key in out) continue;
                out[key] = this.shouldRedactKey(key)
                    ? '[REDACTED]'
                    : this.redactSafe(value[key], seen);
            }
            seen.delete(value);
            return out;
        }
        // Only clone/recurse into plain objects and arrays. Pass other object types
        // (Date, Buffer, RegExp, class instances) through unchanged so their
        // serialization is preserved. Log metadata is expected to be plain data.
        const isArray = Array.isArray(value);
        const proto = Object.getPrototypeOf(value);
        const isPlainObject = proto === Object.prototype || proto === null;
        if (!isArray && !isPlainObject) {
            return value;
        }
        // Track only the current ancestor path so a non-circular shared reference
        // is not mistaken for a cycle.
        if (seen.has(value)) {
            return '[Circular]';
        }
        seen.add(value);

        let result;
        if (isArray) {
            result = value.map(item => this.redactSafe(item, seen));
        } else {
            result = {};
            for (const key of Object.keys(value)) {
                if (this.shouldRedactKey(key)) {
                    result[key] = '[REDACTED]';
                    continue;
                }
                // Reading the property can invoke a getter that throws; never let
                // that escape a log call.
                let val;
                try {
                    val = value[key];
                } catch {
                    result[key] = '[unreadable]';
                    continue;
                }
                result[key] = this.redactSafe(val, seen);
            }
        }
        seen.delete(value);
        return result;
    }

    /**
     * redact() wrapper that can never throw, used for recursion so one bad nested
     * value degrades to a placeholder instead of failing the whole log call. (#103)
     */
    redactSafe(value, seen) {
        try {
            return this.redact(value, seen);
        } catch {
            return '[unserializable]';
        }
    }

    /**
     * Serialize already-redacted data into a single console/file line. Kept
     * separate from redaction so log() can redact once and serialize per
     * destination (console + file) without re-cloning. (#103, #104)
     */
    serialize(level, safeMessage, safeContext, safeMeta, format) {
        const timestamp = new Date().toISOString();
        safeContext = withoutReserved(safeContext);
        safeMeta = withoutReserved(safeMeta);
        // Logger-owned keys were stripped above, so caller fields cannot
        // overwrite them; they lead the record to match docs/LOGGING.md (#433).
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            service: this.serviceName,
            message: safeMessage
        };
        Object.assign(logEntry, safeContext, safeMeta);
        if (this.correlationId) {
            // Not reserved, but the logger's own id still wins, as before #433.
            logEntry.correlationId = this.correlationId;
        }

        if (format === 'json') {
            // JSON.stringify leaves U+2028/2029, DEL, C1 and bidi raw; they can only
            // occur inside strings, so escaping the output keeps it valid JSON. (#447)
            return escapeControlChars(JSON.stringify(logEntry), true);
        }

        // Pretty format for console
        const correlationStr = this.correlationId ? ` [${this.correlationId.substring(0, 8)}]` : '';
        const contextStr = Object.keys(safeContext).length > 0
            ? ` [${escapeControlChars(JSON.stringify(safeContext))}]`
            : '';
        const metaStr = Object.keys(safeMeta).length > 0
            ? ` ${escapeControlChars(JSON.stringify(safeMeta))}`
            : '';

        return `${timestamp} [${level.toUpperCase()}]${correlationStr}${contextStr} ${escapeControlChars(safeMessage)}${metaStr}`;
    }

    /**
     * serialize() that can never throw. A value passed through redaction unchanged
     * (e.g. a class instance with a throwing toJSON) could otherwise make
     * JSON.stringify throw on the console path; a log call must never throw. (#103)
     */
    safeSerialize(level, safeMessage, safeContext, safeMeta, format) {
        try {
            return this.serialize(level, safeMessage, safeContext, safeMeta, format);
        } catch (error) {
            // The fallback is an output path too: escape it like serialize() (#447),
            // and keep json format valid JSON. Plain strings cannot make this throw.
            const ts = new Date().toISOString();
            if (format === 'json') {
                return escapeControlChars(JSON.stringify({
                    timestamp: ts, level: level.toUpperCase(), message: String(safeMessage),
                    serializationError: String(error && error.message)
                }), true);
            }
            return `${ts} [${level.toUpperCase()}] ${escapeControlChars(safeMessage)} [log serialization error: ${escapeControlChars(error && error.message)}]`;
        }
    }

    /**
     * Format syslog message (RFC 5424)
     */
    formatSyslog(level, safeMessage, safeContext = {}, safeMeta = {}) {
        const priority = this.syslog.facility * 8 + this.levelToSyslogSeverity(level);
        const timestamp = new Date().toISOString();
        const hostname = require('os').hostname();
        const appName = this.serviceName;
        const pid = process.pid;

        // Data is already redacted by the caller. Nested values are JSON-encoded so
        // structured metadata is not flattened to "[object Object]", and SD-PARAM
        // values are escaped per RFC 5424 6.3.3 (\, ", ]) so quotes/brackets in the
        // value cannot terminate the structured-data element early. (#103, M5)
        const escapeSd = (s) => String(s).replace(/([\\"\]])/g, '\\$1');
        const encode = (v) => escapeSd(escapeControlChars(v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
        const correlationStr = this.correlationId ? `correlationId="${escapeSd(this.correlationId)}"` : '';
        const contextStr = Object.entries(safeContext)
            .map(([k, v]) => `${k}="${encode(v)}"`)
            .join(' ');
        const metaStr = Object.entries(safeMeta)
            .map(([k, v]) => `${k}="${encode(v)}"`)
            .join(' ');

        const structuredData = [correlationStr, contextStr, metaStr]
            .filter(s => s)
            .join(' ');

        return `<${priority}>1 ${timestamp} ${hostname} ${appName} ${pid} - [${structuredData}] ${escapeControlChars(safeMessage)}`;
    }
    
    /**
     * Convert log level to syslog severity
     */
    levelToSyslogSeverity(level) {
        const severityMap = {
            ERROR: 3,  // Error
            WARN: 4,   // Warning
            INFO: 6,   // Informational
            DEBUG: 7   // Debug
        };
        return severityMap[level.toUpperCase()] || 6;
    }
    
    /**
     * Send log to syslog server
     */
    sendToSyslog(level, safeMessage, safeContext = {}, safeMeta = {}) {
        if (!this.syslogClient) return;

        try {
            const syslogMessage = this.formatSyslog(level, safeMessage, safeContext, safeMeta);
            if (this.syslogClient instanceof SyslogStreamTransport) {
                this.syslogClient.write(syslogMessage);
                return;
            }
            const buffer = Buffer.from(syslogMessage);
            
            this.syslogClient.send(
                buffer,
                0,
                buffer.length,
                this.syslog.port,
                this.syslog.host,
                (err) => {
                    if (err) {
                        console.error('Failed to send to syslog:', err.message);
                    }
                }
            );
        } catch (error) {
            console.error('Error formatting syslog message:', error.message);
        }
    }

    /**
     * Write log entry
     */
    log(level, message, meta = {}, { audit = false } = {}) {
        // An audit record (security events) ignores the configured level. (#444)
        if (!audit && !this.shouldLog(level)) {
            return;
        }

        // Redact once and reuse for every destination. Redaction never throws
        // (a throwing getter degrades to a placeholder), so a bad metadata object
        // can never crash a log call. (#103, perf)
        let safeMessage, safeContext, safeMeta;
        try {
            safeMessage = this.maskSecrets(message);
            safeContext = this.redact(this.context);
            safeMeta = this.redact(meta);
        } catch (error) {
            safeMessage = typeof message === 'string' ? message : String(message);
            safeContext = {};
            safeMeta = { logRedactionError: error.message };
        }

        // Console uses the human-friendly format; the file uses the (default JSON)
        // single-line file format so logs stay machine-parseable. (#104)
        const consoleLine = this.safeSerialize(level, safeMessage, safeContext, safeMeta, this.format);
        const consoleMethod = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
        console[consoleMethod](consoleLine);

        // File output if configured. A file-write failure must never break logging.
        if (this.logDir) {
            try {
                const fileLine = this.safeSerialize(level, safeMessage, safeContext, safeMeta, this.fileFormat);
                if (this.rotatingStream) {
                    this.rotatingStream.write(fileLine + '\n');
                } else {
                    // Use simple daily files
                    const date = new Date().toISOString().split('T')[0];
                    const logFile = path.join(this.logDir, `${this.serviceName}-${date}.log`);
                    fs.appendFileSync(logFile, fileLine + '\n', { encoding: 'utf8', mode: LOG_FILE_MODE });
                }
            } catch (error) {
                console.error('Failed to write log to file:', error.message);
            }
        }

        // Send to syslog if enabled (already-redacted data). (#103)
        if (this.syslog.enabled) {
            this.sendToSyslog(level, safeMessage, safeContext, safeMeta);
        }

        // Broadcast to WebSocket clients if callback is set (already-redacted). (#103)
        if (this.broadcastCallback) {
            try {
                this.broadcastCallback(level.toUpperCase(), safeMessage, safeMeta);
            } catch (error) {
                // Don't let broadcast errors break logging
                console.error('Failed to broadcast log:', error.message);
            }
        }
    }

    /**
     * Log error
     */
    error(message, meta = {}) {
        // Handle Error objects
        if (message instanceof Error) {
            meta = {
                ...meta,
                errorName: message.name,
                errorMessage: message.message,
                errorStack: message.stack,
                errorCode: message.code
            };
            message = message.message;
        }
        this.log('ERROR', message, meta);
    }

    /**
     * Log warning
     */
    warn(message, meta = {}) {
        this.log('WARN', message, meta);
    }

    /**
     * Log info
     */
    info(message, meta = {}) {
        this.log('INFO', message, meta);
    }

    /**
     * Log debug
     */
    debug(message, meta = {}) {
        this.log('DEBUG', message, meta);
    }

    /**
     * Write a security event (D7, OWASP Logging Vocabulary name as `event`,
     * `category: "security"`). It is an audit floor: written whatever the
     * configured level, never sampled. Callers pass `remoteAddress` and
     * static fields only, never bodies, user names, passwords or tokens. (#444)
     *
     * Rate limit: SECURITY_LIMIT records per event and source (the
     * remoteAddress) per window. Past it records are counted, and one
     * `security.suppressed` record with `suppressedCount` is written when the
     * window ends, so a guess loop never looks like it stopped.
     *
     * @param {string} event - e.g. 'authn_login_fail'
     * @param {Object} [fields] - flat fields; remoteAddress is the source key
     * @param {Object} [opts]
     * @param {number} [opts.dedupeMs] - log at most once per source per this
     *   many ms and drop repeats silently ("once per session" events)
     * @param {string} [opts.level] - 'INFO' or 'WARN'; default by event
     * @param {string} [opts.sourceKey] - limiter key for the source; callers
     *   pass the same key as their request limiter (IPv6 grouped by /56), so
     *   rotating addresses inside one prefix share one budget. The record keeps
     *   the full remoteAddress.
     */
    security(event, fields = {}, opts = {}) {
        const state = this.securityState;
        const source = String(opts.sourceKey ?? fields.remoteAddress ?? 'unknown');
        // The realm is part of the key: a metrics scrape must not hide a
        // dashboard login from the same address, nor share its budget.
        const key = `${event}|${fields.realm ?? ''}|${source}`;
        const now = Date.now();
        const windowMs = opts.dedupeMs || SECURITY_WINDOW_MS;
        let entry = state.sources.get(key);
        if (entry && now - entry.start >= windowMs) {
            this.flushSecurityEntry(key, entry);
            entry = undefined;
        }
        if (!entry) {
            if (state.sources.size >= SECURITY_MAX_SOURCES) {
                const oldest = state.sources.keys().next().value;
                this.flushSecurityEntry(oldest, state.sources.get(oldest));
            }
            entry = { start: now, count: 0, suppressed: 0, timer: null, fields: { remoteAddress: fields.remoteAddress }, event };
            state.sources.set(key, entry);
            if (!opts.dedupeMs) {
                entry.timer = setTimeout(() => this.flushSecurityEntry(key, entry), windowMs);
                if (entry.timer.unref) entry.timer.unref();
            }
        }
        entry.count++;
        if (opts.dedupeMs) {
            if (entry.count > 1) return;
        } else if (entry.count > SECURITY_LIMIT) {
            entry.suppressed++;
            return;
        }
        const level = opts.level || (SECURITY_INFO_EVENTS.has(event) ? 'INFO' : 'WARN');
        // event and category go last so a caller field cannot overwrite them.
        this.log(level, event, { ...fields, event, category: 'security' }, { audit: true });
    }

    /** Write the pending security.suppressed record of one source and forget it. */
    flushSecurityEntry(key, entry) {
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        const sources = this.securityState.sources;
        if (sources.get(key) === entry) sources.delete(key);
        if (entry.suppressed > 0) {
            this.log('WARN', 'security.suppressed', {
                ...entry.fields,
                event: 'security.suppressed',
                category: 'security',
                suppressedEvent: entry.event,
                suppressedCount: entry.suppressed
            }, { audit: true });
            entry.suppressed = 0;
        }
    }

    /**
     * Create child logger with additional context
     */
    child(context = {}, options = {}) {
        const childLogger = new Logger({
            level: options.level || this.level,
            format: this.format,
            fileFormat: this.fileFormat,
            logDir: this.logDir,
            serviceName: this.serviceName,
            context: { ...this.context, ...context },
            rotation: this.rotation,
            syslog: this.syslog,
            // Do not open new streams; the child shares the parent's below. (#106)
            inheritStreams: true,
            performance: {
                enabled: this.performanceEnabled,
                thresholds: this.performanceThresholds
            }
        });
        childLogger.correlationId = this.correlationId;
        childLogger.broadcastCallback = this.broadcastCallback;
        childLogger.securityState = this.securityState;
        // Share the parent's redaction set (including any custom keys)
        childLogger.redactIndicators = this.redactIndicators;
        // Share streams to avoid duplicates
        childLogger.rotatingStream = this.rotatingStream;
        childLogger.syslogClient = this.syslogClient;
        return childLogger;
    }

    /**
     * Start performance timer
     */
    startTimer(operationName) {
        if (!this.performanceEnabled) {
            return () => {}; // No-op function
        }
        
        const startTime = Date.now();
        const startCorrelationId = this.correlationId;
        
        return (metadata = {}) => {
            const duration = Date.now() - startTime;
            const level = duration > this.performanceThresholds.verySlow ? 'WARN' 
                        : duration > this.performanceThresholds.slow ? 'INFO' 
                        : 'DEBUG';
            
            // Temporarily restore correlation ID if it changed
            const currentCorrelationId = this.correlationId;
            this.correlationId = startCorrelationId;
            
            this.log(level, `Performance: ${operationName}`, {
                ...metadata,
                duration,
                durationMs: duration,
                operation: operationName,
                slow: duration > this.performanceThresholds.slow,
                verySlow: duration > this.performanceThresholds.verySlow
            });
            
            // Restore current correlation ID
            this.correlationId = currentCorrelationId;
            
            return duration;
        };
    }
    
    /**
     * Close logger and cleanup resources
     */
    /** Write every pending security.suppressed count now (shutdown). (#444) */
    flushSecurity() {
        for (const [key, entry] of [...this.securityState.sources]) {
            this.flushSecurityEntry(key, entry);
        }
    }

    close() {
        this.flushSecurity();
        if (this.rotatingStream) {
            this.rotatingStream.end();
        }
        if (this.syslogClient) {
            this.syslogClient.close();
        }
    }
}

/**
 * Replace control and line-breaking characters with visible escapes so one log
 * call is exactly one line and cannot forge entries or drive the terminal
 * (CWE-117). Covers C0 (incl. CR/LF/ESC), DEL, C1, U+2028/2029 and the bidi
 * controls U+202A-202E and U+2066-2069. (#447)
 * @param {*} value Coerced with String().
 * @param {boolean} [json] Always use \\uNNNN (valid inside a JSON string).
 * @returns {string}
 */
function escapeControlChars(value, json = false) {
    return String(value).replace(
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
        (c) => {
            const code = c.charCodeAt(0);
            const hex = code.toString(16).padStart(json || code > 0xff ? 4 : 2, '0');
            return (json || code > 0xff ? '\\u' : '\\x') + hex;
        }
    );
}

/**
 * Create default logger instance
 */
function createLogger(options = {}) {
    // Load from config if available
    try {
        const ConfigLoader = require('./configLoader');
        const configLoader = new ConfigLoader();
        const config = configLoader.getConfig();
        
        if (config && config.logging) {
            options = {
                level: config.logging.level || 'INFO',
                format: config.logging.format || 'pretty',
                fileFormat: config.logging.fileFormat || 'json',
                logDir: config.logging.logDir || null,
                redact: config.logging.redact,
                rotation: config.logging.rotation,
                ...options
            };
        }
    } catch (error) {
        // Config not loaded yet, use defaults
    }

    return new Logger(options);
}

module.exports = {
    Logger,
    createLogger,
    escapeControlChars,
    LOG_LEVELS,
    LEVEL_NAMES
};
