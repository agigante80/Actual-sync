# Architecture

## 🏗️ System Overview

Actual-sync is a scheduled automation service that orchestrates bank transaction synchronization across multiple Actual Budget server instances. It operates as a single-process Node.js application with scheduled job execution and robust error handling.

---

## 📐 System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Actual-sync Service                     │
│                                                             │
│  ┌──────────────┐      ┌──────────────┐                   │
│  │   Scheduler  │─────▶│  Sync Engine │                   │
│  │ (node-schedule)│     │              │                   │
│  └──────────────┘      └──────┬───────┘                   │
│                                │                            │
│                        ┌───────▼────────┐                  │
│                        │  Retry Handler │                  │
│                        │ (Exponential   │                  │
│                        │   Backoff)     │                  │
│                        └───────┬────────┘                  │
│                                │                            │
│              ┌─────────────────┼─────────────────┐         │
│              │                 │                 │         │
│        ┌─────▼──────┐   ┌─────▼──────┐   ┌─────▼──────┐  │
│        │  Server 1  │   │  Server 2  │   │  Server N  │  │
│        │   Client   │   │   Client   │   │   Client   │  │
│        └─────┬──────┘   └─────┬──────┘   └─────┬──────┘  │
└──────────────┼────────────────┼────────────────┼──────────┘
               │                │                │
               │                │                │
       ┌───────▼────────┐ ┌────▼───────┐ ┌──────▼──────┐
       │  Actual Server │ │  Actual    │ │  Actual     │
       │   (Main)       │ │  Server    │ │  Server     │
       │                │ │ (Alejandro)│ │   (...)     │
       └───────┬────────┘ └────┬───────┘ └──────┬──────┘
               │                │                │
               └────────────────┼────────────────┘
                                │
                        ┌───────▼────────┐
                        │   GoCardless/  │
                        │    Nordigen    │
                        │  (Open Banking)│
                        └────────────────┘
```

---

## 🧩 Component Descriptions

### 1. Scheduler (`node-schedule`)

**Responsibility**: Trigger periodic bank synchronization at configured intervals

**Key Features**:
- Cron-based job scheduling
- Timezone-aware execution (Europe/Madrid)
- Next invocation calculation and logging

**Location**: `sync_all_banks.js` (lines 143-156)

**Configuration**:
```javascript
const SCHEDULE_CRON = '03 03 */2 * *'; // Every other day at 03:03 AM
```

---

### 2. Sync Engine

**Responsibility**: Orchestrate synchronization workflow for all configured servers

**Key Functions**:
- Iterate through server configurations
- Initialize Actual API clients
- Download budget files
- Trigger account-level bank syncs
- Perform file synchronization

**Location**: `sync_all_banks.js`

**Main Functions**:
- `syncAllBanks()`: Iterate through all servers
- `syncBank(server)`: Sync a single server instance

**Workflow**:
1. Create/verify data directory
2. Initialize Actual API connection
3. Download budget file using sync ID
4. Fetch all accounts
5. Trigger file sync
6. For each account, trigger bank sync
7. Perform final file sync
8. Shutdown API connection

---

### 3. Retry Handler

**Responsibility**: Implement resilient error handling with intelligent retry logic

**Key Features**:
- Exponential backoff for rate limits and network failures
- Configurable maximum retry attempts
- Specific error categorization (rate limits, network failures, non-retryable)

**Location**: `sync_all_banks.js` (lines 33-63)

**Configuration**:
```javascript
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 3000;
```

**Retry Logic**:
```javascript
retryDelay = BASE_RETRY_DELAY_MS * (2 ** attemptNumber)
```

**Retryable Errors**:
- Rate limit exceeded (Nordigen API)
- Network failures
- Connection resets (ECONNRESET)
- DNS resolution failures (ENOTFOUND)

---

### 4. Server Client Instances

**Responsibility**: Manage independent connections to Actual Budget servers

**Configuration Structure** (in `config.json`):
```json
{
  "name": "ServerName",
  "url": "http://server:5006",
  "password": "password",
  "syncId": "sync_id",
  "dataDir": "/app/data_temp"
}
```

**Key Characteristics**:
- Isolated data directories per server
- Independent authentication
- Sequential processing (no parallel syncs)
- External configuration file (not hardcoded)
- JSON schema validation on startup

**Location**: Loaded from `config/config.json` via `src/lib/configLoader.js`

---

### 5. Configuration Loader

**Responsibility**: Load and validate server configuration from external file

**Key Features**:
- Load configuration from `config.json`
- Validate against JSON schema (`config.schema.json`)
- Apply default values for optional settings
- Security warnings (weak passwords, HTTP usage)
- Duplicate server name detection

**Location**: `src/lib/configLoader.js`

**Validation Checks**:
- Required fields present
- Valid JSON syntax
- Schema compliance
- Logical constraints (e.g., unique names)
- Security best practices

---

### 6. Account Discovery Utility

**Responsibility**: List all bank accounts accessible on a specific server

**Purpose**: 
- Verify server connectivity
- Discover account IDs for debugging
- Validate bank connection configurations

**Location**: `scripts/listAccounts.js`

**Usage**:
```bash
npm run list-accounts
```

---

## 🔄 Data Flow

### Scheduled Sync Flow

```
1. Scheduler triggers at cron time
   ↓
2. syncAllBanks() invoked
   ↓
3. For each server in configuration:
   ↓
4. syncBank(server) called
   ↓
5. Initialize Actual API with server credentials
   ↓
6. Download budget file (with retry)
   ↓
7. Fetch accounts from server
   ↓
8. Trigger file sync (with retry)
   ↓
9. For each account:
   ├─ Trigger bank sync (with retry)
   └─ Log result (success/failure per account)
   ↓
10. Trigger final file sync (with retry)
   ↓
11. Shutdown Actual API connection
   ↓
12. Repeat for next server
```

### Force Sync Flow

```
1. User runs: node sync_all_banks.js --force-run
   ↓
2. run() function detects --force-run flag
   ↓
3. Immediately invokes syncAllBanks()
   ↓
4. [Same workflow as Scheduled Sync Flow steps 3-12]
   ↓
5. Process exits after completion
```

### Account Discovery Flow

```
1. User runs: node getAccounts.js
   ↓
2. Initialize Actual API with configured server
   ↓
3. Download budget file
   ↓
4. Fetch accounts using getAccounts()
   ↓
5. Log account names and IDs
   ↓
6. Shutdown API connection
```

---

## 🗂️ File Structure

```
Actual-sync/
├── index.js                    # Application entry point
├── package.json                # Dependencies, scripts, and metadata
├── README.md                   # Project overview and quick start
├── .gitignore                  # Git ignore rules
├── .env                        # Environment variables (optional)
├── src/
│   ├── syncService.js          # Main sync service with scheduler
│   ├── lib/
│   │   └── configLoader.js     # Configuration loader with validation
│   └── utils/                  # Utility modules (future)
├── config/
│   ├── config.json             # Server configuration (not in repo)
│   ├── config.example.json     # Example configuration template
│   └── config.schema.json      # JSON schema for validation
├── scripts/
│   └── listAccounts.js         # Account discovery utility
├── docs/                       # Project documentation
│   ├── README.md               # Documentation index
│   ├── ARCHITECTURE.md         # This document
│   ├── CONFIG.md               # Configuration reference
│   ├── MIGRATION.md            # Migration guide
│   └── ...                     # Additional documentation
└── node_modules/               # Installed npm packages
    ├── README.md
    ├── PROJECT_OVERVIEW.md
    ├── ARCHITECTURE.md         # This document
    ├── AI_INTERACTION_GUIDE.md
    ├── REFACTORING_PLAN.md
    ├── TESTING_AND_RELIABILITY.md
    ├── IMPROVEMENT_AREAS.md
    ├── SECURITY_AND_PRIVACY.md
    └── ROADMAP.md
```

---

## 🔌 External Dependencies

### Actual Budget API (`@actual-app/api`)

**Purpose**: Official client library for interacting with Actual Budget servers

**Key Methods Used**:
- `init(options)`: Initialize API connection
- `downloadBudget(syncId)`: Download budget file from server
- `getAccounts()`: Fetch all budget accounts
- `sync()`: Trigger file synchronization
- `runBankSync(options)`: Trigger bank transaction sync for specific account
- `shutdown()`: Clean up API connection

**Documentation**: https://actualbudget.org/docs/api/

---

### Node-Schedule

**Purpose**: Cron-style job scheduling within Node.js process

**Key Features Used**:
- `scheduleJob(cronExpression, callback)`: Create scheduled job
- `job.nextInvocation()`: Get next scheduled execution time

**Cron Expression Format**: `minute hour day month dayOfWeek`

---

### Moment-Timezone

**Purpose**: Timezone-aware date/time handling

**Usage**: Log current time in Europe/Madrid timezone for debugging

---

## 🛡️ Error Handling Strategy

### Error Categories

1. **Retryable Errors**:
   - Rate limit exceeded (exponential backoff)
   - Network failures (exponential backoff)
   - Connection resets
   - DNS failures

2. **Non-Retryable Errors**:
   - Authentication failures
   - Invalid sync IDs
   - API errors (non-rate-limit)

### Error Propagation

- **Account-level errors**: Logged but don't stop other accounts from syncing
- **Server-level errors**: Logged but don't stop other servers from syncing
- **Fatal errors**: Stop the current server sync and move to next server

### Logging Strategy

- Console-based logging (stdout/stderr)
- Detailed error messages with stack traces
- Progress indicators for each operation
- Next schedule time displayed on startup

---

## 🔑 Design Decisions

### Sequential Server Processing

**Decision**: Process servers sequentially, not in parallel

**Rationale**:
- Simplifies error handling and logging
- Avoids overwhelming GoCardless API with concurrent requests
- Reduces risk of rate limiting
- Easier to debug issues with specific servers

### Exponential Backoff

**Decision**: Use exponential backoff for retries (3s, 6s, 12s, 24s, 48s)

**Rationale**:
- Prevents overwhelming external APIs during rate limit periods
- Gives transient network issues time to resolve
- Standard industry practice for API retry logic

### Isolated Data Directories

**Decision**: Each server uses a separate data directory

**Rationale**:
- Prevents cross-contamination of budget data
- Allows concurrent budget file management
- Simplifies cleanup and debugging

### External Configuration Files

**Decision**: Use `config.json` for server configuration with JSON schema validation

**Rationale**:
- Keeps sensitive data out of source control
- Easy to modify without code changes
- Supports multiple servers cleanly
- Schema validation prevents configuration errors
- No code changes needed to add/remove servers
- Better structure than environment variables for complex config

---

## 🔄 State Management

### Stateless Operation

The service is **stateless** between sync runs:
- No persistent storage of sync history
- No database or file-based state
- Each run is independent

### Temporary State

**Data Directories**: Actual API creates temporary local cache in configured data directories. These are reused across runs but can be deleted safely.

---

## 🚀 Deployment Considerations

### Single Instance

Currently designed to run as a single process. Not suitable for:
- Load balancing across multiple instances
- High-availability deployments
- Horizontal scaling

### Resource Requirements

**CPU**: Low (mostly I/O-bound waiting for API responses)
**Memory**: Moderate (depends on budget file size)
**Disk**: Minimal (temporary cache files)
**Network**: Outbound HTTPS to Actual servers and GoCardless API

### Recommended Deployment

- Docker container with scheduled restart policy
- Systemd service with automatic restart
- Kubernetes CronJob (requires refactoring to one-shot execution)

---

**Last Updated**: December 4, 2025
