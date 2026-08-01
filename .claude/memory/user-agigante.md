---
name: user-agigante
description: Who the user is and the working bar he holds (verify-before-done, adversarial review, git discipline)
metadata:
  type: user
---

The user (a.gigante@gmail.com, GitHub `agigante80`) owns and works solo on **Actual-sync** and a sibling repo **actual-mcp-server**. Working style observed across a long session:

- Wants **verification before completion** — repeatedly pushed "code review until green" and rejected surface checks. The bar is exercising logic against real conditions (stubbed `gh`, real git repos with a bare remote, live read-only API probes), not just `bash -n`/YAML-parse. Several real bugs this session were found only by a review pass, never by writing more tests.
- Values **adversarial peer review** between his own projects — had this session review its release-train design against actual-mcp-server's equivalent, twice, and wanted genuine disagreement surfaced, not just confirmations.
- Respects **git discipline**: never push `main` or any branch unless explicitly asked in that message; merging `development` -> `main` only on explicit request.

**Why:** matching this bar the first time avoids rework and false "done" claims.
**How to apply:** before claiming done, run the actual thing; when a design has a peer implementation, offer a cross-project review; treat every push as needing explicit per-message authorization. Related: [[node-version-hook-trap]], [[actual-mcp-server-peer]].
