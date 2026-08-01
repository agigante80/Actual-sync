---
name: actual-sync-release-train
description: Release train live since 2026-07-25 (v1.10.1); the dep-upgrade path is untested until upstream moves past 26.7.0
metadata:
  type: project
---

Issue **#165** (fully automate `@actual-app/api` upgrades end-to-end) was implemented, merged to `main`, and went **live on 2026-07-25**; the merge published **v1.10.1** and the issue is closed. The workflow `.github/workflows/dependency-update.yml` was renamed "Actual API Release Train" and CLAUDE.md / docs/CI_CD.md document the design. That much is in code + git.

What is **NOT** obvious from the repo and worth watching:

- The **`@actual-app/api`-specific path has never run end-to-end** (branch off `main` -> bump dep -> PR to `main` -> full CI -> merge -> chain verifier). It only fires when upstream publishes a version **newer than 26.7.0 on the `latest` dist-tag**, which had not happened as of session end. The no-op path and the whole promotion/release chain WERE proven live. **Next real upstream release is the true acceptance test** — watch that run; by design the first real run can fail *at the chain verifier, after the merge has landed*, if the GitHub App lacks `pull_requests: write` — that is expected behaviour, not a regression.
- **Majors are auto-published** (owner's explicit informed decision despite the mocked-API test gate); the one-line revert to same-major-only is documented in the ticket/CLAUDE.md.
- Scheduled workflows run only from the **default branch (`main`)**, which is why the merge was required to make the daily cron use the new train.

**Why:** the ticket is closed but its riskiest path is still unverified in production.
**How to apply:** when upstream `@actual-app/api` moves past 26.7.0, watch the dependency-update run end-to-end and confirm the PR-create/merge and chain verifier behave. Related: [[actual-mcp-server-peer]], [[node-version-hook-trap]].
