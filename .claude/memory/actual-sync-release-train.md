---
name: actual-sync-release-train
description: The @actual-app/api release train is PROVEN end-to-end as of 2026-08-03 (26.7.0 -> 26.8.0, v1.11.6)
metadata:
  type: project
---

Issue **#165** (fully automate `@actual-app/api` upgrades end-to-end) went live 2026-07-25.
`.github/workflows/dependency-update.yml` ("Actual API Release Train") branches off `main`, bumps
the dep, opens a PR to `main`, merges it once full CI passes, and auto-release tags and publishes.

**Its riskiest path is no longer unverified.** Overnight on **2026-08-03** upstream published
`@actual-app/api` **26.8.0** (the first move past 26.7.0 since 2026-07-03) and the train ran the
real path end to end, unattended: branched, bumped, opened **PR #190**, merged on green CI, and
auto-release published **v1.11.6**. No intervention, no failure at the chain verifier. The
previously-recorded worry — that the first genuine run could fail *after* the merge landed if the
GitHub App lacked `pull_requests: write` — did not materialise.

Still true and worth keeping in mind:

- **Majors are auto-published** (owner's explicit informed decision despite the mocked-API test
  gate); the one-line revert to same-major-only is documented in the ticket and CLAUDE.md.
- Scheduled workflows run only from the **default branch (`main`)**.
- The train automates **`@actual-app/api` only**. Every other dependency is a human decision —
  see `[[verify-the-artifact-not-the-source]]` for how a native-module major was handled (#185).
- If you are mid-work on `development` when it fires, `main` moves underneath you. Fetch and merge
  `main` into `development` before continuing, or the badge/version files conflict later.

**Why:** the ticket's open risk is now closed, and a future session should not spend time
re-verifying it or treating a train-generated release as unexpected.
**How to apply:** treat a surprise `chore(release)` commit and version bump on `main` as normal —
check whether the Actual API train produced it before assuming something went wrong. Related:
[[actual-mcp-server-peer]], [[node-version-hook-trap]].
