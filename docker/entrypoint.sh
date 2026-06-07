#!/bin/sh
# Entrypoint for actual-sync.
#
# Supports PUID/PGID so the container adapts to the host's directory ownership
# (LinuxServer.io / Unraid convention). When started as root, it aligns the
# actualuser UID/GID to PUID/PGID (default 1001/1001 — unchanged from the
# original image), fixes ownership of the writable volumes, then drops
# privileges and execs the app as that user. When not started as root (e.g. the
# orchestrator forced a user), it execs the app directly without adjustments.
set -e

PUID="${PUID:-1001}"
PGID="${PGID:-1001}"

if [ "$(id -u)" = "0" ]; then
    # Align group, then user, to the requested IDs (-o allows non-unique IDs).
    if [ "$(id -g actualuser)" != "$PGID" ]; then
        groupmod -o -g "$PGID" actualuser
    fi
    if [ "$(id -u actualuser)" != "$PUID" ]; then
        usermod -o -u "$PUID" actualuser
    fi

    # The writable mounts must be owned by the runtime user.
    chown -R actualuser:actualuser /app/data /app/logs

    echo "Starting actual-sync as UID:GID ${PUID}:${PGID}"
    exec su-exec actualuser "$@"
fi

# Not root — run as-is.
echo "Starting actual-sync as $(id -u):$(id -g) (not root; PUID/PGID ignored)"
exec "$@"
