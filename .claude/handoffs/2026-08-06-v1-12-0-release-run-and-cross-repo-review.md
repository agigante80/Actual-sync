# Session handoff: v1.11.2 → v1.12.0 release run, path guards, and the cross-repo review

Date: 2026-08-06

## Summary

A long session that shipped **five releases** (v1.11.2 through v1.12.0), closed nine tickets,
and ran a five-round adversarial review with the sibling `actual-mcp-server` session that
changed decisions in both repos. Everything shipped is released and verified. Three small
things are left open and none of them block anything.

## State at close

- `main` = `7664266`, `development` = `349e0a0`, VERSION **1.12.0**, tag **v1.12.0**.
- `development` is 2 commits ahead of `main`; `main` is 0 ahead, so **the next merge to main
  fast-forwards cleanly** (the recurring badge-refresh divergence was back-merged on 2026-08-04).
- Working tree has **one uncommitted change: `CLAUDE.md`** (+64 lines, see below).
- **Zero open issues.** Two open Dependabot PRs (#191, #192).
- Suite: **1604 tests**, knip clean, **67/67 mutations caught** on a baseline verified stable
  over eight consecutive runs.

## Done this session

Releases, each verified against the *published* image rather than the build:

| Version | Content |
|---|---|
| v1.11.2 | #177 — `validate-config` trustworthy in Docker; mutation testing automated |
| v1.11.3 | #178 temp-path, #179 `--fast` baseline, #180 release scripts out of the image |
| v1.11.4 | #176 — dead `formatErrorNotification` family (285 lines) + the class-method gate |
| v1.11.5 | #182 all six channels testable, #183 three more scripts out of the image |
| v1.11.6 | **Not ours** — the Actual API release train fired unattended for `@actual-app/api` 26.8.0 |
| v1.12.0 | #186, #187, #188, #184/#185 (better-sqlite3 13) — minor, because #188 adds an endpoint |

Also: machine-specific paths purged and guarded two ways (CI scan + a `PreToolUse` hook at
`.claude/hooks/no-host-paths.sh`); `.claude/memory/` and `.claude/handoffs/` are now **tracked**;
`REVIEWED_KEPT` in the dead-method guard is **empty**, closing out #181.

## In progress (where we left off)

1. **`CLAUDE.md` is modified and uncommitted** (+64 lines, from `/init`). Adds the missing
   `npm run test:mutation` commands, a mutation-testing rules subsection, the `notifications`
   endpoint and six-channel `test-notification`, the newer code-health guards, and a
   Project-memory section. Every claim in it was verified programmatically. Review with
   `git diff CLAUDE.md` — it is a docs-only change, safe to commit or discard.
2. **The release-train hardening ticket is NOT filed.** Five confirmed gaps, written up in
   `[[train-unattended-gaps]]`. This is the largest piece of real work outstanding.
3. **Two Dependabot PRs, both green and mergeable, neither reviewed:**
   - **#191** knip 6.29.0 → 6.31.0, dev-dependencies, base `development`. Low risk.
   - **#192** `npm_and_yarn` **security** group, 4 updates, lockfile only, base **`main`**.
     Note the base: merging it to `main` triggers auto-release and would publish **1.12.1**.
     Checked — it does **not** float `@actual-app/api`, so we avoid the lockfile trap that
     broke the sibling repo's #319.

## Next steps

1. Decide on `CLAUDE.md` — commit or discard. Nothing depends on it.
2. File the train-hardening ticket from `[[train-unattended-gaps]]`. Suggested order inside it:
   notification first (every other control's value depends on someone learning about failure),
   then the denylist + exact-pin revert runbook, then the soak window, then the arm64 manifest
   assertion.
3. Handle #191 and #192. #192 publishes a release — do it deliberately, not by reflex.
4. Ask the sibling session how its trial unattended run went (it was scheduled for the night of
   2026-08-04 and we never heard the outcome).

## Decisions and why

- **Minor bump for v1.12.0**, done manually on `development` before the merge, because #188 adds
  a dashboard endpoint. Auto-release correctly released it as-is rather than patch-bumping.
- **#188 was wired up rather than deleted.** `getStats()` was unwired, not dead; rate limiting was
  otherwise invisible to users.
- **#187 re-pointed the 13 redaction tests before deleting `formatLog`**, so a behavioural
  difference would have shown up as a failure rather than being deleted along with the wrapper.
- **The dashboard UI mattered as much as the API.** The first #182 implementation added route
  cases only; the four hardcoded buttons meant the reported symptom was unchanged. A guard now
  checks the route *and* the buttons.
- **#185 verified arm64 before merging**, because CI only builds that platform on `main`/tags, so
  a failure would first appear as a tagged release with no image behind it.

## Open questions / blocked on

- **Upstream MAJOR currently auto-publishes as our PATCH.** The sibling changed theirs to bump a
  minor, reasoning that semver describes their own contract, not their dependency's. It lands
  differently here (they mirror the API surface in 71 tools; we call nine methods behind a sync
  service, so an upstream major often changes nothing observable) — but "often nothing" is not
  "never", and a patch gives users no signal to read release notes. **Maintainer decision, not
  taken.**
- **Unescaped server names in `dashboard.html` `innerHTML`** — five sites including one added
  this session; no `escapeHtml` helper exists. Operator-written config behind dashboard auth, so
  self-XSS at worst. Fixing it means touching all five; deliberately not widened into #188.
- **`syncHistory.js` catch blocks remain ~77% covered.** Pre-existing; noted when closing #185.
- **`sqliteDriver.test.js` is non-hermetic** and sits in the blocking suite — see
  `[[hermetic-guards]]`. Harmless while the driver is lockfile-pinned, but misplaced.

## Key context to reload

- `[[train-unattended-gaps]]`, `[[hermetic-guards]]`, `[[verify-the-artifact-not-the-source]]`,
  `[[flaky-tests-poison-mutations]]`, `[[actual-mcp-server-peer]]` — the five memories that
  carry this session's durable findings.
- **Node:** the shell defaults to v18 and the repo needs >= 22. Prefix commands with
  `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"` or ~74 tests error spuriously.
- **`gh` is a snap**: it cannot read `/tmp` or dotfiles at `$HOME` root. Stage `--body-file`
  content as a non-hidden file in `$HOME`.
- **Never touch the working tree while `npm run test:mutation` runs.** A killed run leaves a
  stale `.mutation-test.lock`; `--recover` reports honestly and the next `acquireLock()` clears
  it. Both behaved correctly when a run was killed this session. Long full runs can exceed the
  background-task limit — run them per-ticket with `--fast --ticket '#NNN'`.
- **Repeat-run the suite before trusting a mutation score.** A single flake scores a false
  "caught"; a full 67/67 had to be discarded and re-measured this session for exactly that.
- Local env: `.claude/commands/local-env.md`. The config holds **live** credentials — a forced
  sync sends real notifications.
