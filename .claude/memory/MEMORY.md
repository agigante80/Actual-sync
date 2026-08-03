<!-- Memory index. Each line: - [Title](file.md) - one-line description (~150 chars max) -->
<!-- Add entries here as Claude Code builds up project memory across conversations. -->

- [Node 18 fallback breaks hook-gated pushes from the Bash tool](node-version-hook-trap.md) - Run nvm use 22 before any hook-gated push; system node is 18, repo needs 22
- [User: agigante — solo owner, verification-first, git-disciplined](user-agigante.md) - Who the user is and the working bar he holds (verify-before-done, adversarial review, git discipline)
- [Sibling repo actual-mcp-server (inter-session peer) + reciprocal github.token bug](actual-mcp-server-peer.md) - Sibling repo with an equivalent release train; reachable as inter-session peer; open reciprocal bug to raise
- [@actual-app/api release train — PROVEN end-to-end](actual-sync-release-train.md) - Ran the real path unattended on 2026-08-03 (26.8.0 -> v1.11.6); a surprise release commit on main is normal
- [Mutation testing is the verification bar here](mutation-testing-standard.md) - A green suite proves nothing; reintroduce each defect. npm run test:mutation, plus every false-green trap that bit this tool
- [Verify the artifact, not the source](verify-the-artifact-not-the-source.md) - Check the shipped image/release and make the checker fail on purpose; "it says valid" is what the bug said too
- [v1.11.x notification gate: what shipped and its upgrade hazards](notification-gate-1-11.md) - notifyOnSuccess now really gates every channel; four more bugs found en route; three silent upgrade behaviour changes
- [Isolate concurrent agent work in git worktrees](agent-worktree-isolation.md) - Review agents mutate the working tree; concurrent runs corrupt it and produce phantom findings — use a detached worktree
- [A flaky test poisons the mutation score](flaky-tests-poison-mutations.md) - One flake scores a false "caught"; repeat-run the suite before trusting 67/67, and never assert toBeInstanceOf on a native error
