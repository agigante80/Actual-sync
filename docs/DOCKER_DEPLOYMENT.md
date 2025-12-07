# Docker Deployment Guide

This guide covers deploying Actual-sync using Docker and Docker Compose with real-world configuration examples.

## Table of Contents

- [Quick Start](#quick-start)
- [Docker Compose Setup](#docker-compose-setup)
- [Configuration](#configuration)
- [Common Issues](#common-issues)
- [Production Tips](#production-tips)

## Quick Start

### Using Docker Run

```bash
docker run -d \
  --name actual-sync \
  --user 1026:100 \
  -v ./config.json:/app/config/config.json:ro \
  -v ./data:/app/data \
  -v ./logs:/app/logs \
  -e TZ=Europe/Madrid \
  --restart unless-stopped \
  ghcr.io/agigante80/actual-sync:latest
```

### Using Docker Compose

See [Docker Compose Setup](#docker-compose-setup) below for a complete example.

## Docker Compose Setup

### Complete Example with Multiple Actual Budget Servers

```yaml
version: '3.8'

networks:
  actual-net:
    name: actual-net

services:
  # Actual Budget Server 1
  actual-main:
    image: actualbudget/actual-server:latest
    container_name: finance-actual-budget-main
    ports:
      - "5006:5006"
    environment:
      - TZ=Europe/Madrid
    volumes:
      - ./data-main:/data
    restart: unless-stopped
    networks:
      - actual-net

  # Actual Budget Server 2
  actual-secondary:
    image: actualbudget/actual-server:latest
    container_name: finance-actual-budget-secondary
    ports:
      - "5008:5006"
    environment:
      - TZ=Europe/Madrid
    volumes:
      - ./data-secondary:/data
    restart: unless-stopped
    networks:
      - actual-net

  # Actual-sync Service
  actual-sync:
    image: ghcr.io/agigante80/actual-sync:latest
    container_name: actual-sync-service
    user: "1026:100"  # Important: Match your host user UID:GID
    volumes:
      - ./actual-sync/config.json:/app/config/config.json:ro
      - ./actual-sync/data:/app/data
      - ./actual-sync/logs:/app/logs
    environment:
      - TZ=Europe/Madrid
    depends_on:
      - actual-main
      - actual-secondary
    restart: unless-stopped
    networks:
      - actual-net
```

### Directory Structure

Create the following directory structure before running Docker Compose:

```bash
mkdir -p actual-sync/{data,logs}
```

Your final structure should look like:

```
.
├── docker-compose.yml
├── data-main/              # Actual Budget server 1 data
├── data-secondary/         # Actual Budget server 2 data
└── actual-sync/
    ├── config.json         # Actual-sync configuration
    ├── data/               # Sync data and database
    └── logs/               # Application logs
```

## Configuration

### Basic Configuration Example

Create `actual-sync/config.json`:

```json
{
  "$schema": "./config.schema.json",
  "servers": [
    {
      "name": "Budget 1",
      "url": "http://actual-main:5006",
      "password": "your_password_here",
      "syncId": "your_sync_id_here",
      "dataDir": "/app/data/budget1",
      "sync": {
        "schedule": "0 5 * * 2"
      }
    },
    {
      "name": "Budget 2",
      "url": "http://actual-main:5006",
      "password": "your_password_here",
      "syncId": "another_sync_id",
      "dataDir": "/app/data/budget2",
      "sync": {
        "schedule": "0 5 * * 1,3,5"
      }
    }
  ],
  "sync": {
    "maxRetries": 5,
    "baseRetryDelayMs": 3000
  },
  "logging": {
    "level": "INFO",
    "format": "pretty"
  },
  "healthCheck": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "syncHistory": {
    "dbPath": "data/sync-history.db",
    "retentionDays": 90
  },
  "prometheus": {
    "enabled": true,
    "includeDefaultMetrics": true
  },
  "notifications": {
    "telegram": {
      "enabled": true,
      "botToken": "YOUR_BOT_TOKEN",
      "chatId": "YOUR_CHAT_ID"
    }
  }
}
```

### Cron Schedule Format

The `schedule` field uses standard cron format: `minute hour day month weekday`

Common examples:
- `0 5 * * *` - Daily at 5:00am
- `0 5 * * 1` - Every Monday at 5:00am
- `0 5 * * 1,3,5` - Monday, Wednesday, Friday at 5:00am
- `30 5 * * 2,4` - Tuesday, Thursday at 5:30am
- `0 */6 * * *` - Every 6 hours

## Common Issues

### Issue 1: Permission Denied / Database Write Errors

**Symptom:**
```
Failed to initialize sync history database
unable to open database file
```

**Solution:**

The container runs as a non-root user (UID 1001 by default). You must either:

**Option A: Use the `user` directive (Recommended)**
```yaml
actual-sync:
  image: ghcr.io/agigante80/actual-sync:latest
  user: "1026:100"  # Your host user UID:GID
```

Find your UID and GID:
```bash
id -u  # Gets your UID
id -g  # Gets your GID
```

**Option B: Change directory ownership**
```bash
sudo chown -R 1001:1001 actual-sync/data actual-sync/logs
```

### Issue 2: Configuration Validation Errors

**Symptom:**
```
Server 1 (unnamed): Missing required field 'name'
```

**Solution:**

Ensure each server has all required fields:
- `name` - Display name for the budget
- `url` - Actual Budget server URL
- `password` - Server password
- `syncId` - Budget sync ID
- `dataDir` - Local data directory path

### Issue 3: Network Connectivity

**Symptom:**
Container can't reach Actual Budget servers.

**Solution:**

Ensure all services are on the same Docker network:
```yaml
networks:
  actual-net:
    name: actual-net

services:
  actual-sync:
    networks:
      - actual-net
```

Use service names (e.g., `http://actual-main:5006`) instead of `localhost`.

### Issue 4: Database Path Issues

**Symptom:**
```
unable to open database file
```

**Solution:**

Use relative paths in config for mounted volumes:
```json
{
  "syncHistory": {
    "dbPath": "data/sync-history.db"  // ✅ Relative path
    // NOT "/app/data/sync-history.db" ❌ Absolute path
  }
}
```

## Production Tips

### 1. Security

**Use Read-Only Config:**
```yaml
volumes:
  - ./actual-sync/config.json:/app/config/config.json:ro  # Note :ro flag
```

**Protect Sensitive Data:**
- Never commit `config.json` with real passwords to git
- Use `.gitignore`:
  ```
  actual-sync/config.json
  actual-sync/data/
  actual-sync/logs/
  ```

### 2. Monitoring

**Health Check Endpoint:**
```bash
curl http://localhost:3000/health
```

**Prometheus Metrics:**
```bash
curl http://localhost:9090/metrics
```

**View Logs:**
```bash
docker logs -f actual-sync-service
```

### 3. Notifications

**Telegram Setup:**
1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get your chat ID from [@userinfobot](https://t.me/userinfobot)
3. Add to config:
   ```json
   {
     "notifications": {
       "telegram": {
         "enabled": true,
         "botToken": "YOUR_BOT_TOKEN",
         "chatId": "YOUR_CHAT_ID"
       }
     }
   }
   ```

### 4. Resource Management

**Set Resource Limits:**
```yaml
actual-sync:
  image: ghcr.io/agigante80/actual-sync:latest
  deploy:
    resources:
      limits:
        cpus: '0.5'
        memory: 512M
      reservations:
        cpus: '0.25'
        memory: 256M
```

### 5. Logging

**Rotate Logs with Docker:**
```yaml
actual-sync:
  logging:
    driver: "json-file"
    options:
      max-size: "10m"
      max-file: "3"
```

### 6. Backup Strategy

**Regular Backups:**
```bash
# Backup sync history and data
tar -czf actual-sync-backup-$(date +%Y%m%d).tar.gz actual-sync/data/

# Backup configuration
cp actual-sync/config.json actual-sync/config.json.backup
```

### 7. Multiple Budgets on Same Server

Each budget on the same Actual Budget server needs a separate entry:

```json
{
  "servers": [
    {
      "name": "Personal Budget",
      "url": "http://actual-main:5006",
      "password": "same_password",
      "syncId": "sync_id_1",
      "dataDir": "/app/data/personal",
      "sync": { "schedule": "0 5 * * 1,3,5" }
    },
    {
      "name": "Family Budget",
      "url": "http://actual-main:5006",
      "password": "same_password",
      "syncId": "sync_id_2",
      "dataDir": "/app/data/family",
      "sync": { "schedule": "0 5 * * 2,4" }
    }
  ]
}
```

## Updating

### Pull Latest Image

```bash
docker compose pull actual-sync
docker compose up -d actual-sync
```

### View Release Notes

Check the [GitHub Releases](https://github.com/agigante80/Actual-sync/releases) page for changelogs and upgrade notes.

## Troubleshooting

### Enable Debug Logging

```json
{
  "logging": {
    "level": "DEBUG",
    "format": "pretty"
  }
}
```

### Check Container Status

```bash
docker compose ps
docker compose logs actual-sync
```

### Restart Service

```bash
docker compose restart actual-sync
```

### Clean Start

```bash
docker compose down
docker compose up -d
```

## Support

- **Documentation**: [README.md](../README.md)
- **Configuration**: [config/config.example.json](../config/config.example.json)
- **Issues**: [GitHub Issues](https://github.com/agigante80/Actual-sync/issues)
- **Security**: [SECURITY.md](../SECURITY.md)
