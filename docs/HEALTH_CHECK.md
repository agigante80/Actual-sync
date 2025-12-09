# Health Check Endpoints

## Overview

The health check service provides HTTP endpoints for monitoring the Actual-sync service status. These endpoints enable integration with monitoring systems, load balancers, and container orchestration platforms.

## Features

- **Simple health check**: Basic alive/dead status
- **Detailed metrics**: Sync statistics and success rates
- **Readiness probe**: Kubernetes-compatible readiness endpoint
- **Per-server tracking**: Individual server sync statuses
- **Automatic updates**: Status updated after each sync operation

## Configuration

Health check endpoints are configured in `config/config.json`:

```json
{
  "healthCheck": {
    "port": 3000,
    "host": "0.0.0.0"
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | integer | `3000` | HTTP port for health check endpoints (1024-65535) |
| `host` | string | `"0.0.0.0"` | Host to bind the server (use `"127.0.0.1"` for localhost only) |

## Endpoints

### GET /health

Basic health check endpoint that returns if the service is running.

**Response:**
```json
{
  "status": "UP",
  "timestamp": "2025-12-05T10:30:00.000Z",
  "uptime": 3600,
  "service": "actual-sync"
}
```

**Status Codes:**
- `200 OK`: Service is running

**Use Case:** Simple alive check for load balancers or monitoring tools.

### GET /metrics

Detailed metrics endpoint with sync statistics and per-server status.

**Response:**
```json
{
  "status": "HEALTHY",
  "timestamp": "2025-12-05T10:30:00.000Z",
  "uptime": 3600,
  "service": "actual-sync",
  "sync": {
    "lastSyncTime": "2025-12-05T10:25:00.000Z",
    "lastSyncStatus": "success",
    "totalSyncs": 15,
    "successfulSyncs": 14,
    "failedSyncs": 1,
    "successRate": "93.33%"
  },
  "servers": {
    "Main": {
      "lastSync": "2025-12-05T10:25:00.000Z",
      "status": "success"
    },
    "Secondary": {
      "lastSync": "2025-12-05T10:25:00.000Z",
      "status": "success"
    }
  },
  "lastError": null
}
```

**Status Values:**
- `PENDING`: No syncs performed yet
- `HEALTHY`: Service operating normally (>50% success rate and last sync successful)
- `DEGRADED`: Service partially functional (>50% failure rate)
- `UNHEALTHY`: Service experiencing issues (100% failure rate)

**Status Codes:**
- `200 OK`: Always returns 200 (check `status` field for health)

**Use Case:** Detailed monitoring, alerting on degraded performance, tracking sync history.

### GET /ready

Readiness probe endpoint for Kubernetes and container orchestration.

**Response (Ready):**
```json
{
  "status": "READY",
  "timestamp": "2025-12-05T10:30:00.000Z"
}
```

**Response (Not Ready):**
```json
{
  "status": "NOT_READY",
  "timestamp": "2025-12-05T10:30:00.000Z",
  "reason": "No successful syncs yet"
}
```

**Status Codes:**
- `200 OK`: Service is ready to handle requests
- `503 Service Unavailable`: Service not ready yet

**Use Case:** Kubernetes readiness probes, startup checks.

## Integration Examples

### Docker Healthcheck

Add to your `Dockerfile`:

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
```

### Kubernetes Probes

Add to your Kubernetes deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: actual-sync
spec:
  template:
    spec:
      containers:
      - name: actual-sync
        image: actual-sync:latest
        ports:
        - containerPort: 3000
          name: health
        livenessProbe:
          httpGet:
            path: /health
            port: health
          initialDelaySeconds: 30
          periodSeconds: 30
          timeoutSeconds: 3
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /ready
            port: health
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 3
          failureThreshold: 3
```

### Prometheus Monitoring

The `/metrics` endpoint can be scraped by Prometheus. Example scrape config:

```yaml
scrape_configs:
  - job_name: 'actual-sync'
    static_configs:
      - targets: ['actual-sync:3000']
    metrics_path: '/metrics'
    scrape_interval: 30s
```

You'll need to convert the JSON response to Prometheus format using a JSON exporter or custom script.

### Docker Compose

```yaml
version: '3.8'
services:
  actual-sync:
    image: actual-sync:latest
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 40s
```

### Uptime Monitoring (Uptime Robot, Pingdom)

Configure HTTP monitoring:
- **URL**: `http://your-server:3000/health`
- **Expected Status**: `200`
- **Expected Content**: `"status":"UP"`
- **Interval**: Every 5 minutes

For detailed monitoring:
- **URL**: `http://your-server:3000/metrics`
- **Expected Status**: `200`
- **Expected Content**: `"status":"HEALTHY"`

### Shell Script Monitoring

```bash
#!/bin/bash
# check_health.sh

RESPONSE=$(curl -s http://localhost:3000/metrics)
STATUS=$(echo "$RESPONSE" | jq -r '.status')

case "$STATUS" in
  "HEALTHY"|"PENDING")
    echo "✓ Service is healthy"
    exit 0
    ;;
  "DEGRADED")
    echo "⚠ Service is degraded"
    exit 1
    ;;
  "UNHEALTHY")
    echo "✗ Service is unhealthy"
    exit 2
    ;;
  *)
    echo "? Unknown status: $STATUS"
    exit 3
    ;;
esac
```

### Alerting Rules

Example alerting logic based on metrics:

```bash
# Alert if service is unhealthy
if [ "$(curl -s http://localhost:3000/metrics | jq -r '.status')" == "UNHEALTHY" ]; then
  send_alert "Actual-sync is UNHEALTHY"
fi

# Alert if success rate drops below 80%
SUCCESS_RATE=$(curl -s http://localhost:3000/metrics | jq -r '.sync.successRate' | sed 's/%//')
if (( $(echo "$SUCCESS_RATE < 80" | bc -l) )); then
  send_alert "Actual-sync success rate is $SUCCESS_RATE%"
fi

# Alert if no syncs in last hour
LAST_SYNC=$(curl -s http://localhost:3000/metrics | jq -r '.sync.lastSyncTime')
if [ -n "$LAST_SYNC" ]; then
  LAST_SYNC_TS=$(date -d "$LAST_SYNC" +%s)
  NOW_TS=$(date +%s)
  DIFF=$(( NOW_TS - LAST_SYNC_TS ))
  if (( DIFF > 3600 )); then
    send_alert "No sync in last hour (last: $LAST_SYNC)"
  fi
fi
```

## Accessing Endpoints

### Using curl

```bash
# Basic health check
curl http://localhost:3000/health

# Detailed metrics
curl http://localhost:3000/metrics

# Pretty-print with jq
curl -s http://localhost:3000/metrics | jq

# Check specific status
curl -s http://localhost:3000/metrics | jq -r '.status'

# Check success rate
curl -s http://localhost:3000/metrics | jq -r '.sync.successRate'

# Readiness check
curl http://localhost:3000/ready
```

### Using httpie

```bash
# Basic health check
http :3000/health

# Detailed metrics
http :3000/metrics

# Readiness check
http :3000/ready
```

### Using wget

```bash
wget -qO- http://localhost:3000/health
wget -qO- http://localhost:3000/metrics
```

## Security Considerations

### Network Exposure

By default, the health check service binds to `0.0.0.0` (all interfaces). Consider these options:

1. **Internal Only**: Set `host` to `"127.0.0.1"` if only local access is needed
2. **Firewall**: Restrict access to health check port (3000) to monitoring systems only
3. **Reverse Proxy**: Put behind nginx/Apache with authentication if exposed to internet

### Sensitive Information

The `/metrics` endpoint exposes:
- Server names (from your configuration)
- Sync timing information
- Error messages (which might contain server details)

**Recommendations:**
- Don't expose health check endpoints to the public internet
- Use firewall rules to restrict access to monitoring systems
- Consider adding authentication if external access is required

### Docker Example with Restricted Access

```yaml
services:
  actual-sync:
    image: actual-sync:latest
    # Only expose health check to localhost
    ports:
      - "127.0.0.1:3000:3000"
```

## Troubleshooting

### Port Already in Use

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3000
```

**Solution:** Change the port in `config/config.json`:
```json
{
  "healthCheck": {
    "port": 3001
  }
}
```

### Cannot Connect

```
curl: (7) Failed to connect to localhost port 3000: Connection refused
```

**Possible Causes:**
1. Service not started
2. Health check service failed to start (check logs)
3. Firewall blocking the port
4. Wrong host binding (check `host` setting)

**Debug:**
```bash
# Check if service is listening
netstat -tulpn | grep 3000

# Check logs for errors
tail -f logs/app-2025-12-05.log
```

### 404 Not Found

```
{"error":"Not Found","availableEndpoints":["/health","/metrics","/ready"]}
```

**Solution:** Use one of the available endpoints: `/health`, `/metrics`, or `/ready`

## Best Practices

1. **Regular Monitoring**: Check `/metrics` every 30-60 seconds
2. **Alert Thresholds**: Alert when status is `DEGRADED` or `UNHEALTHY`
3. **Grace Period**: Allow 60 seconds after startup before alerting
4. **Multiple Checks**: Monitor both `/health` (liveness) and `/ready` (readiness)
5. **Historical Tracking**: Log metrics over time to identify patterns
6. **Container Readiness**: Use `/ready` for container orchestration readiness probes
7. **Load Balancer Health**: Use `/health` for simple load balancer health checks

## API Reference

### Health Response Object

```typescript
interface HealthResponse {
  status: "UP";
  timestamp: string;        // ISO 8601 timestamp
  uptime: number;          // Seconds since service start
  service: "actual-sync";
}
```

### Metrics Response Object

```typescript
interface MetricsResponse {
  status: "PENDING" | "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  timestamp: string;
  uptime: number;
  service: "actual-sync";
  sync: {
    lastSyncTime: string | null;
    lastSyncStatus: "pending" | "success" | "failure";
    totalSyncs: number;
    successfulSyncs: number;
    failedSyncs: number;
    successRate: string;    // e.g., "93.33%" or "N/A"
  };
  servers: {
    [serverName: string]: {
      lastSync: string;
      status: "success" | "failure";
      error?: string;
    };
  };
  lastError: {
    message: string;
    timestamp: string;
    serverName: string;
  } | null;
}
```

### Ready Response Object

```typescript
interface ReadyResponse {
  status: "READY" | "NOT_READY";
  timestamp: string;
  reason?: string;          // Present when NOT_READY
}
```

---

## WebSocket Real-Time Logs

The health check service provides WebSocket endpoint for streaming real-time logs to dashboard clients.

### WS /ws/logs

Real-time log streaming via WebSocket connection.

**Connection:**
```javascript
const ws = new WebSocket('ws://localhost:3000/ws/logs');
```

**Message Format (Received):**
```json
{
  "level": "INFO",
  "message": "Starting sync for server: Main Budget",
  "metadata": {
    "server": "Main Budget",
    "correlationId": "abc123-def456"
  },
  "timestamp": "2025-12-09T10:30:00.000Z"
}
```

**Keep-Alive (Client → Server):**
```json
{ "type": "ping" }
```

**Keep-Alive Response (Server → Client):**
```json
{
  "type": "pong",
  "timestamp": "2025-12-09T10:30:00.000Z"
}
```

### WebSocket Features

- **Infinite Reconnection**: Automatically reconnects with exponential backoff (1s to 30s cap)
- **Keep-Alive**: Ping/pong every 30 seconds to detect dead connections
- **Pause on Hidden**: Stops streaming when browser tab is hidden (saves resources)
- **Memory Efficient**: Ring buffer stores up to 500 logs, displays last 200
- **Broadcast to All**: All connected clients receive the same log stream

### Connection Behavior

1. **Initial Connection**: Client connects and receives welcome message
2. **Log Streaming**: All logs are broadcast to connected clients in real-time
3. **Keep-Alive**: Client sends ping every 30s, server responds with pong
4. **Timeout Detection**: If no pong received within 60s, client reconnects
5. **Auto-Reconnect**: On disconnect, client retries with exponential backoff
6. **Tab Visibility**: Streaming pauses when tab is hidden, resumes when visible

### Long-Running Stability

The WebSocket implementation is designed for 24/7 operation:

- ✅ **No memory leaks**: Ring buffer prevents unbounded memory growth
- ✅ **Infinite retry**: Never stops trying to reconnect
- ✅ **Connection monitoring**: Keep-alive detects silent failures
- ✅ **Resource efficiency**: Pauses when not needed
- ✅ **Batch DOM updates**: Reduces CPU usage and browser lag

### Example Usage

```javascript
const ws = new WebSocket('ws://localhost:3000/ws/logs');

ws.onopen = () => {
  console.log('Connected to log stream');
  
  // Start keep-alive
  setInterval(() => {
    ws.send(JSON.stringify({ type: 'ping' }));
  }, 30000);
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'pong') {
    console.log('Keep-alive pong received');
    return;
  }
  
  // Handle log message
  console.log(`[${data.level}] ${data.message}`);
};

ws.onclose = () => {
  console.log('Disconnected, reconnecting...');
  setTimeout(connect, 3000); // Reconnect after 3 seconds
};
```
