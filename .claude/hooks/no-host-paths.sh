#!/usr/bin/env bash
#
# PreToolUse guard: refuse to write a machine-specific home directory into a
# repo file.
#
# A path like /home/<someone>/projects/thing is true on exactly one machine. In
# documentation it is an instruction nobody else can follow; in a script it is a
# silent breakage on every other checkout. Both had crept into .claude/ docs.
#
# Scope is deliberately narrow:
#   - only Write/Edit, only files INSIDE this repo (scratchpad and /tmp are not
#     our business — that is where throwaway scripts legitimately live)
#   - only HOST home directories. Container-absolute paths (/app/data,
#     /app/logs, /usr/local/bin) are correct here and must not be flagged.
#
# CI enforces the same rule over every tracked file via the guard in
# src/__tests__/docDriftGuards.test.js. This hook just moves the failure earlier,
# to the moment of authoring.
#
# It fails OPEN — a missing jq, an unreadable payload, an unresolvable path all
# allow the write. That is deliberate: the CI guard is the real enforcement, and
# a broken hook must not wedge someone's editing. Losing the hook costs you the
# early warning, never the rule itself.
set -uo pipefail

payload="$(cat)"
jqr() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null; }

case "$(jqr '.tool_name // ""')" in
    Write|Edit|MultiEdit) ;;
    *) exit 0 ;;
esac

file="$(jqr '.tool_input.file_path // ""')"
[ -n "$file" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[ -n "$root" ] || exit 0

# Resolve symlinks on BOTH sides before comparing. This repo is reachable at two
# paths on the dev machine (one is a symlink to the other), so a plain prefix
# match silently lets a write through whenever it arrives via the other alias —
# a guard that fails open exactly where this repo is unusual.
resolve() { readlink -f -- "$1" 2>/dev/null || printf '%s' "$1"; }
root_r="$(resolve "$root")"
# The target may not exist yet (a new file), so resolve its parent directory.
file_r="$(resolve "$(dirname -- "$file")")/$(basename -- "$file")"

case "$file_r" in
    "$root_r"/*) ;;
    *) exit 0 ;;   # outside the repo — not this guard's concern
esac

# Every field a write can carry text in.
content="$(jqr '[.tool_input.content, .tool_input.new_string,
                 (.tool_input.edits // [] | .[]?.new_string)]
                | map(select(. != null)) | join("\n")')"
[ -n "$content" ] || exit 0

# Assembled from fragments so this script does not match its own source when
# someone edits it.
lin="/""home""/"
mac="/""Users""/"
win="Users"

hit=""
if printf '%s' "$content" | grep -qE "${lin}[A-Za-z0-9._-]+/"; then
    hit="${lin}<user>/"
elif printf '%s' "$content" | grep -qE "${mac}[A-Za-z0-9._-]+/"; then
    hit="${mac}<user>/"
elif printf '%s' "$content" | grep -qE "[A-Za-z]:\\\\${win}\\\\[A-Za-z0-9._-]+"; then
    hit="a Windows user profile path"
fi

[ -n "$hit" ] || exit 0

jq -n --arg f "${file#"$root"/}" --arg hit "$hit" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: (
      "Blocked: this write puts a machine-specific absolute path (" + $hit +
      ") into " + $f + ", which is only true on one machine. Use $HOME, ~, " +
      "$(git rev-parse --show-toplevel), or a named variable such as $LOCAL_ENV. " +
      "The same rule is enforced over every tracked file by the guard in " +
      "src/__tests__/docDriftGuards.test.js, so this would fail CI anyway."
    )
  }
}'
exit 0
