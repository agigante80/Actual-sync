# Security Policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub private vulnerability reporting:

**[Report a vulnerability](https://github.com/agigante80/Actual-sync/security/advisories/new)**
(repository Security tab, then "Report a vulnerability").

Do **not** open a public issue or pull request for a suspected vulnerability, even a low-impact one. A public report gives everyone running this software, which holds live budget-server credentials and bank connections, a window to be attacked before a fix exists. If you are unsure whether something is a vulnerability, report it privately; it is easy to downgrade later.

## What to include

- The affected version (`VERSION` file, image tag, or commit) and how you run it (Docker, Unraid, bare Node).
- The file and line, or the endpoint, involved.
- Steps to reproduce, and the impact you believe it has.
- A suggested fix, if you have one.

## What NOT to include

Reports are stored by GitHub and read by a human, so keep personal data out of them:

- No real transaction data, account names, balances, or payee names.
- No server credentials, passwords, tokens, or encryption keys. Redact them from logs and configuration, including the Actual server URL if it is not public.
- Use synthetic or placeholder values to demonstrate the problem.

## Supported versions

Only the **current minor release line** (currently 1.17.x) receives security fixes. Fixes ship in a new patch release of that line. If you run an older line, upgrade first and check whether the problem still reproduces.

## Response expectations

This is a single-maintainer project, so these are targets, not guarantees:

| Step | Target |
|------|--------|
| Acknowledge your report | within 7 days |
| Initial assessment (confirmed, not a vulnerability, or need more info) | within 14 days |
| Fix or mitigation for a confirmed high or critical issue | within 30 days |

If you have heard nothing after 7 days, add a comment on the advisory thread.

## Coordinated disclosure

Please give the maintainer reasonable time to ship a fix before you publish details. Once a fix is released, the advisory is published and you will be credited unless you ask not to be. A CVE is requested through the GitHub advisory workflow when one is warranted. If a report is not accepted as a vulnerability, you are free to discuss it publicly.

## Automated and AI-generated reports

Reports found with scanners, fuzzers or AI tools are welcome, but the same rules apply:

- State what you verified yourself (reproduced against a running instance, or confirmed by reading the code) and what you did not.
- Include a working reproduction, not just a scanner finding or a pattern match.
- File it privately, never as a public pull request or issue.

Reports that are unverified tool output with no reproduction may be closed without a detailed reply.

## Scope

In scope: this repository's code, its Docker image and Unraid template, and its CI/CD workflows. Out of scope: vulnerabilities in Actual Budget itself (report those to [actualbudget/actual](https://github.com/actualbudget/actual)) and in third-party dependencies with no effect on this project (report them upstream; Dependabot tracks advisories here).

More detail on the security controls of this project is in [docs/SECURITY_AND_PRIVACY.md](docs/SECURITY_AND_PRIVACY.md).
