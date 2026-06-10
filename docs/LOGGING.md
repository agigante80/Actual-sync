# Enhanced Logging System

Comprehensive guide to Actual-sync's structured logging with rotation, centralized logging, performance tracking, and per-server configuration.

---

## 📊 Overview

Actual-sync uses a custom structured logger with enterprise features:
- **Log Levels**: DEBUG, INFO, WARN, ERROR with filtering
- **Separate console/file formats**: pretty for the console, single-line JSON for files (machine-readable and shippable)
- **Secret redaction**: passwords, tokens, and other secrets are masked before anything is written (console, file, syslog, and the dashboard stream)
- **Correlation IDs**: Track related log entries across operations
- **File Logging**: Dated files with daily + size-based rotation and compression
- **Centralized Logging**: Syslog support (UDP), redacted and RFC 5424 escaped
- **Performance Tracking**: Automatic operation timing
- **Per-Server Config**: Override log levels per server
- **Context Management**: Child loggers with inherited context
- **Real-time Streaming**: WebSocket broadcasting for dashboard (redacted)
- **Never throws**: a bad metadata value (throwing getter/toJSON, BigInt, circular ref) degrades to a placeholder; a log call can never crash the caller

---

## 🔧 Configuration

### Basic Configuration

Configure global logging in `config/config.json`:

```json
{
  "logging": {
    "level": "INFO",
    "format": "pretty",       // console format (pretty | json)
    "fileFormat": "json",     // file format (json recommended; single line per entry)
    "redact": [],             // extra secret key names to mask (defaults always apply)
    "logDir": "./logs",
    "rotation": {
      "enabled": true,      // Default: true (recommended)
      "maxSize": "10M",     // Rotate at 10MB...
      "interval": "1d",     // ...or daily, whichever comes first
      "maxFiles": 30,       // Default: 30 rotated files (with the 1d interval, 30 days)
      "compress": "gzip"    // Default: gzip (~70% space savings)
    },
    "syslog": {
      "enabled": false,
      "host": "localhost",
      "port": 514,
      "protocol": "udp",
      "facility": 16
    },
    "performance": {
      "enabled": true,
      "thresholds": {
        "slow": 1000,
        "verySlow": 5000
      }
    }
  }
}
```

### Per-Server Log Levels

Override log levels for specific servers:

```json
{
  "servers": [
    {
      "name": "Main Budget",
      "url": "https://actual.example.com",
      "logging": {
        "level": "DEBUG",
        "format": "json"
      }
    },
    {
      "name": "Test Budget",
      "url": "http://localhost:5006",
      "logging": {
        "level": "WARN"
      }
    }
  ]
}
```

Use cases:
- **DEBUG for problematic servers**: Get detailed logs for servers with issues
- **WARN for stable servers**: Reduce noise from well-functioning servers
- **JSON for automated analysis**: Use structured output for specific servers

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| **Basic** |
| `level` | string | `INFO` | Log level: DEBUG, INFO, WARN, ERROR |
| `format` | string | `pretty` | **Console** format: `pretty` or `json` |
| `fileFormat` | string | `json` | **File** format: `json` (single line, shippable) or `pretty`. Independent of `format`. Global only. |
| `redact` | array | `[]` | Extra metadata key names to mask. Default secret keys are always redacted (see Secret Redaction). |
| `logDir` | string/null | `./logs` | Directory for log files (`null` = console only) |
| **Rotation** |
| `rotation.enabled` | boolean | `true` | Enable log rotation (recommended) |
| `rotation.maxSize` | string | `10M` | Max file size before rotation (K, M, G) |
| `rotation.interval` | string | `1d` | Time-based rotation (e.g. `1d`, `12h`). Rotation fires on whichever comes first, size or interval. |
| `rotation.maxFiles` | integer | `30` | Rotated files to keep. With the `1d` interval, this is days of retention. |
| `rotation.compress` | string | `gzip` | Compression: `gzip` or `none` |
| **Syslog** |
| `syslog.enabled` | boolean | `false` | Send logs to syslog server |
| `syslog.host` | string | `localhost` | Syslog server hostname |
| `syslog.port` | integer | `514` | Syslog server port |
| `syslog.protocol` | string | `udp` | Protocol: `udp` or `tcp` |
| `syslog.facility` | integer | `16` | Syslog facility code (0-23, 16=local0) |
| **Performance** |
| `performance.enabled` | boolean | `false` | Track operation performance |
| `performance.thresholds.slow` | integer | `1000` | Slow operation threshold (ms) |
| `performance.thresholds.verySlow` | integer | `5000` | Very slow operation threshold (ms) |

---

## 📈 Log Levels

### Level Hierarchy

| Level | Numeric | Description | Example Use Cases |
|-------|---------|-------------|-------------------|
| **ERROR** | 0 | Critical failures | Sync errors, connection failures, configuration errors |
| **WARN** | 1 | Recoverable issues | Rate limits, retries, security warnings |
| **INFO** | 2 | Normal operations | Sync start/complete, connections, account processing |
| **DEBUG** | 3 | Detailed diagnostics | API calls, directory operations, internal state |

**Filtering**: Setting a level shows that level and all levels below it.
- `ERROR`: Only ERROR messages
- `WARN`: WARN + ERROR
- `INFO`: INFO + WARN + ERROR (default)
- `DEBUG`: All messages

**Level discipline (keep the error log honest):** `ERROR` is for problems that need a human. A failure the service *recovered* from (a retry, a transient remote 429/5xx, a network blip) is `WARN` or `DEBUG`, never `ERROR`. Logging expected, self-healing events at `ERROR` buries the real failures and inflates alerts. For example, transient Telegram polling failures and already-handled `@actual-app/api` rejections are logged at `DEBUG`.

---

## 🎨 Output Formats

### Pretty Format (Default)

Human-readable console output:

```
2025-12-09T13:00:00.000Z [INFO] [a1b2c3d4] Starting sync for server: Main {
  "url": "https://example.com",
  "maxRetries": 5
}
```

### JSON Format

Machine-parseable structured logs:

```json
{
  "timestamp": "2025-12-09T13:00:00.000Z",
  "level": "INFO",
  "service": "actual-sync",
  "message": "Starting sync for server: Main",
  "correlationId": "a1b2c3d4",
  "server": "Main"
}
```

### Console vs File

`format` controls the **console** only; `fileFormat` controls **files** and defaults to `json`. So by default you get human-friendly pretty output on the console and single-line JSON in the log files, which is what log shippers and `jq` want. Set `fileFormat: "pretty"` only if you read the raw files by eye and do not ship them.

The file line is always a single line, even when the console is `pretty`.

---

## 🔒 Secret Redaction

Every value is redacted before it is written to **any** destination (console, file, syslog, and the dashboard WebSocket). You never have to remember to scrub metadata.

A property is masked as `[REDACTED]` when its key (case-insensitive, at any depth) contains a secret indicator: `password`, `token`, `secret`, `apikey` / `api_key`, `authorization`, `credential`, `chatid`. This catches variants automatically (`encryptionPassword`, `botToken`, `refreshToken`, `accessToken`, `clientSecret`, ...).

Secret-looking substrings inside string values are also masked: Telegram bot-token URLs, URL userinfo credentials (`https://user:secret@host`), `Bearer <token>`, and `key=value` / `"key":"value"` pairs for secret-named keys.

Add your own keys (the defaults always apply):

```json
{
  "logging": {
    "redact": ["ssn", "accountNumber"]
  }
}
```

Notes:
- Non-secret data is preserved, including `Date`, `Buffer`, and `Error` values (an `Error` keeps its `message`, `stack`, `code`, `cause`, and custom fields such as `statusCode`, all redacted).
- Redaction never mutates the object you passed and never throws.

---

## 🔄 Log Rotation

Automatic file rotation, daily or by size (whichever comes first), with compression:

```json
{
  "logging": {
    "rotation": {
      "enabled": true,
      "maxSize": "10M",
      "interval": "1d",
      "maxFiles": 10,
      "compress": "gzip"
    }
  }
}
```

Files: `actual-sync.log`, `actual-sync-2025-12-08.log.gz`, etc. The daily `interval` matters on low-volume deployments: without it, a quiet server never reaches `maxSize`, so a single file grows for months and `maxFiles` retention never applies.

---

## 📡 Centralized Logging (Syslog)

Send logs to syslog server (RFC 5424):

```json
{
  "logging": {
    "syslog": {
      "enabled": true,
      "host": "syslog.example.com",
      "port": 514,
      "protocol": "udp",
      "facility": 16
    }
  }
}
```

**Facility 16** = local0 (recommended for Actual-sync)

---

## ⏱️ Performance Tracking

Automatically log operation duration:

```json
{
  "logging": {
    "performance": {
      "enabled": true,
      "thresholds": {
        "slow": 1000,
        "verySlow": 5000
      }
    }
  }
}
```

Output:
```
2025-12-09T13:00:05.891Z [INFO] Performance: sync-Main {
  "duration": 5368,
  "operation": "sync-Main",
  "slow": true,
  "verySlow": true
}
```

---

## 🔍 Correlation IDs

Track related log entries with unique IDs:

```
[a1b2c3d4] Starting sync for server: Main
[a1b2c3d4] Connected to Actual server
[a1b2c3d4] Sync completed
```

Search by correlation ID:
```bash
grep "a1b2c3d4" logs/actual-sync-2025-12-09.log
```

---

## 👶 Child Loggers & Context

Create loggers with inherited context:

```javascript
const logger = createLogger();
const serverLogger = logger.child({ server: 'Main' });

serverLogger.info('Starting sync'); 
// Logs: {"server": "Main", "message": "Starting sync"}
```

Per-server loggers are automatically created with appropriate context.

---

## 📝 Usage Examples

### Basic Logging

```javascript
const { createLogger } = require('./lib/logger');
const logger = createLogger();

logger.error('Critical error', { errorCode: 500 });
logger.warn('Warning', { remaining: 10 });
logger.info('Info message', { server: 'Main' });
logger.debug('Debug details', { detail: 'value' });
```

### With Error Objects

```javascript
try {
  await riskyOperation();
} catch (error) {
  logger.error(error); // Auto-extracts name, message, stack
}
```

### Performance Tracking

```javascript
const endTimer = logger.startTimer('operation-name');
await doWork();
endTimer({ metadata: 'value' }); // Logs duration automatically
```

---

## 🔎 Searching Logs

### Pretty Format

```bash
# Find errors
grep "\[ERROR\]" logs/actual-sync-2025-12-09.log

# Find by server
grep '"server":"Main"' logs/actual-sync-2025-12-09.log

# Follow real-time
tail -f logs/actual-sync-2025-12-09.log
```

### JSON Format

```bash
# Parse with jq
cat logs/actual-sync.log | jq '.'

# Filter by level
cat logs/actual-sync.log | jq 'select(.level=="ERROR")'

# Count errors per server
cat logs/actual-sync.log | jq 'select(.level=="ERROR") | .server' | sort | uniq -c
```

---

## 🎯 Best Practices

### Development

```json
{
  "logging": {
    "level": "DEBUG",
    "format": "pretty",
    "logDir": null,  // Disable file logging in dev
    "rotation": {
      "enabled": false  // Not needed without file logging
    },
    "performance": { "enabled": true }
  }
}
```

### Production (Default Settings)

```json
{
  "logging": {
    "level": "INFO",
    "format": "json",
    "logDir": "/var/log/actual-sync",
    "rotation": {
      "enabled": true,    // Default: enabled
      "maxSize": "10M",   // Default: 10M
      "maxFiles": 30,     // Default: 30 days
      "compress": "gzip"  // Default: gzip
    },
    "syslog": {
      "enabled": true,
      "host": "syslog.example.com"
    },
    "performance": { "enabled": true }
  }
}
```

### Customizing Retention

**Minimal retention (7 days)**:
```json
{
  "logging": {
    "rotation": {
      "maxFiles": 7
    }
  }
}
```

**Extended retention (90 days for compliance)**:
```json
{
  "logging": {
    "rotation": {
      "maxFiles": 90
    }
  }
}
```

**High-traffic servers (larger files)**:
```json
{
  "logging": {
    "rotation": {
      "maxSize": "50M",  // Allow larger files before rotation
      "maxFiles": 30
    }
  }
}
```

**Disable rotation (not recommended)**:
```json
{
  "logging": {
    "rotation": {
      "enabled": false  // Logs will grow indefinitely
    }
  }
}
```

---

## 🐳 Docker Logging

Mount logs volume:

```yaml
services:
  actual-sync:
    volumes:
      - ./logs:/app/logs
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

View logs:
```bash
docker compose logs -f actual-sync
```

---

## 🔧 Troubleshooting

### Logs Not Appearing

Check log level and directory permissions:
```bash
grep '"level"' config/config.json
ls -ld logs/
```

### Rotation Not Working

Verify config and disk space:
```bash
grep "rotation" config/config.json
df -h /var/log
```

### Syslog Not Receiving

Test connectivity:
```bash
nc -u syslog.example.com 514 < /dev/null
```

### File Descriptor Warnings

Always close logger on shutdown:
```javascript
logger.close();
```

---

## 📚 Related Documentation

- [Configuration Guide](./CONFIG.md)
- [Dashboard](./DASHBOARD.md)
- [Health Check](./HEALTH_CHECK.md)
- [Prometheus Metrics](./PROMETHEUS.md)

---

For detailed examples and advanced usage, see the full sections above or check `config/config.example.json`.
