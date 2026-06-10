/**
 * Structured Logger
 * Provides structured logging with levels, correlation IDs, JSON output, rotation, and syslog support
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createStream } = require('rotating-file-stream');
const dgram = require('dgram');

// Log levels
const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

const LEVEL_NAMES = {
    0: 'ERROR',
    1: 'WARN',
    2: 'INFO',
    3: 'DEBUG'
};

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
                    fs.mkdirSync(this.logDir, { recursive: true });
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
                    maxFiles: this.rotation.maxFiles
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
            this.syslogClient = dgram.createSocket(this.syslog.protocol === 'tcp' ? 'tcp4' : 'udp4');
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
        this.correlationId = id || uuidv4();
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
        return uuidv4();
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
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            service: this.serviceName,
            message: safeMessage,
            ...safeContext,
            ...safeMeta
        };

        if (this.correlationId) {
            logEntry.correlationId = this.correlationId;
        }

        if (format === 'json') {
            return JSON.stringify(logEntry);
        }

        // Pretty format for console
        const correlationStr = this.correlationId ? ` [${this.correlationId.substring(0, 8)}]` : '';
        const contextStr = Object.keys(safeContext).length > 0
            ? ` [${JSON.stringify(safeContext)}]`
            : '';
        const metaStr = Object.keys(safeMeta).length > 0
            ? ` ${JSON.stringify(safeMeta, null, 2)}`
            : '';

        return `${timestamp} [${level.toUpperCase()}]${correlationStr}${contextStr} ${safeMessage}${metaStr}`;
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
            return `${new Date().toISOString()} [${level.toUpperCase()}] ${safeMessage} [log serialization error: ${error.message}]`;
        }
    }

    /**
     * Format a log entry: redact dynamic data (#103) then serialize in the given
     * format (defaults to the console format). (#104)
     */
    formatLog(level, message, meta = {}, format = this.format) {
        return this.serialize(
            level,
            this.maskSecrets(message),
            this.redact(this.context),
            this.redact(meta),
            format
        );
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
        const encode = (v) => escapeSd(v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
        const correlationStr = this.correlationId ? `correlationId="${this.correlationId}"` : '';
        const contextStr = Object.entries(safeContext)
            .map(([k, v]) => `${k}="${encode(v)}"`)
            .join(' ');
        const metaStr = Object.entries(safeMeta)
            .map(([k, v]) => `${k}="${encode(v)}"`)
            .join(' ');

        const structuredData = [correlationStr, contextStr, metaStr]
            .filter(s => s)
            .join(' ');

        return `<${priority}>1 ${timestamp} ${hostname} ${appName} ${pid} - [${structuredData}] ${safeMessage}`;
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
    log(level, message, meta = {}) {
        if (!this.shouldLog(level)) {
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
                    fs.appendFileSync(logFile, fileLine + '\n', 'utf8');
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
     * Create child logger with additional context
     */
    child(context = {}) {
        const childLogger = new Logger({
            level: this.level,
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
        // Share the parent's redaction set (including any custom keys)
        childLogger.redactIndicators = this.redactIndicators;
        // Share streams to avoid duplicates
        childLogger.rotatingStream = this.rotatingStream;
        childLogger.syslogClient = this.syslogClient;
        return childLogger;
    }

    /**
     * Log with context included
     */
    logWithContext(level, message, meta = {}) {
        const contextMeta = { ...this.context, ...meta };
        this.log(level, message, contextMeta);
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
    close() {
        if (this.rotatingStream) {
            this.rotatingStream.end();
        }
        if (this.syslogClient) {
            this.syslogClient.close();
        }
    }
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
    LOG_LEVELS,
    LEVEL_NAMES
};
