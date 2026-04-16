# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Actual-sync** is a self-hosted Node.js service that automates bank transaction synchronization for [Actual Budget](https://actualbudget.org/) servers. It supports multiple budget instances, encrypted budgets, scheduling, multi-channel notifications, and a web dashboard with Prometheus metrics.

## Commands

```bash
# Run all tests
npm test

# Run a single test file
npm test -- configLoader.test.js

# Run tests matching a name pattern
npm test -- --testNamePattern="should validate configuration"

# Watch mode for a specific file
npm run test:watch -- syncService.test.js

# Generate coverage report
npm run test:coverage

# Start the scheduled sync service
npm start

# Force immediate sync (all servers)
npm run sync

# Sync a specific server
npm run sync -- --server "ServerName"

# Validate config against schema
npm run validate-config

# List discovered bank accounts
npm run list-accounts

# View sync history
npm run history
```

No build step — this is plain JavaScript (no TypeScript, no bundler).

### Docker Development

```bash
# Build image
docker build -t actual-sync:dev .

# Run locally with volume mounts (note: image runs as non-root UID 1001)
docker run --rm \
  -v ./config:/app/config:ro \
  -v ./data:/app/data \
  -v ./logs:/app/logs \
  actual-sync:dev
```

## Architecture

### Core Data Flow

```
Scheduler (node-schedule) or manual trigger
  → syncAllBanks() → syncBank(server) [per server]
    → Correlation ID assigned
    → actual.init() → actual.downloadBudget() → actual.getAccounts()
    → actual.sync() [initial state sync]
    → bankSync per account with runWithRetries() [exponential backoff]
    → actual.sync() [final state sync]
    → Results tracked in SQLite + Prometheus
    → Thresholds evaluated → Notifications dispatched
    → actual.shutdown()
```

### Service Initialization (Dependency Injection)

`index.js` validates startup, then `src/syncService.js` wires all services together:

- `lib/configLoader.js` — AJV schema validation against `config/config.schema.json`
- `lib/logger.js` — Custom structured logger (no Winston/Pino); supports file rotation and correlation IDs
- `services/syncHistory.js` — SQLite-backed sync history via `better-sqlite3`
- `services/healthCheck.js` — Express HTTP server (`/health`, `/ready`, `/metrics`, `/prometheus`, `/dashboard`, `/ws`)
- `services/prometheusService.js` — Prometheus metrics via `prom-client`
- `services/notificationService.js` — Routes alerts to Email/Telegram/Slack/Discord
- `services/telegramBot.js` — Interactive Telegram bot (8 commands)

Each service receives options and a logging config object:

```javascript
new ServiceClass(options, {
    level: config.logging.level,
    format: config.logging.format,
    logDir: config.logging.logDir
});
```

### Key Patterns

**Retry logic**: `runWithRetries()` in `syncService.js` wraps bank sync calls with exponential backoff + jitter. Retryable errors: `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, HTTP 429.

**Correlation IDs**: Set at the start of each sync operation, always cleared in `finally` blocks alongside `actual.shutdown()`:

```javascript
const correlationId = logger.generateCorrelationId();
logger.setCorrelationId(correlationId);
try {
    // ... sync operations ...
} finally {
    logger.clearCorrelationId();
    await actual.shutdown();
}
```

**Multi-server isolation**: Each server gets its own data directory to avoid Actual Budget API state collisions.

**Per-server config resolution**: Use `getSyncConfig(server)` to merge server-level overrides with global config — never access `server.sync.*` fields directly.

**Health status states**: `HealthCheckService` tracks `HEALTHY`, `DEGRADED`, `UNHEALTHY`, and `PENDING`. The `/ready` endpoint returns 503 when `UNHEALTHY`.

### Logging Convention

Always use the custom logger from `src/lib/logger.js` — never add Winston, Pino, or other logging libraries.

```javascript
// CORRECT — concise message + structured metadata
logger.info('Starting sync', { server: name, url, dataDir, maxRetries });
logger.error('Attempt failed', { attempt: i + 1, error: err.message, errorCode: err.code });

// AVOID — data embedded in message string
logger.info(`Starting sync for ${name} at ${url} with ${maxRetries} retries`);
```

Log levels: `ERROR` (failures), `WARN` (retries/threshold warnings), `INFO` (normal operations), `DEBUG` (verbose).

### Configuration

Config is JSON, validated at startup against `config/config.schema.json`. See `config/config.example.json` for a reference template. Per-server settings can override global `sync` and `logging` sections. Encryption passwords for E2EE budgets are set per server (`encryptionPassword` field).

### Actual Budget API

Key methods from `@actual-app/api` used in sync operations:

- `actual.init({ serverURL, password, dataDir })` — connect and prepare
- `actual.downloadBudget(syncId, { password? })` — download budget (password only for E2EE)
- `actual.sync()` — sync local budget file with server (called before and after bank sync)
- `actual.runBankSync({ accountId })` — trigger bank sync for one account
- `actual.getAccounts()` — retrieve all accounts in budget
- `actual.shutdown()` — **always call in `finally` block**

## Testing

Tests live in `src/__tests__/`. Use the shared helpers in `src/__tests__/helpers/testHelpers.js`:

- `createMockConfig(overrides)` — base test config with optional overrides
- `createTempDir()` / `cleanupTempDir(dir)` — temp directory lifecycle
- `createMockActualAPI()` — mock for `@actual-app/api`

Coverage thresholds enforced by Jest: 61% branches, 70% functions/lines/statements.

Note: `src/syncService.js` and `index.js` are excluded from coverage collection (see `package.json` jest config).

## Adding New Features

1. Add configuration to `config/config.schema.json` with description and examples
2. Add business logic validation in `src/lib/configLoader.js` → `validateLogic()`
3. Initialize service in `src/syncService.js` with the logger config pattern above
4. Add tests in `src/__tests__/<feature>.test.js` using the test helpers
5. Update relevant `docs/` files to match changed behavior

## Git Workflow

**Never push to `main` directly.** All code changes must go through a PR and wait for explicit user approval before merging or pushing. Do not run `git push` unless the user has explicitly asked for it in that message. Open a PR and present it for review instead.

## Anti-Patterns to Avoid

- Adding external logging libraries — use the custom logger
- Modifying retry logic without updating tests
- Changing config schema without updating `config/config.example.json`
- Skipping correlation IDs in sync operations
- Forgetting `actual.shutdown()` in finally blocks
- Accessing `server.sync.*` directly instead of using `getSyncConfig(server)`
- Skipping documentation updates when changing observable behavior

## Documentation

Comprehensive guides live in `docs/`. Key references:
- `docs/ARCHITECTURE.md` — deeper architectural detail
- `docs/TESTING.md` — testing patterns and conventions
- `docs/CONFIG.md` — full configuration reference
- `.github/copilot-instructions.md` — additional AI-specific coding patterns
