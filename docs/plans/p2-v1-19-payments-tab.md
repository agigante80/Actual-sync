# Plan: P2 v1.19 Payments tab

Written retroactively on 2026-10-26, after the phase closed, so that every done phase carries the
same five sections. The premortem below is what would have been written at the start; the guards
name what actually caught each failure.

## Goal
Show the operator, on the dashboard, which schedules are watched and what their alert status is,
without any dashboard write.

## Done looks like
- `GET /api/dashboard/payments` serves the persisted alert snapshot per server (#260).
- A Payments tab renders that snapshot with per-server Sync now, filters, polling and a mobile card
  layout, written under the helmet CSP with the vendored Chart.js (#341, on #243 and #244).
- Released as v1.19.0 with CI green.

## Fails if
It is the end of P2 and it failed badly. What happened?
- The tab's script was written before the CSP landed and had to be rewritten under it. Guard:
  #243 and #244 shipped in v1.18.0, before any tab code.
- The tab showed stale alert state because the snapshot was read at sync time but served from a
  cache that never refreshed. Guard: the route reads the ledger on every call; polling tests in the
  e2e suite.
- Polling hammered the server on a phone left open on the tab. Guard: visibility-aware polling with
  a fixed interval, covered by the #341 e2e spec.

## Expected work
#260 first (API, shipped early in v1.18.0), then #341 (the UI).

## Out of scope
- Any dashboard write: P3.
- The editor: P4.
