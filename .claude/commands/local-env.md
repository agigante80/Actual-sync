# Local environment — build and test actual-sync

Builds actual-sync from the local dev source and runs it against the local Actual Budget instance.

## Environment layout

```
/home/alien/docker/librechat-MCP-actual/
├── actual-sync/              ← builds from /home/alien/dev-github-personal/Actual-sync
│   ├── docker-compose.yml
│   ├── Dockerfile
│   └── config/config.json   ← two servers: "Main's Budget" + "TEST BLANK"
└── Finance-actual-budget/   ← local Actual Budget server (port 5006)
```

The `docker-compose.yml` uses a `build.context` pointing at the local dev repo, so every `docker compose up --build` picks up uncommitted source changes.

## Start the local Actual Budget server (if not running)

```bash
cd /home/alien/docker/librechat-MCP-actual/Finance-actual-budget
docker compose up -d
```

Actual Budget available at: `http://localhost:5006`

## Build and start actual-sync from local source

```bash
cd /home/alien/docker/librechat-MCP-actual/actual-sync
docker compose up --build -d
```

Dashboard: `http://localhost:3000/dashboard`
Health:    `http://localhost:3000/health`

## Force a sync run (bypass scheduler)

```bash
# All servers
docker compose -f /home/alien/docker/librechat-MCP-actual/actual-sync/docker-compose.yml \
  exec actual-sync node index.js --force-run

# One specific server
docker compose -f /home/alien/docker/librechat-MCP-actual/actual-sync/docker-compose.yml \
  exec actual-sync node index.js --force-run --server "Main's Budget"
```

## View live logs

```bash
docker logs -f actual-sync
```

## Stop everything

```bash
cd /home/alien/docker/librechat-MCP-actual/actual-sync && docker compose down
cd /home/alien/docker/librechat-MCP-actual/Finance-actual-budget && docker compose down
```

## Test servers in config

| Name | Actual server | Schedule | Encrypted |
|---|---|---|---|
| Main's Budget | finance-actual-budget-main:5006 | none (manual only) | No |
| TEST BLANK | finance-actual-budget-main:5006 | none (manual only) | No |

## Typical dev workflow

1. Make code changes in `/home/alien/dev-github-personal/Actual-sync/`
2. Run `npm test` to verify locally
3. `docker compose up --build -d` in the actual-sync folder to rebuild
4. Trigger a sync via dashboard or `--force-run` and check logs
5. Confirm behaviour before opening a PR
