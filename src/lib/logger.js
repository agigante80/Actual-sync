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
        this.format = options.format || 'pretty'; // 'pretty' or 'json'
        this.logDir = options.logDir || null;
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
        
        // Setup rotating file stream if enabled
        this.rotatingStream = null;
        if (this.logDir && this.rotation.enabled) {
            try {
                const streamOptions = {
                    path: this.logDir,
                    size: this.rotation.maxSize,
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
        
        // Setup syslog client if enabled
        this.syslogClient = null;
        if (this.syslog.enabled) {
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
     * Format log entry
     */
    formatLog(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            service: this.serviceName,
            message,
            ...this.context,
            ...meta
        };

        if (this.correlationId) {
            logEntry.correlationId = this.correlationId;
        }

        if (this.format === 'json') {
            return JSON.stringify(logEntry);
        }

        // Pretty format for console
        const correlationStr = this.correlationId ? ` [${this.correlationId.substring(0, 8)}]` : '';
        const contextStr = Object.keys(this.context).length > 0 
            ? ` [${JSON.stringify(this.context)}]` 
            : '';
        const metaStr = Object.keys(meta).length > 0 
            ? ` ${JSON.stringify(meta, null, 2)}` 
            : '';
        
        return `${timestamp} [${level.toUpperCase()}]${correlationStr}${contextStr} ${message}${metaStr}`;
    }
    
    /**
     * Format syslog message (RFC 5424)
     */
    formatSyslog(level, message, meta = {}) {
        const priority = this.syslog.facility * 8 + this.levelToSyslogSeverity(level);
        const timestamp = new Date().toISOString();
        const hostname = require('os').hostname();
        const appName = this.serviceName;
        const pid = process.pid;
        
        // Structured data
        const correlationStr = this.correlationId ? `correlationId="${this.correlationId}"` : '';
        const contextStr = Object.entries(this.context)
            .map(([k, v]) => `${k}="${v}"`)
            .join(' ');
        const metaStr = Object.entries(meta)
            .map(([k, v]) => `${k}="${v}"`)
            .join(' ');
        
        const structuredData = [correlationStr, contextStr, metaStr]
            .filter(s => s)
            .join(' ');
        
        return `<${priority}>1 ${timestamp} ${hostname} ${appName} ${pid} - [${structuredData}] ${message}`;
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
    sendToSyslog(level, message, meta = {}) {
        if (!this.syslogClient) return;
        
        try {
            const syslogMessage = this.formatSyslog(level, message, meta);
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

        const formattedLog = this.formatLog(level, message, meta);
        
        // Console output with colors
        const consoleMethod = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
        console[consoleMethod](formattedLog);

        // File output if configured
        if (this.logDir) {
            if (this.rotatingStream) {
                // Use rotating stream
                this.rotatingStream.write(formattedLog + '\n');
            } else {
                // Use simple daily files
                const date = new Date().toISOString().split('T')[0];
                const logFile = path.join(this.logDir, `${this.serviceName}-${date}.log`);
                fs.appendFileSync(logFile, formattedLog + '\n', 'utf8');
            }
        }
        
        // Send to syslog if enabled
        if (this.syslog.enabled) {
            this.sendToSyslog(level, message, meta);
        }
        
        // Broadcast to WebSocket clients if callback is set
        if (this.broadcastCallback) {
            try {
                this.broadcastCallback(level.toUpperCase(), message, meta);
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
            logDir: this.logDir,
            serviceName: this.serviceName,
            context: { ...this.context, ...context },
            rotation: this.rotation,
            syslog: this.syslog,
            performance: {
                enabled: this.performanceEnabled,
                thresholds: this.performanceThresholds
            }
        });
        childLogger.correlationId = this.correlationId;
        childLogger.broadcastCallback = this.broadcastCallback;
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
                logDir: config.logging.logDir || null,
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
