---
name: extract-logic-out-of-workflow-yaml
description: Three rounds each narrowed a text slice and the defect moved one indent out; extraction ended it in two
metadata:
  type: feedback
---

Testing logic that lives inside a YAML `run:` block means asserting **which strings appear near which line**. That approach generated the same defect three review rounds running, and it never converged — each fix narrowed the text slice, and the next review found somewhere the slice did not reach:

| Guard scope at the time | Where the defect moved to |
|---|---|
| whole file | satisfied by the wrong branch, and by **comment prose** |
| the `else` branch | the sibling `elif` branch |
| every branch | **after the `fi`**, outside every branch |

There is always another indent level. Two separate review loops (#205/#210, then #216) hit the bad-fix-injection trip wire on exactly this, each time with a fix that looked complete.

**The fix is not a better slice — it is not slicing.** #217 moved the decision into `scripts/retargetRetest.js`: a pure `decideOutcome()` plus effects through an **injected `gh`**, so tests assert the status *actually written*. "A status write outside the chain" stopped being expressible, because there is no chain to be outside of. That loop then closed cleanly in two rounds, and neither round found the old defect class.

Signs you are in this trap: a guard satisfied by a comment; a fix that moves an assertion boundary rather than changing what is asserted; a review finding of the form "same defect, one level out".

**Why:** the guards were counted as coverage while a false-green shipped past them, which is the one failure mode this repo's tooling exists to prevent.
**How to apply:** when non-trivial logic appears in a workflow `run:` block, extract it to a module with injected I/O and test the behaviour; keep a source-reading **wiring** guard only for the call site. Same pattern as `accountFilter`, `rejectionClassifier`, `versionInfo`. Related: [[mutation-testing-standard]], [[hermetic-guards]], [[verify-the-artifact-not-the-source]].
