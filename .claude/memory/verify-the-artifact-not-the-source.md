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

**Why:** a passing check and a check that cannot fail are indistinguishable from the outside. Most false confidence in this repo came from reading a success message rather than proving the failure path works.
**How to apply:** before believing a validator, make it fail on purpose. Before believing an exclusion, inspect the built image. Before believing a green suite, reintroduce the defect. Related: [[mutation-testing-standard]], [[user-agigante]].
