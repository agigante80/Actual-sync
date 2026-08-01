---
name: mutation-testing-standard
description: A green suite proves nothing; reintroduce each defect. npm run test:mutation, plus every false-green trap that bit this tool
metadata:
  type: feedback
---

A passing test suite does not prove a test would catch the bug it was written for. Reintroduce the defect and check the suite fails. That technique found a real gap in **every** one of nine review rounds on #169/#177 — gaps that reading the tests had missed each time.

The repo automates it: `npm run test:mutation` (`scripts/mutations.js` catalog + `scripts/mutationTest.js` runner, 47 mutations as of v1.11.3). **Add a mutation whenever you fix a bug.**

Ways this tool produced a **false green**, each found only by attacking it. Re-verify all of them after any runner change:

1. **In-suite anchor guard.** `mutationCatalog.test.js` asserts each anchor exists, and a mutant replaces its anchor — so with that guard in the scored suite, every mutation was "caught" by construction. Excluded via `--testPathIgnorePatterns`, and a test pins the exclusion.
2. **Exit-code scoring.** `status !== 0` counted a missing toolchain, a timeout and a signal kill as caught. jest also exits 1 for "no tests found" and for config errors. Scoring must read the `--json` report.
3. **No green baseline.** A suite already red made everything "caught". Run unmutated first and abort unless green.
4. **A suite that fails to LOAD is invisible.** jest reports `numFailedTests: 0` with `numTotalTests` non-zero when a suite throws on import — so `numTotalTests > 0 && numFailedTests > 0` (the rule that used to be written here) passes it. The baseline printed `green (841 tests)` while `npm test` exited 1, and a mutant scored a false SURVIVED for a defect that *was* guarded. Read `success` and `numRuntimeErrorTestSuites`; a load error under a mutant is UNSCORED, never a verdict.
5. **`--recover` vs the lock.** Recovering mid-flight reverted the mutant underneath a running suite, which passed against unmutated code and scored SURVIVED. Refuse while a live pid holds the lock; and a file back at its original content when the mutant write *succeeded* is contamination, not the benign failed-write case.
6. **Exit 1 means "mutations survived"** — a claim about coverage. An internal crash must never exit 1 (it exits 2).
7. **Predictable temp paths.** A pid-named report file, unlinked only after the run, let a dead run's report be read as the current one's. Use `mkdtempSync`.
8. **Baseline what you score.** `--fast` scored a scoped run but baselined the full suite, so it never ruled out a file that passes in the suite but fails standalone.

Two structural rules that follow:

- **Guards for runner mutations must NOT live in `mutationCatalog.test.js`** — it is excluded from the scored suite, so a guard there scores every such mutation as SURVIVED regardless of truth. Use `mutationRunner.test.js`.
- **A pure, unit-tested helper needs an unwiring mutation too.** Deleting the call site leaves every unit test green. Pair each extracted decision with a mutation that removes its call, backed by a source-reading wiring test.

Also: `--testPathIgnorePatterns` is **variadic**, so a positional pattern placed after it is swallowed as another ignore pattern — that silently excluded the very file `--fast` was meant to run.

Watch for **near-equivalent mutants** (one kept the discriminator on the next line, so it proved nothing) and mutants that break syntax (jest then fails to parse — a false catch).

**Why:** reviewers repeatedly found fixes a green suite did not protect, including inside the tool built to detect exactly that. Confidence has to be earned adversarially, not inferred.
**How to apply:** after any bug fix, add a catalog entry and confirm it is caught. Run `--fast` as well as full — agreement between them is attribution evidence that each mutation is killed by a test in the file the catalog names. Treat any runner change as safety-critical. Related: [[user-agigante]], [[node-version-hook-trap]], [[agent-worktree-isolation]], [[verify-the-artifact-not-the-source]].
