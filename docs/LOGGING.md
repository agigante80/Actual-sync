# Enhanced Logging System

Comprehensive guide to Actual-sync's structured logging with rotation, centralized logging, performance tracking, and per-server configuration.

---

## 📊 Overview

Actual-sync uses a custom structured logger with enterprise features:
- **Log Levels**: DEBUG, INFO, WARN, ERROR with filtering
- **Multiple Formats**: Pretty (console) or JSON (machine-readable)
- **Correlation IDs**: Track related log entries across operations
- **File Logging**: Daily files with optional rotation and compression
- **Centralized Logging**: Syslog support (UDP/TCP)
- **Performance Tracking**: Automatic operation timing
- **Per-Server Config**: Override log levels per server
- **Context Management**: Child loggers with inherited context
- **Real-time Streaming**: WebSocket broadcasting for dashboard

---

## 🔧 Configuration

### Basic Configuration

Configure global logging in `config/config.json`:

```json
{
  "logging": {
    "level": "INFO",
    "format": "pretty",
    "logDir": "./logs",
    "rotation": {
      "enabled": true,
      "maxSize": "10M",
      "maxFiles": 10,
      "compress": "gzip"
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
| `format` | string | `pretty` | Output format: `pretty` or `json` |
| `logDir` | string/null | `null` | Directory for log files (null = console only) |
| **Rotation** |
| `rotation.enabled` | boolean | `false` | Enable log rotation |
| `rotation.maxSize` | string | `10M` | Max file size before rotation (K, M, G) |
| `rotation.maxFiles` | integer | `10` | Number of rotated files to keep |
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

---

## 🔄 Log Rotation

Automatic file rotation based on size with compression:

```json
{
  "logging": {
    "rotation": {
      "enabled": true,
      "maxSize": "10M",
      "maxFiles": 10,
      "compress": "gzip"
    }
  }
}
```

Files: `actual-sync.log`, `actual-sync-2025-12-08.log.gz`, etc.

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
    "logDir": null,
    "performance": { "enabled": true }
  }
}
```

### Production

```json
{
  "logging": {
    "level": "INFO",
    "format": "json",
    "logDir": "/var/log/actual-sync",
    "rotation": {
      "enabled": true,
      "maxSize": "10M",
      "maxFiles": 30,
      "compress": "gzip"
    },
    "syslog": {
      "enabled": true,
      "host": "syslog.example.com"
    },
    "performance": { "enabled": true }
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
