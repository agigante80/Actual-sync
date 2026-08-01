# Local environment — build and test actual-sync

Builds actual-sync from the local dev source and runs it against the local Actual Budget instance.

## Paths

Every command below is written against two variables so nothing here hardcodes a
machine-specific home directory. Set them once per shell:

```bash
# Where the local docker stacks live (adjust to your machine)
export LOCAL_ENV="$HOME/docker/librechat-MCP-actual"
# This repo checkout — from inside the repo, just use the git root
export REPO_ROOT="$(git rev-parse --show-toplevel)"
```

## Environment layout

```
$LOCAL_ENV/
├── actual-sync/              ← builds from $REPO_ROOT
│   ├── docker-compose.yml
│   ├── Dockerfile
│   └── config/config.json   ← two servers: "Main's Budget" + "TEST BLANK"
└── Finance-actual-budget/   ← local Actual Budget server (port 5006)
```

The `docker-compose.yml` uses a `build.context` pointing at the local dev repo, so every `docker compose up --build` picks up uncommitted source changes.

> Note: the repo is reachable at two paths on the dev machine (a `Sync/…` path and a
> `dev-github-personal/…` path). They resolve to the **same checkout**, not copies —
> `readlink -f` both if you need to confirm. Use `$REPO_ROOT` and the distinction
> stops mattering.

## Start the local Actual Budget server (if not running)

```bash
cd "$LOCAL_ENV/Finance-actual-budget"
docker compose up -d
```

Actual Budget available at: `http://localhost:5006`

## Build and start actual-sync from local source

```bash
cd "$LOCAL_ENV/actual-sync"
docker compose up --build -d
```

Dashboard: `http://localhost:3000/dashboard`
Health:    `http://localhost:3000/health`

## Force a sync run (bypass scheduler)

```bash
# All servers
docker compose -f "$LOCAL_ENV/actual-sync/docker-compose.yml" \
  exec actual-sync node index.js --force-run

# One specific server
docker compose -f "$LOCAL_ENV/actual-sync/docker-compose.yml" \
  exec actual-sync node index.js --force-run --server "Main's Budget"
```

## Validate config inside the container

The schema-resolution fix for #177 only matters in Docker, where a bind-mounted
config dir used to hide the schema. To prove it still discriminates rather than
silently passing, feed it a knowingly invalid config:

```bash
docker compose -f "$LOCAL_ENV/actual-sync/docker-compose.yml" \
  exec actual-sync npm run validate-config
```

## View live logs

```bash
docker logs -f actual-sync
```

## Stop everything

```bash
cd "$LOCAL_ENV/actual-sync" && docker compose down
cd "$LOCAL_ENV/Finance-actual-budget" && docker compose down
```

## Test servers in config

| Name | Actual server | Schedule | Encrypted |
|---|---|---|---|
| Main's Budget | finance-actual-budget-main:5006 | none (manual only) | No |
| TEST BLANK | finance-actual-budget-main:5006 | none (manual only) | No |

**The config holds live credentials.** Email and Telegram are enabled and
`notifyOnSuccess` is unset (so `always`), which means a forced sync sends real
notifications. Use dead endpoints when what you are testing is dispatch decisions.

`Main's Budget` is expected to fail on `Failed syncing account SabadellSync. Rate
limit exceeded.` — that is the upstream bank rate-limiting, seen across many
sessions, and the service classifies and reports it correctly. It is not a regression.

## Typical dev workflow

1. Make code changes in `$REPO_ROOT`
2. Run `npm test` to verify locally
3. `docker compose up --build -d` in `$LOCAL_ENV/actual-sync` to rebuild
4. Trigger a sync via dashboard or `--force-run` and check logs
5. Confirm behaviour before opening a PR
