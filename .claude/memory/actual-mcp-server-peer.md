---
name: actual-mcp-server-peer
description: Sibling repo with an equivalent release train; reachable as inter-session peer; open reciprocal bug to raise
metadata:
  type: project
---

**actual-mcp-server** (github.com/agigante80/actual-mcp-server) is a sibling repo owned by the same user — an MCP server for Actual Budget (71 tools; remote HTTP + local stdio). It runs a **production `@actual-app/api` release train** very similar to Actual-sync's (#165).

It is reachable as an **inter-session peer named `actual-mcp-server`** on this machine (agent-to-agent bus; this session is the peer `actual-sync`). Two rounds of cross-project review happened this session and were high-value.

Durable facts from that exchange:
- Their train **works** (verified: 15 green daily runs; last real fire commit `a59c670` shipped 26.7.0 end-to-end). A belief that it was "stalling" was wrong — upstream `@actual-app/api` has just been static at 26.7.0 since 2026-07-03 (everything newer is `26.8.0-nightly.*`, not on the `latest` dist-tag).
- **Reciprocal bug to raise with them / the user:** their `dependency-update.yml` creates its `main`->`develop` **sync PR with `github.token`**, so that PR gets **no CI runs** (same trap class as GITHUB_TOKEN pushes not triggering workflows). Self-reported by them and confirmed. Still outstanding — flag to the user.
- Two traps surfaced that apply to any adopter: `npm show <pkg> version` returns the **`latest` dist-tag**, not the highest published version (reaching for highest would auto-ship nightlies); and the tagged release commit is not itself the commit that was tested.

**Why:** the user actively uses cross-project review between these two repos and expects it offered.
**How to apply:** when working release/CI automation on either repo, consider a cross-review via the inter-session peer. Related: [[actual-sync-release-train]], [[user-agigante]].
