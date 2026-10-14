# Roadmap

Rolling wave plan. This file owns which phases exist and their state. The ticket's milestone on
GitHub owns which phase a ticket is in. Only an `open` phase carries commitment; `planned` prose is
a reason, not a promise. Checked by the forge-kit roadmap-phases scripts (`check-phases.sh`).

## Phase: P0 Security and bug patch
state: done
plan: docs/plans/p0-security-and-bug-patch.md

Close the exposed and broken things before adding features: the unauthenticated live log stream,
the timing-unsafe credential compare and auth throttle, the trust proxy gap under it, the unpinned
trivy action, the Dismiss button that always fails, and concurrent syncs on the shared Actual API
session. Also lands the browser E2E harness, because every later phase is dashboard work and needs
it. Ships as v1.17.x patches.

Outcome: done (2026-09-27). Every planned ticket landed (#242, #245, #246, #248, #263, #264,
#265), plus #272 (phase timeouts), which surfaced while fixing #265. Planned as one patch per
ticket; shipped as v1.17.2 in a single release instead, because the fixes landed overnight in
sequence. Review lows went to backlog as #280, #284, #286, #288 and #289.

## Phase: P1 v1.18 Payment alerts
state: done
plan: docs/plans/p1-v1-18-payment-alerts.md

User-configurable message templates first, then overdue-payment alerts built on Actual schedules.
Comes after P0 because alerts read budget state at sync time, which is only safe once syncs are
serialised.

Outcome: done (2026-10-14), shipped as v1.18.0. Templates (#257) and schedule alerts (#258, with
the gate follow-ups in #271) landed, plus the review follow-ups #294 and #297. The release also
carries the P2 groundwork early (helmet/CSP #243, vendored Chart.js #244), the timezone setting
(#266), auto-retry and graceful shutdown (#273), the P0 review lows (#280, #284, #286, #288) and
supply chain work from the backlog (#249, #254), the payments API from P2 (#260) and the
digest fairness fixes (#337, #338). Review lows went to backlog as #326 and #332.

## Phase: P2 v1.19 Payments tab
state: open

Read-only Payments tab showing watched schedules and alert status. Helmet/CSP and the vendored
Chart.js land first in this phase, because the new tab adds dashboard script that must be written
under the CSP rather than retrofitted. Both already shipped in v1.18.0. The tab itself is split in
two: #260 persists the alert snapshot and serves `GET /api/dashboard/payments` (shipped in
v1.18.0), then #341 builds the tab UI on that API.

## Phase: P3 v1.20 Control from the dashboard
state: planned

The first dashboard writes: Origin check on every POST, opt-in config writes and an audit trail,
then enable/disable and mute-until for alerts. The security ticket goes first because it guards the
writes that follow.

## Phase: P4 v1.21 Alert editor
state: planned

Add and edit payment alerts from the dashboard with the Actual schedule picker, preview and export.
Last because it depends on every write guard from P3.

## Phase: Backlog
state: backlog

Worth doing, not yet ordered: loan split, activity-based notifications, metrics auth, and the
remaining supply chain and Docker hardening. Items move out when a phase is shaped.
