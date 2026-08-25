---
name: skip-ci-in-prose-halts-the-release
description: Writing "[skip ci]" as prose in a commit message silently stops CI on main, and with it the whole auto-release chain
metadata:
  type: feedback
---

On 2026-08-25 a back-merge commit to `main` explained the recurring badge divergence with the
sentence *"CI pushes .github/badges/tests.json to main after each release ([skip ci])"*. GitHub
does not read that as prose. It scans the **HEAD commit's whole message, body included**, and
skipped the CI/CD Pipeline run entirely.

The consequence is not "CI didn't run". `auto-release.yml` triggers on
`workflow_run: ["CI/CD Pipeline"]`, so no CI run means **no release, no tag, no image** — the
merge lands, everything looks green, and nothing publishes. That is exactly the silent-stall
class the release-train notes warn about, arrived at from a new direction: not a token
permission problem, just a sentence.

**Recovery, which worked and did not require touching history:** `ci-cd.yml` accepts
`workflow_dispatch`, so `gh workflow run ci-cd.yml --ref main -f skip_tests=false -f
skip_docker_publish=false` produced a real CI run, whose completion fired `workflow_run` and
released as normal. Never force-push `main` to amend the message, and an empty commit is the
worse fallback.

**Why:** the marker is matched anywhere in the message, so quoting it, naming it, or explaining
it is indistinguishable from using it.
**How to apply:** never write `[skip ci]`, `[ci skip]` or `[no ci]` in a commit message unless
you mean it — refer to it as "the skip-CI marker" instead. After any merge to `main`, confirm a
CI run actually started before assuming the release chain did; see
[[verify-the-artifact-not-the-source]] and [[actual-sync-release-train]].
