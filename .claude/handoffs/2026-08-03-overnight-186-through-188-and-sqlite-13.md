# Session handoff: overnight run — #186, #187, #188, #185 → v1.12.0

Date: 2026-08-03 (unattended; user asleep)

## Summary

Implemented four tickets, bumped to a **minor**, and released **v1.12.0**. All merged to `main`,
back-merged, published and verified against the shipped image. No open work in flight.

## State at close

- `main` and `development` both at **`fbdec56`**, VERSION **1.12.0**, tag **v1.12.0**, no drift.
- Working tree clean.
- **1604 tests**, knip clean, **67/67 mutations caught** on a baseline proven stable over 8 runs.
- **Zero open issues. Zero open PRs.**

## What shipped

| Ticket | Outcome |
|---|---|
| **#186** | Deleted five methods with no production references (31 lines) |
| **#187** | Deleted `formatLog`; re-pointed its 13 redaction assertions at the live write path |
| **#188** | `GET /api/dashboard/notifications` + Notification Activity panel |
| **#185 / PR #184** | `better-sqlite3` 12.11.1 → 13.0.2, verified incl. arm64 |
| **#181** | Tracker closed — `REVIEWED_KEPT` is now empty |

Also released earlier the same night by the automation: **v1.11.6** (see below).

## The three findings worth remembering

**1. A flaky test had already poisoned a mutation score.** Two of the new driver tests failed
~1 run in 5 (`SqliteError` vs `toBeInstanceOf(Error)` across jest realms). A full `67/67 caught`
had been recorded against that unstable baseline and had to be discarded and re-measured. The
runner takes a *single* green baseline, so a flake scores a false "caught". Now recorded in
`[[flaky-tests-poison-mutations]]`. **Repeat-run the suite before trusting any mutation score.**

**2. Scoring the redaction mutations found two real gaps.** Removing `maskSecrets(message)` and
`redact(this.context)` from the write path broke *no test*. Every existing redaction assertion
operated on `meta`, so a secret interpolated into the log message, or carried in a child logger's
context, was unguarded. Neither was a live defect — production does mask both — but nothing would
have noticed if it stopped, on the one path where the failure mode is a credential on disk. Four
redaction mutations added; there were none before.

**3. The #188 panel shipped with a dishonest label, caught by running it.** After an in-process
sync the counter still read 0, because `updateRateLimitTracking()` only fires for
`status === 'failure'` — rate limiting is failure-only by design. The panel and docs claimed it
counted notifications *sent*. Both corrected to say failure alerts. Reading the code would not
have surfaced this; triggering a sync did.

## Notable: the Actual API release train fired for real

Overnight, upstream published `@actual-app/api` **26.8.0** — the first move past 26.7.0 since
2026-07-03. The train branched off `main`, bumped, opened **PR #190**, merged on green CI, and
auto-release published **v1.11.6**, unattended and without failure. This was its riskiest
unproven path. `[[actual-sync-release-train]]` is updated accordingly.

Practical consequence: `main` can move underneath you mid-session. Fetch and merge before
continuing, or the badge/version files conflict at merge time.

## Guards added this session

- **Every dashboard `load*()` must be invoked** — immediately found `loadHistory()`, dead since
  `loadHistoryTab()` superseded it (28 lines, removed).
- **Every documented dashboard endpoint must be a real route** (docs/HEALTH_CHECK.md table).
- Both are general, not specific to this change.

`src/__tests__/sqliteDriver.test.js` (16 tests) is the reusable harness for any future driver
bump — it asserts **type as well as value** across the JS/native boundary, which is the failure
mode that does not announce itself.

## Verification performed

- arm64 built under QEMU **before** merging, because CI only builds that platform on `main`/tags —
  a failure would otherwise first appear as a tagged release with no image. Binary came from
  `prebuilds/linux-arm64.node`, a shipped prebuild, on musl.
- Full local-env: both servers synced successfully, 4/4 notifications each, zero ERROR lines.
- Published `ghcr.io/agigante80/actual-sync:1.12.0` re-checked: arm64 runs, driver 13.0.2 loads,
  INTEGER round-trips as `number`, `formatLog` gone, six test buttons, release scripts absent.

## Known and deliberately not done

- **Dashboard HTML interpolates server names into `innerHTML` unescaped** — my new panel does it
  too, matching four existing sites (lines ~1606, 1655, 1683, 1693, 2022). No `escapeHtml` helper
  exists. Operator-written config behind dashboard auth, so self-XSS at worst. Fixing it properly
  means touching all five sites — worth its own ticket, not a silent widening of #188.
- **`syncHistory.js` catch blocks remain largely uncovered** (~77% statements). Pre-existing and
  unrelated to the driver bump; #185 was closed noting it.
- No mutations were added for `sqliteDriver.test.js` — those tests guard an external library's
  behaviour, not our code, so mutating our source would not exercise them meaningfully.

## Key context to reload

- **Node:** shell defaults to v18, repo needs >= 22. Prefix with
  `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`. See `[[node-version-hook-trap]]`.
- **`gh` is a snap**: cannot read `/tmp` or dotfiles at `$HOME` root; stage `--body-file` content
  as a non-hidden file in `$HOME`.
- **Never touch the working tree while `npm run test:mutation` runs** — it mutates files in place.
  A killed run leaves a stale `.mutation-test.lock`; `--recover` reports honestly and the next
  `acquireLock()` clears it. Both behaved correctly when a run was killed this session.
- Local env: see `.claude/commands/local-env.md`. Config holds **live** credentials; a forced sync
  really notifies.
- Long mutation runs can exceed the background-task limit. Run them **per ticket**
  (`--fast --ticket '#NNN'`) if a full run gets killed.
