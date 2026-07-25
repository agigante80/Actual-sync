<!-- pr-enhance-version: 1 -->

# Pull Request Enhancement

You are a PR optimization expert specializing in creating high-quality pull requests that facilitate efficient code reviews. Generate comprehensive PR descriptions, automate review processes, and ensure PRs follow best practices for clarity, size, and reviewability — tailored to the **Actual-sync** repository.

## Context

The user needs to create or improve pull requests with detailed descriptions, proper documentation, test coverage analysis, and review facilitation. Focus on making PRs that are easy to review, well-documented, and include all necessary context.

## Repository Context (Actual-sync)

Ground every recommendation in this repo's real setup:

- **Host**: GitHub — the `gh` CLI works here. Repo slug: `agigante80/Actual-sync`.
- **Stack**: a single plain **Node.js** service (Express, `better-sqlite3`, `@actual-app/api`). No TypeScript, no bundler, **no build step**, and **no linter or type-checker**. Do not assume React/Spring/Django/Rails, Prisma, or monorepo packages — none exist.
- **Branch model**: `development` is the active integration branch; `main` holds production-ready releases. Feature work lands on `development`, so **open PRs against `development`** and diff against it.
  - **Never push to `main` directly.** Merging `development` → `main` happens ONLY when the user explicitly asks ("merge to main").
  - Do **not** run `git push` unless the user asked for it in that same message.
- **Releases are automated**: every successful CI run on `main` triggers `.github/workflows/auto-release.yml`, which tags `vX.Y.Z` and publishes a Release. A routine **patch** is just merging `development` → `main` (the bot patch-bumps). For a **minor/major**, run `npm run version:bump -- minor|major` on `development` first, then merge. A manual bump commit must NOT use the `chore(release): bump version` prefix (that prefix is the bot's recursion guard) — use `chore: bump version to X`.
- **Validation the PR can claim** (run these; there is no lint/typecheck/build to cite):
  - `npm test` — full Jest suite (includes the doc↔code drift guards and knip-config guard).
  - `npm run test:coverage` — Jest coverage; thresholds are **61% branches / 70% functions / 70% lines / 70% statements**. Note `src/syncService.js` and `index.js` are excluded from coverage collection.
  - `npm run dead:check` — knip dead-code check (blocking; CI runs it in the lint job).
- **CI workflows** live in `.github/workflows/` (`ci-cd.yml`, `codeql-analysis.yml`, `dependency-update.yml`, and others).
- **Commit style**: Conventional Commits, as in the repo history — e.g. `feat(dashboard): ...`, `chore(deps-dev): ...`, `fix(sync): ...`. Reference issues with `#NN`.

## Requirements

$ARGUMENTS

## Instructions

### 1. PR Analysis

Analyze the changes and generate insights. Diff against the integration branch (`development`), not `main`:

**Change Summary Generator**

```python
import subprocess
import re
from collections import defaultdict

class PRAnalyzer:
    def analyze_changes(self, base_branch='development'):
        """
        Analyze changes between current branch and base
        """
        analysis = {
            'files_changed': self._get_changed_files(base_branch),
            'change_statistics': self._get_change_stats(base_branch),
            'change_categories': self._categorize_changes(base_branch),
            'potential_impacts': self._assess_impacts(base_branch),
            'dependencies_affected': self._check_dependencies(base_branch)
        }

        return analysis

    def _get_changed_files(self, base_branch):
        """Get list of changed files with statistics"""
        cmd = f"git diff --name-status {base_branch}...HEAD"
        result = subprocess.run(cmd.split(), capture_output=True, text=True)

        files = []
        for line in result.stdout.strip().split('\n'):
            if line:
                status, filename = line.split('\t', 1)
                files.append({
                    'filename': filename,
                    'status': self._parse_status(status),
                    'category': self._categorize_file(filename)
                })

        return files

    def _get_change_stats(self, base_branch):
        """Get detailed change statistics"""
        cmd = f"git diff --shortstat {base_branch}...HEAD"
        result = subprocess.run(cmd.split(), capture_output=True, text=True)

        # Parse output like: "10 files changed, 450 insertions(+), 123 deletions(-)"
        stats_pattern = r'(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?'
        match = re.search(stats_pattern, result.stdout)

        if match:
            files, insertions, deletions = match.groups()
            return {
                'files_changed': int(files),
                'insertions': int(insertions or 0),
                'deletions': int(deletions or 0),
                'net_change': int(insertions or 0) - int(deletions or 0)
            }

        return {'files_changed': 0, 'insertions': 0, 'deletions': 0, 'net_change': 0}

    def _categorize_file(self, filename):
        """Categorize file by type (Actual-sync is plain JS — no TS/compiled sources)"""
        categories = {
            'source': ['.js'],
            'test': ['__tests__', '.test.js', '.spec.js'],
            'config': ['config/', '.json', '.schema.json', 'knip.json'],
            'docs': ['.md', 'docs/', 'README', 'CHANGELOG'],
            'build': ['Dockerfile', 'docker/', 'entrypoint.sh'],
            'ci': ['.github/workflows', '.githooks']
        }

        for category, patterns in categories.items():
            if any(pattern in filename for pattern in patterns):
                return category

        return 'other'
```

### 2. PR Description Generation

Create comprehensive PR descriptions:

**Description Template Generator**

```python
def generate_pr_description(analysis, commits):
    """
    Generate detailed PR description from analysis
    """
    description = f"""
## Summary

{generate_summary(analysis, commits)}

## What Changed

{generate_change_list(analysis)}

## Why These Changes

{extract_why_from_commits(commits)}

## Type of Change

{determine_change_types(analysis)}

## How Has This Been Tested?

{generate_test_section(analysis)}

## Config / Schema Impact

{describe_config_impact(analysis)}

## Performance Impact

{analyze_performance_impact(analysis)}

## Breaking Changes

{identify_breaking_changes(analysis)}

## Dependencies

{list_dependency_changes(analysis)}

## Checklist

{generate_review_checklist(analysis)}

## Additional Notes

{generate_additional_notes(analysis)}
"""
    return description

def generate_summary(analysis, commits):
    """Generate executive summary"""
    stats = analysis['change_statistics']

    # Extract main purpose from commits (Conventional Commits: type(scope): subject)
    main_purpose = extract_main_purpose(commits)

    summary = f"""
This PR {main_purpose}.

**Impact**: {stats['files_changed']} files changed ({stats['insertions']} additions, {stats['deletions']} deletions)
**Risk Level**: {calculate_risk_level(analysis)}
**Review Time**: ~{estimate_review_time(stats)} minutes
"""
    return summary

def generate_change_list(analysis):
    """Generate categorized change list"""
    changes_by_category = defaultdict(list)

    for file in analysis['files_changed']:
        changes_by_category[file['category']].append(file)

    change_list = ""
    icons = {
        'source': '🔧',
        'test': '✅',
        'docs': '📝',
        'config': '⚙️',
        'build': '🏗️',
        'ci': '🤖',
        'other': '📁'
    }

    for category, files in changes_by_category.items():
        change_list += f"\n### {icons.get(category, '📁')} {category.title()} Changes\n"
        for file in files[:10]:  # Limit to 10 files per category
            change_list += f"- {file['status']}: `{file['filename']}`\n"
        if len(files) > 10:
            change_list += f"- ...and {len(files) - 10} more\n"

    return change_list
```

Generate the description as a file and open the PR against `development` with `gh`:

```bash
gh pr create --repo agigante80/Actual-sync --base development \
  --title "feat(scope): concise Conventional-Commits subject" \
  --body-file .git/PR_BODY.md
```

### 3. Review Checklist Generation

Create automated review checklists that reflect Actual-sync's real conventions:

**Smart Checklist Generator**

```python
def generate_review_checklist(analysis):
    """
    Generate context-aware review checklist
    """
    checklist = ["## Review Checklist\n"]

    # General items (no linter/typecheck/build in this repo — cite the real gates)
    general_items = [
        "Commits follow Conventional Commits (feat/fix/chore/docs...)",
        "Self-review completed",
        "Comments added for non-obvious logic",
        "No debugging code left",
        "No secrets or credentials committed (redaction is not a substitute)",
        "`npm test` passes (includes doc↔code drift guards)",
        "`npm run dead:check` passes (knip — no new unused files/exports)"
    ]

    # Add general items
    checklist.append("### General")
    for item in general_items:
        checklist.append(f"- [ ] {item}")

    # File-specific checks
    file_types = {file['category'] for file in analysis['files_changed']}

    if 'source' in file_types:
        checklist.append("\n### Code Quality")
        checklist.extend([
            "- [ ] Uses the custom logger (`src/lib/logger.js`) — no Winston/Pino/console.*",
            "- [ ] Correlation ID set at start of a sync op and cleared in a `finally` block",
            "- [ ] `actual.shutdown()` called in a `finally` block for every sync path",
            "- [ ] Per-server config read via `getSyncConfig(server)`, never `server.sync.*` directly",
            "- [ ] Retry logic changes (if any) come with matching test updates",
            "- [ ] Error log level is honest (recovered/transient failures are WARN/DEBUG, not ERROR)"
        ])

    if 'test' in file_types:
        checklist.append("\n### Testing")
        checklist.extend([
            "- [ ] New code is covered; thresholds hold (61% branches / 70% funcs / lines / statements)",
            "- [ ] Uses shared helpers from `src/__tests__/helpers/testHelpers.js`",
            "- [ ] Tests are meaningful and not just for coverage",
            "- [ ] Edge cases are tested",
            "- [ ] No flaky tests introduced"
        ])

    if 'config' in file_types:
        checklist.append("\n### Configuration")
        checklist.extend([
            "- [ ] `config/config.schema.json` change mirrored in `config/config.example.json`",
            "- [ ] Business-logic validation added in `configLoader.js` → `validateLogic()`",
            "- [ ] Per-server override behavior considered (global vs `server.*`)",
            "- [ ] Backwards compatibility maintained",
            "- [ ] Default values are sensible"
        ])

    if 'docs' in file_types:
        checklist.append("\n### Documentation")
        checklist.extend([
            "- [ ] Relevant `docs/` files updated to match changed behavior",
            "- [ ] Doc↔code drift guards still green (`src/__tests__/docDriftGuards.test.js`)",
            "- [ ] README updated if observable surface changed",
            "- [ ] Examples provided where helpful"
        ])

    if 'ci' in file_types or 'build' in file_types:
        checklist.append("\n### CI / Docker")
        checklist.extend([
            "- [ ] Workflow changes validated against `.github/workflows/`",
            "- [ ] Dockerfile/entrypoint changes preserve PUID/PGID privilege-drop behavior",
            "- [ ] No accidental change to the auto-release trigger on `main`"
        ])

    # Security checks
    if has_security_implications(analysis):
        checklist.append("\n### Security")
        checklist.extend([
            "- [ ] Input validation implemented",
            "- [ ] Dashboard/API endpoints stay behind `dashboardAuth()` where required",
            "- [ ] No sensitive data in logs (E2EE passwords, server passwords, channel tokens)",
            "- [ ] Dependencies are secure (direct-dep upgrades only; no transitive overrides)"
        ])

    return '\n'.join(checklist)
```

### 4. Code Review Automation

Automate common review tasks. The checks below key off Actual-sync's documented anti-patterns:

**Automated Review Bot**

```python
class ReviewBot:
    def perform_automated_checks(self, pr_diff):
        """
        Perform automated code review checks
        """
        findings = []

        # Check for common issues
        checks = [
            self._check_console_logs,
            self._check_direct_server_sync_access,
            self._check_missing_shutdown,
            self._check_commented_code,
            self._check_large_functions,
            self._check_todo_comments,
            self._check_hardcoded_values
        ]

        for check in checks:
            findings.extend(check(pr_diff))

        return findings

    def _check_console_logs(self, diff):
        """Flag console.* — this repo uses the custom logger, never console output"""
        findings = []
        pattern = r'\+.*console\.(log|debug|info|warn|error)'

        for file, content in diff.items():
            matches = re.finditer(pattern, content, re.MULTILINE)
            for match in matches:
                findings.append({
                    'type': 'warning',
                    'file': file,
                    'line': self._get_line_number(match, content),
                    'message': 'console.* statement found',
                    'suggestion': "Use the custom logger from src/lib/logger.js (no Winston/Pino/console)"
                })

        return findings

    def _check_direct_server_sync_access(self, diff):
        """Flag direct server.sync.* access — must go through getSyncConfig(server)"""
        findings = []
        pattern = r'\+.*server\.sync\.'

        for file, content in diff.items():
            for match in re.finditer(pattern, content, re.MULTILINE):
                findings.append({
                    'type': 'warning',
                    'file': file,
                    'line': self._get_line_number(match, content),
                    'message': 'Direct server.sync.* access',
                    'suggestion': 'Resolve per-server config via getSyncConfig(server) instead'
                })

        return findings

    def _check_missing_shutdown(self, diff):
        """Warn if actual.init() is added without a finally-block actual.shutdown()"""
        findings = []
        for file, content in diff.items():
            if 'actual.init(' in content and 'actual.shutdown(' not in content:
                findings.append({
                    'type': 'warning',
                    'file': file,
                    'message': 'actual.init() without a matching actual.shutdown()',
                    'suggestion': 'Always call actual.shutdown() in a finally block'
                })
        return findings

    def _check_large_functions(self, diff):
        """Check for functions that are too large"""
        findings = []

        # Simple heuristic: count lines between function start and end
        for file, content in diff.items():
            if file.endswith('.js'):
                functions = self._extract_functions(content)
                for func in functions:
                    if func['lines'] > 50:
                        findings.append({
                            'type': 'suggestion',
                            'file': file,
                            'line': func['start_line'],
                            'message': f"Function '{func['name']}' is {func['lines']} lines long",
                            'suggestion': 'Consider breaking into smaller functions'
                        })

        return findings
```

### 5. PR Size Optimization

Help split large PRs:

**PR Splitter Suggestions**

````python
def suggest_pr_splits(analysis):
    """
    Suggest how to split large PRs
    """
    stats = analysis['change_statistics']

    # Check if PR is too large
    if stats['files_changed'] > 20 or stats['insertions'] + stats['deletions'] > 1000:
        suggestions = analyze_split_opportunities(analysis)

        return f"""
## ⚠️ Large PR Detected

This PR changes {stats['files_changed']} files with {stats['insertions'] + stats['deletions']} total changes.
Large PRs are harder to review and more likely to introduce bugs.

### Suggested Splits:

{format_split_suggestions(suggestions)}

### How to Split:

1. Create a feature branch from `development`
2. Cherry-pick commits for the first logical unit
3. Open a PR (base `development`) for that unit — only push if the user asked
4. Repeat for remaining units

```bash
# Example split workflow (branch off the integration branch)
git checkout development
git checkout -b feature/part-1
git cherry-pick <commit-hashes-for-part-1>
# Push + open PR only when the user has asked you to:
#   git push origin feature/part-1
#   gh pr create --repo agigante80/Actual-sync --base development
```
"""

    return ""

def analyze_split_opportunities(analysis):
    """Find logical units for splitting"""
    suggestions = []

    # Group by feature areas
    feature_groups = defaultdict(list)
    for file in analysis['files_changed']:
        feature = extract_feature_area(file['filename'])
        feature_groups[feature].append(file)

    # Suggest splits
    for feature, files in feature_groups.items():
        if len(files) >= 5:
            suggestions.append({
                'name': f"{feature} changes",
                'files': files,
                'reason': f"Isolated changes to {feature} feature"
            })

    return suggestions
````

### 6. Visual Diff Enhancement

Generate visual representations for architectural changes. Anchor diagrams to the real service boundaries (`syncService`, `healthCheck`, `notificationService`, `syncHistory`, `prometheusService`):

**Mermaid Diagram Generator**

````python
def generate_architecture_diff(analysis):
    """
    Generate diagram showing architectural changes
    """
    if has_architectural_changes(analysis):
        return """
## Architecture Changes

```mermaid
graph LR
    subgraph "Sync Flow"
        SCH[Scheduler / manual] --> SS[syncService]
        SS --> API[@actual-app/api]
        SS --> HIST[syncHistory / SQLite]
        SS --> PROM[prometheusService]
        SS --> NOTIF[notificationService]
    end
```

### Key Changes:

1. Describe the component(s) touched and why
2. Note any change to the per-server isolation or retry path
3. Call out new external data flows (they warrant a security look)
"""
    return ""
````

### 7. Test Coverage Report

Include test coverage analysis using this repo's Jest setup (`npm run test:coverage`):

**Coverage Report Generator**

```python
def generate_coverage_report(base_branch='development'):
    """
    Generate test coverage comparison.
    Thresholds enforced by Jest: 61% branches, 70% functions/lines/statements.
    Note: src/syncService.js and index.js are excluded from coverage collection.
    """
    # Get coverage before and after (run `npm run test:coverage` on each ref)
    before_coverage = get_coverage_for_branch(base_branch)
    after_coverage = get_coverage_for_branch('HEAD')

    coverage_diff = after_coverage - before_coverage

    report = f"""
## Test Coverage

| Metric | Before | After | Threshold | Change |
|--------|--------|-------|-----------|--------|
| Lines | {before_coverage['lines']:.1f}% | {after_coverage['lines']:.1f}% | 70% | {format_diff(coverage_diff['lines'])} |
| Functions | {before_coverage['functions']:.1f}% | {after_coverage['functions']:.1f}% | 70% | {format_diff(coverage_diff['functions'])} |
| Statements | {before_coverage['statements']:.1f}% | {after_coverage['statements']:.1f}% | 70% | {format_diff(coverage_diff['statements'])} |
| Branches | {before_coverage['branches']:.1f}% | {after_coverage['branches']:.1f}% | 61% | {format_diff(coverage_diff['branches'])} |

### Uncovered Files
"""

    # List files with low coverage
    for file in get_low_coverage_files():
        report += f"- `{file['name']}`: {file['coverage']:.1f}% coverage\n"

    return report

def format_diff(value):
    """Format coverage difference"""
    if value > 0:
        return f"+{value:.1f}% ✅"
    elif value < 0:
        return f"{value:.1f}% ⚠️"
    else:
        return "No change"
```

### 8. Risk Assessment

Evaluate PR risk:

**Risk Calculator**

```python
def calculate_pr_risk(analysis):
    """
    Calculate risk score for PR
    """
    risk_factors = {
        'size': calculate_size_risk(analysis),
        'complexity': calculate_complexity_risk(analysis),
        'test_coverage': calculate_test_risk(analysis),
        'dependencies': calculate_dependency_risk(analysis),
        'security': calculate_security_risk(analysis)
    }

    overall_risk = sum(risk_factors.values()) / len(risk_factors)

    risk_report = f"""
## Risk Assessment

**Overall Risk Level**: {get_risk_level(overall_risk)} ({overall_risk:.1f}/10)

### Risk Factors

| Factor | Score | Details |
|--------|-------|---------|
| Size | {risk_factors['size']:.1f}/10 | {get_size_details(analysis)} |
| Complexity | {risk_factors['complexity']:.1f}/10 | {get_complexity_details(analysis)} |
| Test Coverage | {risk_factors['test_coverage']:.1f}/10 | {get_test_details(analysis)} |
| Dependencies | {risk_factors['dependencies']:.1f}/10 | {get_dependency_details(analysis)} |
| Security | {risk_factors['security']:.1f}/10 | {get_security_details(analysis)} |

### Mitigation Strategies

{generate_mitigation_strategies(risk_factors)}
"""

    return risk_report

def get_risk_level(score):
    """Convert score to risk level"""
    if score < 3:
        return "🟢 Low"
    elif score < 6:
        return "🟡 Medium"
    elif score < 8:
        return "🟠 High"
    else:
        return "🔴 Critical"
```

### 9. PR Templates

Generate context-specific templates. Titles should be valid Conventional Commits subjects:

```python
def generate_pr_template(pr_type, analysis):
    """
    Generate PR template based on type
    """
    templates = {
        'feature': f"""
## feat({extract_scope(analysis)}): {extract_feature_name(analysis)}

### Description
{generate_feature_description(analysis)}

### Motivation / Linked Issue
Closes #[issue-number]

### Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

### Technical Implementation
{generate_technical_summary(analysis)}

### Testing Strategy
{generate_test_strategy(analysis)}
""",
        'bugfix': f"""
## fix({extract_scope(analysis)}): {extract_bug_description(analysis)}

### Issue
- **Reported in**: #[issue-number]
- **Severity**: {determine_severity(analysis)}

### Root Cause
{analyze_root_cause(analysis)}

### Solution
{describe_solution(analysis)}

### Testing
- [ ] Bug is reproducible before fix
- [ ] Bug is resolved after fix
- [ ] No regressions introduced
- [ ] Edge cases tested
""",
        'refactor': f"""
## refactor({extract_scope(analysis)}): {extract_refactor_scope(analysis)}

### Motivation
{describe_refactor_motivation(analysis)}

### Changes Made
{list_refactor_changes(analysis)}

### Compatibility
- [ ] No breaking changes
- [ ] Public config/API surface unchanged
- [ ] Coverage maintained or improved
""",
        'chore': f"""
## chore({extract_scope(analysis)}): {extract_chore_scope(analysis)}

### What & Why
{describe_chore(analysis)}

### Notes
- Dependency changes: direct deps only (no transitive overrides / resolutions)
- If this is a version bump on `development`, it must NOT use the
  `chore(release): bump version` prefix (that prefix is the auto-release bot's marker)
"""
    }

    return templates.get(pr_type, templates['feature'])
```

### 10. Review Response Templates

Help with review responses:

```python
review_response_templates = {
    'acknowledge_feedback': """
Thank you for the thorough review! I'll address these points.
""",

    'explain_decision': """
Great question! I chose this approach because:
1. [Reason 1]
2. [Reason 2]

Alternative approaches considered:
- [Alternative 1]: [Why not chosen]
- [Alternative 2]: [Why not chosen]

Happy to discuss further if you have concerns.
""",

    'request_clarification': """
Thanks for the feedback. Could you clarify what you mean by [specific point]?
I want to make sure I understand your concern correctly before making changes.
""",

    'disagree_respectfully': """
I appreciate your perspective on this. I have a slightly different view:

[Your reasoning]

However, I'm open to discussing this further. What do you think about [compromise/middle ground]?
""",

    'commit_to_change': """
Good catch! I'll update this to [specific change].
This should address [concern] while maintaining [other requirement].
"""
}
```

## Output Format

1. **PR Summary**: Executive summary with key metrics
2. **Detailed Description**: Comprehensive PR description (base branch `development`)
3. **Review Checklist**: Context-aware review items keyed to Actual-sync conventions
4. **Risk Assessment**: Risk analysis with mitigation strategies
5. **Test Coverage**: Before/after coverage vs. the enforced Jest thresholds
6. **Visual Aids**: Diagrams tied to real service boundaries where applicable
7. **Size Recommendations**: Suggestions for splitting large PRs
8. **Review Automation**: Automated checks and findings

Focus on creating PRs that are a pleasure to review, with all necessary context and documentation for an efficient code-review process. Remember the workflow guardrails: PRs target `development`, never push to `main` directly, and do not run `git push` unless the user explicitly asked in that message — merging `development` → `main` (which triggers the auto-release) happens only on the user's explicit request.
