# Label taxonomy

Labels organise issues and route `ticket-gate`: the type and special labels decide which lenses
join the critic, and the area labels say which part of Actual-sync a ticket touches. Every work
ticket needs at least one area label or the gate stops at Step 0b.

`.github/labels.yml` declares the same set for GitHub. Apply it with `bash scripts/sync-labels.sh`
(`--check` changes nothing and lists drift). The script creates and updates, and never deletes.
Do not create labels by hand.

## Type labels
| Label | Meaning | Gate effect |
|---|---|---|
| `bug` | Something isn't working | - |
| `enhancement` | New feature or request | - |
| `security` | Security vulnerability or hardening | Adds the security lens |
| `infrastructure` | CI/CD, Docker, dependencies | - |
| `design` | Dashboard UI, UX, accessibility | - |
| `documentation` | Docs updates | - |
| `testing` | Tests, QA, coverage | - |

### Area labels
| Label | Area | Triggers |
|---|---|---|
| `api` | Dashboard/API routes or contracts (`/api/dashboard/*`) | API-design checklist in the critic's brief |
| `privacy` | Personal data (bank/transaction data, credentials, budget passwords) | privacy-regime skill if installed; rule 4 always applies |
| `sync-engine` | `src/syncService.js` sync flow, retries, correlation IDs | - |
| `actual-api` | `@actual-app/api` integration, budget download/decrypt, E2EE | - |
| `config` | Config schema/loader, AJV validation, config bootstrap | - |
| `dashboard` | Express dashboard, `dashboard.html`, `healthCheck.js` | - |
| `notifications` | Telegram/Slack/Discord/email/ntfy/webhook, message formatting | - |
| `metrics` | Prometheus / prom-client | - |
| `sync-history` | better-sqlite3 storage (`syncHistory.js`) | - |
| `logging` | Logger, redaction, rotation | - |
| `docker` | Image, entrypoint, PUID/PGID | - |
| `ci-release` | GitHub Actions, auto-release, version bump | - |

The first column of this table is the area set `check-ticket-mechanics.sh --labels-doc` accepts.
It matches the areas dropdown in the issue templates; change both together.

## Priority labels
| Label | Meaning |
|---|---|
| `P0` | Critical, blocks release |
| `P1` | High, important for current milestone |
| `P2` | Medium, should do, not blocking |
| `P3` | Low, nice to have |

## Special labels
| Label | Effect |
|---|---|
| `critical` | Adds the security lens and puts the critic in maximum scrutiny |
