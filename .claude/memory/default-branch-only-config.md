---
name: default-branch-only-config
description: Some config only takes effect on main; committed-and-green on development means nothing for it — run npm run drift:check
metadata:
  type: project
---

**GitHub reads several config surfaces ONLY from the default branch. On `development` they are committed, reviewed, green — and completely inert.**

Established 2026-08-24 (#204). The branch model here ("work on `development`, merge to `main` only when asked") structurally guarantees this class of bug, because the normal definition of done — tests pass, committed, pushed — is silent about it.

The surfaces, each verified against primary GitHub docs, not memory:

- `.github/FUNDING.yml` — the Sponsor button
- `.github/dependabot.yml` — *"You must store this file in the `.github` directory of your repository in the default branch"*
- `.github/ISSUE_TEMPLATE/*`
- any workflow triggered by `schedule`, `pull_request_target`, or `workflow_run`

**The worked example is the reason to take this seriously.** #199 removed `buy_me_a_coffee` from `FUNDING.yml`, and the ticket body *itself* contained a section titled "The trap worth knowing" spelling out that FUNDING.yml is read only from the default branch. The change landed on `development` anyway and the Sponsor button kept serving `main`'s old file. The warning was written, read, and did not work. That is the lesson: for this class, documentation is not a control — only a report is.

Run **`npm run drift:check`**. It names what is written but not in effect, and when it cannot reach the base ref it says so instead of printing a false all-clear.

**Design constraints worth not re-deriving:**

- The report is **not** blocking and must not become blocking. Drift between `development` and `main` is the normal steady state of this branch model; a gate on it fails on every healthy tree and gets disabled within a week. See [[hermetic-guards]] — it is also fetch-dependent, so it could go red with no commit.
- The enforceable half is a hermetic guard (`src/__tests__/defaultBranchDrift.test.js`): workflow entries are *derived* from their triggers, so a new scheduled workflow is covered the moment it exists. Only the platform surfaces GitHub decides for itself are hand-listed.
- Trigger extraction is deliberately not a `js-yaml` parse — js-yaml reaches this repo only as a transitive of jest, and the Dependency Policy forbids requiring transitive-only packages.

Related: [[dependabot-security-updates-ignore-target-branch]] (the retarget workflow is itself one of the inert files), [[verify-the-artifact-not-the-source]] (the guard was proven by breaking the detector on purpose — six tests go red).
