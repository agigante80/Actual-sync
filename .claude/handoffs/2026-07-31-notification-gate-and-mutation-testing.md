# Session handoff: notification gate (#168 train) + mutation testing

Date: 2026-07-31, extended 2026-08-01

## Summary

Started from issue #168 (a feature request), which turned out to be a documentation/schema
drift bug: `notifyOnSuccess` gated nothing on any channel. Shipped **v1.11.0**, **v1.11.1**,
**v1.11.2** and **v1.11.3**. Along the way, eight adversarial review rounds each found a real
defect — which led to automating mutation testing, which then found defects in itself.

**Everything raised through review round 9 is fixed and released.** There is no in-flight work.

## State at close (2026-08-01)

- `main` and `development` both at **`2869d49`**, VERSION **1.11.3**, no drift.
- Working tree clean apart from untracked `.claude/handoffs/` and `.claude/memory/`.
- **1315 tests** pass, knip clean, **47/47 mutations caught** in both full and `--fast` mode.
- **No open PRs.** One open issue: **#176**.
- Remote has only `main` and `development` — the 41 orphaned Dependabot branches were pruned.

## Released

| Version | What |
|---|---|
| 1.11.0 / 1.11.1 | `notifyOnSuccess` actually gates every channel (#169), honest delivery reporting (#171), poll-error suppression (#172), version consistency (#173), legacy telegram webhooks (#174), `notifyError` removed (#175) |
| 1.11.2 | `validate-config` trustworthy in Docker (#177), documented config examples guarded, mutation testing automated, runner's own false-green paths closed |
| 1.11.3 | The three round-8 deferrables: #178, #179, #180 |

Closed: #168, #169, #170, #171, #172, #173, #174, #175, #177, #178, #179, #180.
Merged direct-dependency PRs #163, #164, #167; closed the transitive #166 per the Dependency Policy.

## The mutation runner is the main artifact here

`npm run test:mutation` — `scripts/mutations.js` (47 mutations), `scripts/mutationTest.js`,
guarded by `src/__tests__/mutationCatalog.test.js` and `src/__tests__/mutationRunner.test.js`.

Every one of these was a way it reported a verdict it had not earned. Do not reintroduce any:

1. The catalog guard asserts anchors exist, and every mutant removes its anchor — leaving it in
   the scored suite made everything "caught" by construction. It is excluded, and pinned.
2. Scoring on exit code counted a missing toolchain, a timeout and a signal kill as caught.
   Scoring reads jest's `--json` report.
3. An already-red suite made every mutation caught. A green baseline is now required.
4. **A suite that fails to LOAD** contributes zero failed tests with `numTotalTests` non-zero,
   so the baseline printed `green (841 tests)` while `npm test` exited 1, and a mutant scored a
   false SURVIVED for a guarded #172. Scoring reads `success` + `numRuntimeErrorTestSuites`;
   a load error under a mutant is UNSCORED, not a verdict.
5. **`--recover` ignored the lock**, so recovering mid-flight reverted the mutant underneath a
   running suite, which then scored unmutated code as SURVIVED. It now refuses while a live pid
   holds the lock, and `now === original` when the mutant write SUCCEEDED is contamination.
6. An internal crash exited **1** — the code meaning "mutations survived". It exits 2.
7. The report path was pid-named and only unlinked after the run, so a stale file could be read
   as the current run's result (#178). Now `mkdtempSync`.
8. `--fast` scored a scoped run but baselined the full suite (#179). Each hint is baselined alone.

**Guards for runner mutations MUST live in `mutationRunner.test.js`, never in
`mutationCatalog.test.js`** — the runner excludes the catalog guard from the scored suite, so a
guard placed there scores every such mutation as SURVIVED regardless of the truth.

**Pure helpers need an unwiring mutation too.** `readReport`, `baselineProblem`, `baselineTargets`,
`scoreMutant`, `postRunState`, `recoveryRefusal`, `makeReportDir` are all pure and unit-tested —
deleting the call site leaves every unit test green. Seven mutations target call sites for exactly
this reason, backed by source-reading wiring tests in `mutationRunner.test.js`.

## Next steps

1. **#176** — dead `MessageFormatter` error-formatter family, ~230 lines, production-dead after
   #175 and invisible to knip. Open and unstarted. This is production-code deletion, so it wants
   its own cycle: delete, run the full suite + mutations, and check nothing in `docs/` describes
   the removed formatters.
2. Optional, unticketed: the image still carries `generateDashboardScreenshots.js`,
   `generate-badges.js`, `version-bump.js`. Dead weight, but none rewrite source files and
   Puppeteer is not in the runtime image, so nothing there is a hazard. Noted in #180's closing
   comment. File a ticket only if the image should be genuinely minimal.

## Decisions and why

- **Kept the email hard-fail** (`email.enabled: true` requires `from` + non-empty `to`) rather
  than softening to a warning. Consistent with every other channel, the config genuinely cannot
  deliver, and the runtime already warns. Mitigation was making `validate-config` trustworthy so
  it can be run *before* upgrading.
- **Explicit config beats a persisted `/notify` value** on restart; a global default does not.
- **`never` means the channel is off entirely, failures included.** The protected invariant is
  narrower: `always` and `errors_only` can never suppress a failure.
- **Deleted `notifyError()`** rather than wiring the gate through it — no production callers, and
  it had drifted twice in one changeset.
- **Mutation testing is not in CI** — it runs the whole suite once per mutation. Pre-release /
  on-change tool.
- **Signal handlers are deliberately absent** from the runner: `main()` is synchronous so they
  could never fire, and registering them broke default terminate. The journal is the recovery
  mechanism.
- **No manual version bump for a patch.** Auto-release patch-bumps on merge to `main`; hand-bumping
  is only for a minor/major, on `development`, before the merge.

## Known limitations, stated not hidden

- The baseline is a **single sample**. It rules out an already-broken suite; it cannot rule out a
  genuine flake, which would fail under some mutant and be recorded as caught for the wrong reason.
  Re-run with `--ticket` if a result surprises you.
- Two fixes shipped with **no dedicated test**: the bounded `acquireLock` retry and dispatching
  `--recover` before the catalog `require`. Their failure modes need a read-only repo and a broken
  catalog, neither of which a test can set up without writing to the real lock/journal and
  colliding with the run that spawned it.
- The `.dockerignore` guard is a **text assertion over a config file** — weaker than a behavioural
  test, but it asserts both directions (runner excluded, `validateConfig.js` retained), so the
  lazy "ignore all of `scripts/`" fix fails it. It was additionally verified against the published
  image, which is the check that actually matters.
- `jest` prints "A worker process has failed to exit gracefully" on every full run. **Pre-existing**
  — reproduces with the newest test files excluded. Not investigated.

## Key context to reload

- `docs/TESTING.md` — mutation-testing section: the runner, its flags, its exit codes, and every
  false-green trap above.
- `docs/MIGRATION.md` — "Upgrading to 1.11.0"; three silent behaviour changes for existing configs.
- `src/services/notificationService.js` — `shouldNotifyChannel`, `_deliveryOutcome`,
  `enabledChannelCount`, `mutedChannels`.
- **Node:** the shell defaults to v18 but the repo needs >= 22. Prefix commands with
  `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"` or `better-sqlite3` fails and ~74
  tests error spuriously. See `[[node-version-hook-trap]]`.
- **`gh` is a snap**: it cannot read `/tmp` or dotfiles at `$HOME` root. Stage `--body-file`
  content as a non-hidden file in `$HOME`.
- **Local env:** `/home/alien/docker/librechat-MCP-actual/actual-sync` builds from this repo — and
  `/home/alien/dev-github-personal/Actual-sync` is the SAME checkout as the Sync path, not a copy.
  Its config holds **live** credentials: email + telegram are enabled and `notifyOnSuccess` is
  unset (so `always`), meaning a forced sync sends real notifications.
- **A real bank rate limit is expected.** `Main's Budget` fails on
  `Failed syncing account SabadellSync. Rate limit exceeded.` — environmental, seen in multiple
  sessions, correctly classified and reported. It is not a regression.
- **Never run anything that touches the working tree while `npm run test:mutation` is running** —
  it mutates real files in place. Concurrent reads produce phantom findings. See
  `[[agent-worktree-isolation]]`.

## Verification bar used here

A green suite proves nothing on its own — reintroduce the defect. `--fast` agreeing with full mode
is real attribution evidence: it shows each mutation is killed by a test in the file the catalog
names, not incidentally by something else. And for anything with an artifact (a Docker image, a
published release), verify the artifact rather than the source that was supposed to produce it —
`validate-config` reporting "✅ valid" is exactly what the #177 bug did, so the check that counted
was feeding it a deliberately invalid config inside a container and watching it exit 1.
