---
name: dependabot-security-updates-ignore-target-branch
description: target-branch governs version updates only; security PRs always open on main and must be retargeted by a workflow
metadata:
  type: project
---

**`target-branch` in `dependabot.yml` is honoured for VERSION updates only. Dependabot SECURITY updates ignore it and always open against the default branch.**

Established 2026-08-24 while reviewing PR #192. It is a platform limitation, not a misconfiguration: [dependabot-core#2767](https://github.com/dependabot/dependabot-core/issues/2767) has been open since 2020, and GitHub's 2024 private-registry changelog explicitly restates that "security updates still does not support target-branch configuration". Do not go looking for the YAML key that fixes this — there isn't one. I burned a round assuming there was, and then a round assuming it was therefore impossible.

There is a second, sharper edge to the same rule: **an entry that sets a non-default `target-branch` is not consulted for security updates at all.** So our long-standing `ignore: @actual-app/api` never applied to security updates — an advisory on the API client could have opened a PR straight onto `main` and collided with the release train. That hole was invisible for as long as the config looked correct.

**How it is now solved — two mechanisms, deliberately not one:**

- *What* gets a PR: `allow: dependency-type: "direct"` on both npm entries. The second npm entry exists solely to reach security updates — it **omits** `target-branch` (that omission is the mechanism) and sets `open-pull-requests-limit: 0` so it contributes no version updates, and it repeats the `@actual-app/api` ignore because entry 1's does not carry over.
- *Where* it lands: `.github/workflows/retarget-dependabot.yml` moves the base `main` → `development` on `pull_request_target`, excluding `deps/actual-api-*` so the release train keeps targeting `main`.

Neither is redundant. Removing either reopens a different half of the gap, and "tidying" the two npm entries into one restores exactly the hole that produced #192.

**Activation trap:** `pull_request_target` runs the copy of the workflow that is on the DEFAULT branch. The retarget workflow does nothing at all until it is merged to `main` — a fix for main-branch behaviour that has to live on main to work.

Related: [[actual-sync-release-train]] (why a PR on `main` is dangerous here — green CI auto-cuts a release), [[verify-the-artifact-not-the-source]] (the workflow verifies the retarget took rather than exiting green on a no-op).
