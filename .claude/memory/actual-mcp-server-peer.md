---
name: actual-mcp-server-peer
description: Inter-session peer; five-round review 2026-08-04 changed decisions both ways; their trial unattended run outcome still unknown
metadata:
  type: project
---

**actual-mcp-server** (github.com/agigante80/actual-mcp-server) is a sibling repo owned by the same user — an MCP server for Actual Budget (71 tools; remote HTTP + local stdio) with its own `@actual-app/api` release train. Reachable as the **inter-session peer `actual-mcp-server`**; this session is the peer `actual-sync`. The user actively wants this cross-review and wants **genuine disagreement surfaced, not confirmations**.

Five rounds happened 2026-08-04 and it was the highest-value exchange so far. Findings flowed both ways and several changed real decisions.

**What we gave them, and what it changed:**
- Their API-coverage ratchet (a unit test asserting full upstream method coverage) blocked every 26.8.0 upgrade. We proposed inverting "zero gaps" to "zero *unacknowledged* gaps" using our `REVIEWED_KEPT` allowlist idiom, including the half that matters — asserting every entry is *still* unreferenced so it cannot rot. Adopted.
- We argued a new method must FAIL the build. **They pushed back and were right**: that couples a dependency upgrade to an unrelated product decision, and their maintainer wants unattended shipping. We withdrew it. Their non-blocking-job split is better for their constraints.
- Adversarial review of their #321-324 produced six missing items, all actioned: artifact verification (green run proves the job exited 0, not that a registry serves the artifact), npm's 72h unpublish window applied to *themselves* not just upstream, a **soak window** (their exposure measured at five hours), notification as ticket zero, flakes reducing an unattended pipeline's availability, and a denylist guard test. We also argued their `npm audit` exemption was wrong — #298 says audit must not BLOCK, not that it must not RUN — and they rewrote #322 on it. Our ordering (325, 321, 324, 326, 322, 323) was adopted over theirs.

**What they gave us:**
- The **hermeticity rule** — see [[hermetic-guards]]. Sharper than our forward-only rule and it subsumes it.
- The **rollback re-upgrade hole** and the **caret-defeats-the-pin** trap, both of which we then confirmed in our own train — see [[train-unattended-gaps]].
- The observation that we had been described as battle-tested when our train has one real end-to-end run behind it. Their #261 and #234 are the source of our chain verifier and forward-only guard; we had been feeding their incidents back to them with our variable names on them.

**Their state at 2026-08-06:** six tickets (#321-#326) toward a fully unattended npm + Docker Hub publish, with a trial unattended run planned for the night of 2026-08-04. **We do not know how that run went** — worth asking.

**Superseded:** the previously-recorded reciprocal bug (their `main`->`develop` sync PR created with `github.token`, so it got no CI) is no longer tracked here as outstanding; it was self-reported by them and is theirs to close.

**Why:** the two repos hit the same class of release-automation problem weeks apart, and each has already caught real defects in the other that neither found alone.
**How to apply:** when touching release/CI automation here, offer a cross-review. Send substantive reasoning rather than yaml summaries — that is what they ask for and what produces the useful pushback. Related: [[actual-sync-release-train]], [[train-unattended-gaps]], [[hermetic-guards]], [[user-agigante]].
