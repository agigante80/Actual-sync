---
name: flaky-tests-poison-mutations
description: Run the suite repeatedly before trusting a mutation score; one flake scores a false "caught"
metadata:
  type: feedback
---

The mutation runner establishes **one** green baseline and then scores each mutant by whether the
suite failed. A test that fails intermittently therefore produces a false **caught** — the suite
went red, but for a reason unrelated to the mutation. The run reports full coverage it has not
earned, which is the exact failure class the tool exists to prevent.

So: **before believing a mutation score, prove the baseline is stable.** Run `npm test` five to
eight times. A single green run is not evidence.

This is not hypothetical. On 2026-08-03 two newly-added tests failed roughly one run in five,
a full `67/67 caught` had already been recorded against that unstable baseline, and the score had
to be discarded and re-measured after the flake was fixed.

**The flake itself is worth remembering**: `SqliteError` from `better-sqlite3` does not reliably
satisfy `expect(err).toBeInstanceOf(Error)` under jest. The native addon can be loaded in a
different realm from the test file, so its prototype chain does not always reach *that* realm's
`Error`. The same trap applies to any native module, and to any cross-realm value.

`toBeInstanceOf` on an error was the wrong assertion regardless of the flake: realm identity is
not a property production code depends on. Assert what the code actually uses — a non-empty
`message`, a `code`, a `stack`.

**Why:** a mutation score is the strongest confidence signal this repo produces, and a flake
silently inflates it.
**How to apply:** repeat-run the suite before any mutation run you intend to act on, and after
adding tests that touch native modules, timers, ports or the filesystem. Prefer behavioural
assertions over constructor identity. Related: [[mutation-testing-standard]],
[[verify-the-artifact-not-the-source]].
