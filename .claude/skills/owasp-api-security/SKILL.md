---
name: owasp-api-security
description: OWASP API Security Top 10 testing patterns, injection payloads, auth bypass vectors, and security test generation for REST APIs. Use when writing security tests, reviewing API endpoints for vulnerabilities, or auditing input validation.
---

<!-- owasp-api-security-version: 1 -->

# OWASP API Security Testing

Comprehensive security testing knowledge base for REST APIs, aligned with OWASP API Security Top 10:2023 and OWASP ASVS 5.0, adapted to **Actual-sync**'s real stack.

## Stack the examples target

Actual-sync exposes one Express HTTP surface from `src/services/healthCheck.js`:

- **Server:** Express app started via `http.createServer(this.app)` on a configurable port. Tests start the real server and hit it with Node's built-in `http` module — **not** `fastify.inject()`, **not** `supertest`. See `src/__tests__/healthCheck.test.js` for the idiom.
- **Auth:** HTTP **Basic auth** (or Bearer token) via `dashboardAuth()`, realm `"Dashboard"`. Unauthenticated/invalid Basic → `401` with a `WWW-Authenticate: Basic realm="Dashboard"` header. There is **one** admin credential pair (`dashboardConfig.auth.username`/`password`), not per-user sessions.
- **Protected surface** (behind `dashboardAuth()`): `/dashboard` and `/api/dashboard/*` (`status`, `servers`, `orphaned-servers`, `schedules`, `metrics`, `history`, `accounts`, plus POST `sync`, `dismiss-error`, `reset-history`, `test-notification`).
- **Public surface** (no auth by design): `/health`, `/ready`, `/metrics`, `/metrics/prometheus`, `/icon.png`, and the WebSocket log stream `/ws/logs`.
- **Validation:** **AJV** against `config/config.schema.json` at startup; request-body validation is hand-rolled in the route handlers. There is no Zod.
- **DB:** **better-sqlite3** with `?`-parameterized prepared statements (`services/syncHistory.js`).
- **Rate limiting:** `express-rate-limit` (60 req/min/IP, `/icon.png` exempt).
- **Logging:** the custom logger in `src/lib/logger.js` auto-redacts secrets before writing — **error responses must redact too** (they are a separate egress path).

## When to Use This Skill

- Writing security tests for the dashboard API endpoints
- Reviewing `/api/dashboard/*` routes for OWASP vulnerabilities
- Generating injection/fuzzing payloads for test suites
- Auditing the single-admin auth gate (`dashboardAuth()`)
- Validating that responses never leak secrets (passwords, tokens, `encryptionPassword`) or stack traces
- Assessing rate limiting and resource-exhaustion protections

## OWASP API Security Top 10:2023

### API1 - Broken Object Level Authorization (BOLA / IDOR)

**Largely N/A here.** Actual-sync is a **single-admin dashboard**. There are no per-user objects and no `:id` path params scoped to a caller — every authenticated request is the same admin. Classic BOLA (User A reading User B's resource by ID) does not apply.

**What still matters:** the "object" is a **server name**. Routes that accept a `server` value must resolve it against the configured server list and reject unknown names rather than acting on attacker-supplied identifiers. `POST /api/dashboard/dismiss-error` guards this with an own-property check to block prototype pollution; `POST /api/dashboard/sync` returns `404` for an unknown server.

```javascript
// Unknown server name must be rejected, not silently acted upon
const res = await httpRequest('POST', '/api/dashboard/sync', authHeader, { server: '__proto__' });
expect([400, 404]).toContain(res.statusCode); // never 200
```

**Checklist:**
- [ ] Every route taking a `server` value validates it against `getServers()` / `serverStatuses`
- [ ] Own-property checks (`Object.prototype.hasOwnProperty.call`) guard object writes keyed by request input
- [ ] No route echoes another server's secrets based on an attacker-chosen name

### API2 - Broken Authentication

The whole `/api/dashboard/*` + `/dashboard` surface sits behind `dashboardAuth()`. Missing or wrong Basic credentials → `401` + `WWW-Authenticate: Basic realm="Dashboard"`.

```javascript
// No auth header → 401 with WWW-Authenticate
const res = await httpGet(`http://127.0.0.1:${port}/api/dashboard/status`);
expect(res.statusCode).toBe(401);
expect(res.headers['www-authenticate']).toMatch(/Basic realm="Dashboard"/);

// Wrong password → 401 (never 200, never 500)
const wrong = Buffer.from('admin:wrong').toString('base64');
const res2 = await httpGetAuth(`http://127.0.0.1:${port}/api/dashboard/status`, `Basic ${wrong}`);
expect(res2.statusCode).toBe(401);

// Malformed Authorization header must not throw a 500 or bypass the gate
const res3 = await httpGetAuth(
  `http://127.0.0.1:${port}/api/dashboard/status`,
  'Basic <script>alert(1)</script>'
);
expect(res3.statusCode).toBe(401);

// Correct credentials → 200
const ok = Buffer.from('admin:secret').toString('base64');
const res4 = await httpGetAuth(`http://127.0.0.1:${port}/api/dashboard/status`, `Basic ${ok}`);
expect(res4.statusCode).toBe(200);
```

**Checklist:**
- [ ] Every `/api/dashboard/*` route and `/dashboard` require `dashboardAuth()`
- [ ] Wrong/absent/malformed credentials all return `401`, never `500` or `200`
- [ ] A failed auth attempt logs at `warn` with the redacted username, never the password
- [ ] `dashboardConfig.enabled === false` returns `403` (dashboard off), not an open surface

### API3 - Broken Object Property Level Authorization

Two concerns for this service: **mass assignment** and **secret fields in responses**.

**Mass assignment (AJV `additionalProperties`).** Startup config is validated against `config/config.schema.json`; schema objects should set `"additionalProperties": false` so an unknown/extra field is rejected rather than silently accepted. For request bodies, handlers accept only the fields they name (e.g. `{ server }`, `{ channel }`) and ignore the rest — assert the extras have no effect.

```javascript
// Extra fields in a POST body must be ignored, not applied
const res = await httpRequest('POST', '/api/dashboard/dismiss-error', authHeader, {
  server: 'Main',
  isAdmin: true,        // not a real field
  auth: { password: 'x' } // must not mutate config
});
// dismiss-error only reads `server`; the extras are inert
expect(res.statusCode).toBeLessThan(500);
```

**Secret fields never in responses.** The config carries per-server `encryptionPassword`, Basic-auth `password`/`token`, notification `botToken`, and webhook URLs. Responses must expose derived facts, not the secrets. `GET /api/dashboard/servers` deliberately returns `encrypted: !!server.encryptionPassword` — a boolean, never the password itself.

```javascript
const res = await httpGetAuth(`http://127.0.0.1:${port}/api/dashboard/servers`, authHeader);
const blob = JSON.stringify(res.body);
expect(blob).not.toMatch(/encryptionPassword/);
expect(blob).not.toMatch(/botToken/);
expect(blob).not.toMatch(/password/);
expect(res.body.servers[0]).toHaveProperty('encrypted'); // boolean, not the secret
```

**Checklist:**
- [ ] Config schema objects use `"additionalProperties": false`
- [ ] Request handlers read only named fields; extras are inert
- [ ] No response body contains `encryptionPassword`, `password`, `token`, `botToken`, or raw webhook URLs

### API4 - Unrestricted Resource Consumption

`express.json()` parses bodies and `express-rate-limit` caps traffic at 60 req/min/IP. Verify both hold.

```javascript
// Oversized JSON body — Express body parser should reject before handler logic
const huge = { server: 'x'.repeat(2_000_000) };
const res = await httpRequest('POST', '/api/dashboard/sync', authHeader, huge);
expect([400, 413]).toContain(res.statusCode); // not 500

// Rate limit: the 61st request in a window is throttled
let limited = false;
for (let i = 0; i < 70; i++) {
  const r = await httpGetAuth(`http://127.0.0.1:${port}/api/dashboard/status`, authHeader);
  if (r.statusCode === 429) { limited = true; break; }
}
expect(limited).toBe(true);
```

Consider setting an explicit `express.json({ limit: '...' })` cap if the default is too permissive for this surface.

**Checklist:**
- [ ] `express.json()` has (or inherits) a sane body-size limit → `413` on overflow, not `500`
- [ ] Rate limiter returns `429` past the per-IP budget
- [ ] History/metrics reads bound their result set (`getRecentSyncs(50)`, `limit` on `/history`) — no unbounded `SELECT *`

### API5 - Broken Function Level Authorization

**Tier-gating is N/A** — there is one privilege level (admin). The BFLA question here collapses to a single invariant: **is every mutating route behind `dashboardAuth()`?** The dangerous verbs are the POSTs — `sync`, `dismiss-error`, `reset-history`, `test-notification` — each of which triggers a real side effect (starts bank syncs, wipes SQLite history, fires notifications).

```javascript
// Every mutating route must reject unauthenticated callers
const mutating = [
  '/api/dashboard/sync',
  '/api/dashboard/dismiss-error',
  '/api/dashboard/reset-history',
  '/api/dashboard/test-notification'
];
for (const route of mutating) {
  const res = await httpRequest('POST', route, /* no auth */ null, { server: 'all' });
  expect(res.statusCode).toBe(401); // gate fires before the side effect
}
```

**Checklist:**
- [ ] Every POST under `/api/dashboard/*` carries `dashboardAuth()` as middleware
- [ ] A destructive action (`reset-history` with `server: 'all'`) is unreachable without valid credentials
- [ ] Public endpoints (`/health`, `/metrics`, `/ready`, `/metrics/prometheus`, `/icon.png`) are read-only and leak no admin data

### API6 - Unrestricted Access to Sensitive Business Flows

The sensitive flows are **manual sync** (spins up Actual connections + outbound bank syncs) and **test-notification** (sends real email/Telegram/Slack/Discord). Both are auth-gated and covered by the shared 60 req/min limiter. If either becomes abuse-prone, add a tighter per-route limit rather than relying on the global bucket.

**Checklist:**
- [ ] `POST /sync` and `POST /test-notification` sit behind auth + the rate limiter
- [ ] `test-notification` returns `400` for an unconfigured channel instead of attempting a send

### API7 - Server-Side Request Forgery (SSRF)

This is a **real** category for Actual-sync: the service makes outbound requests to (a) each configured Actual server `serverURL` and (b) notification webhooks (Discord/Slack) and SMTP hosts. The defense is that **all of these are operator config, loaded and AJV-validated at startup — never taken from an HTTP request**. No dashboard route accepts a URL and fetches it.

**Audit invariants:**
- No `/api/dashboard/*` handler reads a URL/host from `req.body`/`req.query` and passes it to a fetch, `actual.init`, a webhook post, or SMTP connect.
- `serverURL`, webhook URLs, and SMTP host come only from validated config.
- If a URL ever becomes request-supplied, validate scheme (`https`/`http` only), reject internal/link-local targets (`127.0.0.0/8`, `169.254.0.0/16`, `10/8`, `192.168/16`, `::1`), and disallow redirects to them.

```javascript
// Regression guard: no route should turn attacker input into an outbound fetch
const res = await httpRequest('POST', '/api/dashboard/sync', authHeader, {
  server: 'http://169.254.169.254/latest/meta-data/' // cloud metadata SSRF target
});
// `server` is matched against the configured list, not used as a URL → 404
expect([400, 404]).toContain(res.statusCode);
```

**Checklist:**
- [ ] Outbound targets (Actual `serverURL`, webhooks, SMTP) are config-only, AJV-validated
- [ ] No handler fetches a request-supplied URL
- [ ] If that ever changes: scheme allowlist + internal-range denylist + no redirect-following

### API8 - Security Misconfiguration

Error bodies must carry a stable, non-leaky shape — the custom logger redacts secrets before writing, and **responses are a separate egress path that must redact too**. Existing handlers already return generic messages (`{ error: 'Failed to retrieve metrics' }`) and the `accounts` test asserts an internal DB message never reaches the client.

```javascript
// A handler that throws internally must not leak the internal message or a stack
const res = await httpGetAuth(`http://127.0.0.1:${port}/api/dashboard/accounts`, authHeader);
if (res.statusCode >= 400) {
  const blob = JSON.stringify(res.body);
  expect(res.body).toHaveProperty('error');   // generic, human-readable
  expect(blob).not.toMatch(/db read failed/); // no internal detail (see #99 test)
  expect(res.body).not.toHaveProperty('stack');
  expect(res.body).not.toHaveProperty('stackTrace');
}

// Unknown path → clean 404 JSON, not an HTML stack page
const res2 = await httpGet(`http://127.0.0.1:${port}/nonexistent`);
expect(res2.statusCode).toBe(404);
expect(res2.body).toHaveProperty('error', 'Not Found');
```

**Checklist:**
- [ ] Error responses expose a generic `error` string, never `err.message` from an internal failure, never a stack
- [ ] The `500` path for each handler is tested to not leak the underlying exception text
- [ ] `/metrics`/`/metrics/prometheus` expose operational data only — no secrets in metric labels

### API9 - Improper Inventory Management

The endpoint inventory is small and fully enumerated above. The doc-drift guards (`src/__tests__/docDriftGuards.test.js`) already lock "README endpoints exist as Express routes". Keep the public/protected split honest: a new route is either intentionally public (add it to the `/health`-class list) or auth-gated (add `dashboardAuth()` and a `401` test).

**Checklist:**
- [ ] Every Express route is either in the documented public set or behind `dashboardAuth()`
- [ ] No debug/shadow route ships (nothing outside the enumerated surface)
- [ ] New routes get both a happy-path and an unauth (`401`) test

### API10 - Unsafe Consumption of APIs

Actual-sync consumes the **upstream Actual server** via `@actual-app/api`. Its opaque errors (often empty `PostError`s) are already wrapped by `src/lib/actualApiError.js` → `enhanceActualApiError()`. The consumption-safety rule: treat upstream responses/errors as untrusted — never interpolate a raw upstream error string into a dashboard response or notification, and validate the *shape* of upstream data (accounts, versions) before acting on it. Per-server version compatibility detection (#154/#158) is an example of validating what the upstream reports before trusting it.

**Checklist:**
- [ ] Upstream (`@actual-app/api`) errors pass through `enhanceActualApiError()`, not raw into responses
- [ ] Upstream data (account lists, server version) is shape-checked before use
- [ ] A hostile/garbled upstream response degrades to a handled failure, not a `500` with a stack

## Injection Payload Library

Plain JS arrays (this project is plain JavaScript — no TypeScript).

### SQL Injection (better-sqlite3 uses `?` placeholders — these must stay inert data)
```javascript
const sqlPayloads = [
  "' OR '1'='1",
  "'; DROP TABLE sync_history; --",
  "1; SELECT * FROM sync_history --",
  "' UNION SELECT null,null,null --",
  "Main'--",
  "1' AND 1=1 --",
  "' OR 1=1 LIMIT 1 --",
];
```

### XSS Payloads (stored XSS — e.g. a server name rendered in the dashboard)
```javascript
const xssPayloads = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  '<svg onload=alert(1)>',
  '"><script>alert(document.cookie)</script>',
  "'-alert(1)-'",
  '<iframe src="javascript:alert(1)">',
];
```

### Command Injection (no route shells out today — guard against regressions)
```javascript
const cmdPayloads = [
  '; ls -la',
  '| cat /etc/passwd',
  '$(whoami)',
  '`id`',
  '& ping -c 1 attacker.com',
  '\n/bin/sh',
];
```

### Prototype Pollution / NoSQL-style object injection (server-name keyed writes, #dismiss-error)
```javascript
const objectPayloads = [
  '__proto__',
  'constructor',
  'prototype',
  '{"$gt": ""}',
  '{"$ne": null}',
  '{"$where": "sleep(5000)"}',
];
```

### Path Traversal (static file routes: `/icon.png`, `/dashboard` sendFile)
```javascript
const pathPayloads = [
  '../../../etc/passwd',
  '..\\..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  '....//....//....//etc/passwd',
];
```

## Security Test Template

Express + Jest + Node's built-in `http` module, mirroring `src/__tests__/healthCheck.test.js`. The server is started on a real port; requests go over `http`, with and without a valid Basic-auth header.

```javascript
const { HealthCheckService } = require('../services/healthCheck');
const http = require('http');

// GET helper (parses JSON, tolerates non-JSON bodies)
function httpGet(url, authHeader) {
  return new Promise((resolve, reject) => {
    const opts = authHeader ? { headers: { Authorization: authHeader } } : {};
    http.get(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let body; try { body = JSON.parse(data); } catch { body = data; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    }).on('error', reject);
  });
}

// Generic request helper (POST/PUT/etc. with optional auth + JSON body)
function httpRequest(method, path, authHeader, payload, port) {
  return new Promise((resolve, reject) => {
    const body = payload != null ? JSON.stringify(payload) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (authHeader) headers.Authorization = authHeader;
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Dashboard API security', () => {
  let hc;
  const PORT = 4599; // pick a free port; real suites probe for one (see #95)
  const USER = 'admin';
  const PASS = 'secret';
  const goodAuth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  const base = `http://127.0.0.1:${PORT}`;

  beforeEach(async () => {
    hc = new HealthCheckService({
      port: PORT,
      host: '127.0.0.1',
      getServers: () => [{ name: 'Main', encryptionPassword: 'topsecret' }],
      syncHistory: { getAllAccountMetadata: () => [] },
      dashboardConfig: { enabled: true, auth: { type: 'basic', username: USER, password: PASS } },
      loggerConfig: { level: 'ERROR' },
    });
    await hc.start();
  });

  afterEach(async () => { try { await hc.stop(); } catch { /* already stopped */ } });

  describe('authentication (API2/API5)', () => {
    test('rejects unauthenticated request with 401 + WWW-Authenticate', async () => {
      const res = await httpGet(`${base}/api/dashboard/status`);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/Basic realm="Dashboard"/);
    });

    test('rejects wrong credentials with 401 (not 500)', async () => {
      const bad = 'Basic ' + Buffer.from('admin:wrong').toString('base64');
      const res = await httpGet(`${base}/api/dashboard/status`, bad);
      expect(res.statusCode).toBe(401);
    });

    test('accepts correct Basic credentials', async () => {
      const res = await httpGet(`${base}/api/dashboard/status`, goodAuth);
      expect(res.statusCode).toBe(200);
    });

    test('every mutating route is gated (401 without auth)', async () => {
      for (const route of ['sync', 'dismiss-error', 'reset-history', 'test-notification']) {
        const res = await httpRequest('POST', `/api/dashboard/${route}`, null, { server: 'all' }, PORT);
        expect(res.statusCode).toBe(401);
      }
    });
  });

  describe('secret redaction in responses (API3/API8)', () => {
    test('encryptionPassword never appears in /servers', async () => {
      const res = await httpGet(`${base}/api/dashboard/servers`, goodAuth);
      const blob = JSON.stringify(res.body);
      expect(blob).not.toMatch(/topsecret/);
      expect(blob).not.toMatch(/encryptionPassword/);
      expect(res.body.servers[0]).toHaveProperty('encrypted', true); // boolean, not the secret
    });
  });

  describe('input validation & injection (API1/API3)', () => {
    test('injection payloads never cause a 500', async () => {
      const sqlPayloads = ["' OR '1'='1", "'; DROP TABLE sync_history; --", '__proto__'];
      for (const p of sqlPayloads) {
        const res = await httpRequest('POST', '/api/dashboard/dismiss-error', goodAuth, { server: p }, PORT);
        expect(res.statusCode).not.toBe(500);
      }
    });

    test('unknown server name is rejected, not acted upon', async () => {
      const res = await httpRequest('POST', '/api/dashboard/sync', goodAuth, { server: 'nope' }, PORT);
      expect([400, 404]).toContain(res.statusCode);
    });
  });

  describe('error response format (API8)', () => {
    test('returns generic { error } without stack traces or internal detail', async () => {
      const res = await httpRequest('POST', '/api/dashboard/dismiss-error', goodAuth, {}, PORT);
      if (res.statusCode >= 400) {
        expect(res.body).toHaveProperty('error');
        expect(res.body).not.toHaveProperty('stack');
        expect(res.body).not.toHaveProperty('stackTrace');
      }
    });
  });
});
```
