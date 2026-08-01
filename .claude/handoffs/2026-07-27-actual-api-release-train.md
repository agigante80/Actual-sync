# Session handoff: @actual-app/api release train (#165) + CLAUDE.md refresh

Date: 2026-07-27

## Summary
Started as a `/init` CLAUDE.md refresh, became the design, implementation, two-round
cross-project peer review, and live rollout of a fully-automated `@actual-app/api`
release train (issue #165). It is now merged, live, and closed; v1.10.1 was published as
a side effect of the merge.

## Done this session
- **CLAUDE.md**: refreshed (undocumented `src/lib/` modules, two-layer retry, version-
  compat flow, notification channels incl. "no Teams", rate limiter) and later extended
  with the release-train invariants.
- **#165 implemented**: rewrote `.github/workflows/dependency-update.yml` into the
  "Actual API Release Train"; updated `.github/dependabot.yml` (ignore `@actual-app/api`
  entirely), `docs/CI_CD.md`, `CLAUDE.md`.
- **Two rounds of adversarial peer review** with the `actual-mcp-server` inter-session
  peer. Net: 5 real bugs found and fixed (dead `always()` step, push outside best-effort
  guard, `jq` literal-`"null"` mergeCommit, race-treated-as-divergence, unconditional
  `cancelled` exit 0). Corrected two of the peer's findings with evidence.
- **Added** a downstream chain verifier (trigger-proof hard gate + capped observational
  watch) and a sync-PR-on-divergence path; `trap ... EXIT` for HEAD restore.
- **actionlint**: no schema/expression errors (only info-level SC2086, matching repo
  convention).
- **Merged `development` -> `main`** (merge `77b7a1b`) on explicit request. Full chain
  fired live and green: ci-cd -> auto-release patch-bump to **v1.10.1** -> tag -> GitHub
  Release -> Docker publish + metrics-badges.
- **Back-merged `main` -> `development`** (fast-forward) on request; both branches now at
  `24afd97`, VERSION 1.10.1, **zero drift**.
- **#165 closed** as completed with an evidence comment.

## In progress (where we left off)
- Nothing actively mid-edit. Working tree was clean at close; both branches in sync.

## Next steps
1. **Watch the first real `@actual-app/api` upgrade** (upstream still 26.7.0 at close; all
   newer are `26.8.0-nightly.*`, not on `latest`). That run is the true acceptance test of
   the dep-specific path (branch->bump->PR->chain verifier). See memory
   `actual-sync-release-train`.
2. **Dependabot vulns**: count rose to **10 (8 high, 1 moderate, 1 low)** on the default
   branch during this session's pushes — unrelated to this work, worth triage per the repo
   Dependency Policy (direct deps only; no overrides).
3. **Optional `.nvmrc` with `22`** — offered, user has not answered. See open questions.
4. **Reciprocal item for actual-mcp-server**: their sync PR uses `github.token` so it gets
   no CI — raise with the user / that repo. See memory `actual-mcp-server-peer`.

## Decisions and why
- **Version not bumped in the train** — auto-release patch-bumps only when `V_main == V_tag`.
- **Sync `development` at the START of the run**, not back-merge after — avoids racing the
  post-tag bump + badge commits.
- **`--ff-only`, never force**; rejected push = race (retry once, no PR), failed ff =
  divergence (open sync PR with the **App token** so it gets CI).
- **Poll `gh pr checks`** instead of `--auto` merge — repo has `allow_auto_merge:false` and
  no branch protection on `main`.
- **Majors auto-published** — owner's explicit informed override of the recommendation
  (tests mock the API); one-line revert documented.

## Open questions / blocked on
- **`.nvmrc`?** Offered to add `.nvmrc` = `22` (only repo-side option; the real fix for the
  Bash-tool hook trap is upgrading system `/usr/bin/node` 18->22). No answer yet.

## Key context to reload
- Memory: `actual-sync-release-train`, `actual-mcp-server-peer`, `node-version-hook-trap`,
  `user-agigante`.
- Files: `.github/workflows/dependency-update.yml`, `.github/workflows/auto-release.yml`,
  `.github/dependabot.yml`, `docs/CI_CD.md` (§ "Automated @actual-app/api updates").
- Issue: https://github.com/agigante80/Actual-sync/issues/165 (closed).
- **Before any hook-gated push from the Bash tool**: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` (see `node-version-hook-trap`).
- Peer review via inter-session peer `actual-mcp-server`.
