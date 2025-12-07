# Sync History

## Overview

The sync history feature tracks all sync operations in a SQLite database, providing a queryable historical record for analysis, troubleshooting, and monitoring.

## Features

- **Persistent Storage**: All sync attempts stored in SQLite database
- **Rich Metadata**: Duration, account counts, error messages, correlation IDs
- **Query Interface**: Filter by server, date range, status
- **Statistics**: Success rates, averages, per-server metrics
- **Automatic Cleanup**: Configurable retention period
- **CLI Tool**: View history from command line

## Configuration

Configure sync history in `config/config.json`:

```json
{
  "syncHistory": {
    "dbPath": "data/sync-history.db",
    "retentionDays": 90
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | string | `"data/sync-history.db"` | Path to SQLite database file |
| `retentionDays` | integer | `90` | Number of days to retain history (1-365) |

## Data Model

Each sync operation is recorded with:

| Field | Type | Description |
|-------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `timestamp` | TEXT | ISO 8601 timestamp |
| `server_name` | TEXT | Server name from config |
| `status` | TEXT | 'success' or 'failure' |
| `duration_ms` | INTEGER | Sync duration in milliseconds |
| `accounts_processed` | INTEGER | Total accounts processed |
| `accounts_succeeded` | INTEGER | Accounts synced successfully |
| `accounts_failed` | INTEGER | Accounts that failed |
| `error_message` | TEXT | Error message if failed |
| `error_code` | TEXT | Error code if failed |
| `correlation_id` | TEXT | UUID for tracking |

## Viewing History

### Command Line Interface

Use the `viewHistory.js` script to query sync history:

```bash
# Show recent history (default: last 20 records)
npm run history

# Filter by server
npm run history -- --server Main

# Show last 7 days
npm run history -- --days 7

# Show only failures
npm run history -- --status failure

# Limit results
npm run history -- --limit 50

# Show statistics
npm run history -- --stats

# Per-server statistics
npm run history -- --per-server

# Recent errors
npm run history -- --errors

# Combine filters
npm run history -- --server Main --days 30 --status failure
```

### Output Examples

**History View:**
```
Sync History (10 records):

────────────────────────────────────────────────────────────────────────────────
Timestamp                Server              Status      Duration    Accounts            Error
────────────────────────────────────────────────────────────────────────────────
12/5/2025, 10:30:00 AM   Main                ✓ success   4.5s        3/3                 
12/5/2025, 7:30:00 AM    Main                ✓ success   4.2s        3/3                 
12/5/2025, 4:30:00 AM    Main                ✗ failure   2.1s        0/3                 Connection timeout
12/4/2025, 10:30:00 PM   Secondary           ✓ success   5.1s        2/2                 
────────────────────────────────────────────────────────────────────────────────
```

**Statistics View:**
```
Sync Statistics:

────────────────────────────────────────────────────────
Total Syncs:         50
Successful Syncs:    47
Failed Syncs:        3
Success Rate:        94.00%

Average Duration:    4.3s
Min Duration:        2.1s
Max Duration:        8.7s

Total Accounts:      150

Earliest Sync:       11/5/2025, 10:30:00 AM
Latest Sync:         12/5/2025, 10:30:00 AM
────────────────────────────────────────────────────────
```

**Per-Server Statistics:**
```
Per-Server Statistics:

──────────────────────────────────────────────────────────────────────────────────────────────
Server              Total     Success   Failed    Rate        Avg Duration    Last Sync
──────────────────────────────────────────────────────────────────────────────────────────────
Main                25        24        1         96.00%      4.2s            12/5/2025, 10:30:00 AM
Secondary           25        23        2         92.00%      4.5s            12/5/2025, 10:25:00 AM
──────────────────────────────────────────────────────────────────────────────────────────────
```

## Programmatic Access

Access sync history from your own scripts:

```javascript
const { SyncHistoryService } = require('./src/services/syncHistory');

const syncHistory = new SyncHistoryService({
  dbPath: 'data/sync-history.db',
  retentionDays: 90
});

// Get recent history
const history = syncHistory.getHistory({
  serverName: 'Main',
  days: 7,
  limit: 10
});

// Get statistics
const stats = syncHistory.getStatistics({ serverName: 'Main' });
console.log(`Success rate: ${stats.success_rate}`);

// Get recent errors
const errors = syncHistory.getRecentErrors(5);

// Get last sync for server
const lastSync = syncHistory.getLastSync('Main');

// Per-server statistics
const perServer = syncHistory.getStatisticsByServer(30);

// Close when done
syncHistory.close();
```

## Integration with Health Check

Sync history data can be integrated with the health check `/metrics` endpoint by extending the HealthCheckService:

```javascript
// In future enhancement
app.get('/metrics', (req, res) => {
  const stats = syncHistory.getStatistics({ days: 7 });
  res.json({
    // ... existing metrics
    history: {
      last7Days: stats,
      recentErrors: syncHistory.getRecentErrors(3)
    }
  });
});
```

## Use Cases

### 1. Troubleshooting

**Find when a server last synced successfully:**
```bash
npm run history -- --server Main --status success --limit 1
```

**View all failures in last 24 hours:**
```bash
npm run history -- --days 1 --status failure
```

**Check error messages:**
```bash
npm run history -- --errors
```

### 2. Performance Monitoring

**Check if sync times are increasing:**
```bash
npm run history -- --server Main --days 30
# Compare duration_ms over time
```

**View average performance:**
```bash
npm run history -- --stats --days 7
```

### 3. Reliability Tracking

**Calculate 30-day success rate:**
```bash
npm run history -- --stats --days 30
```

**Compare servers:**
```bash
npm run history -- --per-server --days 30
```

### 4. Audit Trail

**Generate compliance report:**
```bash
npm run history -- --days 90 > sync-report.txt
```

**Export to CSV** (add to scripts):
```javascript
const history = syncHistory.getHistory({ days: 90 });
const csv = history.map(r => 
  `${r.timestamp},${r.server_name},${r.status},${r.duration_ms}`
).join('\n');
```

## Database Maintenance

### Automatic Cleanup

Old records are automatically cleaned up based on `retentionDays` setting:
- Runs on service startup
- Deletes records older than retention period
- Runs `VACUUM` to reclaim space

### Manual Cleanup

```javascript
const syncHistory = new SyncHistoryService({ dbPath: 'data/sync-history.db' });
const deletedCount = syncHistory.cleanup();
console.log(`Deleted ${deletedCount} old records`);
syncHistory.close();
```

### Backup

SQLite database can be backed up while service is running:

```bash
# Copy database file
cp data/sync-history.db data/sync-history-backup-$(date +%Y%m%d).db

# Or use SQLite backup command
sqlite3 data/sync-history.db ".backup data/sync-history-backup.db"
```

### Reset History

```bash
# Stop service first
rm data/sync-history.db
# Restart service - database will be recreated
```

## Storage Considerations

### Database Size

Approximate storage per sync record: **~500 bytes**

| Records | Approximate Size |
|---------|------------------|
| 1,000 | ~500 KB |
| 10,000 | ~5 MB |
| 100,000 | ~50 MB |
| 1,000,000 | ~500 MB |

### Retention Recommendations

| Use Case | Recommended Retention |
|----------|----------------------|
| Basic monitoring | 30 days |
| Performance analysis | 90 days (default) |
| Compliance/audit | 365 days |
| Development/testing | 7 days |

## Performance

- **Write Performance**: ~1ms per insert (includes indexes)
- **Query Performance**: Sub-millisecond for typical queries
- **Indexes**: Timestamp, server name, status, correlation ID
- **WAL Mode**: Enabled for better concurrent access

## Troubleshooting

### Database Locked

```
Error: database is locked
```

**Cause**: Multiple processes accessing database simultaneously
**Solution**: Ensure only one sync service instance is running

### Disk Space

```
Error: disk I/O error
```

**Cause**: Disk full or permissions issue
**Solution**: 
- Check available disk space
- Verify write permissions on data directory
- Reduce `retentionDays` if needed

### Corrupted Database

```
Error: database disk image is malformed
```

**Solution**: Restore from backup or delete and recreate:
```bash
mv data/sync-history.db data/sync-history-corrupt.db
# Restart service to create new database
```

## Advanced Queries

Direct SQLite queries for advanced analysis:

```bash
sqlite3 data/sync-history.db
```

### Average sync time by hour:
```sql
SELECT 
  strftime('%H', timestamp) as hour,
  AVG(duration_ms) as avg_ms,
  COUNT(*) as count
FROM sync_history
GROUP BY hour
ORDER BY hour;
```

### Failure rate by server:
```sql
SELECT 
  server_name,
  ROUND(100.0 * SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END) / COUNT(*), 2) as failure_rate
FROM sync_history
GROUP BY server_name;
```

### Slowest syncs:
```sql
SELECT 
  timestamp,
  server_name,
  duration_ms,
  accounts_processed
FROM sync_history
WHERE duration_ms IS NOT NULL
ORDER BY duration_ms DESC
LIMIT 10;
```

## Best Practices

1. **Regular Monitoring**: Check statistics weekly
2. **Investigate Patterns**: Look for failures at specific times
3. **Backup Database**: Include in regular backup routine
4. **Appropriate Retention**: Balance storage vs history needs
5. **Use Correlation IDs**: Track operations across logs and history
6. **Export Reports**: Generate monthly summaries for review

## Future Enhancements

Potential features for future versions:

- Export to CSV/JSON
- Integration with `/metrics` endpoint
- Grafana dashboard templates
- Email reports for failures
- Trend analysis and predictions
- Configurable cleanup schedule
- Compression for old records
