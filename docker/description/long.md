# Actual-sync - Automated Bank Synchronization for Actual Budget

**Actual-sync** is a production-ready Node.js service that automates bank transaction synchronization for [Actual Budget](https://actualbudget.org) servers, eliminating manual sync operations and ensuring financial data stays current across multiple budget instances.

## Key Features

- ✅ **Multi-Server Support** - Manage unlimited Actual Budget instances with independent configurations
- ✅ **Encrypted Budget Support** - Full support for end-to-end encrypted (E2EE) budget files
- ✅ **Flexible Scheduling** - Global and per-server cron schedules with timezone support
- ✅ **Web Dashboard** - Interactive monitoring UI with real-time logs, charts, and manual sync controls
- ✅ **Health Monitoring** - HTTP endpoints (`/health`, `/metrics`, `/ready`) and Prometheus metrics
- ✅ **Multi-Channel Notifications** - Telegram bot, email, Slack, Discord, Microsoft Teams alerts
- ✅ **Sync History** - SQLite database with CLI query tools for troubleshooting
- ✅ **Comprehensive Logging** - File rotation, multiple formats (JSON/pretty), syslog support
- ✅ **Production Ready** - 84.77% test coverage (309 tests), comprehensive error handling
- ✅ **Secure by Default** - Non-root user, credential warnings, HTTPS enforcement

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

## Monitoring

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
