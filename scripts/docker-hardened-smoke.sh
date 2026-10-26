#!/usr/bin/env bash
# Hardened container smoke test (#253).
#
# Starts the image with the same capability and privilege settings as
# docker-compose.yml (src/__tests__/dockerCompose.test.js keeps the two in
# step), with a PUID/PGID that forces the entrypoint's usermod/groupmod path,
# and proves the service still works under them: it reaches /health, serves
# the dashboard, records a sync attempt in its SQLite history and writes its
# log file. The one configured server is unreachable on purpose, so the
# recorded attempt is a failure; what matters is that the row was written.
#
# Usage: scripts/docker-hardened-smoke.sh <image> [host port]
set -euo pipefail

IMAGE=${1:?usage: $0 <image> [host port]}
PORT=${2:-3253}
NAME=actual-sync-hardened-smoke
WORK=$(mktemp -d)
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$NAME-data" "$NAME-logs" >/dev/null 2>&1 || true
  rm -f "$WORK/config.json"
  rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

cat > "$WORK/config.json" <<'EOF'
{
  "servers": [
    {
      "name": "Smoke",
      "url": "http://127.0.0.1:9",
      "password": "unused",
      "syncId": "00000000-0000-0000-0000-000000000000",
      "dataDir": "data/smoke"
    }
  ],
  "sync": { "maxRetries": 1, "baseRetryDelayMs": 1000, "autoRetry": { "enabled": false } },
  "logging": { "logDir": "/app/logs" },
  "syncHistory": { "dbPath": "/app/data/sync-history.db" }
}
EOF
chmod 644 "$WORK/config.json"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges:true \
  -p "127.0.0.1:${PORT}:3000" \
  -e PUID=1234 -e PGID=1234 \
  -v "$WORK/config.json:/app/config/config.json:ro" \
  -v "$NAME-data:/app/data" -v "$NAME-logs:/app/logs" \
  "$IMAGE" >/dev/null

fail() { echo "::error::$*"; echo "--- container logs"; docker logs "$NAME" 2>&1 | tail -40; exit 1; }

# Deadlines in seconds rather than attempt counts: each curl can take up to its
# --max-time, so a container that accepts TCP but never answers would otherwise
# stretch 60 attempts well past the minute the message promises.
code=000
deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  code=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$BASE/health" || true)
  [ "$code" = 200 ] && break
  sleep 1
done
[ "$code" = 200 ] || fail "/health did not return 200 within 60s (last: $code)"

# grep -q closes the pipe early, which pipefail would report as a failure of
# docker logs, so the log is captured first.
grep -q 'Starting actual-sync as UID:GID 1234:1234' <<<"$(docker logs "$NAME" 2>&1)" \
  || fail "entrypoint did not apply PUID/PGID 1234:1234"

# The HEALTHCHECK probe is also a node process (run as root, with capabilities), so
# pick the one running as the PUID rather than the first pidof hit.
NODE_PID=$(docker exec "$NAME" sh -c 'for p in $(pidof node); do grep -q "^Uid:[[:space:]]*1234" "/proc/$p/status" && echo "$p" && break; done' || true)
[ -n "$NODE_PID" ] || fail "no node process running as UID 1234"
CAPS=$(docker exec "$NAME" sh -c "awk '/^CapEff/ {print \$2}' /proc/$NODE_PID/status" || true)
[ "$CAPS" = "0000000000000000" ] || fail "node still holds capabilities: CapEff=$CAPS"
NNP=$(docker exec "$NAME" sh -c "awk '/^NoNewPrivs/ {print \$2}' /proc/$NODE_PID/status" || true)
[ "$NNP" = 1 ] || fail "no-new-privileges not in effect: NoNewPrivs=$NNP"

code=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" -X POST "$BASE/api/dashboard/sync" \
  -H "Content-Type: application/json" -H "Origin: $BASE" -d '{"server":"all"}' || true)
[ "$code" = 200 ] || fail "POST /api/dashboard/sync returned $code"

rows=0
deadline=$((SECONDS + 30))
while [ "$SECONDS" -lt "$deadline" ]; do
  # grep -c exits 1 while the row is not there yet, which set -e would turn into
  # a bare exit; the || true keeps the loop polling.
  rows=$(curl -s --max-time 10 "$BASE/api/dashboard/history?limit=5" -H "Origin: $BASE" | grep -c '"server_name"' || true)
  [ "${rows:-0}" -ge 1 ] && break
  sleep 1
done
[ "${rows:-0}" -ge 1 ] || fail "no sync attempt recorded in the history database within 30s"

code=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$BASE/dashboard" || true)
[ "$code" = 200 ] || fail "GET /dashboard returned $code"

docker exec "$NAME" sh -c 'test -s /app/logs/actual-sync.log' || fail "log file missing or empty"
docker exec "$NAME" sh -c 'test -s /app/data/sync-history.db' || fail "history database missing"
OWNER=$(docker exec "$NAME" sh -c "stat -c %u:%g /app/data/sync-history.db" || true)
[ "$OWNER" = "1234:1234" ] || fail "history database owned by $OWNER, expected 1234:1234"

if grep -qiE 'EACCES|EROFS|SQLITE_READONLY|SQLITE_CANTOPEN|not permitted' <<<"$(docker logs "$NAME" 2>&1)"; then
  fail "permission errors in the container log"
fi

echo "hardened smoke test passed: health 200, PUID/PGID applied, CapEff 0, NoNewPrivs 1, sync attempt recorded, dashboard 200, log and database written"
