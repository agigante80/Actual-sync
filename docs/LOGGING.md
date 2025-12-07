# Logging Guide

This document describes the structured logging system in Actual-sync.

---

## 📊 Overview

Actual-sync uses a custom structured logging system that provides:
- **Log Levels**: DEBUG, INFO, WARN, ERROR
- **Structured Output**: JSON or pretty format
- **Correlation IDs**: Track related log entries across operations
- **File Logging**: Optional log file output
- **Context**: Attach metadata to log entries

---

## 🔧 Configuration

Configure logging in `config/config.json`:

```json
{
  "logging": {
    "level": "INFO",
    "format": "pretty",
    "logDir": null
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `level` | string | `INFO` | Log level: DEBUG, INFO, WARN, ERROR |
| `format` | string | `pretty` | Output format: `pretty` (console) or `json` (parseable) |
| `logDir` | string/null | `null` | Directory for log files (null = console only) |

---

## 📈 Log Levels

### ERROR (0)
Critical errors that require attention:
- Sync failures
- Connection errors
- Configuration errors

### WARN (1)
Warnings that don't stop execution:
- Rate limit warnings
- Network retry warnings
- Security warnings (weak passwords, HTTP connections)

### INFO (2)
General operational information:
- Sync start/complete
- Server connections
- Account processing

### DEBUG (3)
Detailed diagnostic information:
- Directory operations
- API call details
- Internal state changes

### Level Hierarchy

Setting a log level shows that level and all levels below it:
- `ERROR`: Only ERROR messages
- `WARN`: WARN + ERROR
- `INFO`: INFO + WARN + ERROR (default)
- `DEBUG`: All messages

---

## 🎨 Output Formats

### Pretty Format (Default)

Human-readable console output with timestamps and correlation IDs:

```
2025-12-05T10:30:00.000Z [INFO] [a1b2c3d4] Starting sync for server: Main {"server":"Main","url":"https://example.com"}
2025-12-05T10:30:01.000Z [INFO] [a1b2c3d4] Connected to Actual server {"server":"Main"}
2025-12-05T10:30:02.000Z [WARN] [a1b2c3d4] Rate limit exceeded. Retrying in 3 seconds... {"retryDelayMs":3000}
```

**Format**: `{timestamp} [{level}] [{correlationId}] {message} {metadata}`

### JSON Format

Machine-parseable structured logs for log aggregation tools:

```json
{
  "timestamp": "2025-12-05T10:30:00.000Z",
  "level": "INFO",
  "service": "actual-sync",
  "message": "Starting sync for server: Main",
  "correlationId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "server": "Main",
  "url": "https://example.com"
}
```

---

## 🔍 Correlation IDs

Correlation IDs link related log entries, making it easy to trace a single sync operation through all logs.

**Example**: Track a sync operation from start to finish:
```
[a1b2c3d4] Starting sync for server: Main
[a1b2c3d4] Connected to Actual server
[a1b2c3d4] Budget file loaded successfully
[a1b2c3d4] Starting bank sync for account
[a1b2c3d4] Bank sync completed
```

Correlation IDs are:
- Automatically generated for each sync operation
- 36-character UUIDs
- Included in all related log entries
- Cleared after operation completes

---

## 📝 Using the Logger

### In Code

```javascript
const { createLogger } = require('./lib/logger');

// Create logger instance
const logger = createLogger();

// Log messages at different levels
logger.error('Critical error occurred', { errorCode: 500 });
logger.warn('Rate limit approaching', { remaining: 10 });
logger.info('Sync started', { server: 'Main' });
logger.debug('Processing account', { accountId: '123' });
```

### With Correlation IDs

```javascript
// Generate and set correlation ID
const correlationId = logger.generateCorrelationId();
logger.setCorrelationId(correlationId);

logger.info('Operation started');
// ... operation ...
logger.info('Operation completed');

// Clear when done
logger.clearCorrelationId();
```

### With Metadata

Attach structured data to log entries:

```javascript
logger.info('Sync completed', {
  server: 'Main',
  accountCount: 5,
  duration: 30000,
  success: true
});
```

### Error Objects

Logger automatically extracts error details:

```javascript
try {
  // ... code that might throw ...
} catch (error) {
  logger.error(error); // Automatically includes name, message, stack, code
}
```

---

## 📂 File Logging

### Enable File Logging

Set `logDir` in configuration:

```json
{
  "logging": {
    "level": "INFO",
    "format": "pretty",
    "logDir": "/var/log/actual-sync"
  }
}
```

### Log File Names

Files are named: `{serviceName}-{YYYY-MM-DD}.log`

Example: `actual-sync-2025-12-05.log`

New files are created daily automatically.

### Log Rotation

Logs are **not automatically rotated** or cleaned up. Use system tools:

**Using logrotate** (Linux):
```
/var/log/actual-sync/*.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
}
```

**Manual cleanup**:
```bash
find /var/log/actual-sync -name "*.log" -mtime +30 -delete
```

---

## 🔎 Searching Logs

### Pretty Format Logs

Use standard Unix tools:

```bash
# Find all errors
grep "\[ERROR\]" actual-sync-2025-12-05.log

# Find logs for specific server
grep "\"server\":\"Main\"" actual-sync-2025-12-05.log

# Follow logs in real-time
tail -f actual-sync-2025-12-05.log

# Find by correlation ID
grep "a1b2c3d4" actual-sync-2025-12-05.log
```

### JSON Format Logs

Use `jq` for JSON parsing:

```bash
# Find all errors
jq 'select(.level == "ERROR")' actual-sync-2025-12-05.log

# Find logs for specific server
jq 'select(.server == "Main")' actual-sync-2025-12-05.log

# Extract messages only
jq -r '.message' actual-sync-2025-12-05.log

# Find by correlation ID
jq 'select(.correlationId | startswith("a1b2c3d4"))' actual-sync-2025-12-05.log
```

---

## 🚀 Production Recommendations

### Configuration

For production environments:

```json
{
  "logging": {
    "level": "INFO",
    "format": "json",
    "logDir": "/var/log/actual-sync"
  }
}
```

**Why?**
- `INFO`: Balance between detail and noise
- `json`: Easy to parse with log aggregation tools
- `logDir`: Persistent logs for troubleshooting

### Log Aggregation

Consider integrating with:
- **ELK Stack** (Elasticsearch, Logstash, Kibana)
- **Splunk**
- **Datadog**
- **CloudWatch Logs** (AWS)
- **Loki + Grafana**

Example Filebeat configuration for ELK:

```yaml
filebeat.inputs:
- type: log
  enabled: true
  paths:
    - /var/log/actual-sync/*.log
  json.keys_under_root: true
  json.add_error_key: true

output.elasticsearch:
  hosts: ["localhost:9200"]
```

---

## 🐛 Debugging

### Enable Debug Logs

Temporarily set to DEBUG level in `config/config.json`:

```json
{
  "logging": {
    "level": "DEBUG"
  }
}
```

Debug logs include:
- Directory operations
- API connection details
- Account fetch operations
- Detailed retry information

### Common Issues

**No logs appearing**:
- Check log level configuration
- Verify logger is initialized
- Check file permissions if using `logDir`

**Too many logs**:
- Increase log level from DEBUG to INFO
- Reduce verbosity in production

**Can't find logs**:
- Check `logDir` path
- Verify directory exists and is writable
- Look for logs in console if `logDir` is null

---

## 📚 API Reference

### Logger Class

```javascript
const logger = new Logger({
  level: 'INFO',        // Log level
  format: 'pretty',     // Output format
  logDir: null,         // Log directory
  serviceName: 'app'    // Service name
});
```

### Methods

| Method | Description |
|--------|-------------|
| `error(message, meta)` | Log error message |
| `warn(message, meta)` | Log warning message |
| `info(message, meta)` | Log info message |
| `debug(message, meta)` | Log debug message |
| `setCorrelationId(id)` | Set correlation ID |
| `clearCorrelationId()` | Clear correlation ID |
| `generateCorrelationId()` | Generate new UUID |
| `child(context)` | Create child logger with context |

### Factory Function

```javascript
const { createLogger } = require('./lib/logger');

// Reads config automatically
const logger = createLogger();

// Or with overrides
const logger = createLogger({ level: 'DEBUG' });
```

---

## ✅ Best Practices

1. **Use appropriate levels**:
   - ERROR: Only for actual errors
   - WARN: Recoverable issues
   - INFO: Important operations
   - DEBUG: Detailed diagnostics

2. **Include context**:
   ```javascript
   // Good
   logger.info('Sync started', { server: 'Main', accounts: 5 });
   
   // Bad
   logger.info('Sync started');
   ```

3. **Use correlation IDs** for multi-step operations

4. **Don't log sensitive data**:
   - Never log passwords
   - Be careful with API keys
   - Sanitize user data

5. **Use JSON format in production** for better parsing

6. **Monitor log volume** to avoid disk space issues

---

**Last Updated**: December 5, 2025
