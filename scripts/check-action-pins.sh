#!/usr/bin/env bash
# Fail on any GitHub Actions `uses:` reference that is not pinned to a full
# 40-hex commit SHA with a trailing `# vX.Y.Z` version comment (#249).
#
# Tags and branches are mutable: whoever controls the action's repository can
# repoint `v7` at new code and every workflow tracking it runs that code on the
# next run, with our secrets in scope (tj-actions/changed-files, March 2025).
# A SHA cannot be repointed. The version comment keeps the line readable and is
# what Dependabot's `github-actions` ecosystem rewrites together with the SHA.
#
# Usage: scripts/check-action-pins.sh [dir-or-file ...]
#   default: .github/workflows and .github/actions
# Exit: 0 all pinned, 1 at least one violation (file:line and reason printed).
# Exempt: local actions (`uses: ./...`) and `docker://image@sha256:<digest>`.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -eq 0 ]; then
  set -- "$ROOT/.github/workflows" "$ROOT/.github/actions"
fi

files=()
for target in "$@"; do
  if [ -d "$target" ]; then
    while IFS= read -r f; do files+=("$f"); done < <(find "$target" -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)
  elif [ -f "$target" ]; then
    files+=("$target")
  fi
done

bad=0
checked=0
for f in "${files[@]}"; do
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    # Only real `uses:` keys: optional list dash, then `uses:`; skips comments.
    [[ "$line" =~ ^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]*(.*)$ ]] || continue
    rest="${BASH_REMATCH[2]}"
    # Split the value from a trailing comment, and drop optional quotes.
    value="${rest%%#*}"
    comment=""
    [[ "$rest" == *"#"* ]] && comment="${rest#*#}"
    value="$(printf '%s' "$value" | sed -E "s/[[:space:]]+$//; s/^[\"']//; s/[\"']$//")"
    case "$value" in
      ./*) continue ;;
      docker://*@sha256:????????????????????????????????????????????????????????????????) checked=$((checked + 1)); continue ;;
    esac
    checked=$((checked + 1))
    if ! [[ "$value" =~ @[0-9a-f]{40}$ ]]; then
      echo "$f:$n: not pinned to a 40-hex commit SHA: $value"
      bad=$((bad + 1))
    elif ! [[ "$comment" =~ ^[[:space:]]*v[0-9]+(\.[0-9]+)*([-.+][0-9A-Za-z.]+)?[[:space:]]*$ ]]; then
      echo "$f:$n: SHA pin lacks a trailing '# vX.Y.Z' version comment: $value"
      bad=$((bad + 1))
    fi
  done < "$f"
done

if [ "$bad" -gt 0 ]; then
  echo "FAIL: $bad unpinned action reference(s). Pin with: gh api repos/OWNER/REPO/git/ref/tags/TAG (follow annotated tags via git/tags), then write 'uses: OWNER/REPO@<sha> # vX.Y.Z'. See docs/CI_CD.md."
  exit 1
fi
echo "ok: $checked action reference(s) pinned"
