# Web Dashboard

The Actual-sync web dashboard provides real-time monitoring, manual sync controls, and interactive metrics visualization for your budget synchronization service.

## Overview

The dashboard is a single-page web application built into the health check service that offers:

- **Real-time System Status** - Live uptime, sync statistics, and service health
- **Server Management** - View all configured servers and their sync status
- **Manual Sync Controls** - Trigger syncs for all servers or individual servers
- **Live Log Streaming** - Real-time logs via WebSocket connection
- **Interactive Metrics** - Charts showing success rates, duration trends, and sync timelines
- **Sync History** - Detailed history of recent sync operations
- **Authentication** - Optional basic auth or token-based authentication

### Dashboard Preview

See [screenshots](screenshots/) directory for visual examples:
- Healthy system with multiple servers
- Degraded system with error tracking
- Multi-server setup (6+ instances)

**Regenerate screenshots:**
```bash
npm start  # Start service first
npm run screenshots  # Generate screenshots
```

## Accessing the Dashboard

### Default Access

By default, the dashboard is accessible at:

```
http://localhost:3000/dashboard
```

Or with your configured host/port:

```
http://<healthCheck.host>:<healthCheck.port>/dashboard
```

### Configuration

Configure the dashboard in `config/config.json`:

```json
{
  "healthCheck": {
    "port": 3000,
    "host": "0.0.0.0",
    "dashboard": {
      "enabled": true,
      "auth": {
        "type": "none"
      }
    }
  }
}
```

## Authentication

The dashboard supports three authentication types:

### No Authentication (Default)

```json
"dashboard": {
  "enabled": true,
  "auth": {
    "type": "none"
  }
}
```

**Warning**: Only use this on trusted networks. Consider adding authentication when exposing the dashboard over the internet.

### Basic Authentication

```json
"dashboard": {
  "enabled": true,
  "auth": {
    "type": "basic",
    "username": "admin",
    "password": "your-secure-password"
  }
}
```

Browser will prompt for credentials. Use the configured username and password to access the dashboard.

### Token Authentication

```json
"dashboard": {
  "enabled": true,
  "auth": {
    "type": "token",
    "token": "your-secret-bearer-token"
  }
}
```

Access requires sending the `Authorization: Bearer <token>` header. Useful for API clients or reverse proxies.

Example with curl:

```bash
curl -H "Authorization: Bearer your-secret-bearer-token" http://localhost:3000/api/dashboard/status
```

### Disabling the Dashboard

```json
"dashboard": {
  "enabled": false
}
```

All dashboard routes will return 403 Forbidden when disabled.

## Dashboard Features

### System Status

Displays at the top of the dashboard:

- **Version** - Current application version
- **Status** - Service health (HEALTHY, DEGRADED, UNHEALTHY)
- **Uptime** - How long the service has been running
- **Last Sync** - Time of most recent sync operation
- **Last Status** - Status of most recent sync

### Statistics

Real-time metrics:

- **Total Syncs** - Number of sync operations performed
- **Successful Syncs** - Syncs completed without errors
- **Failed Syncs** - Syncs that encountered errors
- **Success Rate** - Percentage of successful syncs

### Server List

Shows all configured servers with:

- Server name
- Last sync timestamp (relative time)
- Current status (✓ success, ✗ error, ⏸ pending)
- Manual sync button per server

### Manual Sync Controls

Two sync options:

1. **Sync All Servers** - Triggers sync for all configured servers
2. **Sync Individual Server** - Click button next to specific server

Sync operations run in the background. Status updates appear in real-time via WebSocket.

### Real-time Logs

Live log stream showing:

- Timestamp
- Log level (ERROR, WARN, INFO, DEBUG)
- Message
- Metadata (if present)

Logs are color-coded:
- **Red** - ERROR
- **Yellow** - WARN
- **Blue** - INFO
- **Gray** - DEBUG

Auto-scrolls to show latest entries. Keeps last 100 log entries.

### Metrics & Analytics

Three interactive charts powered by Chart.js:

#### 1. Success Rate by Server (Bar Chart)

Shows percentage of successful syncs for each server. Higher bars indicate more reliable syncs.

- **Green bars** - Success rate (0-100%)
- **Hover** - View exact percentage
- Updates every 30 seconds

#### 2. Sync Duration Trend (Line Chart)

Displays duration of recent syncs for each server over time.

- **Multiple lines** - One per server (color-coded)
- **Y-axis** - Duration in seconds
- **X-axis** - Recent sync operations
- **Hover** - View exact duration

Useful for identifying:
- Performance trends
- Slow syncs
- Server-specific issues

#### 3. Sync Status Timeline (Bar Chart)

Visual timeline of last 20 sync operations across all servers.

- **Green bars** - Successful syncs
- **Red bars** - Failed syncs
- **X-axis** - Time of sync
- **Hover** - View server name, status, duration

Provides at-a-glance view of sync health over time.

### Sync History Table

Detailed table of recent sync operations:

| Column | Description |
|--------|-------------|
| **Time** | When the sync occurred (relative time) |
| **Server** | Server name |
| **Status** | Success (✓ green) or Error (✗ red) |
| **Duration** | How long the sync took |
| **Accounts** | Number of accounts synced |

Refreshes every 60 seconds. Shows last 10 syncs by default.

## API Endpoints

The dashboard uses these authenticated API endpoints:

### GET /api/dashboard/status

Returns system status and statistics.

**Response:**
```json
{
  "status": "HEALTHY",
  "version": "1.2.3",
  "uptime": 86400,
  "sync": {
    "lastSyncTime": "2025-12-09T10:30:00.000Z",
    "lastSyncStatus": "success",
    "totalSyncs": 150,
    "successfulSyncs": 145,
    "failedSyncs": 5,
    "successRate": "96.67%"
  },
  "servers": [
    {
      "name": "Main Budget",
      "status": "success",
      "lastSync": "2025-12-09T10:30:00.000Z"
    }
  ]
}
```

### POST /api/dashboard/sync

Triggers a manual sync operation.

**Request Body:**
```json
{
  "server": "Main Budget"  // or "all" for all servers
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Sync triggered for Main Budget",
  "correlationId": "abc123-def456"
}
```

**Response (Error):**
```json
{
  "error": "Server not found",
  "availableServers": ["Main Budget", "Personal Budget"]
}
```

### GET /api/dashboard/history?limit=10

Returns recent sync history.

**Query Parameters:**
- `limit` (optional) - Number of records to return (default: 10)

**Response:**
```json
[
  {
    "timestamp": "2025-12-09T10:30:00.000Z",
    "serverName": "Main Budget",
    "status": "success",
    "duration": 5234,
    "accountsProcessed": 3,
    "accountsFailed": 0
  }
]
```

### GET /api/dashboard/metrics

Returns metrics for charts and analytics.

**Response:**
```json
{
  "overall": {
    "totalSyncs": 50,
    "successCount": 48,
    "failureCount": 2,
    "successRate": 0.96
  },
  "byServer": {
    "Main Budget": {
      "totalSyncs": 25,
      "successCount": 24,
      "failureCount": 1,
      "successRate": 0.96,
      "avgDuration": 5200,
      "recentSyncs": [...]
    }
  },
  "timeline": [...]
}
```

## WebSocket Connection

Real-time logs use WebSocket at `/ws/logs`.

### Connection

```javascript
const ws = new WebSocket('ws://localhost:3000/ws/logs');

ws.onmessage = (event) => {
  const log = JSON.parse(event.data);
  console.log(log);
};
```

### Message Format

```json
{
  "timestamp": "2025-12-09T10:30:00.000Z",
  "level": "INFO",
  "message": "Starting sync for server: Main Budget",
  "metadata": {
    "server": "Main Budget",
    "correlationId": "abc123-def456"
  }
}
```

### Welcome Message

Upon connection, the server sends:

```json
{
  "type": "welcome",
  "message": "Connected to Actual-sync log stream"
}
```

### Auto-Reconnect

Dashboard automatically reconnects on disconnect with exponential backoff (max 5 attempts).

## Docker Deployment

When running in Docker, expose the dashboard port:

```bash
docker run -d \
  -p 3000:3000 \
  -v ./config:/app/config:ro \
  -v ./data:/app/data \
  -v ./logs:/app/logs \
  agigante80/actual-sync:latest
```

Access at: `http://localhost:3000/dashboard`

### Docker Compose

```yaml
services:
  actual-sync:
    image: agigante80/actual-sync:latest
    ports:
      - "3000:3000"
    volumes:
      - ./config:/app/config:ro
      - ./data:/app/data
      - ./logs:/app/logs
```

## Reverse Proxy Setup

### Nginx

```nginx
server {
    listen 80;
    server_name sync.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Traefik

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.actual-sync.rule=Host(`sync.example.com`)"
  - "traefik.http.services.actual-sync.loadbalancer.server.port=3000"
```

## Security Best Practices

1. **Enable Authentication** - Always use basic auth or token auth when exposing the dashboard publicly
2. **Use HTTPS** - Configure reverse proxy with TLS/SSL certificates
3. **Restrict Access** - Use firewall rules or Docker network isolation to limit access
4. **Strong Credentials** - Use long, random passwords or tokens
5. **Regular Updates** - Keep Actual-sync updated for security patches
6. **Monitor Logs** - Watch for failed authentication attempts

### Example: Secure Configuration

```json
{
  "healthCheck": {
    "port": 3000,
    "host": "127.0.0.1",  // Only local access
    "dashboard": {
      "enabled": true,
      "auth": {
        "type": "token",
        "token": "32-character-random-token-here"  // Generate with: openssl rand -hex 16
      }
    }
  }
}
```

Access via reverse proxy only:
- Bind to localhost (127.0.0.1)
- Use token authentication
- Nginx/Traefik handles HTTPS and external access

## Troubleshooting

### Dashboard Not Loading

1. Check service is running: `docker ps` or `systemctl status actual-sync`
2. Verify port is open: `curl http://localhost:3000/health`
3. Check logs: `docker logs actual-sync` or `/app/logs/actual-sync-*.log`
4. Ensure `dashboard.enabled: true` in config

### Authentication Issues

1. Verify credentials in `config.json`
2. Clear browser cache and cookies
3. Check logs for authentication failures
4. For token auth, ensure `Authorization: Bearer <token>` header is sent

### Charts Not Displaying

1. Check browser console for JavaScript errors
2. Verify `/api/dashboard/metrics` returns data
3. Ensure Prometheus service is enabled in config
4. Check sync history has data: `npm run history`

### WebSocket Connection Failing

1. Verify WebSocket endpoint: `ws://localhost:3000/ws/logs`
2. Check firewall allows WebSocket connections
3. If behind reverse proxy, ensure WebSocket upgrade headers are passed
4. Check browser console for connection errors

### No Sync History

1. Verify sync operations have run
2. Check SQLite database exists: `data/sync-history.db`
3. Run manual sync to generate data
4. Check sync history service is initialized

## Performance

The dashboard is optimized for performance:

- **Auto-refresh Intervals**:
  - Status: Every 30 seconds
  - History: Every 60 seconds
  - Charts: Every 30 seconds
- **Log Buffer**: Last 100 entries kept in memory
- **Chart Updates**: In-place updates without re-rendering
- **WebSocket**: Only broadcasts when logs are generated
- **Rate Limiting**: 60 requests per minute per IP

For high-traffic scenarios, consider:
- Increasing refresh intervals
- Reducing chart data points
- Using authentication to limit access

## Browser Support

Dashboard works in all modern browsers:

- ✅ Chrome 90+
- ✅ Firefox 88+
- ✅ Safari 14+
- ✅ Edge 90+

Requires:
- WebSocket support
- ES6 JavaScript
- CSS Grid
- Fetch API

## Related Documentation

- [Health Check](HEALTH_CHECK.md) - Health check endpoints
- [Prometheus Metrics](PROMETHEUS.md) - Metrics configuration
- [Logging](LOGGING.md) - Log configuration
- [Configuration](CONFIG.md) - Full configuration reference
- [Docker Deployment](DOCKER_DEPLOYMENT.md) - Docker setup guide
