---
name: node-version-hook-trap
description: Run nvm use 22 before any hook-gated push; system node is 18, repo needs 22
metadata:
  type: feedback
---

The build environment for this project has a Node fallback trap. The repo requires Node **>=22** (package.json engines, all CI workflows, and the Dockerfile all target 22) and the pre-push git hook runs `npm test --coverage --ci`. On this machine `nvm alias default` is already **22** (v22.22.2), so the user's interactive shells and their own `git push` use 22 and pass the hook fine.

The trap is specific to non-interactive shells: Claude Code's Bash tool does not source nvm (its init lives in `.bashrc`, which non-interactive shells skip), so bare `node` there falls back to the **system `/usr/bin/node`, which is v18.19.1**. With Node 18, `better-sqlite3`'s native binding is ABI-mismatched (NODE_MODULE_VERSION 127 vs 109) and ~74 tests across the syncHistory + prometheusService suites fail — which also **blocks the pre-push hook**.

**Why:** several pushes this session failed the hook purely from this, and it looks like a real test failure when it is not.
**How to apply:** before any hook-gated git push (or running the full suite) from the Bash tool, prefix with `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22`. If `better-sqlite3` was already built under 18, `npm rebuild better-sqlite3` under 22 first. This is a local-env quirk only — CI (Node 22) is unaffected, so never "fix" the tests for it. See [[actual-sync-release-train]].
