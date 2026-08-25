---
name: verify-the-artifact-not-the-source
description: Check the shipped artifact and feed the checker a known-bad input; "it says valid" is what the bug said too
metadata:
  type: feedback
---

When a fix has an artifact — a published Docker image, a release, a config validator's verdict — verify **the artifact**, not the source that was supposed to produce it, and verify it **discriminates**, not merely that it reports success.

Three times in the #177/#180 work this changed the outcome:

- **#177** made `validate-config` trustworthy in Docker. Running it in the container printed `✅ Configuration is valid` — which is *exactly what the bug printed*, because a bind mount hid the schema and validation was silently skipped. The check that counted was mounting a deliberately schema-invalid config (`notifyOnSuccess: "sometimes"`, a pure enum violation that business-logic validation has no opinion on) and confirming exit 1 with the right message. A green result from a checker you have not proven can go red is not evidence.
- **#180** excluded the mutation runner from the image. The test guarding it is a text assertion over `.dockerignore` — weak by construction. Pulling `ghcr.io/...:1.11.3` and listing `/app/scripts` is what actually established the file was gone. Also assert the *opposite* direction (`validateConfig.js` still present), so the lazy "ignore all of `scripts/`" fix fails the guard.
- **Mutation results**: running `--fast` as well as full mode is attribution evidence — it shows each mutation is killed by a test in the file the catalog names, rather than incidentally by something elsewhere in the suite.

Sharpened 2026-08-04 while reviewing the sibling repo. There are **three distinct claims** and it is easy to conflate the last two:

1. the run **triggered** — what a chain verifier proves
2. the run went **green** — what watching it to completion adds
3. the **artifact exists** — what neither proves

A green run means a process exited 0. It does not mean a third-party registry now serves what you think it serves. Our `ci-cd.yml:573,586` `deployment-test` does genuinely pull and run the published image from Docker Hub and GHCR, which is better than a green-run check — **but it runs on an amd64 runner, so it fetches the amd64 layer and a manifest missing `linux/arm64` passes it**. Asserting the manifest lists every expected platform is a different check, and it is the one that is missing. See [[train-unattended-gaps]].

Also: registry read-after-write is not instant, so an artifact check without retry/backoff false-negatives and gets ignored, which is worse than not having it.

**Why:** a passing check and a check that cannot fail are indistinguishable from the outside. Most false confidence in this repo came from reading a success message rather than proving the failure path works.
**How to apply:** before believing a validator, make it fail on purpose. Before believing an exclusion, inspect the built image. Before believing a green suite, reintroduce the defect. Related: [[mutation-testing-standard]], [[user-agigante]].
