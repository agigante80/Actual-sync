# Plan: P4 v1.21 Alert editor

## Goal
Add and edit payment alert rules from the dashboard, with the Actual schedule picker, preview and
test send, on top of every write guard from P3. Carry the fixes and dependency work that gathered
in the milestone.

## Done looks like
- Rules created on the dashboard are stored in SQLite, merged with the config rules at sync, and
  served by the payment rule, schedule snapshot and preview routes behind auth, the Origin check
  and the config-writes gate (#262, shipped on development by PR #364).
- The editor dialog opens from the Payments tab, validates each field against the same rules as
  the API, shows every error where it was made, and never leaves Save disabled without a visible
  reason (#268, PR #379).
- Reset all history also deletes the dashboard rules of servers removed from the config (#372),
  and that purge runs only while config writes are on (PR #380).
- Retargeting a rule closes the old schedule's open `missing` alerts once per destination (#373).
- The CodeQL actions run at v4.39.1 together (#374, #395) and dockerhub-description at v5 (#375).
- The direct runtime (#393) and dev (#394) dependencies are at their latest published versions,
  with the 5-day cooldown respected.
- Released as v1.21.0 with CI green, and every ticket above closed with the release named.

## Fails if
It is the end of P4 and it failed badly. What happened?
- An operator saved a rule that looked valid in the dialog and the next sync rejected it, because
  the browser validator and `scheduleAlertRules.js` drifted. Guard: the dialog posts to the same
  validator through the preview route, and the e2e spec saves every fixture rule and syncs it.
- Save was disabled and the operator could not see why, because the error sat in a collapsed
  template section. Guard: a template section with an error is opened and the save hint uses the
  same "error shown" condition as the button; e2e scenario for a collapsed template error.
- A dashboard rule was silently superseded by a config rule with the same id and the operator kept
  editing a rule that never ran. Guard: the superseded flag is shown in the row and the editor.
- A test send leaked a real notification to every channel during editing. Guard: the test send is
  rate limited, targets the chosen channels only and is labelled as a test in the template.
- A dependency bump broke the e2e suite or knip and was merged anyway because the bump PR skipped
  the slow checks. Guard: every bump runs jest, knip and the e2e suite before merge; a new knip
  finding is triaged in the ticket, never silenced.
- The release carried a version that disagreed between package.json, VERSION and the lockfile.
  Guard: `npm run version:bump -- minor` writes all three and auto-release checks them.

## Expected work
PR #379 (#268) finishes its round-2 fix and merges; PR #380 is reviewed and merged; #395 pins
the CodeQL actions (#374 and #375 are already on development); #393 and #394 bump the
dependencies once their cooldown dates pass; then development is promoted to main as v1.21.0.

## Out of scope
- Anything that needs `@actual-app/api` 26.11.0: #298, #391, #392, #236 (P6).
- Metrics auth, SBOM and Docker hardening: P5.
- Loan split #256: backlog.
