# Actual-sync - Automated Bank Synchronization for Actual Budget

**Actual-sync** is a production-ready Node.js service that automates bank transaction synchronization for [Actual Budget](https://actualbudget.org) servers, eliminating manual sync operations and ensuring financial data stays current across multiple budget instances.

## Key Features

### 🎯 Core Capabilities
- ✅ **Multi-Server Support** - Manage unlimited Actual Budget instances with independent configurations
- ✅ **Encrypted Budget Support** - Full support for end-to-end encrypted (E2EE) budget files
- ✅ **Flexible Scheduling** - Global and per-server cron schedules with timezone support
- ✅ **Intelligent Retry Logic** - Exponential backoff with rate limit detection and handling

### 📊 Modern Web Dashboard
- ✅ **Tabbed Interface** - Overview, Analytics, History, and Settings tabs for organized monitoring
- ✅ **2-Column Overview** - Service health, server list with encryption badges, recent activity, live logs
- ✅ **Sync Status Badges** - Visual indicators showing success/partial/failure for each sync
- ✅ **Interactive Charts** - Success rates by server, duration trends, and sync timeline
- ✅ **Date Format Preferences** - 11 customizable formats including 3-letter months (e.g., Dec 10, 2025)
- ✅ **Orphaned Server Cleanup** - Remove historical data for decommissioned budgets
- ✅ **Manual Sync Controls** - Trigger syncs for all servers or specific instances via UI

### 🔔 Notifications & Monitoring
- ✅ **Health Monitoring** - HTTP endpoints (`/health`, `/metrics`, `/ready`) and Prometheus metrics
- ✅ **Multi-Channel Notifications** - Telegram bot, email, Slack, Discord, Microsoft Teams alerts
- ✅ **Sync History** - SQLite database with CLI query tools for troubleshooting
- ✅ **Comprehensive Logging** - File rotation, multiple formats (JSON/pretty), syslog support
- ✅ **WebSocket Streaming** - Real-time log broadcast with ring buffer (500 logs, 200 displayed)

### 🛡️ Production Ready
- ✅ **98.73% Test Coverage** - 255 passing tests ensuring reliability
- ✅ **Secure by Default** - Non-root user, credential warnings, HTTPS enforcement
- ✅ **Docker Optimized** - 229MB Alpine-based image, multi-architecture support (amd64/arm64)

## Quick Start

```bash
# Using Docker Hub
docker run -d \
  --name actual-sync \
  --restart unless-stopped \
  -v ./config:/app/config:ro \
  -v ./data:/app/data \
  -v ./logs:/app/logs \
  -p 3000:3000 \
  -e TZ=America/New_York \
  agigante80/actual-sync:latest

# OR using GitHub Container Registry
docker run -d \
  --name actual-sync \
  --restart unless-stopped \
  -v ./config:/app/config:ro \
  -v ./data:/app/data \
  -v ./logs:/app/logs \
  -p 3000:3000 \
  -e TZ=America/New_York \
  ghcr.io/agigante80/actual-sync:latest
```

## Configuration

Create `config/config.json`:

```json
{
  "servers": [
    {
      "name": "Main",
      "url": "https://budget.example.com",
      "password": "your_secure_password",
      "syncId": "your_sync_id",
      "dataDir": "/app/data/main",
      "encryptionPassword": "MyBudgetEncryptionKey"
    }
  ],
  "sync": {
    "schedule": "0 2 * * *",
    "maxRetries": 5
  },
  "logging": {
    "level": "INFO",
    "format": "json",
    "logDir": "/app/logs"
  },
  "healthCheck": {
    "port": 3000
  }
}
```

**Configuration Notes:**
- `encryptionPassword` is optional and only needed for E2EE encrypted budgets
- `logDir` should be set to `/app/logs` to persist logs in the mounted volume
- Set `logDir` to `null` to disable file logging (console only)
```

## Web Dashboard

Access the modern web dashboard at `http://localhost:3000/dashboard`:

- **Overview Tab**: 2-column layout showing service health, configured servers with status badges, recent sync activity, and live logs
- **Analytics Tab**: Interactive charts displaying success rates by server, duration trends, and sync timeline
- **History Tab**: Searchable sync history with server and limit filters, showing detailed error messages
- **Settings Tab**: Customize date formats (11 options), manage orphaned servers, reset history, and clear errors

![Dashboard Screenshot](https://raw.githubusercontent.com/agigante80/Actual-sync/development/docs/screenshots/dashboard-hero.png)

## Monitoring & Health Checks

- **Web Dashboard**: `http://localhost:3000/dashboard` (interactive UI)
- **Health Check**: `curl http://localhost:3000/health`
- **Metrics**: `curl http://localhost:3000/metrics`
- **Prometheus**: `curl http://localhost:3000/prometheus`
- **View History**: `docker exec actual-sync npm run history`

## Docker Compose Example

```yaml
version: '3.8'
services:
  actual-sync:
    image: agigante80/actual-sync:latest  # or ghcr.io/agigante80/actual-sync:latest
    container_name: actual-sync
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./config:/app/config:ro
      - ./data:/app/data
      - ./logs:/app/logs
    environment:
      - TZ=America/New_York
      - NODE_ENV=production
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Requirements

- Actual Budget server with configured bank connections (GoCardless/Nordigen)
- Valid Actual Budget credentials and sync ID
- Network access to Actual Budget server and banking APIs

## Documentation

Full documentation available at:
- GitHub: https://github.com/agigante80/Actual-sync
- Configuration Guide: https://github.com/agigante80/Actual-sync/blob/main/docs/CONFIG.md
- Docker Deployment: https://github.com/agigante80/Actual-sync/blob/main/docs/DOCKER_DEPLOYMENT.md

## Image Details

- **Base Image**: node:20-alpine
- **Image Size**: 229MB
- **User**: actualuser (UID 1001, non-root)
- **Exposed Ports**: 3000 (health checks)
- **Volumes**: `/app/config`, `/app/data`, `/app/logs`

## Support

- 📖 Documentation: https://github.com/agigante80/Actual-sync/tree/main/docs
- 🐛 Issues: https://github.com/agigante80/Actual-sync/issues
- 💬 Discussions: https://github.com/agigante80/Actual-sync/discussions
- ☕ Support: https://buymeacoffee.com/agigante80

Built with ❤️ for the Actual Budget community
