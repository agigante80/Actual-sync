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
state: done
plan: docs/plans/p2-v1-19-payments-tab.md

Read-only Payments tab showing watched schedules and alert status. Helmet/CSP and the vendored
Chart.js land first in this phase, because the new tab adds dashboard script that must be written
under the CSP rather than retrofitted. Both already shipped in v1.18.0. The tab itself is split in
two: #260 persists the alert snapshot and serves `GET /api/dashboard/payments` (shipped in
v1.18.0), then #341 builds the tab UI on that API.

Outcome: done (2026-10-14), shipped as v1.19.0. The Payments tab (#341) landed on the #260 API
with per-server Sync now, filters, polling and a mobile card layout. The P3 tickets were gated the
same night: #270 was folded into #261, and #259 and #261 were revised for implementation.

## Phase: P3 v1.20 Control from the dashboard
state: done
plan: docs/plans/p3-v1-20-control-from-the-dashboard.md

The first dashboard writes: Origin check on every POST, opt-in config writes and an audit trail,
then enable/disable and mute-until for alerts. The security ticket goes first because it guards the
writes that follow.

Outcome: done (2026-10-14), shipped as v1.20.0. The write guards (#259: Origin check, opt-in config
writes, audit trail) and the alert controls (#261: enable/disable and mute-until with a mute-end
summary) landed. The release also carries the schedule alert fixes #326 (completed one-off
schedules), #296, #332, #356 (deleted schedules, ruleUnmatched once) and #359 (empty schedule list
skips matching), the e2e harness fixes #289, and supply chain work from the
backlog: the npm audit gate (#250), Dependabot cooldown (#251), Scorecard (#255) and the pinned
Docker base image with Dependabot updates (#362).

## Phase: P4 v1.21 Alert editor
state: done
plan: docs/plans/p4-v1-21-alert-editor.md

Add and edit payment alerts from the dashboard with the Actual schedule picker, preview and test
send. Comes after P3 because it depends on every write guard from there. Also carries the fixes
and dependency work that gathered since v1.20.0: the reset and retarget bugs (#372, #373), the
CodeQL and dockerhub action bumps (#374, #375, #395) and the direct dependency bumps (#393, #394).

Outcome: done. Released as v1.21.0 on 2026-10-26. The editor API and storage (#262) and the
dialog (#268) landed, with the reset purge (#372) and the retarget close (#373). The CodeQL
actions moved to v4.39.1 together (#374, #395) and dockerhub-description to v5 (#375); the direct
runtime (#393) and dev (#394) dependencies are at their latest versions. Nothing was dropped or
moved out.

## Phase: P5 v1.22 Hardening
state: done
plan: docs/plans/p5-v1-22-hardening.md

Opt-in auth for the metrics endpoints independent of the dashboard (#247), an SBOM and build
provenance attestation for the Docker image (#252), and hardened compose and Unraid defaults:
localhost bind, cap_drop, no-new-privileges, read-only rootfs (#253). Comes after P4 because none
of it needs the api release P6 waits for, and all of it can ship while that release is pending.

Outcome: done. Released as v1.22.0 on 2026-10-26. The metrics credential (#247), the SBOM and
signed provenance (#252, verified with `gh attestation verify` on Docker Hub and GHCR, SBOMs on the
release) and the hardened compose and Unraid defaults (#253) landed. As the plan allowed, the
read-only root filesystem shipped as a documented opt-in, because a custom PUID/PGID cannot start
with it; making it work for every ID went to backlog as #409.

## Phase: P6 v1.23 Sync activity
state: planned
plan:

Carry the transaction counts the new runBankSync result exposes into the run summary and the
generic payload (#391), add the activity_only notification mode on top of them (#392, #236), and
replace the vendored schedule expansion with getScheduleDates (#298). Waits for @actual-app/api
26.11.0, expected in the first days of November 2026; the release train bumps the api on its own,
and this phase opens once that bump lands on development.

## Phase: Backlog
state: backlog

Worth doing, not yet ordered: the post-sync loan split (#256). It stays here because it would be
the first feature that writes transactions into Actual, which changes the read-only posture the
README promises, and that is the owner's call before it is shaped into a phase. Also the read-only
root filesystem for a custom PUID/PGID (#409), left over from P5. Items move out when a phase is
shaped.
