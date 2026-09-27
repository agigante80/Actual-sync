# Plan: P1 v1.18 Payment alerts

## Goal
Notify the operator when an expected recurring payment, modelled as an Actual schedule, did not
happen, using message templates the operator can change.

## Done looks like
- `src/lib/templateRenderer.js` compiles Handlebars templates with AST validation at startup, and
  every channel gets correctly escaped output; existing notifications are byte for byte unchanged
  against a baseline snapshot committed before any code change (#257).
- A server with a `scheduleAlerts` block gets `missing`, `wrongAmount`, `cannotCheck`, `resolved`
  and `ruleUnmatched` notifications from a step that runs inside its sync, after the bank-sync
  loop, and never changes the sync result (#258).
- Every open item of #271 is reflected in the #258 implementation and tests, or rejected with a
  reason in the #258 PR.
- A server without the block never calls `getSchedules()`.
- README carries the "Missing-payment alerts" section with ten scenarios; `docs/SCHEDULE_ALERTS.md`
  exists; the drift guards pass.
- Released as v1.18.0 with CI green.

## Fails if
It is the end of P1 and it failed badly. What happened?
- A false `missing` alert went out for a payment that had arrived, because the bank connection was
  stale or the window maths was off by a day around midnight or DST, and the operator stopped
  trusting the alerts. Guard: `cannotCheck` whenever `last_sync` is not after the deadline or is
  stale; injected clock and timezone in every evaluation test; the #271 boundary scenarios.
- The same alert repeated on every sync, because the ledger key or the failed-send rule was wrong.
  Guard: de-duplication tested across two syncs and a restart with a real temp SQLite file.
- The alert step broke syncing: an exception, a slow `aqlQuery`, or a second Actual session.
  Guard: the step runs inside the existing session under the #265 queue, is wrapped in a WARN-only
  catch, and has a service-level test proving the sync result is unchanged when it throws.
- Existing notifications changed shape (a Telegram `parse_mode`, escaping) and broke operators'
  parsers. Guard: the payload snapshot is committed first and must not change.
- A template reached config secrets or prototype members. Guard: AST whitelist, `knownHelpersOnly`,
  `lookup` and `log` rejected, and a test that no secret key is in the render context.
- Overlapping windows (#271 item 1) double counted a payment or inverted the late window.
  Guard: reject `graceDays + earlyDays >=` the shortest interval at config load, with a test.

## Expected work
#257 first (it blocks #258), then #258 with #271 resolved inside the same PR.

## Out of scope
- Dashboard surfaces for alerts: #260 (P2), #259 and #261 (P3), #262 (P4).
- Global `timezone` setting #266: backlog; `resolveTimezone` picks it up when it lands.
- Post-sync loan split #256: backlog.
