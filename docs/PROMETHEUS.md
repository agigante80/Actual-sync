# Prometheus Metrics Export

This document describes the Prometheus metrics export feature that enables comprehensive monitoring and observability for Actual-sync.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Configuration](#configuration)
- [Available Metrics](#available-metrics)
- [Accessing Metrics](#accessing-metrics)
- [Prometheus Setup](#prometheus-setup)
- [Grafana Dashboard](#grafana-dashboard)
- [Alerting Examples](#alerting-examples)
- [Troubleshooting](#troubleshooting)

## Overview

Actual-sync exposes Prometheus-compatible metrics that provide detailed insights into:

- Sync operation performance and reliability
- Account processing success rates
- Error patterns and distributions
- Node.js runtime health (memory, CPU, event loop)
- Historical success rates per server

These metrics enable:
- Real-time monitoring dashboards
- Automated alerting on failures
- Performance trend analysis
- Capacity planning

## Features

### Application Metrics

- **Sync Duration**: Histogram of sync operation durations with percentile tracking
- **Sync Total Counter**: Total number of syncs by server and status
- **Accounts Processed**: Number of accounts successfully synced
- **Accounts Failed**: Number of accounts that failed to sync
- **Last Sync Timestamp**: Unix timestamp of last sync per server
- **Success Rate**: Success rate per server (calculated from history)
- **Error Distribution**: Count of errors by server and error code
- **Application Info**: Version and Node.js version labels

### Node.js Runtime Metrics

When `includeDefaultMetrics` is enabled (default: true):

- **Memory Usage**: Heap and RSS memory metrics
- **CPU Usage**: Process CPU time
- **Event Loop Lag**: Event loop delay metrics
- **Garbage Collection**: GC duration and frequency
- **Active Handles**: Open file descriptors and sockets

## Configuration

Add the `prometheus` section to your `config.json`:

```json
{
  "prometheus": {
    "enabled": true,
    "includeDefaultMetrics": true
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable Prometheus metrics export |
| `includeDefaultMetrics` | boolean | `true` | Include Node.js runtime metrics |

## Available Metrics

### Custom Application Metrics

#### `actual_sync_duration_seconds`

**Type**: Histogram  
**Labels**: `server`, `status`  
**Description**: Duration of sync operations in seconds

Buckets: `[1, 5, 10, 30, 60, 120, 300, 600]` (1s to 10min)

Use for:
- Tracking performance trends
- Identifying slow syncs
- Setting SLOs

Example queries:
```promql
# Average sync duration (5m)
rate(actual_sync_duration_seconds_sum[5m]) / rate(actual_sync_duration_seconds_count[5m])

# 95th percentile duration
histogram_quantile(0.95, rate(actual_sync_duration_seconds_bucket[5m]))

# Max duration in last hour
max_over_time(actual_sync_duration_seconds_sum[1h])
```

#### `actual_sync_total`

**Type**: Counter  
**Labels**: `server`, `status`  
**Description**: Total number of sync operations

Use for:
- Tracking sync frequency
- Success vs failure rates
- Volume trending

Example queries:
```promql
# Sync rate per hour
rate(actual_sync_total[1h])

# Total syncs by status
sum by (status) (actual_sync_total)

# Failed syncs in last 24h
increase(actual_sync_total{status="error"}[24h])
```

#### `actual_sync_accounts_processed`

**Type**: Gauge  
**Labels**: `server`  
**Description**: Number of accounts successfully processed in last sync

Use for:
- Monitoring data volume
- Detecting incomplete syncs
- Capacity planning

Example queries:
```promql
# Total accounts processed
sum(actual_sync_accounts_processed)

# Accounts per server
actual_sync_accounts_processed

# Change in accounts over time
delta(actual_sync_accounts_processed[1h])
```

#### `actual_sync_accounts_failed`

**Type**: Gauge  
**Labels**: `server`  
**Description**: Number of accounts that failed in last sync

Use for:
- Identifying problematic accounts
- Quality monitoring
- Alert triggering

Example queries:
```promql
# Any failures
actual_sync_accounts_failed > 0

# Total failures across servers
sum(actual_sync_accounts_failed)

# Failure ratio
actual_sync_accounts_failed / (actual_sync_accounts_processed + actual_sync_accounts_failed)
```

#### `actual_sync_last_sync_timestamp`

**Type**: Gauge  
**Labels**: `server`, `status`  
**Description**: Unix timestamp of last sync operation

Use for:
- Detecting stalled syncs
- Monitoring sync frequency
- Alerting on delays

Example queries:
```promql
# Time since last successful sync (seconds)
time() - actual_sync_last_sync_timestamp{status="success"}

# Servers with no recent sync (>2 hours)
(time() - actual_sync_last_sync_timestamp{status="success"}) > 7200

# Minutes since last sync
(time() - actual_sync_last_sync_timestamp{status="success"}) / 60
```

#### `actual_sync_success_rate`

**Type**: Gauge  
**Labels**: `server`  
**Description**: Success rate of sync operations (0-1)

Calculated from sync history. Updated before metrics are exported.

Use for:
- SLO tracking
- Quality monitoring
- Comparative analysis

Example queries:
```promql
# Current success rate (percentage)
actual_sync_success_rate * 100

# Servers below 95% success
actual_sync_success_rate < 0.95

# Average success rate
avg(actual_sync_success_rate)
```

#### `actual_sync_errors_total`

**Type**: Gauge  
**Labels**: `server`, `error_code`  
**Description**: Total number of sync errors by type

Use for:
- Error pattern analysis
- Root cause investigation
- Alert routing

Example queries:
```promql
# Errors by code
sum by (error_code) (actual_sync_errors_total)

# Rate limit errors
actual_sync_errors_total{error_code="RATE_LIMIT"}

# Top error codes
topk(5, sum by (error_code) (actual_sync_errors_total))
```

#### `actual_sync_info`

**Type**: Gauge  
**Labels**: `version`, `node_version`  
**Description**: Application metadata (always 1)

Use for:
- Version tracking
- Deployment verification
- Runtime information

Example query:
```promql
# Application version
actual_sync_info
```

### Default Node.js Metrics

When `includeDefaultMetrics: true`:

- `process_cpu_user_seconds_total` - CPU time in user mode
- `process_cpu_system_seconds_total` - CPU time in system mode
- `process_resident_memory_bytes` - Resident memory size
- `nodejs_heap_size_total_bytes` - Total heap size
- `nodejs_heap_size_used_bytes` - Used heap size
- `nodejs_external_memory_bytes` - External memory (C++ objects)
- `nodejs_eventloop_lag_seconds` - Event loop lag
- `nodejs_active_handles_total` - Active handles
- `nodejs_active_requests_total` - Active requests
- `nodejs_gc_duration_seconds` - GC duration by type

See [prom-client documentation](https://github.com/siimon/prom-client#default-metrics) for complete list.

## Accessing Metrics

Metrics are exposed via HTTP endpoint at `/metrics/prometheus` on the health check port (default: 3000).

### Curl Example

```bash
curl http://localhost:3000/metrics/prometheus
```

### Response Format

Prometheus text format:

```
# HELP actual_sync_duration_seconds Duration of sync operations in seconds
# TYPE actual_sync_duration_seconds histogram
actual_sync_duration_seconds_bucket{server="Main",status="success",le="1"} 0
actual_sync_duration_seconds_bucket{server="Main",status="success",le="5"} 2
actual_sync_duration_seconds_bucket{server="Main",status="success",le="10"} 5
actual_sync_duration_seconds_bucket{server="Main",status="success",le="+Inf"} 5
actual_sync_duration_seconds_sum{server="Main",status="success"} 28.5
actual_sync_duration_seconds_count{server="Main",status="success"} 5

# HELP actual_sync_total Total number of sync operations
# TYPE actual_sync_total counter
actual_sync_total{server="Main",status="success"} 42
actual_sync_total{server="Main",status="error"} 3

# HELP actual_sync_success_rate Success rate of sync operations (0-1)
# TYPE actual_sync_success_rate gauge
actual_sync_success_rate{server="Main"} 0.9333333333333333
```

### Verify Metrics

Check that metrics are accessible:

```bash
# Test endpoint
curl -s http://localhost:3000/metrics/prometheus | grep actual_sync_

# Count metrics
curl -s http://localhost:3000/metrics/prometheus | grep "^actual_sync_" | wc -l

# View specific metric
curl -s http://localhost:3000/metrics/prometheus | grep actual_sync_total
```

## Prometheus Setup

### 1. Install Prometheus

#### Docker

```bash
docker run -d \
  --name prometheus \
  -p 9090:9090 \
  -v $(pwd)/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus
```

#### Docker Compose

Add to `docker-compose.yml`:

```yaml
services:
  actual-sync:
    # ... existing config ...

  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    restart: unless-stopped
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=30d'
    networks:
      - actual-network

volumes:
  prometheus-data:

networks:
  actual-network:
    driver: bridge
```

### 2. Configure Prometheus

Create `prometheus.yml`:

```yaml
global:
  scrape_interval: 30s
  evaluation_interval: 30s
  scrape_timeout: 10s

scrape_configs:
  - job_name: 'actual-sync'
    static_configs:
      - targets: ['actual-sync:3000']
    metrics_path: '/metrics/prometheus'
    scrape_interval: 30s
```

For multiple instances:

```yaml
scrape_configs:
  - job_name: 'actual-sync'
    static_configs:
      - targets: 
          - 'actual-sync-1:3000'
          - 'actual-sync-2:3000'
          - 'actual-sync-3:3000'
        labels:
          environment: 'production'
    metrics_path: '/metrics/prometheus'
```

### 3. Verify Scraping

1. Open Prometheus UI: `http://localhost:9090`
2. Go to Status → Targets
3. Verify `actual-sync` target shows "UP"
4. Test query: `actual_sync_total`

### 4. Basic Queries

Try these queries in Prometheus:

```promql
# Current success rate
actual_sync_success_rate

# Syncs in last hour
increase(actual_sync_total[1h])

# Average sync duration
rate(actual_sync_duration_seconds_sum[5m]) / rate(actual_sync_duration_seconds_count[5m])

# Failed syncs
actual_sync_total{status="error"}

# Time since last sync
time() - actual_sync_last_sync_timestamp{status="success"}
```

## Grafana Dashboard

### 1. Install Grafana

#### Docker

```bash
docker run -d \
  --name=grafana \
  -p 3001:3000 \
  -v grafana-storage:/var/lib/grafana \
  grafana/grafana
```

#### Docker Compose

Add to `docker-compose.yml`:

```yaml
services:
  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    restart: unless-stopped
    ports:
      - "3001:3000"
    volumes:
      - grafana-data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_INSTALL_PLUGINS=
    networks:
      - actual-network
    depends_on:
      - prometheus

volumes:
  grafana-data:
```

### 2. Add Prometheus Data Source

1. Open Grafana: `http://localhost:3001` (admin/admin)
2. Go to Configuration → Data Sources
3. Click "Add data source"
4. Select "Prometheus"
5. Set URL: `http://prometheus:9090` (or `http://localhost:9090` if not using Docker network)
6. Click "Save & Test"

### 3. Import Dashboard

We provide a pre-built dashboard in `grafana-dashboard.json`:

1. Go to Dashboards → Import
2. Upload `grafana-dashboard.json`
3. Select Prometheus data source
4. Click "Import"

The dashboard includes:

- **Overview Stats**: Total syncs, success rate, accounts processed/failed
- **Sync Duration Graph**: Average duration over time with percentiles
- **Sync Rate**: Syncs per hour by status
- **Success vs Failure**: Running totals
- **Error Distribution**: Table of errors by server and code
- **Time Since Last Sync**: Staleness monitoring with alert
- **Node.js Metrics**: Memory usage and event loop lag

### 4. Custom Panels

Add custom panels for your specific needs:

#### Panel: Sync Success Rate Gauge

```json
{
  "type": "gauge",
  "targets": [{
    "expr": "actual_sync_success_rate * 100"
  }],
  "options": {
    "unit": "percent",
    "min": 0,
    "max": 100,
    "thresholds": {
      "mode": "absolute",
      "steps": [
        {"value": 0, "color": "red"},
        {"value": 90, "color": "yellow"},
        {"value": 95, "color": "green"}
      ]
    }
  }
}
```

#### Panel: Recent Errors Table

```json
{
  "type": "table",
  "targets": [{
    "expr": "topk(10, actual_sync_errors_total)",
    "format": "table",
    "instant": true
  }]
}
```

## Alerting Examples

### Prometheus Alerts

Create `alerts.yml`:

```yaml
groups:
  - name: actual-sync
    interval: 60s
    rules:
      # No sync in 2 hours
      - alert: SyncDelayed
        expr: (time() - actual_sync_last_sync_timestamp{status="success"}) > 7200
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Sync delayed for {{ $labels.server }}"
          description: "No successful sync in over 2 hours"

      # Low success rate
      - alert: LowSuccessRate
        expr: actual_sync_success_rate < 0.8
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Low success rate for {{ $labels.server }}"
          description: "Success rate is {{ $value | humanizePercentage }}"

      # High failure count
      - alert: HighFailureCount
        expr: increase(actual_sync_total{status="error"}[1h]) > 5
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High failure count for {{ $labels.server }}"
          description: "{{ $value }} failures in last hour"

      # Accounts failing to sync
      - alert: AccountSyncFailures
        expr: actual_sync_accounts_failed > 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Account sync failures on {{ $labels.server }}"
          description: "{{ $value }} accounts failed to sync"

      # Slow sync operations
      - alert: SlowSync
        expr: rate(actual_sync_duration_seconds_sum[5m]) / rate(actual_sync_duration_seconds_count[5m]) > 60
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Slow sync operations for {{ $labels.server }}"
          description: "Average sync duration is {{ $value }}s"

      # High memory usage
      - alert: HighMemoryUsage
        expr: process_resident_memory_bytes > 512000000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage"
          description: "Memory usage is {{ $value | humanize }}B"

      # Event loop lag
      - alert: HighEventLoopLag
        expr: rate(nodejs_eventloop_lag_seconds[1m]) > 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High event loop lag"
          description: "Event loop lag is {{ $value }}s"
```

Add to `prometheus.yml`:

```yaml
rule_files:
  - 'alerts.yml'

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']
```

### Grafana Alerts

Configure alerts in Grafana dashboard panels:

1. Edit panel
2. Click Alert tab
3. Create alert rule
4. Configure notification channel

Example: Alert when no sync in 2 hours

- **Condition**: `WHEN last() OF query(A, 5m, now) IS ABOVE 7200`
- **Query**: `time() - actual_sync_last_sync_timestamp{status="success"}`
- **Frequency**: Every 60s
- **For**: 5m

## Troubleshooting

### Metrics Not Available

**Problem**: `/metrics/prometheus` returns 503

**Solutions**:

1. Check Prometheus service is enabled:
   ```json
   "prometheus": {"enabled": true}
   ```

2. Restart the service:
   ```bash
   npm start
   ```

3. Check logs for errors:
   ```bash
   # Check for Prometheus initialization
   grep "Prometheus metrics service" logs/*.log
   ```

### Empty Metrics

**Problem**: Endpoint works but no `actual_sync_*` metrics

**Solutions**:

1. Wait for first sync to complete (metrics recorded on sync)

2. Manually record a test metric:
   ```bash
   # This will trigger health check
   curl http://localhost:3000/health
   ```

3. Check sync history:
   ```bash
   npm run history -- --days 1
   ```

### Prometheus Not Scraping

**Problem**: Target shows "DOWN" in Prometheus

**Solutions**:

1. Verify connectivity:
   ```bash
   # From Prometheus container
   curl http://actual-sync:3000/metrics/prometheus
   ```

2. Check firewall/network:
   ```bash
   # Test port
   telnet actual-sync 3000
   ```

3. Verify metrics path in `prometheus.yml`:
   ```yaml
   metrics_path: '/metrics/prometheus'  # Correct
   ```

4. Check Prometheus logs:
   ```bash
   docker logs prometheus
   ```

### High Cardinality

**Problem**: Too many unique metric label combinations

**Solutions**:

1. Limit number of servers (each server = new label value)

2. Disable default metrics if not needed:
   ```json
   "prometheus": {
     "enabled": true,
     "includeDefaultMetrics": false
   }
   ```

3. Monitor cardinality:
   ```promql
   # Count series
   count({__name__=~"actual_sync_.*"})
   
   # Count by metric
   count by (__name__) ({__name__=~"actual_sync_.*"})
   ```

### Missing Historical Data

**Problem**: `actual_sync_success_rate` is 0 or missing

**Solutions**:

1. Ensure sync history is enabled and has data:
   ```bash
   npm run history -- --stats
   ```

2. Check sync history database:
   ```bash
   ls -lh data/sync-history.db
   ```

3. Verify `updateFromHistory()` is called:
   ```bash
   # Check logs
   grep "updated from history" logs/*.log
   ```

### Dashboard Not Loading

**Problem**: Grafana dashboard shows "No data"

**Solutions**:

1. Verify Prometheus data source connection

2. Check time range (default: last 6 hours)

3. Test query directly in Prometheus:
   ```promql
   actual_sync_total
   ```

4. Adjust dashboard queries if server labels differ

5. Check for data:
   ```promql
   # Any actual-sync metrics
   {__name__=~"actual_sync_.*"}
   ```

## Best Practices

1. **Set reasonable scrape intervals**
   - 30s for most cases
   - 10s for real-time monitoring
   - 60s for low-frequency syncs

2. **Configure retention**
   - Prometheus: 30-90 days typical
   - Sync history: Match or exceed Prometheus

3. **Use recording rules** for expensive queries:
   ```yaml
   groups:
     - name: actual-sync-recordings
       interval: 60s
       rules:
         - record: job:actual_sync_duration_seconds:avg5m
           expr: rate(actual_sync_duration_seconds_sum[5m]) / rate(actual_sync_duration_seconds_count[5m])
   ```

4. **Label consistently**
   - Keep server names short and alphanumeric
   - Avoid spaces in labels
   - Use lowercase

5. **Alert on symptoms, not causes**
   - ✅ "Sync taking too long"
   - ❌ "CPU usage high"

6. **Set up dashboards before production**
   - Test with historical data
   - Verify all panels load
   - Configure alerting

7. **Monitor metrics cardinality**
   - Track series count
   - Alert on rapid growth
   - Review label usage

## Related Documentation

- [HEALTH_CHECK.md](./HEALTH_CHECK.md) - Health check endpoint documentation
- [SYNC_HISTORY.md](./SYNC_HISTORY.md) - Sync history persistence
- [NOTIFICATIONS.md](./NOTIFICATIONS.md) - Error notification system
- [DOCKER.md](./DOCKER.md) - Docker deployment guide

## References

- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
- [prom-client Library](https://github.com/siimon/prom-client)
- [PromQL Guide](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/naming/)
