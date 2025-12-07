# Actual-sync

**Automated bank synchronization service for Actual Budget across multiple servers**

Actual-sync is a Node.js-based automation tool that periodically syncs bank transactions with Actual Budget servers. It supports multiple server configurations, implements retry logic with exponential backoff for rate limits and network failures, and runs on a configurable schedule.

---

## 🚀 Quick Start

### Prerequisites

- Node.js (v14 or higher)
- Access to one or more Actual Budget servers
- Bank accounts configured with GoCardless/Nordigen integration in Actual Budget

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd Actual-sync
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create configuration file:**
   Copy the example configuration and customize it:
   ```bash
   cp config/config.example.json config/config.json
   ```
   
   Edit `config/config.json` with your server details:
   ```json
   {
     "servers": [
       {
         "name": "Main",
         "url": "http://actual-main:5006",
         "password": "your_password",
         "syncId": "your_sync_id",
         "dataDir": "/app/dataDir_Main_temp"
       }
     ]
   }
   ```
   
   **Note:** See [MIGRATION.md](./MIGRATION.md) if upgrading from environment variables.

4. **Validate setup:**
   ```bash
   # Validate configuration (checks JSON syntax and schema)
   npm run validate-config
   
   # Test connection and list accounts
   npm run list-accounts
   ```

   The service automatically validates your environment on startup:
   - Node.js version (requires v14+)
   - Required dependencies installed
   - Configuration file exists and is valid JSON
   - All required configuration fields present

5. **Run tests (optional but recommended):**
   ```bash
   # Run all tests
   npm test
   
   # Run with coverage report
   npm run test:coverage
   ```
   
   See [TESTING.md](./TESTING.md) for comprehensive testing documentation.

6. **Run a manual sync:**
   ```bash
   # Run immediate sync (without waiting for schedule)
   npm run sync
   ```

---

## 📖 Usage

### Scheduled Sync (Production)

Start the service to run on the configured schedule:
```bash
npm start
```

Default schedule: Every other day at 03:03 AM (configurable in `config/config.json`)

### Manual Sync (Testing)

Force an immediate sync across all configured servers:
```bash
npm run sync
```

### Account Discovery

List all accounts accessible on configured servers:
```bash
npm run list-accounts
```

---

## 📚 Complete Documentation

| Document | Purpose |
|----------|---------|
| [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md) | Project goals, features, and technology summary |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design and component relationships |
| [AI_INTERACTION_GUIDE.md](./AI_INTERACTION_GUIDE.md) | AI agent rules and automation policies |
| [REFACTORING_PLAN.md](./REFACTORING_PLAN.md) | Ongoing improvements and task tracking |
| [TESTING_AND_RELIABILITY.md](./TESTING_AND_RELIABILITY.md) | Testing strategy and reliability policies |
| [IMPROVEMENT_AREAS.md](./IMPROVEMENT_AREAS.md) | Known gaps and technical debt |
| [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) | Security policies and privacy protection |
| [ROADMAP.md](./ROADMAP.md) | Future development priorities |

---

## 🔧 Configuration

### Server Configuration

Add or modify servers in `config/config.json`:
```json
{
  "servers": [
    {
      "name": "ServerName",
      "url": "http://actual-server:5006",
      "password": "your_password",
      "syncId": "your_sync_id",
      "dataDir": "/app/dataDir_temp"
    }
  ]
}
```

### Retry Configuration

Adjust retry behavior in `config/config.json`:
```json
{
  "sync": {
    "maxRetries": 5,
    "baseRetryDelayMs": 3000
  }
}
```

### Schedule Configuration

Modify the cron expression in `config/config.json`:
```json
{
  "sync": {
    "schedule": "03 03 */2 * *"  // Every other day at 03:03 AM
  }
}
```

**Common schedules:**
- Daily at 2 AM: `"0 2 * * *"`
- Every 6 hours: `"0 */6 * * *"`
- Hourly: `"0 * * * *"`

See [MIGRATION.md](../MIGRATION.md) for complete configuration reference.

---

## 🛠️ Troubleshooting

### Connection Issues

1. Verify server URL is accessible:
   ```bash
   curl http://actual-server:5006
   ```

2. Check credentials in `config/config.json`

3. Ensure data directories have write permissions

### Rate Limiting

If you encounter GoCardless/Nordigen rate limits:
- The system automatically implements exponential backoff
- Consider reducing sync frequency
- Check rate limit quotas in GoCardless dashboard

### Network Failures

The system automatically retries on:
- Network failures
- Connection resets (ECONNRESET)
- DNS resolution failures (ENOTFOUND)

---

## 📄 License

[Add your license here]

## 🤝 Contributing

See [AI_INTERACTION_GUIDE.md](./AI_INTERACTION_GUIDE.md) for contribution guidelines and development workflows.

---

**Note:** This project requires active Actual Budget servers with properly configured bank integrations (GoCardless/Nordigen).
