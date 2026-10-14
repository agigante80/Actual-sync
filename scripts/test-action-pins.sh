#!/usr/bin/env bash
# Contract test for check-action-pins.sh (#249): fixture workflows, exit codes.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/check-action-pins.sh"
SHA=0123456789abcdef0123456789abcdef01234567
pass=0; fail=0
t=$(mktemp -d)

# run <desc> <expected-exit> <uses-line> [expected-output-fragment]
run() {
  local f="$t/w.yml"
  printf 'jobs:\n  j:\n    steps:\n%s\n' "$3" > "$f"
  local out; out=$(bash "$SCRIPT" "$f" 2>&1); local rc=$?
  if [ "$rc" -eq "$2" ] && { [ -z "${4:-}" ] || [[ "$out" == *"$4"* ]]; }; then
    echo "  ok: $1"; pass=$((pass + 1))
  else
    echo "  FAIL: $1 (expected exit $2, got $rc): $out"; fail=$((fail + 1))
  fi
}

run "SHA with version comment"        0 "      - uses: actions/checkout@$SHA # v7.0.1"
run "SHA with two-space comment gap"  0 "        uses: actions/checkout@$SHA  # v7.0.1"
run "quoted SHA"                      0 "        uses: \"actions/checkout@$SHA\" # v7.0.1"
run "subpath action"                  0 "        uses: github/codeql-action/init@$SHA # v4.1.0"
run "local action exempt"             0 "        uses: ./.github/actions/thing"
run "docker digest exempt"            0 "        uses: docker://alpine@sha256:${SHA}${SHA:0:24}"
run "uses text in a comment ignored"  0 "        # uses: actions/checkout@v4"
run "major tag"                       1 "        uses: actions/checkout@v7" "w.yml:4:"
run "quoted major tag"                1 "        uses: 'actions/checkout@v4'"
run "branch main"                     1 "        uses: foo/bar@main"
run "branch master"                   1 "        uses: aquasecurity/trivy-action@master"
run "short SHA"                       1 "        uses: foo/bar@0123456 # v1.0.0"
run "SHA without comment"             1 "        uses: foo/bar@$SHA" "version comment"
run "SHA with non-version comment"    1 "        uses: foo/bar@$SHA # latest"
run "tag with version comment"        1 "      - uses: foo/bar@v1 # v1.0.0"

rm -rf "$t"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
