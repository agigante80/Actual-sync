#!/usr/bin/env bash
# Contract test for check-template-lockstep.sh.
# Builds fixture template dirs and asserts the guard's exit code:
#   all markers equal            -> 0 (locked)
#   any marker diverges          -> 1 (drift, listed)
#   unmarked template            -> exempt (e.g. contribution.yml)
#   fewer than 2 versioned files -> 0 (nothing to lock)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/check-template-lockstep.sh"

pass=0
fail=0

# mk <dir> <name> <version|->   ("-" writes a template with NO marker)
mk() {
  local d="$1" name="$2" ver="$3"
  if [ "$ver" = "-" ]; then
    printf 'name: %s\nbody: []\n' "$name" > "$d/$name.yml"
  else
    printf 'name: %s\n        <!-- template-version: %s -->\nbody: []\n' "$name" "$ver" > "$d/$name.yml"
  fi
}

# run <desc> <expected-exit> <dir> [canonical-doc]
run() {
  bash "$SCRIPT" "$3" ${4:+"$4"} >/dev/null 2>&1
  local rc=$?
  if [ "$rc" -eq "$2" ]; then
    echo "  ok: $1"
    pass=$((pass + 1))
  else
    echo "  FAIL: $1 (expected exit $2, got $rc)"
    fail=$((fail + 1))
  fi
}

t=$(mktemp -d)

d="$t/eq"; mkdir -p "$d"
mk "$d" feature 4; mk "$d" bug 4; mk "$d" security 4
run "all templates at the same version passes" 0 "$d"

d="$t/drift"; mkdir -p "$d"
mk "$d" feature 5; mk "$d" bug 4; mk "$d" security 4
run "one lagging template fails" 1 "$d"

d="$t/exempt"; mkdir -p "$d"
mk "$d" feature 4; mk "$d" bug 4; mk "$d" contribution -
run "an unmarked template is exempt" 0 "$d"

d="$t/single"; mkdir -p "$d"
mk "$d" feature 4
run "a single versioned template has nothing to lock" 0 "$d"

d="$t/mixdrift"; mkdir -p "$d"
mk "$d" feature 4; mk "$d" bug 5; mk "$d" contribution -
run "drift is caught even with an exempt file present" 1 "$d"

d="$t/withdoc"; mkdir -p "$d"
mk "$d" feature 4; mk "$d" bug 4
printf 'canonical\n<!-- template-version: 4 -->\n' > "$t/doc-ok.md"
run "canonical doc at the matching version passes" 0 "$d" "$t/doc-ok.md"

printf 'canonical\n<!-- template-version: 5 -->\n' > "$t/doc-drift.md"
run "canonical doc at a different version fails" 1 "$d" "$t/doc-drift.md"

# Issue #61: forge-adapt (v<=34) installed Forgejo templates to the LOWERCASE
# .forgejo/issue_template, which resolve_dir did not accept, so on such repos the guard
# printed "nothing to check" and exited 0 over drifted templates. Legacy lowercase
# installs must be resolved. Needs the no-arg (CI) invocation, so fixtures are git repos.
lc="$t/lowercase-repo"; mkdir -p "$lc/.forgejo/issue_template"
git -C "$lc" init -q
mk "$lc/.forgejo/issue_template" feature 4
mk "$lc/.forgejo/issue_template" bug 99
out=$( (cd "$lc" && bash "$SCRIPT" 2>&1) ); rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'DRIFT'; then
  echo "  ok: lowercase .forgejo/issue_template is resolved and drift is caught"
  pass=$((pass + 1))
else
  echo "  FAIL: lowercase .forgejo/issue_template drift (expected exit 1 + DRIFT report, got exit $rc)"
  fail=$((fail + 1))
fi

# Ordering is HOST-grouped, not case-grouped: a repo migrated GitHub->Forgejo that kept a
# stale .github/ISSUE_TEMPLATE while its live templates sit in legacy .forgejo/issue_template
# must have the LIVE Forgejo dir checked, not the stale GitHub one.
mg="$t/migrated-repo"; mkdir -p "$mg/.github/ISSUE_TEMPLATE" "$mg/.forgejo/issue_template"
git -C "$mg" init -q
mk "$mg/.github/ISSUE_TEMPLATE" feature 4
mk "$mg/.github/ISSUE_TEMPLATE" bug 4
mk "$mg/.forgejo/issue_template" feature 4
mk "$mg/.forgejo/issue_template" bug 99
out=$( (cd "$mg" && bash "$SCRIPT" 2>&1) ); rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'forgejo/issue_template'; then
  echo "  ok: live legacy Forgejo dir outranks a stale .github dir (host-grouped order)"
  pass=$((pass + 1))
else
  echo "  FAIL: migrated-repo ordering (expected exit 1 checking .forgejo/issue_template, got exit $rc)"
  fail=$((fail + 1))
fi

# When BOTH casings exist, uppercase is canonical and wins; a warning names the other dir.
# Uppercase in lockstep + lowercase drifted must pass (proves uppercase was selected) and
# warn (proves the duplicate is surfaced rather than silently first-matched).
bc="$t/bothcase-repo"; mkdir -p "$bc/.forgejo/ISSUE_TEMPLATE" "$bc/.forgejo/issue_template"
git -C "$bc" init -q
if [ "$bc/.forgejo/ISSUE_TEMPLATE" -ef "$bc/.forgejo/issue_template" ]; then
  # Case-insensitive filesystem (macOS/Windows): the two casings are ONE directory, so the
  # both-casings scenario cannot be constructed here. The guard itself handles that FS via
  # the -ef check; skip rather than fail.
  echo "  ok: both-casings case skipped (case-insensitive filesystem)"
  pass=$((pass + 1))
else
mk "$bc/.forgejo/ISSUE_TEMPLATE" feature 4
mk "$bc/.forgejo/ISSUE_TEMPLATE" bug 4
mk "$bc/.forgejo/issue_template" stale 99
out=$( (cd "$bc" && bash "$SCRIPT" 2>&1) ); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'WARNING.*issue_template'; then
  echo "  ok: with both casings, uppercase wins and the duplicate dir is warned about"
  pass=$((pass + 1))
else
  echo "  FAIL: both-casings case (expected exit 0 + WARNING, got exit $rc)"
  fail=$((fail + 1))
fi
fi

# --- doc-rules-version is NOT locked (issue #94) --------------------------------------------
# ticket-standards.md carries two markers. `template-version` says which FORM it describes and IS
# locked to the templates; `doc-rules-version` says which revision its RULES TEXT is at and must be
# free to move on its own, or a prose clarification costs an auto-synthesis round trip over every
# open ticket, which is the coupling #94 removed.
mkdoc() {   # mkdoc <path> <template-version> <doc-rules-version|-> [reversed]
  { if [ "${4:-}" = reversed ]; then
      [ "$3" = "-" ] || printf '<!-- doc-rules-version: %s -->\n' "$3"
      printf '<!-- template-version: %s -->\n' "$2"
    else
      printf '<!-- template-version: %s -->\n' "$2"
      [ "$3" = "-" ] || printf '<!-- doc-rules-version: %s -->\n' "$3"
    fi
    printf '\n# Ticket standards\n'; } > "$1"
}

d="$t/two-markers"; mkdir -p "$d"
mk "$d" feature 5; mk "$d" bug 5
mkdoc "$t/doc-a.md" 5 1
run "a doc carrying both markers, in lockstep, passes" 0 "$d" "$t/doc-a.md"

mkdoc "$t/doc-b.md" 5 9
run "doc-rules-version may differ from template-version without drift" 0 "$d" "$t/doc-b.md"

# ORDER-REVERSED on purpose. With template-version written first, a loose `[a-z-]*-version`
# pattern still finds it, so the assertion would pass for the wrong reason and could not detect
# the very mutation it exists to catch (verified: that mutant survived until this fixture existed).
# Putting doc-rules-version first makes the guard's LITERAL pattern the only reason it passes.
mkdoc "$t/doc-c.md" 5 9 reversed
run "the guard reads template-version by name, not by position" 0 "$d" "$t/doc-c.md"

mkdoc "$t/doc-c2.md" 4 5 reversed
run "...and still catches drift when the markers are reversed" 1 "$d" "$t/doc-c2.md"

mkdoc "$t/doc-d.md" 4 1
run "template-version drift is still caught when both markers are present" 1 "$d" "$t/doc-d.md"

rm -rf "$t"

# The no-arg path is what CI invokes: it resolves the template dir and the canonical doc
# itself. Exercise it against the real repo (which is in lockstep) so a regression in
# resolve_dir or the default-doc wiring cannot ship green.
if bash "$SCRIPT" >/dev/null 2>&1; then
  echo "  ok: no-arg run resolves the real repo and passes"
  pass=$((pass + 1))
else
  echo "  FAIL: no-arg run against the real repo (expected exit 0)"
  fail=$((fail + 1))
fi

echo ""
echo "template-lockstep tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
