#!/usr/bin/env bash
# leak-lib-version: 1
#
# The history reader and object selection, defined once and sourced by both leak scanners (#206).
#
# WHY A LIBRARY. Until #206 this block existed twice, once in each scanner, regenerated from the
# public half by script during #191. Every fix in it landed twice, the private half received the
# code and almost none of the tests, and in three weeks the copies drifted three times (#211's emit
# line, an allow-file loop added to one copy, #222's read step). The separator and the allow-file
# skip were the two seams; they now live outside this file (the separator is the argument below,
# the skip is each scanner's own skip_by_name), so what is left is one definition with two callers.
#
# Source it, do not execute it. Only the --history branch of each scanner sources it, and lazily,
# on purpose: the tree modes (--all, --staged, --range, --head, which both git hooks run) must keep
# working in a project that installed the scanners before this file existed, or that refreshed
# one asset alone. Sourcing at the top of the scanner, the shape the roadmap and forge-host
# libraries use, would make every hook refuse there. Do not "fix" it to that shape.
#
# THE CONTRACT. history_read <separator> reads the publishable history into "$TMPD/tagged", one
# "<label>\t<line>\t<separator><text>" row per content line it keeps, and always creates that file
# (empty when nothing is selected). The caller defines what this file uses and does not define:
# die (exits 2 with the caller's own prefix), TMPD, ORPHANS, SELF, set_lower (sets LOWER), and
# skip_by_name (the caller's own skip rules, allow-file included). The functions are checked when
# this file is sourced, so a wrong caller fails at once rather than mid-scan. The separator is an
# argument rather than a literal on the read line because the read line is shared: the public
# scanner passes a space so its rule C has a byte before column 1 (#211), the private one passes
# nothing, because its matching splits on the second tab and a space would reach its evidence.
#
# VERSIONS. The scanner checks that history_read exists after sourcing, which catches a library from
# before #206 or a wrong file, and nothing finer: forge-adapt drift and refresh compare the marker
# above, the posture roadmap-lib.sh takes. A scanner reached through a symlink looks for this file
# beside the symlink, not beside its target (the same limit the roadmap assets document).
#
# NO `awk -v` IN THIS FILE (#259), and no awk takes a file operand (#405): every value reaches awk
# through ENVIRON (`LG_*`) and every file through a redirect. bash 3.2 is the floor.

[ "${BASH_SOURCE[0]}" != "$0" ] || { echo "leak-lib: a library sourced by the leak scanners, not a command" >&2; exit 2; }
for _lg_fn in die set_lower skip_by_name; do
  type "$_lg_fn" >/dev/null 2>&1 || { printf 'leak-lib: %s is not defined by the sourcing scanner\n' "$_lg_fn" >&2; exit 2; }
done
unset _lg_fn

# The reader. One awk program, POSIX, run under LC_ALL=C over the --batch stream with NUL already
# mapped to \001 by tr. It is in the r<0 state between objects, where the only thing it will accept
# is a header; inside an object it COUNTS: r starts at the declared size plus the newline git adds,
# every line subtracts its length plus one, and the object ends when r reaches zero. A content line
# that looks like a header is therefore content. No regex touches a content line (each scanner's
# header says why); index, substr and length are byte operations. It emits "<label>\t<line>\t<text>"
# for every content line of every object it keeps, and DROPS an object when it contains NUL (seen as
# \001, so a genuine \001 byte drops it too), or when it is the scanner's own source: an oid marked
# "cand" (some path has this scanner's basename) is self when it carries the marker line; an oid
# with NO known path (--orphans) is self under the weaker content test of shebang plus marker on
# lines 1 and 2. Once an object is dropped nothing more of it is buffered, so memory is bounded by
# the largest KEPT object, not the largest object. The byte between the line number and the text is
# the caller's separator ($1 of history_read, read through ENVIRON as LG_SEP; see the header). The
# record on which r reaches zero and that is empty is git's terminator, not a line, and is never
# emitted.
# The "r < 0 {" line is the load-bearing one, and the contract test mutates exactly it.
READER='
BEGIN {
  labels = ENVIRON["LG_LABELS"]; orphans = ENVIRON["LG_ORPHANS"] + 0; sep = ENVIRON["LG_SEP"]
  r = -1
  while ((getline l < labels) > 0) {
    split(l, a, "\t"); label[a[1]] = a[2]
    if (a[2] != "") haspath[a[1]] = 1
    if (a[3] == "cand") cand[a[1]] = 1
  }
  close(labels)
}
r < 0 {
  if (NF == 3 && (length($1) == 40 || length($1) == 64) && ($2 == "blob" || $2 == "commit" || $2 == "tag") && $3 ~ /^[0-9]+$/) {
    oid = $1; type = $2; r = $3 + 1; n = 0; drop = 0; cnt = 0; body = (type == "blob")
    if (type == "blob") { lab = ((oid in label) && label[oid] != "") ? label[oid] "@" oid : "blob@" oid } else lab = type "@" oid
    next
  }
  print "malformed cat-file header: " $0 > "/dev/stderr"; exit 2
}
{
  r -= length($0) + 1; n++
  if (!drop) {
    if (n == 1) first = $0
    if (index($0, "\001")) drop = 1
    else if (substr($0, 1, 8) == "# check-" && index($0, "-leaks-version: ")) {
      if (oid in cand) drop = 1
      else if (orphans && n == 2 && !(oid in haspath) && substr(first, 1, 2) == "#!") drop = 1
    }
    if (drop) split("", buf)
    else if (body) { if (!(r <= 0 && $0 == "")) buf[cnt++] = n "\t" sep $0 }
    else if ($0 == "") body = 1
  }
  if (r <= 0) {
    if (!drop) for (i = 0; i < cnt; i++) print lab "\t" buf[i]
    split("", buf); r = -1
  }
}
END { if (r > 0) { print "truncated cat-file stream" > "/dev/stderr"; exit 2 } }
'

# Every pipeline in here checks EVERY stage. A stage that fails leaves a partial map or a partial
# stream, and a partial scan that reports clean is the exact outcome this mode exists to prevent.
pipe_ok() {  # pipe_ok <what> <PIPESTATUS...>
  local what="$1"; shift; local st
  for st in "$@"; do [ "$st" = 0 ] || die "$what failed (a stage exited $st); nothing was scanned"; done
}

history_read() {  # history_read <separator>: the publishable history into "$TMPD/tagged"
  # Refusals first. Each is a store this scanner would read as if it were the repository, and is not.
  # Replacement refs and grafts make git SHOW a different object than the one a push sends; the
  # env var turns the first off for every git call below, and the second cannot be turned off.
  export GIT_NO_REPLACE_OBJECTS=1
  local grafts
  grafts="$(git rev-parse --git-path info/grafts 2>/dev/null)"
  [ -n "$grafts" ] && [ -f "$grafts" ] && die "refusing --history: info/grafts exists, and grafts hide objects a push still sends"
  [ -z "${GIT_OBJECT_DIRECTORY:-}" ] || die "refusing --history: GIT_OBJECT_DIRECTORY is set"
  [ -z "${GIT_ALTERNATE_OBJECT_DIRECTORIES:-}" ] || die "refusing --history: GIT_ALTERNATE_OBJECT_DIRECTORIES is set"
  local alt promisor
  alt="$(git rev-parse --git-path objects/info/alternates 2>/dev/null)"
  [ -n "$alt" ] && [ -f "$alt" ] && die "refusing --history: objects/info/alternates points outside this repository ($alt)"
  promisor="$(git config --get extensions.partialclone 2>/dev/null || true)"
  [ -n "$promisor" ] || promisor="$(git config --get-regexp '^remote\..*\.promisor$' true 2>/dev/null | sed -n 's/^remote\.\(.*\)\.promisor.*/\1/p' | head -1)"
  [ -z "$promisor" ] || die "refusing --history: this is a partial clone; --history would fetch every missing object from $promisor"

  local objects="$TMPD/objects" types="$TMPD/types" pathmap="$TMPD/paths" labels="$TMPD/labels" oids="$TMPD/oids"
  local tagged="$TMPD/tagged"
  # Enumerate the publishable set: every ref except refs/stash, plus every worktree's HEAD, which is
  # what a mirror push sends (#210: --branches --tags --remotes missed refs/original, refs/notes
  # and every custom namespace). --exclude narrows only the selector AFTER it, so it must precede
  # --all; the other way round the stash is scanned and the suite's stash case fails. No
  # --single-worktree: a linked worktree's detached HEAD over-reports, the safe side.
  # --batch-all-objects (--orphans) carries no path; the map below still supplies paths for
  # whatever is reachable.
  if [ "$ORPHANS" = 1 ]; then
    git cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)' > "$types"; pipe_ok "git cat-file --batch-check" "${PIPESTATUS[@]}"
    : > "$objects"
  else
    git rev-list --objects --exclude=refs/stash --all > "$objects"; pipe_ok "git rev-list" "${PIPESTATUS[@]}"
    cut -d' ' -f1 "$objects" | git cat-file --batch-check='%(objectname) %(objecttype)' > "$types"; pipe_ok "git cat-file --batch-check" "${PIPESTATUS[@]}"
  fi
  # An object git cannot read prints "<oid> missing" with exit 0. That is a store this scanner
  # cannot read honestly, so it refuses rather than scanning what is left.
  local unreadable
  unreadable="$(LC_ALL=C awk '$2 != "blob" && $2 != "commit" && $2 != "tag" && $2 != "tree" { print; exit }' < "$types")"
  [ -z "$unreadable" ] || die "refusing --history: git cannot read every object ($unreadable); repair the store first"
  # Every path each blob has ever had, from every commit's diff against every parent (-m: a merge
  # resolved to content in neither parent has no other entry). -z then tr, because --raw quotes
  # unusual paths without it. Deletions carry the null oid and drop out with the "D" status.
  # The -c overrides pin the output shape against user config that would otherwise change it
  # silently: log.showSignature injects lines, log.diffMerges=combined changes the record shape and
  # the field that holds the merge result, diff.relative drops entries outside the cwd, and
  # log.showRoot=false drops the root commit. Each was reproduced hiding a reachable leak.
  # The parser then REFUSES a record that is not the five-field meta line it expects (a path
  # containing a newline, split by tr, is the known way to produce one), because a desynchronised
  # map suppresses every older entry. The shape test uses no regex over the path line.
  git -c log.showRoot=true -c log.showSignature=false -c log.diffMerges=separate -c diff.relative=false \
      log -m --exclude=refs/stash --all --raw --no-abbrev --no-renames --format= -z \
    | LC_ALL=C tr '\0' '\n' \
    | LC_ALL=C awk '
        NR % 2 == 1 { if (substr($0, 1, 1) != ":" || split($0, a, " ") != 5) { print "path map desynchronised at record " NR ": " $0 > "/dev/stderr"; exit 2 }
                      oid = a[4]; st = a[5]; next }
        st != "D" && oid !~ /^0+$/ { print oid "\t" $0 }' \
    | LC_ALL=C sort -u > "$pathmap"; pipe_ok "the path map (git log --raw)" "${PIPESTATUS[@]}"
  # Decide, per object, whether it is read and under what label. A blob is read unless EVERY path
  # it ever had is skipped; when its only unskipped paths carry this scanner's basename it is a
  # candidate for the identity test, which the reader completes by looking for the marker line. An
  # object with no path at all (--orphans, or a blob the map never saw) is read.
  # One sorted merge of every (blob, path) pair, the rev-list path first for each blob, then one
  # sequential read: no process runs per object, which is what keeps this under a second.
  local merged="$TMPD/merged"
  {
    # No regex over a line that carries a path (each scanner's header says why): the path is what
    # follows the first space.
    # && inside the group: a brace group's pipeline status is its LAST command's, so without it a
    # failure of the first awk would be invisible to pipe_ok (found in review round 2).
    LC_ALL=C awk '{ i = index($0, " "); p = i ? substr($0, i + 1) : ""; if (p != "") print $1 "\t0\t" p }' < "$objects" \
    && LC_ALL=C awk -F'\t' '{ print $1 "\t1\t" $2 }' < "$pathmap"
  } | LC_ALL=C sort -t'	' -k1,1 -k2,2 -k3,3 -u \
    | LC_ALL=C LG_TYPES="$types" awk -F'\t' '
        BEGIN { types = ENVIRON["LG_TYPES"]; while ((getline l < types) > 0) { split(l, a, " "); t[a[1]] = a[2] } close(types) }
        t[$1] == "blob" { seen[$1] = 1; n = split($3, b, "/"); print $1 "\t" $3 "\t" tolower(b[n]) }
        END { for (o in t) if (t[o] == "blob" && !(o in seen)) print o "\t\t" }' > "$merged"; pipe_ok "the object merge" "${PIPESTATUS[@]}"
  local oid type path lower cur="" keep="" selfnamed=0 first="" selfbase="${SELF##*/}"
  set_lower "$selfbase"; local selflower="$LOWER"
  : > "$labels"
  finish_blob() {
    [ -n "$cur" ] || return 0
    if [ "$keep" = blob ]; then printf '%s\n' "$cur" >> "$labels"
    elif [ -n "$keep" ]; then printf '%s\t%s\t\n' "$cur" "$keep" >> "$labels"
    elif [ "$selfnamed" = 1 ]; then printf '%s\t%s\tcand\n' "$cur" "$first" >> "$labels"
    fi
  }
  while read -r oid type; do
    case "$type" in commit|tag) printf '%s\n' "$oid" >> "$labels" ;; esac
  done < "$types"
  while IFS='	' read -r oid path lower; do
    if [ "$oid" != "$cur" ]; then finish_blob; cur="$oid"; keep=""; selfnamed=0; first=""; fi
    [ -n "$path" ] || { keep=blob; continue; }
    [ -n "$first" ] || first="$path"
    [ -z "$keep" ] || continue
    skip_by_name "$path" "$lower" && continue
    [ "$lower" != "$selflower" ] || { selfnamed=1; continue; }
    keep="$path"
  done < "$merged"
  finish_blob
  cut -f1 "$labels" > "$oids"
  : > "$tagged"
  [ -s "$oids" ] || return 0
  git cat-file --batch < "$oids" \
    | LC_ALL=C tr '\0' '\001' \
    | LC_ALL=C LG_LABELS="$labels" LG_ORPHANS="$ORPHANS" LG_SEP="$1" awk "$READER" > "$tagged"; pipe_ok "the history reader" "${PIPESTATUS[@]}"
}
