---
name: hermetic-guards
description: Blocking tests must read only tracked repo files; sqliteDriver.test.js is our known exception
metadata:
  type: feedback
---

**A guard whose result can change with no commit is misplaced, whatever its direction.**

Received from the actual-mcp-server session on 2026-08-04 and it is sharper than the rule we had. Our `docDriftGuards.test.js` says guards must be *forward-direction only* — everything the docs advertise must exist in code, never the reverse. That rule is correct but it is a special case. The general property is hermeticity: a test in the blocking suite must depend only on tracked files in this repo.

Their incident is the clean illustration. A unit test read the live `@actual-app/api` surface out of `node_modules` and asserted full tool coverage. Upstream published three new methods, and a healthy tree went red with no change on their side — blocking three lanes including a security PR. Once framed as "this test is not hermetic" the fix stopped being "soften the assertion" and became "move every registry-dependent check out of the blocking suite into its own non-blocking job".

Audit of ours against the rule (2026-08-06): `docDriftGuards`, `deadMethodGuard`, `configExamplesGuard`, `knipConfig` and the dockerignore/host-path guards all read only tracked files. Hermetic, correctly placed.

**The known exception is `src/__tests__/sqliteDriver.test.js`.** It asserts `better-sqlite3` marshalling, so its result depends on the installed native module rather than on our code, and it sits in the blocking suite. It has not bitten us because the driver is lockfile-pinned, so it only moves on a deliberate commit — but that makes it *currently harmless*, not correctly placed. If it ever fails without a commit touching the lockfile, this is why.

The same lens explains why `npm audit` belongs in a non-blocking reporting job rather than being switched off: its result changes with no commit, so it must not block, but that is not a reason for it never to run.

**Why:** a blocking check that a third party can turn red is an outage someone else controls, and the instinct when it fires is to weaken the assertion rather than move it.
**How to apply:** before adding a test to the blocking suite, ask what it reads. Registry, network, clock, installed-module behaviour, or anything outside the repo means it belongs in its own job — loud, ticket-filing, blocking nothing. Related: [[mutation-testing-standard]], [[verify-the-artifact-not-the-source]], [[actual-mcp-server-peer]].
