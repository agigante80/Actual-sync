# Review GitHub ticket readiness

Run the ticket readiness gate on a GitHub issue before implementation begins.

## Usage

```
/review-ticket <issue-number>
```

**Argument**: GitHub issue number (required). Example: `/review-ticket 44`

## What this does

Invokes the `ticket-gate` agent, which validates the issue through 3 sequential specialist agents:

1. **actual-api** — verifies correct `@actual-app/api` lifecycle, method names, field names, and known quirks
2. **qa** — verifies test cases are specific and cover error paths, shutdown assertions, and coverage thresholds
3. **release-manager** — verifies PR scope, commit convention, version bump, and measurable acceptance criteria

Each agent scores the issue 1–10. All three must score 10/10 for the issue to PASS.

## Output

The gate posts a scorecard as a GitHub comment on the issue and reports:

- **PASS** — implementation may begin
- **BLOCKED** — exact list of required changes; re-run after addressing them

## Steps

Use the Agent tool with `subagent_type: ticket-gate`, passing the following prompt:

```
Run the ticket readiness gate on GitHub issue #<issue-number> in agigante80/Actual-sync.

Follow all steps in the ticket-gate agent instructions:
1. Fetch the issue with gh issue view
2. Load CLAUDE.md, src/syncService.js (API call sequence), and src/__tests__/helpers/testHelpers.js
3. Run actual-api agent — wait for result — then qa agent — wait for result — then release-manager agent.
   IMPORTANT: one agent per message, strictly sequential, never in parallel.
4. Compile the scorecard
5. Post it as a GitHub comment
6. Report PASS or BLOCKED with required changes
```
