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
- **Centralized Logging**: Syslog support (UDP, TCP, TLS), redacted and RFC 5424 escaped
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
    "actualApiVerbose": false, // UNSAFE if true: @actual-app/api prints transactions (payees, amounts, notes)
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
        "level": "DEBUG"
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

**Deprecated: per-server `format`.** It is still accepted so existing configs load, but it is ignored (it never took effect). Output format is chosen per sink with `logging.format` (console) and `logging.fileFormat` (file). Remove `format` from your `servers[].logging` blocks.

Reserved fields `timestamp`, `level`, `severity`, `message`, `service`, `version`, `seq` and `schema` are set by the logger and cannot be overwritten by context or metadata; such keys passed in context or metadata are dropped. `event` and `component` are also reserved names, but the caller sets them (a component child logger, an audit event such as `authz_fail`).

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
| `rotation.maxSize` | string | `10M` | Max file size before rotation: positive integer + unit B/K/M/G, optional `B` suffix (e.g. `10M`, `10MB`, `512B`) |
| `rotation.interval` | string | `1d` | Time-based rotation: positive integer + unit s/m/h/d or `M` for months (e.g. `1d`, `12h`, `1M`; m = minutes). Rotation fires on whichever comes first, size or interval. |
| `rotation.maxFiles` | integer | `30` | Rotated files to keep. With the `1d` interval, this is days of retention. |
| `rotation.compress` | string | `gzip` | Compression: `gzip` or `none` |
| **Syslog** |
| `syslog.enabled` | boolean | `false` | Send logs to syslog server |
| `syslog.host` | string | `localhost` | Syslog server hostname |
| `syslog.port` | integer | `514` | Syslog server port |
| `syslog.protocol` | string | `udp` | Transport: `udp`, `tcp` or `tls` |
| `syslog.ca` | string | none | PEM CA file to trust for `tls` (certificate verification is always on) |
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

**Crash records (#439):** `uncaughtException`, `unhandledRejection` and `warning` handlers are installed first in `index.js`. They log a static message with `event: sys_crash` (or `process.warning`) and a classified `error: { type, code, category, safeMessage }`. The upstream message and the rejection object are never logged; frames appear only in a DEBUG record. A crash before the logger exists (while the service is still loading) writes one JSON line with the frames to stderr and exits 1. An already-handled `@actual-app/api` rejection is `process.rejection_benign` at WARN. Before the logger exists, one JSON line goes to stderr.

**Level discipline (keep the error log honest):** `ERROR` is for problems that need a human. A failure the service *recovered* from (a retry, a transient remote 429/5xx, a network blip) is `WARN` or `DEBUG`, never `ERROR`. Logging expected, self-healing events at `ERROR` buries the real failures and inflates alerts. For example, transient Telegram polling failures are logged at `DEBUG`; already-handled `@actual-app/api` rejections are `process.rejection_benign` at `WARN`.

---

## Record contract (convention version 1)

This section is the shared convention with actual-mcp-server. Both repos keep a
copy; each states the version it follows, so drift shows in a diff.

**Convention version: 1.** Actual-sync follows version 1. Design:
`docs/plans/logging-architecture.md`.

### Record schema

Every JSON record validates against [`log-record.schema.json`](log-record.schema.json).
Required: `timestamp` (UTC ISO 8601, milliseconds), `level`, `severity`
(OpenTelemetry SeverityNumber: ERROR 17, WARN 13, INFO 9, DEBUG 5), `service`,
`version` (app version), `message`, `seq` (per-process counter starting at 1,
so gaps and reordering are visible) and `schema` (`1`). Optional: `component`,
`event`, `correlationId`, `server`, `fields`, `error`.

- `message` is a string literal, never interpolated. Data goes in fields.
- `event` is a dotted name from the catalogue below, so alerting does not
  depend on wording.
- The keys `timestamp`, `level`, `severity`, `message`, `service`, `version`,
  `seq` and `schema` are written by the logger and cannot be overwritten by
  context or fields. `event` and `component` are reserved names that callers
  set (child loggers, audit events).
- Context and fields are still written flat. The field allowlist (#437) moves
  them under `fields` and closes the schema.

### Event catalogue

| Event | Level | Meaning |
|---|---|---|
| `sync.account.completed` | INFO | One account finished syncing |
| `third_party.console` | per call | `@actual-app/api` console output through the bridge |
| `process.rejection_benign` | WARN | An allowlisted, already-handled rejection (#105). Same name in actual-mcp-server |
| `security.suppressed` | WARN | The security rate limiter tripped; carries `suppressedCount` |
| `authn_login_success` | INFO | Dashboard login accepted (once per session) |
| `authn_login_fail` | WARN | Dashboard login refused |
| `authz_fail` | WARN | Unauthorized Telegram chat or refused origin |
| `input_validation_fail` | WARN | Rejected API input |
| `sys_startup`, `sys_shutdown` | INFO | Process lifecycle |
| `sys_crash` | ERROR | Uncaught exception or rejection |
| `sys_config_change` | INFO | A setting, payment rule or server changed (our name; OWASP has no exact term) |

Security events use the OWASP Logging Vocabulary names verbatim, carry
`category: "security"`, may carry `remoteAddress`, and never carry request
bodies, message text or user names. New events are added to this table with
the change that emits them.

### Error categories

A logged error is `error: { type, code, httpStatus, category, safeMessage }`.
`category` is one of `timeout`, `auth`, `upstream_unavailable`, `rate_limited`,
`not_found`, `validation`, `conflict`, `cancelled`, `internal`. Raw upstream
error text is never logged.

### Startup record groups

`sys_startup` carries these groups: versions (app, Node, @actual-app/api, pid,
platform, container flag); timezone and UTC offset; log level, effective api
verbose and active sinks; whether a custom log dir and data dir are set
(booleans, not paths) and retention days; effective privacy flags; server count
and schedules; enabled notification channels (booleans); dashboard bind
address, auth mode and TLS; timeouts; config schema version.

### Key mapping with actual-mcp-server

| Concept | Actual-sync | actual-mcp-server |
|---|---|---|
| component | `component` | `module` |
| correlation | `correlationId` | `sessionId`, `requestId` |

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

## Actual API console output

`@actual-app/api` prints warnings and errors straight to the console, whatever `actualApiVerbose` says. During each sync session Actual-sync routes that output through its own logger as one static record per call: `event: "third_party.console"`, `component: "actual-api"`, message `Actual API console output`. The upstream arguments are dropped (they can carry transactions or upstream text), so the record has the configured level, format and redaction but no payload. `console.error` maps to ERROR, `warn` to WARN, `log`/`info`/`group` to INFO and `debug` to DEBUG. With `actualApiVerbose: true` a masked `consolePreview` (first 300 characters) is added; these records are never sent to `/ws/logs`.

## Startup output before the logger exists

The startup banner, config validation warnings and config load failures go
through the bootstrap logger (`src/lib/bootstrapLogger.js`, #442), not raw
`console` calls. It needs no config: the built-in secret redaction and control
character escaping apply to every record. Records are buffered and replayed
into the root logger as soon as it is created (so they follow `logging.level`
and `logging.format`). If startup dies first (validation failure, config load
error), the buffered records are written to stderr as JSON lines.

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

**IP addresses**: the client address (`remoteAddress`) is recorded by these log lines, for security monitoring and an audit trail of dashboard actions (GDPR Art. 6(1)(f)):

- WARN: failed dashboard logins, and requests to unknown endpoints.
- INFO: every dashboard action (manual sync, error dismiss, history reset, test notification).
- INFO: live log stream (`/ws/logs`) connections.
- DEBUG: `/health`, `/metrics` and Prometheus scrapes.

Behind a reverse proxy the HTTP lines show the real client IP only when `healthCheck.trustProxy` is set; otherwise they show the proxy's address. The `/ws/logs` lines follow the same rule: the forwarded client with `healthCheck.trustProxy`, otherwise the TCP peer, which behind a proxy is the proxy. Log files follow the file retention (`rotation.maxFiles`, 30 days by default). Console output is kept by whatever collects it: under Docker, stdout is kept until the container is removed unless you set log rotation on the container (for example `logging: { driver: json-file, options: { max-size: 10m, max-file: "5" } }` in Compose).

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

**Transports**

- `udp` (default): **plaintext and unreliable.** Datagrams are unencrypted, can be lost or reordered, and anyone on the path can read them. It is not an audit log. Use it only on a trusted network.
- `tcp`: RFC 6587 octet-counting framing (`<len> <msg>`). Reliable, but still plaintext.
- `tls`: TCP framing inside TLS (RFC 5425). The server certificate is always verified; set `syslog.ca` to a PEM file to trust a private CA. There is no option to disable verification.

For `tcp` and `tls` the logger reconnects with exponential backoff (1s up to 30s). While disconnected, messages wait in a bounded in-memory queue of 1000; when full the oldest are dropped. Logging never throws or blocks on a down syslog server.

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

## 🚨 Alertable Security Events

These are security events (#444, design D7). They are an audit floor: written
whatever `logging.level` is, so `level: error` does not hide a guessing loop.
They carry `category: "security"` and the OWASP Logging Vocabulary name as
`event`, plus `remoteAddress`, and never a body, a user name, a password or a
token.

| `event` | Meaning |
|---|---|
| `authn_login_fail` | One refused dashboard or metrics credential (`reason`: `invalid_credentials`, `invalid_token` or `throttled`; `realm`: `dashboard` or `metrics`). `throttled` means the client already has 10 failed logins in the current 15 minute window and is refused with 429 (#246). A steady stream at the scrape interval on `realm: metrics` is a Prometheus with a stale credential (#247) |
| `authn_login_success` | A good dashboard or metrics credential, logged at INFO at most once per source address per hour (Basic and bearer have no session) |
| `authz_fail` | A refused request origin (`reason: origin_not_allowed`) or a message from an unauthorized Telegram chat |
| `security.suppressed` | The per-source limiter tripped: more than 10 records of one event from one address in a minute. One record per window carries `suppressedEvent`, `remoteAddress` and `suppressedCount`, so a guess loop never looks like it stopped |

`WebSocket handshake refused` (a `/ws/logs` connection refused, with the status
and reason) is still a plain WARN line.

```bash
grep '"category":"security"' logs/actual-sync-*.log
```

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
        max-file: "5"
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
