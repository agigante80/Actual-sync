# Actual-sync - Automated Bank Synchronization for Actual Budget

**Actual-sync** is a production-ready Node.js service that automates bank transaction synchronization for [Actual Budget](https://actualbudget.org) servers, eliminating manual sync operations and ensuring financial data stays current across multiple budget instances.

## Key Features

- ✅ **Multi-Server Support** - Manage unlimited Actual Budget instances with independent configurations
- ✅ **Flexible Scheduling** - Global and per-server cron schedules with timezone support
- ✅ **Health Monitoring** - HTTP endpoints (`/health`, `/metrics`, `/ready`) and Prometheus metrics
- ✅ **Multi-Channel Notifications** - Telegram bot, email, Slack, Discord, Microsoft Teams alerts
- ✅ **Sync History** - SQLite database with CLI query tools for troubleshooting
- ✅ **Production Ready** - 98.73% test coverage (255 tests), comprehensive error handling
- ✅ **Secure by Default** - Non-root user, credential warnings, HTTPS enforcement

## Quick Start

```bash
docker run -d \
  --name actual-sync \
  --restart unless-stopped \
  -v ./config:/app/config:ro \
  -v ./data:/app/data \
  -v ./logs:/app/logs \
  -p 3000:3000 \
  -e TZ=America/New_York \
  yourusername/actual-sync:latest
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
      "dataDir": "/app/data/main"
    }
  ],
  "sync": {
    "schedule": "0 2 * * *",
    "maxRetries": 5
  },
  "healthCheck": {
    "port": 3000
  }
}
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
    image: yourusername/actual-sync:latest
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
- GitHub: https://github.com/yourusername/actual-sync
- Configuration Guide: https://github.com/yourusername/actual-sync/blob/main/docs/CONFIG.md
- Docker Deployment: https://github.com/yourusername/actual-sync/blob/main/docs/DOCKER.md

## Image Details

- **Base Image**: node:20-alpine
- **Image Size**: 229MB
- **User**: actualuser (UID 1001, non-root)
- **Exposed Ports**: 3000 (health checks)
- **Volumes**: `/app/config`, `/app/data`, `/app/logs`

## Support

- 📖 Documentation: https://github.com/yourusername/actual-sync/tree/main/docs
- 🐛 Issues: https://github.com/yourusername/actual-sync/issues
- 💬 Discussions: https://github.com/yourusername/actual-sync/discussions
- 🔐 Security: security@example.com

Built with ❤️ for the Actual Budget community
