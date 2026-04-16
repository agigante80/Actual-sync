# Dependency Audit for actual-sync

Runs a four-check dependency health audit and creates GitHub issues for findings.
Accepts optional `[--full]` flag. Default is cache-first (skip packages audited within 30 days).

## Four sequential checks

### Check 1: Known vulnerabilities (`npm audit`)

```bash
cd /home/alien/dev-github-personal/Actual-sync
npm audit --json
```

Parse output and create GitHub issues for **moderate / high / critical** findings. Each issue must include:
- CVE or advisory ID
- Affected package and version range
- Dependency path (which direct dep pulls it in)
- Recommended upgrade command

**Security rule — no overrides**: Never use `npm overrides` or `resolutions` to silence a transitive vulnerability. Always upgrade the direct dependency that pulls it in. This is a hard project rule — see `CLAUDE.md` Anti-Patterns.

### Check 2: Registry health

For each **direct** dependency in `package.json` (not cached within 30 days), fetch npm metadata:

```bash
npm show <package> --json
# Fields: time (latest publish), deprecated, dist-tags.latest
# Weekly downloads: https://api.npmjs.org/downloads/point/last-week/<package>
```

Severity thresholds:
- **Critical**: deprecated or < 1,000 weekly downloads
- **Warning**: > 12 months since last publish OR < 10,000 weekly downloads
- **Info**: 6–12 months since last publish

Create one issue per finding with alternatives research and migration effort estimate.

### Check 3: Version drift

```bash
npm outdated --json
```

Flag packages **1+ major versions** behind latest. Create issues with:
- Current vs latest version
- Link to changelog / release notes (if findable)
- Affected files (grep for `require('<package>')`)
- Effort estimate (patch = trivial, minor = low, major = medium/high)

Note 2+ minor version gaps as informational in the same issue.

**Skip**: devDependencies that don't affect production behaviour (pure test tooling gaps are low priority).

### Check 4: Open Dependabot PRs

```bash
gh pr list --repo agigante80/Actual-sync --state open --json number,title,createdAt,labels \
  | jq '.[] | select(.labels[].name == "dependencies")'
```

Summarise all pending Dependabot PRs by age. Flag any older than 60 days for prioritisation.

## Deduplication

Before creating any issue, check for an existing open issue:
```bash
gh issue list --state open --search "<package-name>" --json number,title
```

Skip creation if a matching issue already exists; add a comment to the existing one instead.

## Output format

After all checks, display a summary table:

```
| Check | Findings | Issues created | Skipped (cached) |
|-------|----------|----------------|------------------|
| npm audit | 2 high | 2 | 0 |
| Registry health | 1 warning | 1 | 8 |
| Version drift | 3 outdated | 2 | 1 (dup) |
| Dependabot PRs | 15 open | — | — |
```

Label all created issues with `infrastructure`.
