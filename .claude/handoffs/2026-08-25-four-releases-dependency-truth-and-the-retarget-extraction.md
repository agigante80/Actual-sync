# Session handoff: four releases, the dependency false premise, and the retarget extraction

Date: 2026-08-25

## Summary

Started by reconstructing an abruptly-closed overnight session, then shipped **four
releases (v1.13.0 → v1.16.0)**, closed **12 tickets**, and took the Dependabot alert
count from 11 to **0**. The backlog is now empty. Two review loops hit the
bad-fix-injection trip wire on the same file, and the third attempt fixed the cause
rather than the symptom.

## State at close

- `main` = `development` = `9fe4d19`, VERSION **1.16.0**, tag **v1.16.0**, **zero drift**.
- **0 open issues, 0 open PRs, 0 Dependabot alerts.**
- Suite: **2017 tests / 31 suites**, knip clean, **87/87 mutations** caught, `drift:check` clean.
- Published image `ghcr.io/agigante80/actual-sync:1.16.0` verified: reports 1.16.0,
  manifest carries **amd64 + arm64**, and `/app/scripts/` contains only the four
  operator scripts.
- Local env verified end to end: both servers sync, notifications 4/4, 0 ERROR lines.

## Done this session

| Release | Content |
|---|---|
| v1.13.0 | The overnight batch: #204, #206, #207, #208 (drift reporter, Dependabot split, retarget workflow) |
| v1.13.1 | #200–#203 — all four dependency advisories cleared |
| v1.15.0 | #205, #209, #210, #212 — retarget re-test, evidence check, docs |
| v1.16.0 | #211, #213, #216, #217 — CI drift report, guard fixes, the extraction |

Tickets closed: **#199, #200, #201, #202, #203, #205, #209, #210, #211, #212, #213, #216, #217**.

## Decisions and why

- **The four dependency tickets were fixed, not waived.** All four rested on a false
  premise: a patched release was already **inside each parent's declared range**, so
  `npm update` cleared every advisory with `package.json` byte-identical. The
  vulnerable copy was held by the **lockfile**, not the range. The corrected rule —
  *check for an in-range fix before concluding a transitive must wait* — now lives in
  CLAUDE.md's Dependency Policy, so it is deliberately not duplicated as a memory.
  The same wrong conclusion had been re-derived four times (#51 → #92 → #127 → #200)
  because `.claude/dep-audit-cache.json` cached it; that note is corrected too.
- **#217 changed the testing strategy rather than patching a boundary** — see
  [[extract-logic-out-of-workflow-yaml]]. That loop then closed cleanly in two rounds.
- **#216 finding 5 (`shell:`) deliberately deferred** — building for a value no
  workflow uses. The assumption is documented in the guard.
- **Mutant `210-comment-asserts-retest` deleted rather than escaped**, and its lost
  cover replaced with valid-shell entries.

## Open questions / blocked on

- **Upstream MAJOR still auto-publishes as our PATCH.** Unchanged from 2026-08-06 and
  still a maintainer decision.
- **Unescaped server names in `dashboard.html` `innerHTML`** — five sites, no
  `escapeHtml` helper. Operator-written config behind dashboard auth, so self-XSS at
  worst. Still open, still unticketed.
- **`syncHistory.js` catch blocks ~77% covered.** Pre-existing.
- **The sibling `actual-mcp-server`'s trial unattended run outcome** is still unknown —
  outstanding since 2026-08-04. See [[actual-mcp-server-peer]].
- **Four `.claude` files have been uncommitted since 2026-08-06**: three memory edits
  plus the untracked `2026-08-06-…` handoff. Content is fine; nobody has decided
  whether to commit them.

## Next steps

1. Decide on the four dangling `.claude` files (commit or discard) — three weeks stale.
2. Nothing is blocked. The backlog is empty, so the next session picks new work.
3. If a Dependabot security PR arrives, **watch the first real retarget run** — the
   whole chain (retarget → close/reopen → evidence → status) has never executed
   against a live PR. Only scratch PRs #214 and #215 exercised it.

## Key context to reload

- [[extract-logic-out-of-workflow-yaml]] — the session's biggest lesson.
- [[agent-worktree-isolation]] — updated; review agents and mutation runs collided
  twice today. **Never run both at once in this checkout.**
- [[skip-ci-in-prose-halts-the-release]] — written today after a prose mention of the
  marker stalled a release chain.
- [[verify-the-artifact-not-the-source]], [[mutation-testing-standard]], [[user-agigante]].
- **Node:** `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"` or ~74 tests
  error spuriously.
- **Verified platform facts** (both now in CLAUDE.md + docs/CI_CD.md): a **conflicting
  PR produces no CI run at all** — GitHub never computes `refs/pull/N/merge`, and
  close/reopen does not change that; and `gh run list --commit <sha>` returns the
  pre- and post-reopen runs together, so only a **newer** run id is evidence.
- Local env: `.claude/commands/local-env.md`. A forced sync sends **real** notifications.
