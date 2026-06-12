# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Actual-sync** is a self-hosted Node.js service that automates bank transaction synchronization for [Actual Budget](https://actualbudget.org/) servers. It supports multiple budget instances, encrypted budgets, scheduling, multi-channel notifications, and a web dashboard with Prometheus metrics.

## Commands

```bash
# Install git hooks (run once after cloning — also runs automatically via npm install)
git config core.hooksPath .githooks
# This installs a pre-push hook that runs npm test --coverage --ci before every push.

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

# Check for dead code (unused files/exports) with knip
npm run dead:check     # blocking (exit 1 on findings)
npm run knip           # report-only (always exit 0; what CI runs)

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

# Bump version (updates VERSION + package.json + package-lock.json in sync;
# aborts if local version is behind the latest released tag). For a patch
# release you do not need this (the auto-release patch-bumps). Run it on
# `development` only to cut a MINOR or MAJOR release, which the auto-release
# then publishes as-is (see Git Workflow).
npm run version:bump -- minor   # or: patch / major
```

No build step — this is plain JavaScript (no TypeScript, no bundler).

### Docker Development

```bash
# Build image
docker build -t actual-sync:dev .

# Run locally with volume mounts
docker run --rm \
  -v ./config:/app/config:ro \
  -v ./data:/app/data \
  -v ./logs:/app/logs \
  -e PUID=1001 -e PGID=1001 \
  actual-sync:dev
```

**PUID/PGID & privilege drop:** the container starts as root via `docker/entrypoint.sh`, aligns its user to `PUID`/`PGID` (default `1001:1001`), chowns `/app/data` + `/app/logs`, then drops to that non-root user with `su-exec` under `tini`. Set `PUID`/`PGID` to match the owner of the mounted volumes (Unraid: `99`/`100`); otherwise the budget SQLite DB can't be written and sync fails with "No budget file is open". The published image is built with `npm ci --omit=dev`, so it contains **no** devDependencies. Multi-arch (arm64) images are built only on `main`/`v*` tags; `development` builds amd64 only.

### NAS / server deployment (pull pre-built image)

In deployments that consume the pre-built GHCR image (no `build:` key in the compose file), **`docker compose build` is a no-op** — update by pulling the newly published image:

```bash
docker compose pull actual-sync && docker compose up -d actual-sync
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
- `services/healthCheck.js` — Express HTTP server. Public (no auth): `/health`, `/ready`, `/metrics`, `/metrics/prometheus`, `/icon.png`, and a WebSocket log stream at `/ws/logs`. Behind `dashboardAuth()`: `/dashboard` and the `/api/dashboard/*` REST API (`status`, `servers`, `orphaned-servers`, `schedules`, `metrics`, `history`, `accounts`, plus POST `sync`, `dismiss-error`, `reset-history`, `test-notification`)
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

### Helper Modules in `src/lib/`

Beyond `configLoader.js` and `logger.js`, small single-purpose modules encode non-obvious sync behavior. Prefer extending these over inlining logic in `syncService.js`:

- `accountFilter.js` — `partitionSyncableAccounts()` splits accounts into `syncable` vs `skipped`. Only accounts with `account_sync_source` set and not `closed` are synced; running `runBankSync` on manual/closed accounts is a silent no-op that would otherwise be miscounted as success (#98).
- `rejectionClassifier.js` — `classifyRejection()` decides the log level for unhandled promise rejections. Rejections originating inside `@actual-app/api` are downgraded to `debug` (already surfaced via the normal sync error path); genuine rejections from our own code stay at `error`. Keys off the originating stack frame so a real bug passing through an api callback isn't hidden. Reinforces the "keep the error log honest" rule.
- `actualApiError.js` — `enhanceActualApiError()` wraps opaque `@actual-app/api` errors (often empty `PostError`s) with human-readable context and `.phase`/`.code`/`.errorCode`/`.originalError` fields, branching on phase (`download`/`sync`) and E2EE.
- `messageFormatter.js` — `MessageFormatter.formatSyncNotification()` produces one unified notification payload formatted per channel; notification channels consume this rather than building their own strings.
- `configBootstrap.js` — On first run seeds an example config into an empty (bind-mounted) config dir from the image-baked `config-defaults/`, so a fresh container gets a fillable template instead of a cryptic "not found" (#96).

### Logging Convention

Always use the custom logger from `src/lib/logger.js` — never add Winston, Pino, or other logging libraries.

```javascript
// CORRECT — concise message + structured metadata
logger.info('Starting sync', { server: name, url, dataDir, maxRetries });
logger.error('Attempt failed', { attempt: i + 1, error: err.message, errorCode: err.code });

// AVOID — data embedded in message string
logger.info(`Starting sync for ${name} at ${url} with ${maxRetries} retries`);
```

Log levels: `ERROR` (failures needing attention), `WARN` (retries/threshold warnings), `INFO` (normal operations), `DEBUG` (verbose). **Level discipline:** a failure the service recovered from (a retry, a transient remote 429/5xx, a network blip, an already-handled `@actual-app/api` rejection) is `WARN`/`DEBUG`, never `ERROR`. Keep the error log honest.

Secrets are redacted automatically before writing (console/file/syslog/dashboard) by key name and by secret-looking string patterns, so passing a token in metadata is masked, not leaked. Files default to single-line JSON (`fileFormat`), console to `pretty`. See `docs/LOGGING.md` for the full standard (redaction keys, rotation, syslog).

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

## Code Health (dead code + doc drift)

- **Dead code**: `knip` is configured in `knip.json` (explicit `entry` points, no
  blanket `ignore` — suppress legitimate exceptions at the source). `npm run dead:check`
  is blocking; CI runs the report-only `npm run knip` in the lint job (flip to blocking
  via a dedicated cleanup PR once a baseline is clean). `knipConfig.test.js` guards the
  config's entry roots.
- **Doc↔code drift guards** (`src/__tests__/docDriftGuards.test.js`, wired into `npm test`):
  forward-direction checks that lock known invariants — README endpoints exist as Express
  routes, advertised notification channels have implementations (the #128/Teams class),
  no rotting hardcoded metrics, and the README node badge matches `engines.node`. When you
  change observable surface, keep these green (or extend them) rather than deleting them.
- **Periodic audit**: the manual `/code-health-auditor` skill (agent
  `.claude/agents/code-health-auditor.md`, cache `docs/audit/deadcode-audit-cache.json`)
  runs knip + the guards, triages, and files gate-ready tickets. It owns dead code + doc
  drift; **dependencies** are `dep-auditor`'s scope — the two never overlap.

## Adding New Features

1. Add configuration to `config/config.schema.json` with description and examples
2. Add business logic validation in `src/lib/configLoader.js` → `validateLogic()`
3. Initialize service in `src/syncService.js` with the logger config pattern above
4. Add tests in `src/__tests__/<feature>.test.js` using the test helpers
5. Update relevant `docs/` files to match changed behavior

## Git Workflow

**Branch model:** `development` is the active integration branch; `main` holds production-ready releases. Feature work lands on `development`.

**Auto-release:** every successful CI run on `main` triggers `.github/workflows/auto-release.yml`, which tags `vX.Y.Z` and publishes a GitHub Release. It decides the version by comparing the version on `main` (after the merge) against the latest released tag:
- **Version unchanged** (no manual bump): it **patch-bumps** (1.4.7 to 1.4.8), commits, tags, releases. This is the routine path, so for a normal patch release you just merge `development` to `main` and let it bump.
- **Version already higher** (you bumped on `development`): it **releases that version as-is**, no extra bump. This is how you cut a **minor or major** release: run `npm run version:bump -- minor` (or `major`) on `development` first, then merge. It also means an intentional manual patch bump is respected (no double-bump).
- **Version lower than the latest tag**: it **aborts and flags** a regression (a stale `development` was merged without back-merging `main` first).

Notes:
- A **manual** bump commit must NOT use the `chore(release): bump version` prefix (that prefix is the recursion guard's marker for the bot's own bump). Use `chore: bump version to X`.
- The patch-bump path commits to `main` only, so **after a routine (auto-patch) release, back-merge `main` → `development`** (fast-forward) to avoid version drift. A minor/major release bumped on `development` does not drift.
- Auth uses a GitHub App token (`APP_ID` / `APP_PRIVATE_KEY` secrets), not `GITHUB_TOKEN`, otherwise the new tag would not trigger the tag-based Docker publish.

**Rules:**
- **Never push to `main` directly.** Merging `development` → `main` happens ONLY when the user explicitly asks (e.g. "merge to main").
- Do not run `git push` unless the user asked for it in that message.

## Dependency Policy

**Never force transitive versions.** No `npm overrides`, `resolutions`, or `.npmrc` pins — none exist and none should be added.

- **Direct dependencies** (in `package.json`): upgrade these to fix advisories. Dependabot PRs for direct deps + GitHub Actions are fine to merge.
- **Transitive dependencies** (not in `package.json`): do **not** bump them directly. Wait for the **direct parent** to release a version that pulls the fix. Close standalone transitive-upgrade issues and Dependabot PRs (`@dependabot ignore this dependency`) rather than overriding.
- A transitive only clears if the parent's range *floor* moves above the vulnerable version. Bumping a parent whose range still admits the old version (e.g. `ajv ^3.0.1` still allowing the old `fast-uri`) won't help — that one waits.
- The app's own code must only `require()` declared direct dependencies, never transitive-only packages.

## Anti-Patterns to Avoid

- Adding external logging libraries — use the custom logger
- Modifying retry logic without updating tests
- Changing config schema without updating `config/config.example.json`
- Skipping correlation IDs in sync operations
- Forgetting `actual.shutdown()` in finally blocks
- Accessing `server.sync.*` directly instead of using `getSyncConfig(server)`
- Skipping documentation updates when changing observable behavior
- Forcing transitive versions via `overrides`/`resolutions` (see Dependency Policy)
- Manually patch-bumping for a routine release (the auto-release patch-bumps; only bump manually on `development` for a minor/major, see Git Workflow)

## Documentation

Comprehensive guides live in `docs/`. Key references:
- `docs/ARCHITECTURE.md` — deeper architectural detail
- `docs/TESTING.md` — testing patterns and conventions
- `docs/CONFIG.md` — full configuration reference
