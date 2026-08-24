---
name: train-unattended-gaps
description: Rollback undone in 24h, caret defeats the pin, no soak window, nobody watching, deployment-test is arm64-blind
metadata:
  type: project
---

Our `@actual-app/api` release train is safe **only because a human reads the nightly result and pulls the image**. That dependency is undocumented and load-bearing. Five gaps, all confirmed against `.github/workflows/dependency-update.yml` on 2026-08-06, none filed as a ticket yet:

1. **A rollback survives exactly one night.** There is no denylist, skip list or pin-respect anywhere (grep for denylist/blocklist/skip-version/hold/freeze returns nothing). Revert a bad version, and the next nightly sees CURRENT=old, LATEST=bad, `sort -V` says *forward*, and it re-upgrades. Our direction check refuses backwards moves and is structurally incapable of catching this. The signature is the expensive part: "I fixed it and it came back on its own" reads as a failed fix.
2. **A caret defeats the pin.** Reverting to `^26.8.0` re-resolves to 26.8.0 while it is still published. We strip carets when computing CURRENT for comparison (`dependency-update.yml:90`) but that does nothing for the revert. The revert must pin exactly — and even then gap 1 undoes it.
3. **No soak window.** Measured 2026-08-04: `@actual-app/api` 26.8.0 was published 20:22:27Z, our train fires ~01:35Z. Roughly five hours between an upstream release existing and us auto-publishing from it. `npm view <pkg> time --json` gives the timestamps; refusing anything younger than ~48h is a few lines and costs latency nobody waits on.
4. **Nobody is watching.** Train failure writes only to `GITHUB_STEP_SUMMARY`, seen only by someone who goes looking. The sibling repo's train was dead two nights before its owner noticed by eye; ours has the same hole.
5. **`deployment-test` is architecture-blind.** `ci-cd.yml:573,586` genuinely pulls and runs the published image from Docker Hub and GHCR after publish — better than a green-run check — but on an amd64 runner it fetches the amd64 layer. A manifest missing `linux/arm64` passes. arm64 has only ever been verified by hand (#185).

We do NOT have the App-token expiry bug the sibling found in theirs: we re-mint (`:142` and `:334`) and the chain verifier deliberately uses `github.token` because an App token can expire mid-watch.

**Why:** the train auto-publishes a multi-arch image with no human approval, and every one of these is invisible until an incident. Gaps 1 and 2 together mean an incident response silently reverts itself.
**How to apply:** before extending the train, add the notification (gap 4) first — every other control's value depends on someone learning when it fails. Gaps 1+2 belong in one revert runbook that writes the denylist BEFORE pinning, and the denylist needs a guard test proving a denylisted version actually blocks. Related: [[verify-the-artifact-not-the-source]], [[actual-sync-release-train]], [[actual-mcp-server-peer]].
