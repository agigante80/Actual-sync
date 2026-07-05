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

Detect the working branch. In this repo the integration branch is **`development`**
(feature work lands there; `main` holds releases). Check `development` first, and also
check `main` for the release-path workflows (`auto-release.yml` runs only on `main`):

```bash
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main"
```

For each discovered workflow, check the latest run on the relevant branch:

```bash
gh run list --workflow <workflow-file> --branch <branch> --limit 1 --json databaseId,conclusion,createdAt,name -q '.[0]'
```

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

2. **If no ticket exists**, create one:
   - Title: `fix(ci): <workflow> - <job-name> failing on <branch>`
   - Labels: `bug`, `infrastructure`
   - Priority: P0
   - Body must include:
     - Error logs (last 100 lines of failed job)
     - Link to the failing run
     - Affected files (if identifiable from logs)
     - `<!-- template-version: 3 -->` marker
     - Acceptance criteria: "CI job passes on `<branch>`"

3. **If a ticket already exists**, add a comment with the latest error logs.

### Phase 3: Gate each new ticket

Run the ticket-gate agent on each newly created ticket (this repo's 3-agent panel:
actual-api, qa, release-manager). Fix and re-run until 10/10.

Use parallel agents if multiple tickets were created.

### Phase 4: Implement fixes

For each gated ticket:

**AUTO-IMPLEMENT** (fix and push to `development`):
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
in CI via `npm test -- --coverage --ci`), then:

```bash
git add <specific-files>
git commit -m "fix(ci): <description>"
git push origin development
```

### Phase 5: Verify

After pushing, wait 30 seconds then check whether a new run was triggered:

```bash
gh run list --workflow <workflow-file> --branch development --limit 1 --json databaseId,status,conclusion -q '.[0]'
```

Report whether the fix was pushed and a new run is in progress.

---

## Rules

- **Never hard-code workflow file names:** always discover via `ls .github/workflows/`
- **Never push to `main`:** fixes go to `development`; merging to `main` happens only when the user explicitly asks
- **Gate review must pass 10/10** before implementing any fix
- **One commit per fix:** not one big commit for everything
- **No duplicate tickets:** always search before creating
- **Never use `npm overrides`/`resolutions`** to resolve dependency conflicts (CLAUDE.md Dependency Policy)
- **Do not run `git push` unless the user asked for it in that message** (CLAUDE.md Git Workflow) — if the user has not authorized pushing, stop after committing and report
