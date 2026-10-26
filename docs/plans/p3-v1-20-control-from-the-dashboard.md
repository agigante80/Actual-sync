# Plan: P3 v1.20 Control from the dashboard

Written retroactively on 2026-10-26, after the phase closed, so that every done phase carries the
same five sections. The premortem below is what would have been written at the start; the guards
name what actually caught each failure.

## Goal
Let the operator act on alerts from the dashboard (enable, disable, mute until) behind guards
that make the first dashboard writes safe.

## Done looks like
- Every dashboard POST checks the Origin header, config writes are opt-in and every write lands in
  an audit trail (#259).
- Alerts can be enabled, disabled and muted until a date from the Payments tab, with a mute-end
  summary (#261, with #270 folded in).
- Released as v1.20.0 with CI green.

## Fails if
It is the end of P3 and it failed badly. What happened?
- A cross-site page on the operator's browser toggled an alert, because the write routes trusted
  the session cookie alone. Guard: the Origin check on every POST, tested with a foreign origin.
- An operator who never opted into config writes found their config file rewritten. Guard:
  `configWritesReason()` gates every write and the route tests cover the off state.
- A mute silently outlived its date, or a muted alert still fired. Guard: mute-until evaluated with
  an injected clock, and the mute-end summary tested across the boundary.
- A write bypassed the audit trail. Guard: the audit row is written in the same transaction as the
  change, with a test per route.

## Expected work
#259 first, then #261.

## Out of scope
- Creating and editing rules from the dashboard: P4.
