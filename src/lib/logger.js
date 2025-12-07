/**
 * Structured Logger
 * Provides structured logging with levels, correlation IDs, and JSON output
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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
        
        // Ensure log directory exists
        if (this.logDir && !fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
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
        const metaStr = Object.keys(meta).length > 0 
            ? ` ${JSON.stringify(meta, null, 2)}` 
            : '';
        
        return `${timestamp} [${level.toUpperCase()}]${correlationStr} ${message}${metaStr}`;
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
            const date = new Date().toISOString().split('T')[0];
            const logFile = path.join(this.logDir, `${this.serviceName}-${date}.log`);
            fs.appendFileSync(logFile, formattedLog + '\n', 'utf8');
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
            serviceName: this.serviceName
        });
        childLogger.correlationId = this.correlationId;
        childLogger.context = { ...this.context, ...context };
        return childLogger;
    }

    /**
     * Log with context included
     */
    logWithContext(level, message, meta = {}) {
        const contextMeta = { ...this.context, ...meta };
        this.log(level, message, contextMeta);
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
