# Plan: P5 v1.22 Hardening

## Goal
Close the three security and supply chain tickets that need no new `@actual-app/api` release:
an optional credential for the metrics endpoints (#247), an SBOM and build provenance for the
Docker image (#252), and hardened compose and Unraid defaults (#253). Ship them as v1.22.0 while
P6 waits for the api bump.

## Done looks like
- `healthCheck.auth` (none, basic or token) protects `/metrics` and `/metrics/prometheus` only,
  independent of `healthCheck.dashboard.auth` and of `dashboard.enabled`. `/health` and `/ready`
  are never authenticated. The default is `none`, so an upgrade changes nothing for an existing
  scrape. A set type with a missing credential refuses to start and names the key (#247).
- Every published image carries a provenance attestation (`provenance: mode=max`) and an SBOM,
  the SBOM is attached to the GitHub release as an asset, and `gh attestation verify` succeeds
  against the published tag (#252).
- `docker-compose.yml` publishes port 3000 on `127.0.0.1` only, drops all capabilities except the
  ones the PUID/PGID entrypoint demonstrably needs, and sets `no-new-privileges`. Each line
  carries a comment saying what it does and how to relax it. The Docker Hub snippet matches. The
  Unraid template keeps the WebUI on the LAN and gets the same capability and privilege settings.
  The container was started with the hardened file and completed a sync, wrote its log, its
  SQLite history and the dashboard, before the change was committed (#253).
- Released as v1.22.0 with CI green, and the three tickets closed with the release named.

## Fails if
It is the end of P5 and it failed badly. What happened?
- An operator upgraded and Prometheus started showing the target as DOWN, because the metrics
  credential was on by default or the dashboard credential started applying to the scrape.
  Guard: default `none`, tests that the two credentials are independent, a 401 troubleshooting
  entry in PROMETHEUS.md.
- A Docker or Kubernetes probe started failing after the upgrade. Guard: tests that `/health`
  and `/ready` return 200 with no credential under every `healthCheck.auth` type.
- The hardened compose file shipped and the container could not write its history database or
  logs, or the entrypoint could not drop privileges, because `read_only` or `cap_drop ALL` was
  applied without a real container run. Guard: the ticket's rule is "start from ALL, add back
  only what a real run proves necessary, document each"; `read_only` is only adopted if the run
  passes with it, otherwise it is documented as an opt-in.
- Users on a LAN install lost the dashboard after `docker compose pull` and found no explanation.
  Guard: the inline comment on the ports line, a breaking-change note in the release notes and
  DOCKER_DEPLOYMENT.md, and the Unraid template unchanged on exposure.
- The provenance step broke the publish job on a tag and v1.22.0 shipped with no image. Guard:
  the workflow change is exercised on a development build before the release tag, and the
  attestation step is `continue-on-error: false` only once it has passed there.

## Expected work
PR for #247 (branch `feat/247-metrics-auth`, written during P4 and held until v1.21.0 shipped)
merges first. #252 is a workflow change on `ci-cd.yml` plus a release asset. #253 is compose,
Docker Hub description, Unraid template and DOCKER_DEPLOYMENT.md, verified with a local
container run. Then development is promoted to main as v1.22.0.

## Out of scope
- Anything that needs `@actual-app/api` 26.11.0: #298, #391, #392, #236 (P6).
- Loan split #256: backlog.
- A read-only root filesystem if the container run shows it needs more than a tmpfs for `/tmp`;
  in that case it becomes a documented opt-in and a backlog ticket, not a P5 blocker.
