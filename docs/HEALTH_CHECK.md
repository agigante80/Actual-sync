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
| `auth` | object | `{ "type": "none" }` | Credential for `/metrics` and `/metrics/prometheus` (see [Which endpoints are authenticated](#which-endpoints-are-authenticated)) |

The other `healthCheck` keys (`trustProxy`, `hsts`, `dashboard`) are documented in [CONFIG.md](CONFIG.md#healthcheck-optional).

### Which endpoints are authenticated

Two credentials exist, and they are independent: rotating one never breaks the other.

| Endpoint | `healthCheck.auth` | `healthCheck.dashboard.auth` |
|----------|--------------------|------------------------------|
| `GET /health`, `GET /ready` | never | never |
| `GET /metrics`, `GET /metrics/prometheus` | when `type` is `basic` or `token` | no effect |
| `GET /dashboard`, `/api/dashboard/*`, `WS /ws/logs` | no effect | when `type` is `basic` or `token` |

`/health` and `/ready` are liveness and readiness probes. Docker, Kubernetes and uptime checkers send no credentials, so a credential there would only make the container look permanently unhealthy. They return a status word and an uptime, nothing about your servers.

`/metrics` and `/metrics/prometheus` name your configured servers, when each last synced and whether it failed. By default they are open, exactly as before the credential existed, so an upgrade changes nothing. Set `healthCheck.auth` to close them:

```json
"healthCheck": {
  "auth": { "type": "token", "token": "a-long-random-value" }
}
```

`type` is `none` (default), `token` (sent as `Authorization: Bearer <token>`, the recommended choice for a scraper) or `basic` (`username` and `password`, for scrape tooling that only speaks basic auth). With `basic` or `token` the credential must be set, or the service refuses to start and names the missing key. Wrong credentials get `401`, and after 10 failures from one address in 15 minutes the metrics endpoints answer `429` for the rest of the window, on a counter separate from the dashboard login throttle. `healthCheck.dashboard.enabled` has no effect on these four endpoints. The dashboard API (`/api/dashboard/status`, `/api/dashboard/metrics`) returns the same server list, so this credential only closes the data when `healthCheck.dashboard.auth` is also set or the dashboard is disabled.

Once set, Prometheus needs the same credential in its scrape config; see [PROMETHEUS.md](PROMETHEUS.md#2-configure-prometheus). Network controls (binding to `127.0.0.1`, a firewall, a reverse proxy) remain the first line, this credential is a second layer for operators who cannot use them.

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

Detailed metrics endpoint with sync statistics and per-server status. Open by
default; `healthCheck.auth` can require a credential (see
[Which endpoints are authenticated](#which-endpoints-are-authenticated)).

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

`/metrics` is open by default, so after a failed sync `lastError` holds only `timestamp` and
`serverName`, and a server entry never carries the error text at any `healthCheck.auth` type (it can include bank or Actual
messages). Read the failure text on the authenticated dashboard.

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

### GET /metrics/prometheus

Prometheus-format metrics (text exposition). This is the endpoint to scrape with
Prometheus — `/metrics` returns JSON for humans/uptime checks, `/metrics/prometheus`
returns the Prometheus text format. Open by default; `healthCheck.auth` can require
a bearer token or basic credentials, which Prometheus then sends with every scrape
(see [Which endpoints are authenticated](#which-endpoints-are-authenticated)). See
[docs/PROMETHEUS.md](PROMETHEUS.md) for the full metric reference and scrape config.

### Other public endpoints

- `GET /icon.png` — the project icon (served locally; used by the dashboard and notifications).
- `GET /vendor/chart.umd.min.js`: the Chart.js bundle from the installed npm package, used by the dashboard charts. Fixed path, no directory listing, cached for one day.

### Internal dashboard API (`/api/dashboard/*`)

These endpoints back the web dashboard UI and are **internal** — all are behind
`dashboardAuth()` and return shapes tailored to the dashboard's JavaScript, not a
stable public API (no compatibility guarantees). They are listed here so the docs
match the code, not as an integration surface:

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/dashboard/status` | Overall status + per-server summary |
| GET  | `/api/dashboard/servers` | Configured servers |
| GET  | `/api/dashboard/orphaned-servers` | History for servers no longer in config |
| GET  | `/api/dashboard/schedules` | Per-server schedules / next run |
| GET  | `/api/dashboard/metrics` | Aggregated metrics for the Analytics tab |
| GET  | `/api/dashboard/history` | Sync history records (`?limit=N`, optional `?serverName=` to filter to one server) |
| GET  | `/api/dashboard/accounts` | Discovered bank accounts |
| GET  | `/api/dashboard/payments` | Missing-payment alert snapshot per server (optional `?server=`), no connection to Actual needed |
| GET  | `/api/dashboard/payment-overrides` | Every stored payment alert override (switch and mute), with an `orphaned` flag |
| PUT  | `/api/dashboard/payments/:server/:alertId/state` | Switch an alert on or off, or mute or unmute it (needs config writes) |
| DELETE | `/api/dashboard/payments/:server/:alertId/state` | Reset an alert's override, including one whose alert or server no longer exists (needs config writes) |
| GET  | `/api/dashboard/payment-schedules/:server` | The stored Actual schedule snapshot (for the rule editor's picker) and the editor `defaults` |
| GET  | `/api/dashboard/payment-rules/:server` | Config and dashboard payment rules of a server, with `source`, `superseded` and `invalid` |
| POST | `/api/dashboard/payment-rules/:server` | Create a dashboard payment rule (needs config writes) |
| PUT  | `/api/dashboard/payment-rules/:server/:alertId` | Replace a dashboard payment rule (needs config writes) |
| DELETE | `/api/dashboard/payment-rules/:server/:alertId` | Delete a dashboard payment rule (needs config writes) |
| POST | `/api/dashboard/payment-preview/:server` | Render a rule's message, optionally send it as a test (needs config writes) |
| GET  | `/api/dashboard/notifications` | Failure-alert rate-limit usage + recent sync outcomes per server |
| GET  | `/api/dashboard/capabilities` | `{configWrites, reason, channels}`: whether dashboard config writes are enabled (`reason` is `disabled`, `auth-none` or null) and which channels (`telegram`, `email`, `slack`, `discord`, `webhook`, `ntfy`) currently have a destination |
| GET  | `/api/dashboard/config-audit` | Configuration change audit trail, newest first (`?limit=N`, 1 to 200, default 50; otherwise 400 `invalid_limit`). 503 `Sync history not available` without history, 500 `Failed to retrieve configuration changes` on a read error |
| POST | `/api/dashboard/sync` | Trigger a manual sync |
| POST | `/api/dashboard/dismiss-error` | Clear a server's last error |
| POST | `/api/dashboard/reset-history` | Reset stored sync history. 404 `server_not_found` for a name that is neither configured nor present in any history table, 400 `invalid_server` for a non-string name, 400 `server_name_too_long` above 200 characters |
| POST | `/api/dashboard/test-notification` | Send a test notification (`email`, `discord`, `slack`, `telegram`, `ntfy`, `generic`) |

Every POST, PUT and DELETE runs the dashboard auth first and then an Origin check: a cross-origin browser request is refused with 403 `{"error":"origin_rejected"}`. Configuration-changing routes additionally return 403 `config_writes_disabled` unless `dashboard.allowConfigWrites` is true and auth is not `none`, 415 `invalid_content_type` for a non-JSON body, 413 `payload_too_large` above 16 KB and 400 `invalid_json` for a malformed body. Any other unreadable body (for example a corrupt gzip body) is 400 `invalid_body`, a 4xx raised by a route keeps its status with `request_error`, and an unexpected server error is 500 `internal_error`; none shows a stack trace.

`GET /api/dashboard/payments` serves the snapshot of the last missing-payment evaluation
(#258) that a sync persists after evaluating (#260), so a dashboard can list every watched schedule without
reaching Actual. Its data is as fresh as `lastRun.at`; a sync that skips or aborts before the evaluation
(including a stuck bank sync, #284) leaves the items and `lastRun` unchanged. With the
default `auth.type: none` the route is open to anyone who can reach the port, so enable dashboard
auth when `scheduleAlerts` is used (it exposes schedule, payee and account names and amounts).

```json
{
  "servers": [
    {
      "server": "Main",
      "configured": true,
      "lastRun": { "at": "2026-01-14T08:01:00Z", "ok": true, "errorCode": null, "lastSuccessAt": "2026-01-14T08:01:00Z", "rulesErrored": 0 },
      "items": [
        {
          "alertId": "parking-a", "scheduleId": "b1c2...", "name": "Rent - Parking A",
          "cadenceText": "Every month on the 5th", "account": "Main", "payee": "Tenant A",
          "expectedAmount": 6000, "nextDate": "2026-02-05", "deadline": "2026-01-11",
          "state": "missing", "lastAlertAt": "2026-01-12T08:01:00Z", "source": "config",
          "ruleState": { "enabled": true, "mutedUntil": null, "reason": null, "lockedByConfig": false, "muteEndDue": false },
          "occurrences": [ { "date": "2026-01-05", "deadline": "2026-01-11", "state": "missing", "receivedDate": null, "receivedAmount": null, "daysLate": null } ]
        }
      ]
    }
  ]
}
```

- `expectedAmount` is integer cents (6000 = 60.00), `null`, or `{ "num1": 5000, "num2": 7000 }`
  (min, max) for a range. `receivedAmount` is cents or `null`.
- `state` is one of `upcoming`, `received`, `late`, `missing`, `wrongAmount`, `cannotCheck`, `skipped`.
- `daysLate` is computed per request: for a `late` occurrence, `receivedDate - deadline` in
  calendar days; `null` for every other state.
- `lastAlertAt` is the latest delivered alert (`delivery = 'sent'`, resolved notices included)
  from the `schedule_alerts` ledger, computed at request time; `null` when none was sent or the
  last one is older than the ledger retention.
- `source` is `"config"` for a rule from `config.json` and `"dashboard"` for a rule created in the dashboard (see [Payment rules](#payment-rules-262)).
- `ruleState` is `{ enabled, mutedUntil, reason, lockedByConfig, muteEndDue }`, computed per request from the
  stored override (#261) and the rule: `enabled` is `false` when the rule has `enabled: false` in
  the config (`lockedByConfig: true`) or the operator switched it off; `mutedUntil` is a
  `YYYY-MM-DD` date (or `null`) and `reason` its reason. `mutedUntil` stays set, in the past, from the
  end of the mute until the summary has been sent. `muteEndDue` is `true` in that period (the mute day
  is over in the server timezone); the dashboard uses it, not the browser date, for the "summary pending" badge.
  Without an override it is
  `{ "enabled": true, "mutedUntil": null, "reason": null, "lockedByConfig": false, "muteEndDue": false }`. The `state` of an
  item is always the real evaluation result: a switch or a mute never changes it.
- `configured: false` (no `scheduleAlerts` block) gives `items: []` and `lastRun: null`; a
  configured server has `lastRun: null` before its first run. `lastRun.at` is the latest attempt,
  `lastSuccessAt` the latest success (`null` until one happens). On a failed run the previous
  `items` are still returned and `lastRun.errorCode` is one of `rules_invalid`,
  `actual_read_failed`, `evaluation_failed`.

| Status | Body | When |
|--------|------|------|
| 400 | `{"error":"Invalid server parameter"}` | `server` is not a single non-empty string (repeated, `server[]=`, `server[a]=`, or empty) |
| 401 | | no or bad credentials |
| 403 | `{"error":"Dashboard is disabled"}` | the dashboard is disabled |
| 404 | `{"error":"Server not found"}` | no configured server with that name |
| 429 | `{"error":"Too many failed authentication attempts, try again later"}` | auth throttle after repeated bad credentials |
| 429 | `Too many requests, please try again later.` | the request limiter |
| 500 | `{"error":"Invalid authentication configuration"}` | `auth.type` is unrecognised |
| 503 | `{"error":"Server list not available"}` | the server list is not wired |
| 503 | `{"error":"Sync history not available"}` | sync history is disabled |
| 500 | `{"error":"Failed to retrieve payments"}` | the snapshot or ledger read threw (logged) |

#### Payment alert state (#261)

`PUT /api/dashboard/payments/:server/:alertId/state` switches an alert off or on, or mutes it until a
date, without editing `config.json` or restarting. It runs behind dashboard auth, the Origin check and
the config-writes gate (see above), so it needs `dashboard.allowConfigWrites: true` and auth other than
`none`. The body is a JSON object with at least one of these keys and no others:

| Key | Rule |
|-----|------|
| `enabled` | boolean |
| `mutedUntil` | `YYYY-MM-DD` from today to today + 365 days (in the configured timezone), or `null` to unmute |
| `reason` | string, 1 to 200 characters after trimming; required when `mutedUntil` is a date; given alone, checked the same way on a muted alert and ignored otherwise; ignored when `mutedUntil` is `null` |

It merges the given keys into the stored override and answers `200 {"ruleState": {...}}` (the shape
above). `{"enabled":true}` when nothing is stored is a no-op: nothing is stored and nothing is audited.
Extending a mute keeps its original start, so the summary covers the whole period. Every accepted
change that alters the stored state is written to the configuration audit trail with the action
`payment_alert_state`; the reason is recorded as `[redacted]`. Rejected and no-op writes are not audited.

| Status | Code | When |
|--------|------|------|
| 400 | `invalid_json`, `invalid_body_encoding` | a malformed body or an unsupported charset or content encoding (the shared body parser) |
| 400 | `invalid_body` | not an object, no known key, an unknown key, or a wrong type |
| 400 | `invalid_muted_until` | not a real date, in the past, or more than 365 days ahead |
| 400 | `reason_required` | a mute date with a missing or blank reason, or a blank reason alone on a muted alert |
| 400 | `invalid_reason` | a reason over 200 characters after trimming |
| 401 | | no or bad credentials (the dashboard auth bodies) |
| 403 | `origin_rejected`, `config_writes_disabled` | the Origin or config-writes gate |
| 404 | `server_not_found`, `alert_not_found` | the server or alert id is not configured |
| 409 | `disabled_in_config` | any change to an alert with `enabled: false` in the config, except one that only unmutes |
| 413, 415 | `payload_too_large`, `invalid_content_type` | a body over 16 KB, or not `application/json` |

The checks run in that order: body shape, then date and reason, then 404, then 409. A top-level JSON
string body is rejected by the strict parser as `invalid_json`.

`DELETE` on the same path removes the override (switch and mute together) and answers
`200 {"deleted": true}`. It checks the stored override first, so the override of a server or alert
that is no longer configured (an orphan) can still be deleted; with no override it is
`404 override_not_found`. Deleting a mute also deletes its held-back ledger rows, with no summary.

`GET /api/dashboard/payment-overrides` returns
`{"overrides": [{ "server", "alertId", "enabled", "mutedFrom", "mutedUntil", "reason", "updatedAt", "orphaned" }]}`
ordered by server and alert id. An orphaned override (its server or alert is no longer in the
configuration) is ignored by delivery and by `ruleState`, and the Settings tab lists it for deletion.
This is also the export of everything stored about overrides.

#### Payment rules (#262)

Rules can also be created in the dashboard and are stored in the sync-history database (table
`payment_alert_rule`); `config.json` is never written. The editor itself is #268; these routes are its
API. A server needs a `scheduleAlerts` block (an empty `{ "alerts": [] }` is enough) before it accepts
dashboard rules. Config rules win: a dashboard rule whose id equals a config rule's id is
`superseded`, kept but not evaluated. `GET` routes need dashboard auth only; `POST`, `PUT` and
`DELETE` also need the Origin check and config writes, like the alert state route.

- `GET /api/dashboard/payment-schedules/:server` answers
  `{ configured, capturedAt, schedules: [{ id, name, cadenceText, amount, amountMin, amountMax, amountOp, account, payee, nextDate, completed }], defaults }`.
  The schedules are captured by the sync's alert step (`capturedAt` is `null` before the first
  capture, so a new install needs a sync first). `account` is `null` for a deleted account.
  `defaults` is always present: `{ graceDays: 3, earlyDays: 2, templates, blockTemplates, variables }`,
  read from the same constants the validator uses; `variables` maps each of the six events to the
  variable list a template may use.
- `GET /api/dashboard/payment-rules/:server` answers
  `{ configured, rules: [{ id, source, superseded, invalid, errors, definition, updatedAt }] }`.
  `definition` is exactly one `scheduleAlerts.alerts[]` entry, so it can be copied into `config.json`.
  `invalid` and `errors` use the validator mode the sync uses, so the list and the sync agree on which
  rules run. A server without a block answers `configured: false` with its stored rows (dormant).
- `POST` takes one rule (`id` required, `enabled` not allowed: use the alert switch) and answers
  `201 { rule }`. `PUT .../:alertId` replaces it (`200 { rule }`); a body identical to the stored rule is a
  no-op with no audit row. `DELETE` answers `200 { deleted: true }`; it also removes the rule's alert
  override, its held-back `muted` rows and its payment status rows, unless a config rule of the same id
  exists (then only the dashboard row goes). At most 200 dashboard rules per server.
- `POST /api/dashboard/payment-preview/:server` takes `{ rule, event, send? }` (`event` is `missing`,
  `wrongAmount`, `resolved`, `cannotCheck`, `ruleUnmatched` or `muteEnded`) and answers
  `{ text, sampleKeys, sent, results }`. Schedule fields come from the stored snapshot; `sampleKeys` lists
  the variables filled with stand-ins. With `send: true` one test message goes to each destination;
  nothing is written to the alert ledger or the payment status. `results[]` is
  `{ channel, target, ok, error? }`, where `target` is the webhook name or an opaque destination key (never
  a URL) and `error` is `send_failed`, `send_threw`, `timeout` or `channel_unavailable`. At most 5 test
  sends per minute per process.
- Writes are audited as `payment_alert_rule_create`, `payment_alert_rule_update` and
  `payment_alert_rule_delete` (target the alert id, `changes` as `{ field: [before, after] }`), in the same
  transaction as the write. The definition values are recorded, so do not put secrets in a rule.

| Status | Code | When |
|--------|------|------|
| 400 | `invalid_rule` + `details: [{path, message}]` | the rule fails the schema, or `id` is missing, or `enabled` is present |
| 400 | `invalid_template` + `template`, `token`, `line`, `reason` | a template does not compile |
| 400 | `no_configured_destination` | the rule's channels resolve to no destination (create, replace, preview) |
| 400 | `id_mismatch` | PUT body `id` differs from `:alertId` |
| 400 | `invalid_event`, `invalid_body` | preview: unknown event, or a missing or mistyped `rule`, `event` or `send` |
| 400 | `invalid_json`, `invalid_body_encoding` | the shared body parser |
| 401 | | no or bad credentials |
| 403 | `origin_rejected`, `config_writes_disabled` | the Origin or config-writes gate |
| 404 | `server_not_found` | unknown server (checked first on every route) |
| 404 | `rule_not_found` | an id that is not a valid alert id, or is neither a dashboard nor a config rule of that server |
| 409 | `alerts_not_configured` | create, replace or preview on a server without a `scheduleAlerts` block |
| 409 | `id_in_config` | create with the id of a config rule (wins over `duplicate_id`) |
| 409 | `duplicate_id` | create with the id of a stored dashboard rule |
| 409 | `managed_in_config` | replace a config rule, or delete a config id that has no dashboard row |
| 409 | `too_many_rules` | create beyond 200 dashboard rules |
| 413, 415 | `payload_too_large`, `invalid_content_type` | a body over 16 KB, or not `application/json` (a DELETE needs no body) |
| 429 | `test_send_rate_limited` | the 6th test send in a minute |
| 500 | `Failed to retrieve payment rules` (reads), `Failed to save payment rule` (writes), `Failed to preview payment rule` | an unexpected error; the text is fixed and the cause is only logged |
| 502 | `send_failed` + `results` | every destination refused the test message |
| 503 | `Sync history not available` | sync history is disabled |

Create checks run in this order: server, block, validation (400), `id_in_config`, `duplicate_id`,
`too_many_rules`.

`GET /api/dashboard/notifications` exposes rate-limit headroom and recent sync outcomes per
server. Rate limiting is otherwise invisible: a server at zero remaining is having its failure
alerts suppressed, and this is the surface that says so. The configured `rateLimit` is echoed
back, because "remaining" means nothing without the ceiling it counts down from.

**`notificationsSentLastHour` counts FAILURE notifications only.** Rate limiting is failure-only
by design — a successful sync never consumes budget — so this is not a count of all
notifications sent. `recentSyncsByServer` reports every outcome (total / successes / failures)
and `consecutiveFailuresByServer` the current streak.

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

The `/metrics/prometheus` endpoint exposes Prometheus-format metrics for scraping
(`/metrics` returns JSON, not the Prometheus text format). Example scrape config:

```yaml
scrape_configs:
  - job_name: 'actual-sync'
    static_configs:
      - targets: ['actual-sync:3000']
    metrics_path: '/metrics/prometheus'
    scrape_interval: 30s
    # Only when healthCheck.auth is set to type token:
    # authorization:
    #   type: Bearer
    #   credentials: a-long-random-value
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

1. **Internal Only**: Set `host` to `"127.0.0.1"` if only local access is needed. In a container keep `0.0.0.0` (the address inside the container) and restrict with the port mapping instead: the shipped `docker-compose.yml` publishes `127.0.0.1:3000:3000`, which only the Docker host can reach ([Container hardening](DOCKER_DEPLOYMENT.md#container-hardening-253))
2. **Firewall**: Restrict access to health check port (3000) to monitoring systems only
3. **Reverse Proxy**: Put behind nginx/Apache with authentication if exposed to internet, and set `healthCheck.trustProxy` (usually `1`) so rate limiting and auth-failure logs see the real client IP ([CONFIG.md](CONFIG.md#healthcheck-optional))

### Sensitive Information

The `/metrics` endpoint exposes:
- Server names (from your configuration)
- Sync timing information
- Error messages (which might contain server details)

**Recommendations:**
- Don't expose health check endpoints to the public internet
- Use firewall rules to restrict access to monitoring systems
- Set `healthCheck.auth` when the metrics endpoints must be reachable beyond your monitoring network (see [Which endpoints are authenticated](#which-endpoints-are-authenticated)). It is off by default so existing Prometheus setups keep working after an upgrade; that trade is deliberate, since the service normally sits behind a firewall.

### Docker Example with Restricted Access

This is the default in the shipped `docker-compose.yml` since v1.22.0:

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
    };
  };
  lastError: {
    // no message: the error text stays on the authenticated dashboard
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

Real-time log streaming via WebSocket connection. **Not public**: the handshake is checked before the socket opens, so a refused client never receives a log line.

| Check | Applies | Refused with |
|---|---|---|
| `dashboard.enabled` is false | always | 403 |
| `Origin` is neither same-origin nor in `dashboard.allowedOrigins` | every auth type; skipped when there is no `Origin` header | 403 |
| more than 10 open log streams from one address | always | 429 |
| no valid ticket (an `Authorization` header is not accepted here) | `dashboard.auth.type` basic or token | 401 |

The per-address cap and the `handshake refused` log lines use the client address Express resolves: the TCP peer address by default, or the `X-Forwarded-For` client when `healthCheck.trustProxy` is set. Without `trustProxy`, behind a reverse proxy the cap counts every stream through that proxy together. The ticket is spent before any other check, so a handshake refused for its Origin, the cap or a disabled dashboard cannot be retried with the same ticket. The same Origin rule guards the state-changing dashboard POSTs (403 `origin_rejected`). With `auth.type: none` the Origin check does not stop DNS rebinding; see [DASHBOARD.md](DASHBOARD.md).

**Authenticating from a browser.** A browser cannot put an `Authorization` header on a WebSocket, so the dashboard first calls `GET /api/dashboard/ws-ticket` (behind the normal dashboard auth) and gets a ticket that is single use and valid for 30 seconds:

```json
{ "ticket": "9f2c...64 hex chars", "expiresInSeconds": 30 }
```

It then connects to `/ws/logs?ticket=<ticket>`. Tickets live in memory, so after a restart the dashboard simply asks for a new one.

**Authenticating from a script.** Do the same: call `GET /api/dashboard/ws-ticket` with the `Authorization` header the HTTP dashboard takes (`Basic ...` or `Bearer ...`), then connect with the ticket. The handshake itself does not accept the header, because WebSocket upgrades bypass the HTTP rate limiter and would otherwise allow unlimited password guessing.

With `auth.type: none`, no ticket is needed; the `Origin` check and the connection cap still apply.

**Connection:**
```javascript
const { ticket } = await (await fetch('/api/dashboard/ws-ticket')).json();
const ws = new WebSocket(`ws://localhost:3000/ws/logs?ticket=${ticket}`);
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
// Node.js 18+ with the ws package, token auth: fetch a ticket, then connect with it.
const WebSocket = require('ws');
const auth = { Authorization: 'Bearer <dashboard token>' };

async function connect() {
  const res = await fetch('http://localhost:3000/api/dashboard/ws-ticket', { headers: auth });
  const { ticket } = await res.json();
  const ws = new WebSocket(`ws://localhost:3000/ws/logs?ticket=${ticket}`);
  let keepAlive;

  ws.on('open', () => {
    console.log('Connected to log stream');
    keepAlive = setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 30000);
  });

  ws.on('message', (raw) => {
    const data = JSON.parse(raw);
    if (data.type === 'pong') return;
    console.log(`[${data.level}] ${data.message}`);
  });

  ws.on('close', () => {
    clearInterval(keepAlive);
    console.log('Disconnected, reconnecting...');
    setTimeout(connect, 3000);
  });
}

connect();
```
