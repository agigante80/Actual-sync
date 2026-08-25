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
npm run dead:check     # blocking (exit 1 on findings); CI runs this in the lint job
npm run knip           # report-only (always exit 0); for local diffing

# Report config that is written here but NOT YET IN EFFECT, because GitHub reads
# it only from the default branch (#204). Report-only, always exits 0.
npm run drift:check

# Mutation testing — the verification bar here. Reintroduces each shipped
# defect one at a time and asserts the suite FAILS. Not in CI (it runs the
# whole suite once per mutation); run it before a release and after any
# change the catalog covers.
npm run test:mutation                       # all of them, full suite each
npm run test:mutation -- --fast             # only each mutation's hinted test file
npm run test:mutation -- --ticket '#177'    # one ticket's mutations
npm run test:mutation -- --list             # what is covered, without running anything
npm run test:mutation -- --recover          # restore a file after a hard kill

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

# Regenerate docs/screenshots/* (Puppeteer, dev-only) and README metric badges
npm run screenshots
npm run badges:generate

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
- `services/healthCheck.js` — Express HTTP server. Public (no auth): `/health`, `/ready`, `/metrics`, `/metrics/prometheus`, `/icon.png`, and a WebSocket log stream at `/ws/logs`. Behind `dashboardAuth()`: `/dashboard` and the `/api/dashboard/*` REST API (`status`, `servers`, `orphaned-servers`, `schedules`, `metrics`, `history`, `accounts`, `notifications`, plus POST `sync`, `dismiss-error`, `reset-history`, `test-notification`). `notifications` (#188) reports failure-alert rate-limit headroom and recent sync outcomes per server — note `notificationsSentLastHour` counts **failure** notifications only, because rate limiting is failure-only by design. `test-notification` accepts all six channels: `email`, `discord`, `slack`, `telegram`, `ntfy`, `generic` (#182). A global `express-rate-limit` (60 req/min/IP) covers every route except `/icon.png`, which is exempt so the dashboard's favicon/logo fetch doesn't eat the API budget (#113)
- `services/prometheusService.js` — Prometheus metrics via `prom-client`
- `services/notificationService.js` — Routes alerts to Email, Telegram, ntfy, and webhooks (Slack / Discord / generic). Config keys under `notifications`: `email`, `telegram`, `ntfy`, `webhooks`, plus `branding`, `notifyOnSuccess`, `thresholds`, `rateLimit`. Note there is **no** Teams channel — see the advertised-channels drift guard below before adding one to the README.
  **`notifyOnSuccess`** (`always`/`errors_only`/`never`, #169) is resolved by `shouldNotifyChannel(channel, status, entry)` with precedence *webhook entry → channel → global → `always`* (the channel tier exists only for the object-shaped `email`/`telegram`/`ntfy`; the webhook arrays resolve entry → global). `partial` counts as an error; `never` mutes the channel entirely (failures included) while `bypassThresholds` test notifications always send. `thresholds` and `rateLimit` remain **failure-only** — never gate success/partial through them, and never let `always`/`errors_only` suppress a `failure`
- `services/telegramBot.js` — Interactive Telegram bot (9 commands)

Each service receives options and a logging config object:

```javascript
new ServiceClass(options, {
    level: config.logging.level,
    format: config.logging.format,
    logDir: config.logging.logDir
});
```

### Key Patterns

**Two independent retry layers** — don't conflate them:

1. **In-sync retries** — `runWithRetries()` wraps each bank sync call with exponential backoff + jitter, inside a single `syncBank()` run. Retryable errors: `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, HTTP 429.
2. **Cross-sync auto-retry** — `scheduleAutoRetry()` re-runs the *whole* `syncBank()` later via a `setTimeout` tracked per server in the `activeRetryTimers` map, driven by `getSyncConfig(server).autoRetry` (`enabled`/`maxAttempts`/`delayMinutes`). Always go through `cancelPendingRetry(serverName)` before scheduling or on manual sync, otherwise a server accumulates overlapping timers.

**Version compatibility** (#154–#158): at connect time `syncBank()` calls `fetchServerVersion()` / `getClientVersion()` / `describeCompatibility()` from `lib/versionInfo.js`. The "supported" ceiling is the *installed* `@actual-app/api` version — never hardcode it, since the dependency-update workflow only merges a client bump after the suite passes. The check is non-fatal (a failed `/info` fetch just skips it) and its result is recorded on `HealthCheckService` separately from sync status, then merged into the `/api/dashboard/servers` payload as `serverVersion` + `versionVerdict`.

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
- `loggerConfig.js` — Maps a `config.logging` block to `createLogger()` options via an explicit `LOGGER_CONFIG_KEYS` allow-list, dropping `undefined` so logger defaults apply. Runtime-only options (`serviceName`, `broadcastCallback`, `context`, `inheritStreams`) are deliberately excluded. **When you add a `logging.*` config option, add its key here** — hand-picking a subset inline is exactly how `redact` and `fileFormat` became unreachable (#116).
- `versionInfo.js` — Server/client version fetch + compatibility verdict (see Key Patterns above). Client version is resolved once and cached.
- `version.js` — Resolves the service's own version: prefers `process.env.VERSION` (CI passes it as a Docker `--build-arg`), but treats the literal `"unknown"` — the Dockerfile's `ARG VERSION=unknown` default — the same as unset and falls back to `package.json` (#132).

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

### Mutation testing (`scripts/mutations.js` + `scripts/mutationTest.js`)

A green suite does not prove a test would catch the bug it was written for. **When you fix a
bug, add a catalog entry and confirm it is caught.** Rules that are not obvious from the code:

- **Guards for mutations of the runner itself must NOT live in `mutationCatalog.test.js`.**
  The runner excludes that file from the scored suite (it asserts anchors exist, which every
  mutant breaks), so a guard placed there scores every such mutation as SURVIVED regardless
  of the truth. Use `mutationRunner.test.js`.
- **A pure, unit-tested helper needs an *unwiring* mutation too.** Deleting its call site
  leaves every unit test green. Pair each extracted decision with a mutation that removes the
  call, backed by a source-reading wiring test.
- **Repeat-run the suite before trusting a score.** The runner takes a *single* green
  baseline, so one flaky test scores a false "caught". This has happened: a full pass was
  recorded against an unstable baseline and had to be discarded. Run `npm test` five to eight
  times after adding tests that touch native modules, timers, ports or the filesystem.
- Do not assert `toBeInstanceOf(Error)` on a native module's error — jest can load the addon
  in a different realm, so the prototype chain does not always reach the test's `Error`.
  Assert the message/code the production code actually uses.
- Never touch the working tree while a run is in progress; it mutates files in place. A killed
  run leaves a stale `.mutation-test.lock` — `--recover` reports honestly and the next
  `acquireLock()` clears it. Long full runs can exceed a background-task limit; run them
  per-ticket (`--fast --ticket '#NNN'`) if one gets killed.

`docs/TESTING.md` documents the runner's flags, exit codes, and every false-green trap it has
produced.

## Code Health (dead code + doc drift)

- **Dead code**: `knip` is configured in `knip.json` (explicit `entry` points, no
  blanket `ignore` — suppress legitimate exceptions at the source). `npm run dead:check`
  is blocking and **CI runs it in the lint job** (a `npm run knip` report-only variant
  remains for local diffing). `knipConfig.test.js` guards the config's entry roots.
- **Doc↔code drift guards** (`src/__tests__/docDriftGuards.test.js`, wired into `npm test`):
  forward-direction checks that lock known invariants — README endpoints exist as Express
  routes, advertised notification channels have implementations (the #128/Teams class),
  no rotting hardcoded metrics, and the README node badge matches `engines.node`. When you
  change observable surface, keep these green (or extend them) rather than deleting them.
  **Forward-direction only, deliberately**: everything the docs advertise must exist in
  code, never the reverse — the README is curated, not an exhaustive mirror, so a
  bidirectional guard would fail on a healthy tree. The same file also guards that every
  schema-defined notification channel has a route case **and** a dashboard button (#182),
  that every dashboard `load*()` is actually invoked (#188), that documented dashboard
  endpoints are real routes, that release-time scripts stay out of the image (#180/#183),
  and that no machine-specific absolute path is committed.
- **knip's blind spot: class methods** (`src/__tests__/deadMethodGuard.test.js`). knip flags
  unused files and exports but not an unused **method on a class it can see is used** — the
  gap that let `notifyError()` (#175) and then the whole `formatErrorNotification` family
  (#176) survive sweeps. The scan iterates to a fixpoint so a dead *family* collapses rather
  than propping itself up, and tests do not count as references. `REVIEWED_KEPT` is an
  allowlist of acknowledged exceptions, each naming an owning ticket; it also asserts every
  entry is *still* unreferenced, so a stale one fails the build. It is currently **empty** —
  keep it that way, or the allowlist becomes where findings hide.
- This project is **not a library** (no `bin`, no `files`, unpublished), so "public API" is
  never a reason to keep an uncalled method. Unused in-repo means unused.
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

**Default-branch-only config (#204).** GitHub reads some surfaces *only* from the
default branch (`main`), so a change to one of them on `development` is committed,
green, and **completely inert** until the merge — with nothing reporting it. This has
already bitten: #199 dropped `buy_me_a_coffee` from `.github/FUNDING.yml` on
`development` and the Sponsor button kept serving `main`'s copy. The surfaces are
`.github/FUNDING.yml`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/*`,
`.github/badges/*` (the README pins those Shields URLs to `/main/`), and any workflow
**not** triggered solely by `push` / `pull_request` / `merge_group` / `workflow_call` /
`workflow_dispatch` (a workflow whose ONLY trigger is `workflow_dispatch` still counts,
because GitHub only offers the Run button for workflows on the default branch).
That last one is an allow-list on purpose: GitHub resolves essentially every other event
from the default branch, so `schedule`, `workflow_run`, `issue_comment`, `release`,
`label` and `repository_dispatch` are all equally inert here — listing only the three
best-known ones is how the detector under-reported before (#207).
Run **`npm run drift:check`** to see what is currently written but not in effect.
Drift is the *normal* steady state here, so the report is advisory and never blocks;
the invariant that is genuinely enforceable — a default-branch-only workflow trigger
cannot go uncatalogued — is a hermetic guard in `src/__tests__/defaultBranchDrift.test.js`.

**Auto-release:** every successful CI run on `main` triggers `.github/workflows/auto-release.yml`, which tags `vX.Y.Z` and publishes a GitHub Release. It decides the version by comparing the version on `main` (after the merge) against the latest released tag:
- **Version unchanged** (no manual bump): it **patch-bumps** (1.4.7 to 1.4.8), commits, tags, releases. This is the routine path, so for a normal patch release you just merge `development` to `main` and let it bump.
- **Version already higher** (you bumped on `development`): it **releases that version as-is**, no extra bump. This is how you cut a **minor or major** release: run `npm run version:bump -- minor` (or `major`) on `development` first, then merge. It also means an intentional manual patch bump is respected (no double-bump).
- **Version lower than the latest tag**: it **aborts and flags** a regression (a stale `development` was merged without back-merging `main` first).

Notes:
- A **manual** bump commit must NOT use the `chore(release): bump version` prefix (that prefix is the recursion guard's marker for the bot's own bump). Use `chore: bump version to X`.
- The patch-bump path commits to `main` only, so **after a routine (auto-patch) release, back-merge `main` → `development`** (fast-forward) to avoid version drift. A minor/major release bumped on `development` does not drift.
- Auth uses a GitHub App token (`APP_ID` / `APP_PRIVATE_KEY` secrets), not `GITHUB_TOKEN`, otherwise the new tag would not trigger the tag-based Docker publish.

**Actual API release train:** `.github/workflows/dependency-update.yml` is the one exception to "releases are human-initiated" — it fully automates `@actual-app/api` upgrades, and **only** that dependency. Daily it fast-forwards `development` up to `main`, branches off `main`, bumps the dep (never the version — auto-release owns that), opens a PR to `main`, and merges it once full CI passes; auto-release then patch-bumps, tags and publishes. Majors included. Consequences to preserve:
- `dependabot.yml` must ignore `@actual-app/api` **entirely** (bare `dependency-name`, no `update-types`), or every major yields both a Dependabot PR and an auto-published release.
- Never add a version bump to the train — bumping would push `main` past the tag and auto-release would release as-is instead of patch-bumping.
- The `development` sync is `--ff-only` and must never become a force-push: on a diverged `development` it fails harmlessly (and opens a sync PR), whereas a reset would destroy in-flight work. The step is `continue-on-error` on purpose — the sync must never block the dependency from shipping.
- Never drop the post-merge "Verify the release chain actually started" step. Without it a misconfigured App token means the merge lands, nothing publishes, and the job still exits green — a silent stall. Any push that must trigger a downstream workflow needs the App token, never `GITHUB_TOKEN`.

**Rules:**
- **Never push to `main` directly.** Merging `development` → `main` happens ONLY when the user explicitly asks (e.g. "merge to main"). The release train above is the sole automated exception.
- Do not run `git push` unless the user asked for it in that message.

## Dependency Policy

**Never force transitive versions.** No `npm overrides`, `resolutions`, or `.npmrc` pins — none exist and none should be added.

- **Direct dependencies** (in `package.json`): upgrade these to fix advisories. Dependabot PRs for direct deps + GitHub Actions are fine to merge.
- **Transitive dependencies** (not in `package.json`): do **not** pin or override them. Close standalone transitive-upgrade issues and Dependabot PRs (`@dependabot ignore this dependency`) rather than overriding.
- **Before concluding "this one waits", check whether a fixed version is already inside the parent's declared range.** These are two different questions and conflating them cost this repo four rounds of re-triage (#51 → #92 → #127 → #200, and #53 → #126 → #203):
  - *Is a fixed version reachable today?* — true whenever the parent's range **admits** a patched release. Then **`npm update` clears it**: npm resolves to the highest version satisfying the parent's own range. The vulnerable copy was held only by the **lockfile**, not by the range. This is not forcing anything — no `package.json` edit, no override — and it is what closed #200–#203.
  - *Is it permanently unreachable?* — only when the parent's range **excludes** every fixed release (e.g. a fix that lands in `fast-uri@4` while `ajv` declares `^3.0.1`). **That** is the case that genuinely waits for the parent.
  - The parent's *floor* moving above the vulnerable version is what makes a fix **durable** for a fresh resolve. It is not a precondition for fixing it now, and a still-low floor is not a reason to leave an advisory open.
- Run `npm audit` after `npm update`; if it reaches 0, the advisories were in-range all along.
- The app's own code must only `require()` declared direct dependencies, never transitive-only packages.
- The app's own code must only `require()` declared direct dependencies, never transitive-only packages.

**How Dependabot is scoped (#192, #204).** `dependabot.yml` has **two** npm entries and
merging them reopens a real hole. Entry 1 sets `target-branch: development` and covers
**version** updates. Entry 2 deliberately **omits** `target-branch` — that omission is the
only thing that makes its rules reach **security** updates, because an entry with a
non-default `target-branch` is not consulted for them — and sets
`open-pull-requests-limit: 0` so it adds no version updates. Both use
`allow: dependency-type: "direct"`, so a vulnerable *transitive* no longer produces a
lockfile-only PR. `@actual-app/api` is ignored in **both**; entry 1's `ignore` does not
carry over, and it is a direct dependency.

Security PRs still open against `main` (GitHub allows no alternative), so
`.github/workflows/retarget-dependabot.yml` moves them to `development`. It runs on an
**hourly schedule**, not `pull_request_target`: a Dependabot-initiated run gets a
read-only token and no Actions secrets, so the App-token step would fail on exactly the
PRs it exists for. A scheduled run is not Dependabot-initiated and gets normal secrets.
The trade is up to an hour of latency, which costs nothing because nothing merges those
PRs in that window. **A retargeted PR is not automatically re-tested** — it keeps the
check it earned against `main`, so re-run CI before merging one (#205).

**A retargeted security PR recurs until `main` is promoted, and that is correct
behaviour, not a loop (#209).** Dependabot opens security PRs against the branch it
sees as vulnerable — the default branch. Merging the retargeted PR fixes
`development`, but `main` still carries the vulnerable lockfile, so Dependabot
re-detects the same advisory and opens the PR again; the hourly job dutifully
retargets the new one. Expect one new PR per Dependabot run, each retargeted and each
carrying the workflow's explanatory comment. The cycle stops when `development`
reaches `main`.

Do not suppress it. `main` genuinely *is* still vulnerable until promoted, and
Dependabot saying so is Dependabot working — silencing it would suppress a true alert
about production. The real cost is that a recurring PR trains someone to close these
reflexively, which is how a genuinely new advisory gets closed unread. **Read the
package and advisory before closing any of them**; promoting `main` is the actual fix.

- Adding external logging libraries — use the custom logger
- Modifying retry logic without updating tests
- Changing config schema without updating `config/config.example.json`
- Skipping correlation IDs in sync operations
- Forgetting `actual.shutdown()` in finally blocks
- Accessing `server.sync.*` directly instead of using `getSyncConfig(server)`
- Skipping documentation updates when changing observable behavior
- **Hardcoding a machine-specific absolute path** — a host home directory (`/home/<user>/…`, `/Users/<user>/…`, a Windows profile) is true on exactly one machine: in docs it is an instruction nobody else can follow, in a script it is a silent breakage on every other checkout. Use `$HOME`, `~`, `$(git rev-parse --show-toplevel)`, or a named variable. Container-absolute paths (`/app/data`, `/app/logs`) are fine and deliberate. Enforced two ways: a guard over every tracked file in `src/__tests__/docDriftGuards.test.js` (so CI fails), and a `PreToolUse` hook (`.claude/hooks/no-host-paths.sh`, wired in `.claude/settings.json`) that blocks the write at authoring time.
- Forcing transitive versions via `overrides`/`resolutions` (see Dependency Policy)
- Manually patch-bumping for a routine release (the auto-release patch-bumps; only bump manually on `development` for a minor/major, see Git Workflow)

## Project memory

`.claude/memory/` is the **tracked, canonical** record of decisions, traps and context that is
not derivable from the code or git history — `MEMORY.md` is its index, one line per entry.
`.claude/handoffs/` holds dated resume notes (what shipped, what is unfinished, what to
reload). Both are committed, so read them before starting non-trivial work and add to them
when you learn something a future session would otherwise rediscover the hard way.

## Documentation

Comprehensive guides live in `docs/`. Key references:
- `docs/ARCHITECTURE.md` — deeper architectural detail
- `docs/TESTING.md` — testing patterns and conventions
- `docs/CONFIG.md` — full configuration reference
- `docs/HEALTH_CHECK.md` — the endpoint reference, including the internal `/api/dashboard/*` table
