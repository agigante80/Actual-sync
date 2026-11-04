# Logging architecture (agreed design, 2026-11-04)

Status: AGREED with actual-mcp-server (peer session, 2026-11-04) and reviewed
by Gemini 4 Argon (high) and Grok 4.7 (xhigh). Review claims were checked
against the code before adoption (see "Review notes"). Tickets are listed in "Delivery".

Sources: OWASP Logging Cheat Sheet and Logging Vocabulary, CWE-532, CWE-117,
OpenTelemetry log data model, 12-factor (logs), NIST SP 800-92, GDPR
Art. 5(1)(c) and Art. 25, pino docs.

## Goals, in priority order

1. **No secrets, no financial data, no third-party personal data in any log
   sink by default, at any level including DEBUG.** Omit first; redact only
   as defence in depth.
2. **One pipeline.** Every byte the process writes about itself goes through
   one root logger: our code, @actual-app/api, and pre-logger startup output.
3. **Machine-parseable, stable records.** A documented schema with event
   names, so alerting and log shipping do not depend on message wording.
4. **Operable.** The operator can answer "what happened to server X at 03:00"
   from logs alone: correlation, outcomes, timings, error classes, versions.

## Current state (audit 2026-11-04)

A custom `Logger` (`src/lib/logger.js`) with console, rotating file, UDP
syslog and the `/ws/logs` broadcast. Its key and string redaction covers
secrets only. Gaps: the api dumps transactions (#425); api warn/error bypass
the logger (#426); webhook URL secrets (#431); the syslog tcp crash (#432);
level overwrite (#433); DEBUG raw result (#434); Telegram sender data (#435);
six separate Logger instances that miss config; 21 raw `console.*` calls in
the Node process; upstream error text logged as-is; the crash handlers spread
rejection objects (`syncService.js:1284`); no event names; no correlation
outside a sync; `/ws/logs` has no backpressure.

## Decisions

### D1. One root logger, components as children

- `createRootLogger(config)` is called once, in `index.js`, before anything
  else is required.
- Every module gets `root.child({ component: 'notifications' })`. No more
  separate `createLogger` instances, so redaction, sinks and the live view
  apply everywhere, with one file handle.
- Reserved keys (`timestamp`, `level`, `severity`, `message`, `event`,
  `service`, `version`, `component`, `seq`, `schema`) cannot be overwritten by
  context or fields (#433). A per-server level is a child option, not a field.
  Per-server `format` is deprecated (one format per sink).

### D2. Library: our facade, pino underneath

- Our facade keeps the `info(message, fields)` signature, so call sites move
  gradually.
- The facade does the allowlist (D3), schema (D4), escaping and caps
  **synchronously, on the main thread**, before pino sees the record. The same
  final record feeds `/ws/logs`, so the live view never differs from the file.
- pino serializes and writes. No worker-thread transports for the primary
  sink; the crash path calls a synchronous flush with a 1 s timeout.
- actual-mcp-server stays on winston. One shape does not need one library.

### D3. Field allowlist with data classes

Every field key is registered in `src/lib/logFields.js` with a class, a type
and, for objects, its allowed child keys (max depth 3):

| Class | Examples | Emitted |
|---|---|---|
| `op` | durationMs, status, counts, attempt, schedule | always |
| `id` | server (operator-chosen name), accountId, correlationId, scheduleId | always |
| `personal` | accountName, budget name, remoteAddress | **off by default**; `logging.includeAccountNames: true` opts in; remoteAddress only on security events (D7) |
| `upstream` | error text from Actual, GoCardless, SMTP or Telegram | **never** (D5) |
| `financial` | payee, amount, notes, transaction objects | **never** |
| `secret` | passwords, tokens, webhook URLs, chat ids | **never** (masked if found) |

- Registered keys hold scalars, or objects with registered child keys only.
  A registered key holding an unregistered object is dropped whole.
- An unregistered key is dropped. Production records carry
  `droppedFieldCount`; tests fail on any drop (D9). Key names are not logged,
  because a spread object can turn data into keys.
- Notifications are not logs: they go to the operator's own channel and keep
  account names (#427).

### D4. Record schema (OTel log data model, ECS names)

```json
{
  "timestamp": "2026-11-04T03:00:01.234Z",
  "level": "INFO", "severity": 9,
  "service": "actual-sync", "version": "1.23.0",
  "component": "sync",
  "event": "sync.account.completed",
  "message": "Bank sync completed for account",
  "correlationId": "c0ffee12", "server": "Vega II",
  "fields": { "accountId": "a1b2", "durationMs": 812, "added": 5, "updated": 0 },
  "seq": 1042,
  "schema": 1
}
```

- `message` is a string literal, never interpolated (a source guard enforces
  it, D9). Data goes in `fields`.
- `event` is a dotted name from the catalogue in `docs/LOGGING.md`. Security
  events keep the OWASP vocabulary names verbatim (D7).
- `severity` is the OTel SeverityNumber (ERROR 17, WARN 13, INFO 9, DEBUG 5).
- Timestamps are UTC ISO 8601 with milliseconds. `seq` is a per-process
  counter, so gaps and reordering are visible.
- Caps run **before** serialization: 1 KB per string field, 16 KB per record,
  then `truncated: true`.
- C0, C1, DEL and CR/LF in values are escaped (CWE-117). The pretty console
  format is derived from the same record.
- pino `base` is set explicitly: no `hostname` (it names the NAS on every
  pasted line) and no `pid` per line (pid is in `sys_startup`). `messageKey`
  is `message`; the facade writes `severity` itself, and replaces
  `stdSerializers.err` (it emits `message` and `stack`).
- Correlation uses `AsyncLocalStorage`: a sync, an HTTP request, a Telegram
  update and a scheduled job each open a scope, so every record inside it gets
  `correlationId` without passing a logger around.

### D5. Errors: classify, never echo (fail closed)

- An error is logged as
  `error: { type, code, httpStatus, category, safeMessage }`.
- `category` is one of: `timeout`, `auth`, `upstream_unavailable`,
  `rate_limited`, `not_found`, `validation`, `conflict`, `cancelled`,
  `internal`.
- `safeMessage` is our own text or an allowlisted upstream pattern (for
  example `503 Service Unavailable`). Raw upstream text is **never** logged,
  at any level, DEBUG included: secret masking does not catch personal data
  ("Category 'Rent to Marco' already exists", IBANs, payees).
- `stack` only at DEBUG and only for our own errors.
- The same classified error feeds `sync_history.error_message`, the dashboard
  and notifications, so the three never disagree.
- Existing `sync_history.error_message` rows that do not match the new shape
  are rewritten to their category by a one-time migration.
- The crash handlers use the classifier: no `{...reason}` spread, no
  `promise.toString()`. They are installed first in `index.js`, together with
  a `warning` handler, and write `sys_crash` with a synchronous write.

### D6. Third-party and pre-logger output

- `api.init({ verbose: false })` by default; `logging.actualApiVerbose: true`
  opts in, documented as unsafe (#425).
- Upstream `warn` and `error` are not gated by `verbose`, so a console bridge
  is needed anyway (#426). It maps `console.*` (including `group`) to one
  static record: `event: "third_party.console"`, `component: "actual-api"`,
  static `message`. Arguments are dropped. With `actualApiVerbose`, a capped
  `consolePreview` (300 chars) is added, and never sent to `/ws/logs`.
- A bootstrap logger handles output before the root exists (banner, config
  validation, the 21 raw console calls). It applies the built-in allowlist
  and secret patterns without needing config, buffers, then flushes into the
  root; if startup dies first, it writes JSON lines to stderr.

### D7. Security events (OWASP Logging Vocabulary)

Events use the OWASP names as `event`, with `category: "security"`. They are
an **audit floor**: emitted whatever the configured level, and rate-limited
per source; when the limiter trips it writes one `security.suppressed`
record with `suppressedCount`, so a guess loop never looks like it stopped.
WARN, ERROR and security records are never sampled.

| Event | Actual-sync | actual-mcp-server |
|---|---|---|
| `authn_login_success` | dashboard login accepted (once per session) | bearer or OIDC accepted (once per session) |
| `authn_login_fail` | dashboard login refused | bearer or OIDC refused |
| `authz_fail` | unauthorized Telegram chat, refused origin | budget ACL refused |
| `input_validation_fail` | rejected API input | rejected tool input |
| `sys_startup`, `sys_shutdown` | process lifecycle | same |
| `sys_crash` | uncaught exception or rejection | same |
| `sys_config_change` (our name; OWASP has no exact term) | dashboard or Telegram changes a setting, a payment rule, a server | a budget ACL or auth setting changes |

They carry `remoteAddress` (legitimate interest, documented) and never carry
request bodies, message text or user names.

### D8. Startup record

One `sys_startup` record replaces the banner and the scattered INFO lines:

- versions: app, Node, resolved @actual-app/api; pid; platform; container flag
- timezone and UTC offset (the cron schedules depend on them)
- log level, effective api verbose, and which sinks are active
- whether a custom log dir and data dir are set (booleans, not paths:
  `/home/<user>/...` is personal data in a paste), retention days
- the effective privacy flags (`includeAccountNames`, `actualApiVerbose`)
- the server count and their cron schedules
- which notification channels are enabled (booleans)
- dashboard bind address, auth mode and TLS
- timeouts
- **config schema version**, not a hash of values (a hash over short
  passwords is an offline guessing oracle)

No names beyond operator-chosen server names, no URLs, no credentials.

### D9. Tests that enforce it

- Source guard: no `console.*` in `src/` except the bridge, the bootstrap
  logger and the browser file `dashboard.js`.
- Source guard: every logged key is in `logFields.js`.
- Source guard: the first argument of every log call is a string literal.
- Sentinel test: a mocked sync, a notification failure, a Telegram message
  and an upstream error at DEBUG with `SENTINEL_PAYEE`, `-12345`, a fake
  webhook token, a fake password and a fake account name. None may appear in
  the console, file (including gzip), syslog, `/ws/logs`, `sync_history` or a
  notification body.
- Schema test: every record validates against `docs/log-record.schema.json`.

### D10. Sinks and retention

- In a container, stdout JSON is the primary sink (12-factor). The file sink
  defaults to off in Docker, on in bare metal.
- Log dir mode 0700, files 0600.
- In Docker the log driver owns stdout retention, which this process does not
  control: SECURITY_AND_PRIVACY.md recommends `max-size` and `max-file`, and
  says the 30-file cap applies to the optional file sink only.
- Syslog: UDP (plaintext, documented as not an audit log) or TCP with
  octet-counting framing (RFC 6587) and TLS with certificate verification
  (RFC 5425), via a transport (#432). RFC 5424 structured data escapes `\`,
  `]` and `"`.
- `/ws/logs` gets the same final record, behind the existing dashboard auth
  ticket (#242), with a bounded per-client queue: a client over its
  `bufferedAmount` limit is dropped, never allowed to grow memory. DEBUG is
  not sent unless the viewer opts in. The page renders records as text.
- Retention: 30 rotated files by default, documented as personal-data
  retention in SECURITY_AND_PRIVACY.md.

## Shared convention with actual-mcp-server

No shared npm package for now: it would couple two release trains. (Grok
preferred a shared contract package; the peer's coupling argument won. Drift
is the revisit trigger.) Each repo
keeps a copy of one written convention in `docs/LOGGING.md`: the event
catalogue, the error categories, the D7 table and the D8 field groups. Revisit
if the copies drift.

The convention fixes `event`, `severity`, `schema`, `error.*` and the D8
groups. `docs/LOGGING.md` carries a convention version; each repo states the
version it follows, so drift is visible in a diff. Each project maps its own
context keys:

| Concept | Actual-sync | actual-mcp-server |
|---|---|---|
| component | `component` | `module` |
| correlation | `correlationId` | `sessionId`, `requestId` |

## Delivery

Existing tickets, aligned with this design: #425, #426, #427, #431, #432,
#433, #434, #435.

New tickets, in dependency order:

1. #436 record contract (schema, event catalogue, `docs/LOGGING.md`)
2. #437 field allowlist; #438 fail-closed error classifier
3. #439 crash handlers; #440 one root logger; #442 bootstrap logger
4. #441 AsyncLocalStorage correlation; #443 `sys_startup`; #444 security
   audit floor; #448 account names off by default
5. #445 `/ws/logs` backpressure; #446 file permissions; #447 CWE-117
   escaping; #451 Docker retention docs
6. #450 sentinel suite and source guards (gate for the next step)
7. #449 pino under the facade

## Resolved questions

1. Upstream error text: **fail closed** (peer and Gemini agree).
2. pino: **yes, behind our facade**, with the pipeline on the main thread.
   actual-mcp-server keeps winston.
3. Account names: **off by default** in logs; opt-in.
4. Shared package: **no**; one convention, one copy per repo.

## Review notes (claims checked against the code, 2026-11-04)

Not adopted, because the code already handles them:

- "`/ws/logs` has no session check" (Grok): it uses single-use tickets from
  the authenticated `/api/dashboard/ws-ticket` (#242).
- "The config warning replays the raw server URL" (Grok):
  `configLoader.js:424` prints server names only.
- "Health checks at INFO fill the logs" (Grok): `healthCheck.js:674` logs
  them at DEBUG.
- "Prometheus labels can carry account names" (Grok): labels are `server`,
  `status`, `error_code`, `version`, `node_version` only.
- "`X-Forwarded-For` is trusted" (Grok): `trust proxy` is off unless
  configured (#245).

Confirmed: dashboard auth failures are logged at WARN
(`healthCheck.js:641,652`), so `logging.level=error` drops them; hence the
D7 audit floor.
