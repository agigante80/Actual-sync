<!-- ci-health-version: 3 -->

# CI Health Monitor

Check all GitHub Actions workflows for failures, create P0 tickets, gate each ticket, and auto-fix safe failures.

## Process

Execute these phases in order. Stop early if all workflows are passing.

### Phase 1: Discover and assess workflows

Auto-discover all workflow files:

```bash
ls .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null
```

Determine each workflow's run branch by its trigger — **this is the common failure of a
naive `--branch development` filter**:

- **`push` / `pull_request` workflows** (`ci-cd.yml`, `codeql-analysis.yml`): runs are
  attributed to the branch that triggered them — check `development` (integration branch),
  and also `main` for the release-path workflows (`auto-release.yml` runs only on `main`).
- **`schedule`-triggered workflows** (`dependency-update.yml` daily cron, any CodeQL cron):
  GitHub attributes scheduled runs to the **default branch (`main`)**, NOT to the branch the
  workflow checks out. A `--branch development` query returns **zero** runs for these and
  silently reports them green — the exact failure this monitor exists to catch. Query these
  **without `--branch`** (take the latest run regardless of branch), or with `main`.

Inspect each workflow's `on:` block to classify it, then query the latest run accordingly:

```bash
# push/PR workflow — filter by the branch it runs on:
gh run list --workflow <workflow-file> --branch <branch> --limit 1 --json databaseId,conclusion,createdAt,name,headBranch,event -q '.[0]'

# schedule-triggered workflow — do NOT filter by branch (runs are attributed to main):
gh run list --workflow <workflow-file> --limit 1 --json databaseId,conclusion,createdAt,name,headBranch,event -q '.[0]'
```

Include `event` and `headBranch` in the output so a misclassification is visible (a
`schedule` event showing `headBranch: main` confirms the no-filter path was needed).

For each **failing** run, get failed jobs and error logs:

```bash
gh run view <RUN_ID> --json jobs --jq '.jobs[] | select(.conclusion == "failure") | .name'
gh run view <RUN_ID> --log-failed 2>&1 | tail -150
```

Report a summary table:

| Workflow | Branch | Status | Failed jobs |
|---|---|---|---|
| ci-cd.yml | development | pass/fail | job1, job2 |
| auto-release.yml | main | pass/fail | - |

If ALL workflows are passing, report "All workflows green" and stop.

**Classify governance workflows separately.** A red **auto-release** run caused by a
*version regression* (version on `main` lower than the latest released tag) is an
*intentional governance signal* — a stale `development` was merged without back-merging
`main` — **not** a CI breakage. Do not file a P0 bug for it and do not carry it into the
fix phases; surface it as "action: back-merge `main` → `development`, then re-merge (see
CLAUDE.md Git Workflow)" and move on (see Phase 4).

### Phase 2: Create tickets for failures

For each failing job:

1. **Check for an existing open ticket** to avoid duplicates:
```bash
gh issue list --repo agigante80/Actual-sync --search "fix(ci): <job-name-keyword>" --state open --limit 1
```

2. **If no ticket exists**, create one. Use the same **template-version 3** base structure
   as `dep-auditor.md` so tickets stamped with that marker are consistent:
   - Title: `fix(ci): <workflow> - <job-name> failing on <branch>`
   - Labels: `bug`, `infrastructure`
   - Body (write to a file, apply with `gh issue create --body-file`):
     ```
     <!-- template-version: 3 -->
     ### Priority
     P0

     ## Summary
     <workflow>/<job-name> is failing on <branch>. <one-line cause from the logs>

     ## Error logs
     <last ~100 lines of the failed job>

     ## Failing run
     <link to the run> — affected files: <files from logs, if identifiable>

     ## Acceptance criteria
     - [ ] CI job `<job-name>` passes on `<branch>`

     ## GDPR compliance
     N/A
     ```

3. **If a ticket already exists**, add a comment with the latest error logs.

### Phase 3: Gate each new ticket

Run the ticket-gate agent on each newly created ticket (this repo's 3-agent panel:
actual-api, qa, release-manager). Fix and re-run until 10/10.

Gate tickets **one at a time**, not concurrently: each ticket-gate run invokes its
specialists strictly sequentially (its own hard rule — never two agents in one message), so
launching parallel gate instances would multiply sub-agents and contend on the same repo/gh
state. For mechanical AUTO-IMPLEMENT fixes (lint, knip, a single failing unit test) whose
acceptance is simply "the CI job passes", gate once rather than looping to 10/10.

### Phase 4: Implement fixes

For each gated ticket:

**AUTO-IMPLEMENT** (fix and commit locally — see the push gate below before pushing):
- Lint / knip (`npm run dead:check`) failures
- Unit test failures (`npm test`)
- Build/Docker-build failures
- Dependency issues (upgrade the **direct** dependency — never `npm overrides`)
- Configuration errors

**DO NOT AUTO-IMPLEMENT** (investigate only, leave a comment):
- CodeQL / security scan findings: comment with findings summary, do not auto-fix
- Auto-release version regressions: never bump the version to make the release path
  pass — the fix is the back-merge described in Phase 1, and version bumps follow
  CLAUDE.md Git Workflow (auto-patch on merge; manual bump only for minor/major on
  `development`, never with the `chore(release): bump version` prefix)
- Failures in `metrics-badges.yml` that only affect generated badge commits: investigate
  before touching — its commits carry `[skip ci]` and interact with the branch history

After implementing, run the project's test suite locally (`npm test`; coverage gates run
in CI via `npm test -- --coverage --ci`), then **commit**:

```bash
git add <specific-files>
git commit -m "fix(ci): <description>"
```

**Push gate.** Do **not** run `git push` unless the user asked for it in this invocation
(CLAUDE.md Git Workflow; Rules below). If not authorized: stop after committing, report the
commit SHA(s), and state that the fix is committed locally and awaiting a push. Only when the
user has authorized pushing in this request:

```bash
git push origin development
```

### Phase 5: Verify (only if a push happened)

If (and only if) the fix was pushed, wait 30 seconds then check whether a new run was
triggered:

```bash
gh run list --workflow <workflow-file> --branch development --limit 1 --json databaseId,status,conclusion,event,headBranch -q '.[0]'
```

Report whether the fix was pushed and a new run is in progress. If the push was not
authorized, report the local commit(s) and that verification is pending a push instead.

---

## Rules

- **Never hard-code workflow file names:** always discover via `ls .github/workflows/`
- **Never push to `main`:** fixes go to `development`; merging to `main` happens only when the user explicitly asks
- **Gate review must pass 10/10** before implementing any fix
- **One commit per fix:** not one big commit for everything
- **No duplicate tickets:** always search before creating
- **Never use `npm overrides`/`resolutions`** to resolve dependency conflicts (CLAUDE.md Dependency Policy)
- **Do not run `git push` unless the user asked for it in that message** (CLAUDE.md Git Workflow) — if the user has not authorized pushing, stop after committing and report
