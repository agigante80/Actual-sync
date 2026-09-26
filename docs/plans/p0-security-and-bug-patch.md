# Plan: P0 Security and bug patch

## Goal
Close the exposed and broken dashboard and sync paths, and land the browser E2E harness, before
any feature work starts.

## Done looks like
- `/ws/logs` refuses unauthenticated clients and cross-site upgrades (#242).
- Behind a reverse proxy the rate limiter keys on the real client address (#245), and dashboard
  credentials are compared in constant time with their own throttle (#246).
- No workflow references a mutable action ref in a job holding write permissions (#248).
- The Dismiss button works (#264).
- Syncs that touch the Actual API never overlap (#265).
- `npm run test:e2e` drives the real dashboard in a browser from shared fixture states, and the
  screenshot generator runs on the same harness (#263).
- Each landed as a v1.17.x patch release with CI green.

## Fails if
It is the end of P0 and it failed badly. What happened?
- The sync queue (#265) deadlocked or starved a server, and scheduled syncs silently stopped.
  Guard: a throwing sync must release the lock, tested; the queue is logged per server.
- The WebSocket auth (#242) broke the live log view for users with auth `none`, or behind a proxy.
  Guard: explicit tests for every auth type and for the proxy case after #245.
- Trust proxy (#245) was set too broadly and let any client spoof `X-Forwarded-For` to dodge the
  limiter. Guard: config-driven hop count, default off, tested both ways.
- The E2E harness (#263) was flaky in CI and got skipped, so later phases shipped untested UI.
  Guard: fixed clock, timezone and fixtures; no external network; it runs in CI from day one.
- A patch release shipped red because "green" was read from a partial check list.
  Guard: release only after every required check on the promotion PR has passed.

## Expected work
#264, #265, #248, #245, #246, #242, #263. Order: the small fixes first, then the queue, then the
auth work, then the harness.

## Out of scope
- #266 timezone setting: backlog; #258 resolves the timezone itself.
- #247 metrics auth and the rest of the hardening batch (#249 to #255): backlog.
- Helmet/CSP (#243) and vendored Chart.js (#244): P2.
