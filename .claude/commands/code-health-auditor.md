# Audit code health (dead code + doc drift)

Find dead/unused code and doc↔code drift, triage, and open gate-ready tickets.
**Manual, on demand** — there is no scheduled trigger and you must not add one.

## Usage

```
/code-health-auditor            # full audit, files tickets
/code-health-auditor --dry-run  # report only, writes nothing
/code-health-auditor --full     # ignore cached filed/allowlisted status
```

## What this does

Invokes the `code-health-auditor` agent, which:

1. Runs **knip** (`npm run dead:check`) for unused files + exports, and triages each
   (false-positive → fix `knip.json`; intentional → allowlist at source; genuine → remove/ticket).
2. Runs the committed **drift guards** (`docDriftGuards`, `knipConfig`) — a failing guard is a confirmed drift to fix.
3. Scans for **new drift classes** not yet locked by a guard, and proposes adding a guard for recurring ones.
4. Opens gate-ready GitHub issues, cache-first (`docs/audit/deadcode-audit-cache.json`).

**Scope split:** this owns unused files/exports + doc drift. Dependency findings go to
the `dep-auditor` agent (`/dep-auditor`) — this agent never files dependency tickets.

## Steps

Use the Agent tool with `subagent_type: code-health-auditor`, passing:

```
Run the code-health audit on agigante80/Actual-sync. Follow all steps in the
code-health-auditor agent instructions: read the cache, run knip + the drift guards,
scan for new drift, triage, dedup against cache + open issues, file gate-ready tickets,
and update the cache. Respect any --dry-run / --full flag passed by the user.
```
