# Copilot Instructions for Actual-sync

## Project Overview

Actual-sync is a production-ready Node.js service that automates bank transaction synchronization for [Actual Budget](https://actualbudget.org) servers. It manages multiple budget instances with scheduled syncs, comprehensive error handling, and enterprise monitoring capabilities (Prometheus, Telegram bot, health checks).

**Key Characteristics:**
- 98.73% test coverage with 255 passing Jest tests
- Zero external logging dependencies (custom structured logger with correlation IDs)
- Multi-server support with per-server or global configuration overrides
- Docker-first deployment (229MB Alpine image, runs as non-root user)

## Architecture Pattern

### Core Services (Dependency Injection Pattern)

All services follow a consistent initialization pattern in `src/syncService.js`:

1. **ConfigLoader** (`src/lib/configLoader.js`) - Loads and validates config with JSON schema (AJV)
2. **Logger** (`src/lib/logger.js`) - Custom structured logger (NO external logging libs)
3. **SyncHistoryService** - SQLite-backed sync tracking
4. **PrometheusService** - Metrics export (optional)
5. **HealthCheckService** - Express server with `/health`, `/metrics`, `/ready` endpoints
6. **NotificationService** - Multi-channel alerts (Telegram, email, webhooks)
7. **TelegramBotService** - Interactive bot for manual control

Services are initialized with:
```javascript
new Service(options, { 
    level: config.logging.level,
    format: config.logging.format,
    logDir: config.logging.logDir 
});
```

### Sync Flow

Entry point: `index.js` → `src/syncService.js`

```
syncAllBanks() → for each server: syncBank(server)
  ↓
1. Generate correlationId (logger.generateCorrelationId())
2. Create data directory (fs.mkdir with recursive)
3. Init Actual API (actual.init with serverURL, password, dataDir)
4. Download budget (actual.downloadBudget with syncId)
5. Fetch accounts (actual.getAccounts)
6. Initial file sync (actual.sync)
7. For each account: actual.runBankSync with retry logic
8. Final file sync (actual.sync)
9. Track results in syncHistory and prometheus
10. Trigger notifications based on thresholds
11. actual.shutdown() in finally block
```

**Critical**: Each sync operation uses `runWithRetries()` wrapper for exponential backoff with jitter.

## Configuration System

### Schema-Driven Validation

Config schema at `config/config.schema.json` validated with AJV. Key patterns:

- **Per-server overrides**: `server.sync.maxRetries` overrides global `sync.maxRetries`
- **Schedule resolution**: Use `getSyncConfig(server)` helper to get effective config
- **Data directories**: Each server has isolated `dataDir` for budget file caching

Example server config:
```json
{
  "name": "Main Budget",
  "url": "https://actual.example.com",
  "password": "secret",
  "syncId": "abc123-def456",
  "dataDir": "/app/data/main",
  "sync": {
    "schedule": "0 2 * * *",  // Optional override
    "maxRetries": 5
  }
}
```

### Access Patterns

```javascript
const config = new ConfigLoader().load();
const server = config.servers.find(s => s.name === 'Main');
const syncConfig = getSyncConfig(server); // Merges server + global config
```

## Testing Conventions

### Test Helpers (`src/__tests__/helpers/testHelpers.js`)

Always use these for consistency:
- `createMockConfig(overrides)` - Generate test config
- `createTempDir()` / `cleanupTempDir()` - Temp directory management
- `createMockActualAPI()` - Mock @actual-app/api

### Test Structure

```javascript
describe('ComponentName', () => {
    let tempDir;
    
    beforeEach(() => {
        tempDir = createTempDir();
    });
    
    afterEach(() => {
        cleanupTempDir(tempDir);
    });
    
    test('should do something specific', () => {
        // Arrange
        const config = createMockConfig({ servers: [...] });
        
        // Act
        const result = functionUnderTest(config);
        
        // Assert
        expect(result).toBe(expectedValue);
    });
});
```

**Coverage Requirements**: 70% branches, functions, lines, statements (see `package.json` jest config)

### Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Generate coverage report
```

### Testing Patterns by Service Type

**Service Tests** (`notificationService.test.js`, `prometheusService.test.js`):
- Mock external dependencies (nodemailer, HTTP clients)
- Test initialization with default and custom configs
- Verify method calls with various inputs
- Clean up resources in `afterEach` (close DBs, clear mocks)

**Integration Tests** (`syncService.test.js`):
- Mock `@actual-app/api` methods
- Test full sync flow with multiple scenarios
- Verify error handling and retry logic
- Check correlation IDs are set/cleared properly

**Configuration Tests** (`configLoader.test.js`, `perServerConfig.test.js`):
- Test schema validation failures with specific error messages
- Verify business logic validation (duplicates, security warnings)
- Test per-server config overrides
- Use temp directories for file-based tests

## Logging Pattern

### Custom Logger Usage (NO Winston/Pino)

```javascript
const { createLogger } = require('./lib/logger');
const logger = createLogger({
    level: 'info',      // ERROR, WARN, INFO, DEBUG
    format: 'pretty',   // 'pretty' or 'json'
    logDir: './logs'
});

// Always use correlation IDs for sync operations
const correlationId = logger.generateCorrelationId();
logger.setCorrelationId(correlationId);

logger.info('Starting sync', { server: 'Main', accountCount: 5 });
logger.error('Sync failed', { error: err.message, code: err.code });

logger.clearCorrelationId(); // In finally blocks
```

### Logging Convention (Strictly Followed)

**Pattern**: `logger.level(message, metadataObject)`

```javascript
// ✅ CORRECT - Concise message + structured metadata
logger.info('Starting sync for server: ${name}', { 
    server: name, 
    url, 
    dataDir,
    maxRetries: syncConfig.maxRetries
});

logger.error('Attempt ${i + 1} failed', { 
    attempt: i + 1, 
    error: error.message,
    errorCode: error.code
});

// ✅ CORRECT - Simple messages still use structured format
logger.info('Configuration loaded successfully', { 
    serverCount: config.servers.length 
});

// ❌ AVOID - Putting all data in message string
logger.info(`Starting sync for ${name} at ${url} with ${maxRetries} retries`);

// ❌ AVOID - Missing metadata for important context
logger.error('Sync failed');  // No error details!
```

**Key Rules:**
1. **Message**: Concise string in present tense ("Starting sync", "Connected to server")
2. **Metadata**: All contextual data (IDs, counts, error details) in second parameter object
3. **Correlation IDs**: Set at operation start, clear in finally blocks
4. **Log Levels**: ERROR (failures), WARN (retries/degraded), INFO (normal ops), DEBUG (verbose tracing)
5. **Error Handling**: Pass error details in metadata object or pass Error object directly

**Why This Convention:**
- Searchability: Structured metadata enables JSON querying
- Consistency: Used across all 50+ logging calls
- Observability: Correlation IDs track related operations
- File Safety: Avoids template string injection in log files

## Error Handling & Retry Logic

### Retry Pattern (`src/syncService.js`)

```javascript
async function runWithRetries(fn, retries, baseDelayMs) {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (isRetryableError(error) && i < retries) {
                const delay = baseDelayMs * Math.pow(2, i) + Math.random() * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
}
```

**Retryable Errors**: ECONNREFUSED, ENOTFOUND, ETIMEDOUT, 429 (rate limit)

### Health Status Tracking

Service health is tracked in `HealthCheckService`:
- `HEALTHY` - All syncs succeeding
- `DEGRADED` - Some failures but within threshold
- `UNHEALTHY` - Failures exceed threshold
- `PENDING` - No syncs completed yet

Status affects `/ready` endpoint (returns 503 if UNHEALTHY).

## Development Workflows

### Local Development Setup

```bash
# Install dependencies
npm install

# Copy config template
cp config/config.example.json config/config.json

# Edit config with your Actual Budget server details
nano config/config.json

# Validate config
npm run validate-config

# Run sync manually (bypass scheduler)
npm run sync

# Start with scheduler
npm start
```

### Utility Scripts

```bash
npm run list-accounts  # List all accounts across servers
npm run history        # View sync history from SQLite
npm run validate-config # Validate config.json against schema
```

### Docker Development

```bash
# Build image
docker build -t actual-sync:dev .

# Run tests in container (happens automatically during build)
docker build --target builder -t actual-sync:test .

# Run locally with volume mounts
docker run --rm \
  -v ./config:/app/config:ro \
  -v ./data:/app/data \
  -v ./logs:/app/logs \
  actual-sync:dev
```

**Important**: Docker image runs as non-root user (UID 1001). Match host permissions or use `--user` flag.

## Common Patterns & Conventions

### File Organization

- `src/` - Main source code
  - `lib/` - Shared utilities (configLoader, logger)
  - `services/` - Service classes (healthCheck, syncHistory, notifications)
  - `__tests__/` - Jest tests (colocated with source)
- `config/` - Configuration files (JSON + schema)
- `scripts/` - Utility scripts (listAccounts, viewHistory, validateConfig)
- `docs/` - Comprehensive documentation (17 guides)

### Adding New Features

1. **Add configuration** to `config/config.schema.json` with description and examples
2. **Validate in ConfigLoader** (`src/lib/configLoader.js` → `validateLogic()`)
3. **Initialize service** in `src/syncService.js` with logger config pattern
4. **Add tests** in `src/__tests__/<feature>.test.js` using test helpers
5. **Update documentation** in relevant `docs/` files
6. **Ensure coverage** meets 70% threshold

### Notification Thresholds

Notifications trigger based on two configurable thresholds:

```json
{
  "notifications": {
    "failureThreshold": {
      "consecutiveFailures": 3,  // Alert after N consecutive failures
      "failureRate": 0.5,         // Alert if >50% of last 10 syncs failed
      "windowSize": 10
    }
  }
}
```

Use `NotificationService.recordSyncResult(serverName, success, correlationId)` to track.

## Security & Privacy

### Credential Handling

- **NEVER** hardcode credentials in source code
- Use `config/config.json` (excluded from git via `.gitignore`)
- Docker: Mount config as read-only (`:ro` flag)
- Warn users about HTTP vs HTTPS in `validateLogic()`

### Rate Limiting

- Health check endpoints rate-limited (60 req/min per IP)
- Telegram bot commands throttled internally
- Bank sync retry logic respects 429 responses

## Documentation Standards

When modifying code that affects behavior:

1. Update corresponding `docs/` file immediately
2. Keep examples current with actual code
3. Update `docs/README.md` table of contents if adding new docs
4. Cross-reference related documentation sections

**Key docs**:
- `docs/ARCHITECTURE.md` - System design and component interactions
- `docs/CONFIG.md` - Configuration reference
- `docs/TESTING.md` - Test patterns and coverage
- `docs/AI_INTERACTION_GUIDE.md` - AI agent boundaries and workflows

## Codebase Evolution Notes

This project was "vibe-generated" with AI assistance and has organically grown into a production-ready system. Key characteristics:

- **Consistent patterns emerged naturally** - Service initialization, logger config, test helpers
- **Documentation is comprehensive** - 17 docs files that are kept in sync with code
- **Test coverage is rigorous** - 98.73% coverage enforces quality
- **Single maintainer workflow** - Optimized for solo development with AI assistance

### Code Quality Guidelines

When suggesting changes:
- **Maintain existing patterns** - Follow established service initialization, logging, and testing patterns
- **Update all related docs** - Changes to behavior MUST update corresponding `docs/` files
- **Preserve test coverage** - New features must meet 70% coverage threshold
- **Keep consistency** - Match existing code style and structure

## Anti-Patterns to Avoid

❌ Adding external logging libraries (use custom logger)  
❌ Modifying retry logic without updating tests  
❌ Changing config schema without updating example files  
❌ Skipping correlation IDs in sync operations  
❌ Forgetting `actual.shutdown()` in finally blocks  
❌ Hardcoding paths instead of using config values  
❌ Breaking Docker compatibility (always test in container)  
❌ Creating inconsistent service initialization patterns  
❌ Skipping documentation updates when changing behavior

## Actual Budget API Integration

### Key API Methods Used

From `@actual-app/api` package (see https://actualbudget.org/docs/api/reference):

- **`init({ serverURL, password, dataDir })`** - Connect to server and prepare for operations
- **`downloadBudget(syncId, { password? })`** - Download budget file (supports encrypted budgets with optional password)
- **`sync()`** - Sync local budget file with server
- **`runBankSync({ accountId })`** - Trigger bank sync for specific account
- **`getAccounts()`** - Retrieve all accounts in budget
- **`shutdown()`** - Clean up and close connection (ALWAYS call in finally block)

### Encrypted Budget Support

For budgets with end-to-end encryption (BudgetFile.hasKey === true):

```javascript
// Download encrypted budget
await actual.downloadBudget(syncId, { password: encryptionPassword });

// Config schema supports encryption key per server
{
  "name": "Main Budget",
  "syncId": "abc123",
  "encryptionPassword": "budget-encryption-key"  // Future feature
}
```

**Note**: Encryption password is separate from server password. Check `BudgetFile.hasKey` field to detect encrypted budgets.

## Planned Enhancements (Roadmap Context)

When working on new features, consider these planned improvements:

1. **Logging Improvements**
   - Current: Custom logger with correlation IDs
   - Planned: Enhanced log streaming, better structured output for web dashboard

2. **Force Individual Sync**
   - Current: `npm run sync` syncs all servers
   - Planned: CLI command to sync specific server by name
   - Implementation pattern: Add `--server` flag to index.js, filter `config.servers`

3. **Web Dashboard**
   - Planned: Express-based UI for status viewing and sync triggering
   - Build on existing HealthCheckService (already has Express server)
   - Display real-time logs (stream from logger), sync history (query SyncHistoryService)
   - Manual sync buttons (call syncBank() for specific server)

4. **Encrypted Budget Support**
   - Add `encryptionPassword` field to server config schema
   - Pass to `downloadBudget(syncId, { password })` if present
   - Update ConfigLoader validation to handle optional encryption passwords

## Quick Reference

### Get Effective Server Config
```javascript
const syncConfig = getSyncConfig(server); // Merges server + global
```

### Initialize Service with Logger Config
```javascript
new ServiceClass(options, {
    level: config.logging.level,
    format: config.logging.format,
    logDir: config.logging.logDir
});
```

### Correlation ID Pattern
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

### Test with Mocks
```javascript
const config = createMockConfig({ servers: [...] });
const tempDir = createTempDir();
// ... test logic ...
cleanupTempDir(tempDir);
```
