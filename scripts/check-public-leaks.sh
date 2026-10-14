#!/usr/bin/env bash
# check-public-leaks-version: 38
#
# The public half of the leak guard: home paths, unlisted "~/" roots and reachable addresses.
#
# Stops the developer's own machine leaking into a repository that is about to be made public
# (forge-kit issue #99, split as #155). It catches by SHAPE and by ALLOWLIST, so it needs no list
# of private names and can therefore run in CI, in the open, for every contributor. The first line
# above is deliberately one whole sentence: the component index renders it verbatim.
#
# HONEST STATEMENT OF REACH. This would not have caught the leak that prompted the ticket. That was
# a set of real sibling-project folder names sitting in prose as demo data, and a folder name in
# prose contains no path and no "@". Rules A and C catch the pasted-traceback class, which is the
# one that recurs. Rule B catches the "~/" class, which is the one that survived a full history
# scrub. NOTHING PUBLIC CATCHES A BARE PROJECT NAME: that needs the list, the list cannot live in
# the repository it protects, and so it lives outside it and is checked by the private half. A
# guard that overstates its reach is worse than a narrow one that admits it.
#
# THE TREE MODES NEVER LOOK AT HISTORY; --history DOES, AND IT IS OPT-IN (#185, #191). `--all`
# and `--head` change to the repository root first, so from any directory they cover every tracked
# file and print root-relative paths (#401). `--all`
# enumerates `git ls-files`: tracked files in the WORKING TREE. `--head` reads HEAD's COMMITTED
# tree (#375; `git ls-tree -r -z HEAD`, each blob by `git show "HEAD:./$f"`), so an uncommitted
# edit, or a tracked file deleted in the working tree, cannot mask what a push publishes: the
# pre-push hook uses it. It is HEAD's tree and not every pushed commit. `--staged` reads the
# index. `--range` enumerates `git diff --no-renames --name-only --diff-filter=ACMT` between two
# endpoints and reads each file at HEAD, so a file added AND deleted inside the range is excluded
# at both ends. A home path committed in one commit and removed in the next is invisible to all
# four, in the public repository where it stays readable forever, and that is exactly the
# going-public moment this component exists for. `--no-renames` and the `T` are load-bearing
# (#208): with rename detection on, a renamed-and-edited file is status R and was listed by
# nothing, so the commit hook said clean on an ordinary `git mv` plus an appended leak; a symlink
# replaced by a file is T and was invisible the same way. The tree modes also FAIL CLOSED like
# `--history` now: a temp directory that cannot be made, a blob git has but cannot write, a
# tracked file this process cannot open, are each exit 2 with the file named, where every one
# used to be exit 0.
#
# `--history` reads the publishable history: every blob reachable from EVERY REF EXCEPT refs/stash,
# plus every worktree's HEAD (`--exclude=refs/stash --all`, the exclude BEFORE the selector it
# narrows), and every commit and tag MESSAGE (subject and body; the author, committer and tagger
# lines are what the forge already shows beside each commit and are not scanned). That set is what
# a mirror push sends: branches, tags, remote-tracking refs (a branch that exists only on the remote
# is already on a forge), refs/notes, filter-branch's refs/original backups, refs/pull and any
# custom namespace (#210: the first cut read branches, tags and remotes only, so a scrubbed
# history whose backup ref still held the leak scanned clean). A detached HEAD is over-reporting,
# since a push sends refs/ only, which is the safe side. Not reached, by design: refs/stash, which no
# push sends (--orphans reaches it), and a tag message embedded in a commit's mergetag header. One `git cat-file --batch` streams the
# objects and a POSIX awk reader counts each object's declared BYTES, so a blob whose first line
# forges a batch header cannot hide the line after it (a line-oriented reader would skip it). The
# reader puts no content byte, and no path byte, through a regex: Apple's awk aborts the moment a
# regex meets a byte over 0x7F (every such byte under a C locale on glibc; an invalid sequence under
# a UTF-8 one), and a reader that only counts and slices cannot meet that on any libc. LC_ALL=C is
# there for byte-length semantics, not to avoid that abort. Objects containing NUL are dropped
# whole, the stream's equivalent of grep -I (a genuine \001 byte drops one too, since NUL is mapped
# to it for awk's sake; the tree modes would read that file). Refs/replace and grafts are ignored
# or refused, because they make git show a different object than the one a push sends.
# An object is scanned unless EVERY path it has ever had is skipped (the binary and lockfile names,
# the allow-file `skip` entries, the scanner's own past copies), so identical content at
# "zzz.md" and "aaa.lock" is still reported. Cost on this repository, 4,300 reachable objects and
# 23 MB of content: about 3 s of CPU under bash 5 and twice that under bash 3.2 (measured 2026-09-14
# on a loaded machine; the reader itself is a tenth of that, the rest is bash judging matches),
# against fourteen seconds process-per-blob. The tagged stream materialises the whole readable
# history under TMPDIR once, and `hits` can equal it again, so budget twice the readable content on
# disk; awk holds the largest kept object twice in memory. NEVER wired into a hook: it is a
# pre-publish step, run by hand, and its evidence is REDACTED by default (see below).
#
# COST AND ITS LIMITS (#211, #239). Rules A and B are linear in the line length in TREE mode and
# under `--history --show-evidence`: the tail walk is one anchored match rather than a per-byte
# loop, the segment is cut with a shortest-match strip (`${raw#/*/}`) rather than `${raw##*/}`,
# which a 262144-byte dot-tail case in the suite pins with a mutant, and a trailing slash is
# tested before it is stripped rather than through `${m%/}`, which tries every suffix when the
# string does not end in one. A 64 KB punctuation tail cost 40 s and now costs 0.15 s; 1 MB took
# 2 s unloaded and 3.7 s under load. The REDACTED `--history` report is linear too (#217): redact
# builds its mask by doubling and the home arms cut the segment with IFS=/ read, and the suite
# times a 256 KB email match and 1 MB home-path and home-root segments under a UTF-8 locale.
# Measured on bash 5.2.21 and glibc; this repository's stated floor is bash 3.2.57, where the
# COST is unmeasured. Correctness does not rest on that floor behaving: a failed tail match falls back to the byte loop, so an engine that
# does not reload the locale the way `local LC_ALL=C` expects reports a finding slowly rather
# than missing it (review of #239).
# Rule C is linear in the line length in both modes: the anchored
# RE_MAIL keeps grep on its DFA, LC_ALL=C on the tree-mode grep keeps it there under any locale,
# and judge() splits the address with `IFS=@ read` rather than `${addr#*@}`. A 1 MB token followed
# by an address costs 0.08 s where it once cost minutes, which is what matters: a hook that stalls
# is a hook that gets --no-verify, and that is how this guard gets removed.
#
# THREE SHAPES THIS DELIBERATELY DOES NOT REPORT, the first two consequences of the above, each
# pinned by a test case so they cannot be rediscovered as bugs:
#   1. An address glued to a home path or root, `/home/<name>/<name>@<host>.<tld>` and
#      `~/<root>/<name>@<host>.<tld>`: rules A and B end in `/?`, which consumes the byte rule C's anchor
#      needs, so the path row is reported and the address is not. Dropping that `/?` would change
#      five existing cases for a shape no real tree here has produced. A separator between the two
#      (`/home/<name>/notes <name>@<host>.<tld>`) reports both.
#   2. An accented local part or domain in TREE mode, a local part with an acute e or a diaeresis,
#      or a domain with an accented letter, likewise: LC_ALL=C narrows `[A-Za-z]` to ASCII, where a
#      territory UTF-8 locale would admit Latin letters with diacritics. This is not a new blind
#      spot: --history has always run under C, and CI runs under C.UTF-8, where GNU grep already
#      misses them; the pin makes the laptop hook path match them. Widening the three classes with
#      \x80-\xff is linear and was costed, and it glues any preceding multibyte byte into the
#      evidence, so it is a maintainer decision rather than an oversight.
#   3. A `/home/` or `/Users/` preceded by a word byte or a dot (#230): `./home/<Screen>.vue`,
#      `src/home/index.ts`, `https://example.com/home/<name>`. Rule A is anchored on the byte
#      before it, so a home path glued to a word (`cd/home/<name>` in a pasted transcript with the
#      space lost) is not reported either. A real path starts at a boundary, and the fleet hit
#      that argued for this was a Vue screen importing its siblings from `./home/`. The same
#      mechanism as shape 1 applies to rule A against itself: in `/home/<a>//home/<b>` the first
#      match's trailing `/` consumes the second's anchor byte, so only `/home/<a>/` is reported.
#
# `--history --orphans` also reads objects no ref reaches: a leak amended or reset away is still
# in the local store until `git gc` prunes it, and so is a stash entry, which is the one ref the
# set above leaves out. A push (a `--mirror` push included) and a clone over a URL never send
# either; a bundle never carries an orphan but `bundle create --all` does carry the stash; a clone
# from a local PATH (git hardlinks the object store) and any copy of the .git directory carry
# both, which is the case the flag exists for. It is NOT what reaches a filter-branch
# backup: refs/original is a ref, a mirror push sends it, and plain --history reads it. An object that is also reachable keeps
# its paths and its skips; a true orphan has no path, so nothing is skipped by name for it and the
# self-skip falls back to a weaker content test (shebang plus marker line).
#
# --history NEEDS leak-lib.sh BESIDE THIS SCRIPT (#206): the reader and the object selection are
# defined there once, for both scanners. Without it (or with one that is unreadable or too old)
# --history refuses, exit 2. The tree modes, which the git hooks run, never read it.
#
# WHAT --history REFUSES, exit 2, because a store it cannot read honestly is worse than none: an
# alternates file (a `git clone --shared`, resolved through `git rev-parse --git-path` so a linked
# worktree's .git FILE is handled), GIT_ALTERNATE_OBJECT_DIRECTORIES or GIT_OBJECT_DIRECTORY set (the
# second re-points the alternates check itself), and a partial clone, which would otherwise fetch
# every missing object from its remote during the scan. It also refuses, exit 2, a store git cannot
# read in full (an object reported "missing"), a path map it cannot parse (a path containing a
# newline), and any pipeline stage that fails, since a partial scan reporting clean is the one
# outcome worse than no scan. One cosmetic limit: a path containing a TAB prints truncated at the
# tab in the report label; the finding itself is not affected. The alternatives to this reader, a
# bash `read -N` (bash 4.1, and it drops NUL uncounted), a helper in another language (forge-adapt
# installs assets/*.sh only) and `cat-file -Z` (git 2.42), were each costed in #191 and rejected
# because this one adds no floor.
#
# The store holds more than file contents: on this repository, 1,639 blobs against 527 commit
# objects. Whoever scans the store by hand (#198):
# pass `grep -a` over a `git cat-file --batch` stream, because tree objects contain NUL and a grep
# then treats the stream as binary, GNU replacing matched lines with "binary file matches" and a
# wrapper that passes `-I` skipping the stream and reporting no match at all.
#
# A history-aware CREDENTIAL scanner is still a companion, not a substitute: `gitleaks git .` hunts
# secrets and this hunts the developer's IDENTITY, which is a different subject with a different
# false-positive profile. Running both is the answer.
#
# AND BOTH PATH RULES JUDGE THE FIRST SEGMENT ONLY. Rule A asks who "/home/<name>/" belongs to and
# rule B asks whether "~/<root>" may be shown; NEITHER looks below that. So a private directory name
# under an allowed root ("~/<root>/<client>/repo", "/home/<name>/clients/<client>/build.log") is
# invisible here, and the segments above the project are exactly what the ticket called the worse
# half of the leak. Catching those needs the name, which is the private half's job. This was found
# by review AFTER the paragraph above shipped, which is the argument for the paragraph.
#
#   check-public-leaks.sh [--staged | --range <base> | --head | --all] [--allow-file <path>]
#                         [paths...]
#   check-public-leaks.sh --history [--orphans] [--show-evidence] [--allow-file <path>]
#
# Exit 0 clean, 1 when something was found, 2 when it could not run. One line per violation:
#   <file>:<line>: <rule>: <evidence>                        (tree modes)
#   <path>@<oid>:<line>: <rule>: <evidence>                  (--history; commit@, tag@, or blob@
#                                                             when no path is known)
# In --history the evidence is redacted to two leading characters (/home/al***/, ~/se****/,
# al******) because a pre-publish report is exactly the text that gets pasted into a public
# issue; --show-evidence prints it whole.
#
# WHY RULE B IS AN ALLOWLIST AND THE OTHER TWO ARE NOT. Shape can decide that a first name after
# /home/ is a person and that the word user there is a placeholder. Shape cannot decide whether "~/foo" is private, because the
# string carries no marker either way. So the test is inverted: an allowlist of roots a document is
# allowed to show. That catches the case by construction rather than by enumeration, and it needs
# one thing from the project, a canonical example root, agreed once.
#
# WHY BINARIES ARE DETECTED BY PIPING INTO grep -I. The obvious alternative, asking git for a
# numstat, is EMPTY in a full-tree mode because nothing is staged, so every binary then reaches a
# command substitution, which drops null bytes and warns once per occurrence. A full scan prints a
# wall of warnings and reads font files as text.
#
# WHY THE SCRIPT SKIPS ITSELF. Its own source has to carry the patterns, so scanning it would
# report the guard as a leak. Its TEST is not skipped here: it is excluded by an allow-file entry
# in the project that runs it, which keeps the exemption visible in that project's own config
# rather than hidden in this file.

# NO `awk -v` IN THIS FILE (#259). `-v` runs a backslash-escape pass over its value, and the temp
# paths this scanner hands to awk (`types`, `labels`) are built under `mktemp -d`, so they carry
# whatever the caller's TMPDIR is named. Under a TMPDIR named `t\tx` (backslash, t) the paths read
# back with a TAB, every `getline` failed, and `--history` reported CLEAN over a committed finding.
# Every value now reaches awk through ENVIRON (`LG_*`); the 0-or-1 flags (`orphans`) moved as
# hardening only. The suite counts zero `awk ... -v` lines (scripts/awkv-count.sh, continuations
# joined), and no awk takes a file operand (#405): under a TMPDIR named `x=y` one was an assignment.
set -uo pipefail

# --- portability ------------------------------------------------------------
# macOS still ships bash 3.2 and a BSD readlink with no -f, and this component is installed into
# other people's repositories. A guard that dies on a contributor's laptop is a guard they remove.
# The lowercase helper assigns to a variable rather than returning a string, so the fast path on
# bash 4 costs no fork at all; the slow path pays one, on the platform that has no alternative.
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
  set_lower() { LOWER="${1?}"; LOWER="${LOWER,,}"; }
else
  set_lower() { LOWER="$(printf '%s' "${1?}" | tr '[:upper:]' '[:lower:]')"; }
fi
# POSIX stand-in for `readlink -f`, which is enough here: every path this resolves exists, so the
# only job is to make two spellings of the same file compare equal.
abspath() {
  local d b
  d="$(dirname -- "$1")"; b="$(basename -- "$1")"
  d="$(CDPATH= cd -- "$d" 2>/dev/null && pwd -P)" || { printf '%s' "$1"; return; }
  printf '%s/%s' "$d" "$b"
}

SELF="$(abspath "${BASH_SOURCE[0]}")"

MODE=all
MODESET=0
BASE=""
ALLOW_FILE=""
PATHS=()
ORPHANS=0
SHOW_EVIDENCE=0

die() { printf 'check-public-leaks: %s\n' "$1" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    # One mode per run. The last flag used to win silently, so "--history --staged" scanned the
    # index and reported clean on the history the user asked about. The five mode arms below carry
    # the same one-line refusal as their siblings and stay over 100 columns on purpose: they are
    # meant to be read as a column, and wrapping one would hide that they are identical (#384).
    --all)        [ "$MODESET" = 0 ] || die "one mode only: --all, --staged, --range, --head or --history"; MODESET=1; MODE=all ;;
    --staged)     [ "$MODESET" = 0 ] || die "one mode only: --all, --staged, --range, --head or --history"; MODESET=1; MODE=staged ;;
    --range)      [ "$MODESET" = 0 ] || die "one mode only: --all, --staged, --range, --head or --history"; MODESET=1
                  MODE=range; shift; [ $# -gt 0 ] || die "--range needs a base ref"; BASE="$1" ;;
    --history)    [ "$MODESET" = 0 ] || die "one mode only: --all, --staged, --range, --head or --history"; MODESET=1; MODE=history ;;
    --head)       [ "$MODESET" = 0 ] || die "one mode only: --all, --staged, --range, --head or --history"; MODESET=1; MODE=head ;;
    --orphans)    ORPHANS=1 ;;
    --show-evidence) SHOW_EVIDENCE=1 ;;
    --allow-file) shift; [ $# -gt 0 ] || die "--allow-file needs a path"; ALLOW_FILE="$1" ;;
    # Prints the whole comment header, rather than a hardcoded line range. The range was the bug:
    # growing the header by seven lines truncated --help mid-sentence and dropped the synopsis, and
    # help text that rots silently is worse than none because it still reads as current.
    --help|-h)    awk 'NR==1{next} /^# *[a-z0-9-]+-version: [0-9]+$/{next} /^#/{sub(/^# ?/,""); print; next} {exit}' < "$SELF"; exit 0 ;;
    --)           shift; while [ $# -gt 0 ]; do PATHS+=("$1"); shift; done; break ;;
    -*)           die "unknown flag: $1" ;;
    *)            PATHS+=("$1") ;;
  esac
  shift
done

# Trailing sentence punctuation belongs to the prose, not to the name. Only the tail is stripped,
# so "~/.claude" keeps the dot that is part of the directory name. The angle bracket is deliberately
# NOT in the set: stripping it would turn the "<user>" placeholder into "<user", which no longer
# matches the placeholder list, and the guard would start rejecting the documentation forms it
# exists to permit. Defined here, ahead of the allow-file parser below, because the prefix key
# needs it to refuse a dead entry before judge() (which needs it too) is ever reached.
TAIL_PUNCT='.,;:!?)]}"'"'"
# Assigns to STRIPPED rather than printing, like set_lower: a command substitution forks, and
# --history judges thousands of matches in one run.
# ONE anchored match, never a per-byte loop (#239). Every bash parameter expansion is O(n) in the
# string, so popping one byte at a time was quadratic: 40 s on a 64 KB punctuation tail under C and
# 183 s under a UTF-8 locale, where 9 ms is what the anchored regex costs. `${s##*[!punct]}` and a
# per-index loop were both measured WORSE (105 s and 9.6 s), and an unanchored regex is quadratic
# for the same reason #211 recorded for grep. The class is built from TAIL_PUNCT with `]` leading,
# which is how a bracket expression takes a literal `]`; TAIL_PUNCT holds no `^`, `-` or backslash,
# so nothing else in it is special there.
# LC_ALL=C is load-bearing, not hygiene: under a UTF-8 locale a byte that is not valid UTF-8 makes
# the match FAIL, and a failed match is read here as "entirely punctuation", which would suppress a
# leak this scanner reports today (found by the #239 security lens). Verified on bash 5.2.21; the
# stated floor is 3.2.57, where neither the reload nor the cost is measured.
_TAIL_CLASS="]${TAIL_PUNCT//]/}"
_TAIL_RE="^(.*[^$_TAIL_CLASS])[$_TAIL_CLASS]*$"
# TWO matches, then a loop that a working engine never reaches. The first says where the tail
# starts. The second is what the first failing MEANS on a working engine: the value is empty or
# entirely punctuation, so the answer is the empty string, and it is asked as a second anchored
# match rather than assumed, because assuming it is the direction that SUPPRESSES a finding on an
# engine that did not reload the locale (review of #239). Only when both disagree does the byte
# loop run, which is v18's rule exactly: correct, and slow only on an engine already misbehaving.
# The loop is NOT free and must stay unreachable: an entirely-punctuation segment is reachable
# (`/home/` followed by 64 KB of dots is a rule A match) and walking it byte by byte costs 33 s,
# which the second match answers in a millisecond (round 2 of the review found exactly that).
_TAIL_ALL="^[$_TAIL_CLASS]*$"
strip_tail() {
  local s="$1" c LC_ALL=C
  if [[ $s =~ $_TAIL_RE ]]; then STRIPPED="${BASH_REMATCH[1]}"; return; fi
  if [[ $s =~ $_TAIL_ALL ]]; then STRIPPED=""; return; fi
  while [ -n "$s" ]; do
    c="${s: -1}"
    case "$_TAIL_CLASS" in *"$c"*) s="${s%?}" ;; *) break ;; esac
  done
  STRIPPED="$s"
}
# in_list_stripping <value> <entries...>: is the value, or the value with any number of trailing
# TAIL_PUNCT bytes removed, in the list? A marker such as `[redacted]` ends in a byte strip_tail
# would pop, so "~/[redacted]." must be compared at EVERY step of the strip, not only raw and fully
# stripped: raw is `[redacted].`, fully stripped is `[redacted`, and the literal sits between them
# (#227 review). A list entry that itself ends in punctuation therefore matches its literal.
# Compared by ENTRY LENGTH rather than by walking the tail once per entry (#239): an entry `e`
# matches when the value truncated to `${#e}` equals it. THE LOWER BOUND IS THE RULE, not an
# optimisation: without `${#e}` at least `${#STRIPPED}` this is a prefix match, and every allow
# entry widens into a suppressor for every longer name starting with it (`root ~/forge-kit` would
# suppress `~/forge-kit-private`, and both that entry and `root [redacted` are live in this
# repository's own allow-file). A false negative is this component's one security failure mode.
# STRIPPED is left holding the fully stripped value on both paths, so rule A walks the tail once.
in_list_stripping() {
  local s="$1" e n min LC_ALL=C; shift
  strip_tail "$s"; min=${#STRIPPED}
  for e in "$@"; do
    n=${#e}
    [ "$n" -ge "$min" ] && [ "$n" -le "${#s}" ] || continue
    [ "${s:0:n}" = "$e" ] || continue
    return 0
  done
  return 1
}

# --- the allowed sets ------------------------------------------------------
# Roots a document may show. "<root>" is the generic placeholder for projects that have not agreed
# a canonical example root yet; the others are either the canonical root or real, published
# locations that any reader can visit on their own machine.
# The dotfile entries are not a nod to convenience. Every one of them names a location that is
# identical on every machine, so it discloses nothing about whose machine it is, which is the only
# question this rule asks.
ALLOW_ROOTS=(projects .claude .config .local .cache dev code src work '<root>'
             .ssh .bashrc .bash_profile .zshrc .profile .gitconfig .npmrc
             '[redacted]' '<redacted>' '***REMOVED***')
# The last three entries of both lists are REDACTION MARKERS (#227): a history rewrite that removes
# a private root or user replaces it with one, and the scanner must know the marker or the very
# rewrite that removed the leak leaves the scan red in every affected repository. `[redacted]` is
# the convention the leak-guard remediation uses; `***REMOVED***` is git filter-repo's own default
# when a --replace-text expression names no replacement. A marker is a LITERAL, never a shape:
# `~/[myco]/` is still a root.
# Segments that are obviously a stand-in for a person rather than a person.
PLACEHOLDER_USERS=(user users username youruser '<user>' '<username>' '<name>' '<you>' '...' '$USER' '${USER}' '$HOME'
                   '[redacted]' '<redacted>' '***REMOVED***')
ALLOW_PREFIXES=()
ALLOW_EMAILS=()
SKIP_PATHS=()

if [ -n "$ALLOW_FILE" ]; then
  [ -f "$ALLOW_FILE" ] || die "allow-file not found: $ALLOW_FILE"
  lineno=0
  while IFS= read -r raw || [ -n "$raw" ]; do
    lineno=$((lineno + 1))
    line="${raw%$'\r'}"
    # The trims are an ASCII BYTE list, never `[[:space:]]` (#403): RE_HOME and RE_ROOT run under
    # LC_ALL=C, so an edge U+2003 is part of a live entry there, and a caller-locale class trimmed it
    # under UTF-8 only, giving one allow-file two meanings. Under UTF-8 an edge-U+2003 key, comment
    # or U+2003-only line is therefore an entry like any other, and exits 2 where it is malformed.
    line="${line#"${line%%[!$' \t\n\v\f\r']*}"}"          # strip leading whitespace
    line="${line%"${line##*[!$' \t\n\v\f\r']}"}"          # strip trailing whitespace
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%% *}"; val="${line#* }"
    val="${val#"${val%%[!$' \t\n\v\f\r']*}"}"              # two spaces after the key are not part of the value (#240)
    [ "$key" != "$val" ] || die "$ALLOW_FILE:$lineno: entry has no value: $line"
    case "$key" in
      # A root is written the way it appears in prose, "~/name", so the config reads like the
      # thing it permits.
      root)
        # A trailing slash is stripped, as the prefix key strips it: rule B's own report prints
        # `~/<root>/`, so the natural copy-paste carries the slash, and judge() compares the root
        # without its slash, so stored with it the entry could never match (review of #224).
        rootv="${val#\~/}"; rootv="${rootv%/}"   # ~/ first, so `root ~/` strips to nothing and refuses
        # Exactly one segment, as the prefix key requires (#240): rule B yields one segment and
        # nothing deeper, so a two-segment root, a doubled slash (one is stripped above, one
        # remains) and a bare tilde (nothing strips it) could never match. This clause runs
        # BEFORE strip_tail below, which would otherwise pop nothing off "a/b" and accept it.
        case "$rootv" in '~'|*/*) die "$ALLOW_FILE:$lineno: root must name exactly one segment, because rule B matches one segment and nothing deeper: $val" ;; esac
        # A root that is entirely punctuation ("..", "}", "...") is returned clean by rule B before
        # the list is consulted, so an entry naming one can never change a verdict: a dead entry
        # that reads as a decision. Refused at parse time, as the prefix key's segment is (#224).
        # The redaction markers strip to something and stay accepted.
        # Rule B's match class yields no whitespace, double quote or backtick, so an entry carrying
        # one could never match (#239). The SINGLE quote is a name byte, not punctuation here:
        # `root o'brien` suppresses a live `~/o'brien` row, and refusing it would break a working
        # allow-file at exit 2. The whitespace is spelled as BYTES, as the prefix arm's is (#400, the
        # twin of #242): RE_ROOT's class runs under LC_ALL=C, where only these ASCII bytes are
        # whitespace, while `[[:space:]]` here would follow the caller's locale and, under UTF-8,
        # also refuse U+2003, which rule B can yield; so one entry got exit 0 or 2 by locale. The
        # allow-file line and value trims above use the same byte list, so an EDGE U+2003 is kept
        # in every locale too (#403).
        case "$rootv" in
          *[$' \t\n\v\f\r']*|*'"'*|*'`'*) die "$ALLOW_FILE:$lineno: root cannot contain whitespace, a double quote or a backtick (rule B's match class yields none of them), so this entry could never match: $val" ;;
        esac
        strip_tail "$rootv"
        [ -n "$STRIPPED" ] || die "$ALLOW_FILE:$lineno: root cannot be entirely punctuation (rule B never reports one), so this entry could never match: $val"
        # An entry ending in punctuation is compared after the strip, so it could only ever match
        # its own literal: the dead-entry class again (#239). The one exception is the redaction
        # marker `[redacted]`, which ends in a TAIL_PUNCT byte and is a literal on purpose; the
        # other two markers end in `>` and `*`, neither of which is in TAIL_PUNCT.
        # A BRACKETED literal is exempt, not only the marker itself: `[redacted]` is one shape a
        # rewrite writes, `[redacted-other]` and `[myco]` are others, and each matches exactly the
        # root a rewrite produced, which is the point of writing it (the #227 suite pins one).
        # Everything else ending in punctuation stays refused.
        case "$rootv" in \[*\]) bracketed=1 ;; *) bracketed=0 ;; esac
        if [ "$STRIPPED" != "$rootv" ] && [ "$bracketed" = 0 ]; then
          die "$ALLOW_FILE:$lineno: root cannot end in punctuation (rule B strips it before compare, so this entry could only match its own literal): $val"
        fi
        ALLOW_ROOTS+=("$rootv") ;;
      # Rule A matches "/home/<seg>" or "/Users/<seg>" and nothing deeper, so a prefix with more
      # than one segment, or one under any other root, can never equal a match. It would parse
      # cleanly and silently do nothing, which is the config bug every other key here refuses.
      prefix)
        pfx="${val%/}"
        case "$pfx" in
          /home/*|/Users/*) : ;;
          *) die "$ALLOW_FILE:$lineno: prefix must start /home/ or /Users/ (rule A matches no other root): $pfx" ;;
        esac
        rest="${pfx#/*/}"
        case "$rest" in
          */*|'') die "$ALLOW_FILE:$lineno: prefix must name exactly one segment, because rule A matches one segment and nothing deeper: $pfx" ;;
        esac
        # A segment that is entirely punctuation ("..", "...") is never a username: judge() will
        # never see it as one either (it returns before ALLOW_PREFIXES is consulted), so an entry
        # naming one could never match anything. Refuse it rather than accept a dead entry.
        strip_tail "$rest"
        [ -n "$STRIPPED" ] || die "$ALLOW_FILE:$lineno: prefix segment cannot be a username (entirely punctuation), so this entry could never match: $pfx"
        # Two more dead shapes (#242). Where both apply (a segment ending in a double quote, or
        # holding a space and ending in a period) the whitespace/quote/backtick message wins,
        # because it is checked first and is the deeper fault: RE_HOME could never yield the
        # segment at all, ending in punctuation or not.
        # Rule A's match class (RE_HOME) yields no [[:space:]], double quote or backtick.
        # The whitespace set is spelled as bytes, not [[:space:]], so this test gives the same
        # verdict in every caller locale: RE_HOME's [[:space:]] runs under LC_ALL=C and a UTF-8
        # caller's [[:space:]] would also match U+2003, which rule A's C-locale class does yield,
        # so refusing it would refuse a live entry.
        case "$rest" in
          *[$' \t\n\v\f\r']*|*'"'*|*'`'*) die "$ALLOW_FILE:$lineno: prefix segment cannot contain whitespace, a double quote or a backtick (rule A's match class yields none of them), so this entry could never match: $pfx" ;;
        esac
        # DELIBERATELY unlike root, which exempts a bracketed literal (#239): rule A strips the
        # match and compares it EXACTLY against the unstripped entry (no in_list_stripping, which
        # only rule B and PLACEHOLDER_USERS use), so an entry ending in a TAIL_PUNCT byte can
        # never equal a stripped match, bracketed or not. Do not copy root's exemption here.
        # Only the final byte is tested: punctuation inside a name (`a.b`, `o'brien`) is fine.
        [ "$STRIPPED" = "$rest" ] || die "$ALLOW_FILE:$lineno: prefix segment cannot end in punctuation (rule A strips it from the match before compare), so this entry could never match: $pfx"
        ALLOW_PREFIXES+=("$pfx") ;;
      # A custom redaction marker (#391): the built-in three are literals, and `~/[myco]/` is a root
      # unless the repository says its rewrite wrote that token. It joins BOTH lists the built-ins
      # sit in, so it is accepted in a `~/` root and in a `/home/` segment. One bracketed token and
      # nothing else: the unclosed `root [myco` spelling is deliberately not documented or pinned.
      marker)
        case "$val" in
          \[*\]) : ;;
          *) die "$ALLOW_FILE:$lineno: marker must be one bracketed token, [name]: $val" ;;
        esac
        mk="${val#\[}"; mk="${mk%\]}"
        case "$mk" in
          '') die "$ALLOW_FILE:$lineno: marker cannot be empty, write [name]: $val" ;;
          *[$' \t\n\v\f\r']*|*/*|*'"'*|*'`'*) die "$ALLOW_FILE:$lineno: marker cannot contain a slash, whitespace, a double quote or a backtick (a path segment yields none of them), so this entry could never match: $val" ;;
        esac
        ALLOW_ROOTS+=("$val"); PLACEHOLDER_USERS+=("$val") ;;
      email)  ALLOW_EMAILS+=("$val") ;;
      # skip_by_name() compares a skip value QUOTED, as an exact path or a slash-anchored suffix,
      # so `*` and `?` are literal there and a value holding one is a dead entry that reads as a
      # glob. Refused, as check-private-leaks.sh refuses it, so one shared line has one meaning
      # (#226). `[` is NOT refused: `app/[slug]/page.tsx` is a real path and matches literally.
      skip)
        case "$val" in *[*?]*) die "$ALLOW_FILE:$lineno: skip is matched as an exact path or a path suffix, so a wildcard could never match: $val" ;; esac
        case "$val" in */) die "$ALLOW_FILE:$lineno: skip names a file, so a value ending in / could never match: $val" ;; esac
        SKIP_PATHS+=("$val") ;;
      # REFUSE rather than skip the entry. A silently ignored line in a security config is a guard
      # that reports a coverage it does not have, which is the failure this whole component exists
      # to end.
      *)      die "$ALLOW_FILE:$lineno: unknown key '$key' (want root, prefix, marker, email or skip)" ;;
    esac
  done < "$ALLOW_FILE"
fi

# One builtin per lookup, not one iteration per entry: --history judges thousands of matches
# against these lists in a single run, and a bash loop is the slow part of bash.
in_list() { local n="$1"; shift; local IFS=$'\n'; case "$IFS$*$IFS" in *"$IFS$n$IFS"*) return 0 ;; esac; return 1; }

# --history is a mode, and the two flags that modify it mean nothing without it. Refused rather
# than ignored: a flag that silently does nothing is a scan the user believes ran wider than it did.
if [ "$MODE" = history ]; then
  [ "${#PATHS[@]}" -eq 0 ] || die "--history takes no paths"
else
  [ "$ORPHANS" = 0 ] || die "--orphans is only valid with --history"
  [ "$SHOW_EVIDENCE" = 0 ] || die "--show-evidence is only valid with --history"
fi
# Explicit paths would switch MODE to `paths` below and silently ignore --head (#375).
[ "$MODE" != head ] || [ "${#PATHS[@]}" -eq 0 ] || die "--head takes no paths"

# --- which files ------------------------------------------------------------
in_git() { git rev-parse --is-inside-work-tree >/dev/null 2>&1; }

FILES=()
if [ "${#PATHS[@]}" -gt 0 ]; then
  MODE=paths
  FILES=("${PATHS[@]}")
else
  # --history needs an object store, not a work tree: a bare mirror about to be published is a
  # natural target. The tree modes need the tree.
  if [ "$MODE" = history ]; then git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
  else in_git || die "not inside a git work tree (pass explicit paths to scan without git)"; fi
  # THE TREE MODES SCAN THE WHOLE REPOSITORY FROM ANY DIRECTORY (#401). `ls-files` and `ls-tree`
  # list only the current directory's subtree, so a run from `sub/` used to pass clean over a
  # committed root leak. Anchoring here, after the allow file is read (a caller-relative
  # `--allow-file ../x` still resolves against the caller's directory), makes `--all` and
  # `--head` see every tracked file and print root-relative paths, the form `--staged` prints.
  # `--staged` and `--range` are not anchored: their enumeration is already root-relative.
  # The empty-`top` test is defensive: the work-tree check above already refuses where
  # `--show-toplevel` would be empty, but a bare `cd ""` returns 0 without moving.
  if [ "$MODE" = all ] || [ "$MODE" = head ]; then
    top="$(git rev-parse --show-toplevel 2>/dev/null)"
    [ -n "$top" ] && CDPATH= cd -- "$top" || die "could not change to the work-tree root"
  fi
  case "$MODE" in
    history) : ;;
    all)
      while IFS= read -r -d '' f; do FILES+=("$f"); done < <(git ls-files -z) ;;
    staged)
      while IFS= read -r -d '' f; do FILES+=("$f"); done \
        < <(git diff --cached --no-renames --name-only --diff-filter=ACMT -z) ;;
    range)
      # Fail CLOSED on a base ref that is not present, rather than passing vacuously. The same
      # posture the repo's other range guards take: a check that cannot run must not report clean.
      git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null \
        || die "base ref not found: $BASE (fetch it first)"
      while IFS= read -r -d '' f; do FILES+=("$f"); done \
        < <(git diff --no-renames --name-only --diff-filter=ACMT -z "$BASE...HEAD") ;;
    head)
      # HEAD's committed tree (#375): what a push publishes, whatever the working tree says. The
      # unborn-HEAD check is explicit because the enumeration below hides a failure and an empty
      # list exits 0 further down. The pre-check is the mechanism for a failing `ls-tree`, since
      # `< <(...)` hides its exit status. Only blob entries (100644, 100755, 120000) are kept, so
      # a 160000 gitlink is skipped and no per-file `cat-file -t` is needed. `ls-tree` lists paths
      # relative to the CURRENT directory, which is why the read below is `HEAD:./$f`.
      git rev-parse --verify --quiet "HEAD^{commit}" >/dev/null \
        || die "HEAD not found: no commits yet, so --head has nothing to scan"
      git ls-tree -r -z HEAD >/dev/null 2>&1 || die "could not list HEAD's tree"
      while IFS= read -r -d '' ent; do
        case "${ent%% *}" in 100644|100755|120000) FILES+=("${ent#*$'\t'}") ;; esac
      done < <(git ls-tree -r -z HEAD) ;;
  esac
fi

[ "$MODE" = history ] || [ "${#FILES[@]}" -gt 0 ] || exit 0

# Unconditional and fatal: a scan that cannot make its temp directory used to continue and
# report clean (#208). A refusal is the honest answer and the hooks treat exit 2 as a block.
TMPD="$(mktemp -d 2>/dev/null)" || die "cannot create a temp directory"
trap 'rm -rf "$TMPD"' EXIT
BLOB="$TMPD/blob"

# --- what is not worth scanning --------------------------------------------
skip_by_name() {  # skip_by_name <path> [<lowercased basename>]
  # Suffixes match anywhere in the path; the named lockfiles must match the BASENAME, or a path
  # like "vendor/package-lock.json" slips through while "package-lock.json" at the root is caught.
  # The second argument lets --history, which decides thousands of paths in one loop, pass a
  # basename awk already lowercased, so the loop forks nothing on the bash-3 slow path.
  if [ $# -ge 2 ]; then LOWER="$2"; else set_lower "${1##*/}"; fi
  case "$LOWER" in
    *.png|*.jpg|*.jpeg|*.gif|*.bmp|*.ico|*.webp|*.svgz|*.pdf|*.zip|*.gz|*.bz2|*.xz|*.tar \
    |*.woff|*.woff2|*.ttf|*.otf|*.eot|*.mp3|*.mp4|*.mov|*.wav|*.class|*.jar|*.so|*.dylib \
    |*.dll|*.exe|*.pyc|*.o|*.a|*.wasm) return 0 ;;
    # A lockfile is generated, is enormous, and its registry URLs are full of shapes that look
    # like findings. Nobody writes prose in one.
    *.lock|package-lock.json|npm-shrinkwrap.json|yarn.lock|pnpm-lock.yaml|composer.lock \
    |gemfile.lock|poetry.lock|cargo.lock|go.sum|*.lockb) return 0 ;;
  esac
  local s
  for s in ${SKIP_PATHS+"${SKIP_PATHS[@]}"}; do
    [ "$1" = "$s" ] && return 0
    case "$1" in */"$s") return 0 ;; esac
  done
  return 1
}

# --- the three rules --------------------------------------------------------
# The backtick is excluded from both character classes for one reason found by running this over a
# real tree: a markdown code span is the commonest way a path appears in prose, and reading
# "~/name`" as the root means the project's own allow-file entry never matches it.
# Anchored like RE_MAIL below (#230): the byte before /home/ or /Users/ must not be a word byte or a
# dot, so "./home/Foo.vue", "src/home/index.ts" and "https://example.com/home/<name>" are a
# directory called home, not a home directory. A real path always starts at a boundary (a quote,
# =, (, a space, the start of the line). The match carries that one leading byte, and judge()
# strips it before dispatching, as it does for rule C. `~` is excluded from the anchor class too
# (review): with it admitted, a tilde root whose name is the word home matched rule A as the longer alternative and lost its
# rule B `root home` allow entry.
RE_HOME='(^|[^A-Za-z0-9_.~])(/home|/Users)/[^/[:space:]"`]+/?'
RE_ROOT='~/[^/[:space:]"`]+/?'
# The leading "(^|[^class])" is the half of #211 that makes rule C linear: unanchored, the local
# part's "+" run can start at EVERY position of a long word-class byte run, and grep leaves its DFA
# to retry each one (64 KB of [A-Za-z0-9] then one address: 105 s before, milliseconds after). The
# match therefore carries one leading byte where the line does not start with the address, and
# judge() strips it before dispatching. The other half is LC_ALL=C on the tree-mode grep below.
RE_MAIL='(^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
RE_ANY="$RE_HOME|$RE_ROOT|$RE_MAIL"

violations=0
report() { printf '%s:%s: %s: %s\n' "$1" "$2" "$3" "$4"; violations=$((violations + 1)); }

# Two leading characters and stars for the rest, the private half's shape. Applied in --history
# only, because that report is a pre-publish artifact and the likeliest thing to be pasted.
# LINEAR (#217): the length is counted once and the mask is built by doubling. A per-character
# loop that recounts ${#n} is quadratic under a UTF-8 locale (41 s at 128 KB), and a slow default
# pushes the operator to --show-evidence, which prints the secret. The k <= 0 guard runs BEFORE any
# slice: a negative length in ${s:0:k} is an error on bash 3.2, and on bash 5 too for a length-0
# input (k = -2), so lengths 0 to 2 print the input itself, exactly as ${1:0:2} always did.
# Characters, not bytes, in every locale (#416): the UTF-8 lead bytes, i.e. every byte but the 0x80 to
# 0xBF continuation bytes, so the length no longer depends on the locale (`${#n}` is bytes under C, characters under UTF-8).
# Sets CHARS. The tr is pinned to C because only under C is it a byte filter (a multibyte-aware tr
# can reject these bytes); the count after it needs no pin, since what is left holds no continuation
# byte and reads as one unit per byte (verified for C and UTF-8 only). One tr, so it is linear in any locale (#217);
# the trailing x keeps $( ) from eating a final newline.
char_len() {
  local t
  t="$(printf '%sx' "$1" | LC_ALL=C tr -d '\200-\277')"
  CHARS=$(( ${#t} - 1 ))
}
# redact keeps two whole characters (#416): a lead byte and its continuation bytes, twice, then one
# star per remaining character. `local LC_ALL=C` makes the match and the slice count bytes whatever the caller's
# locale; the single regex match below is linear (a `%%` strip of each run is quadratic, 13 s at
# 1 MB), and the awk `redact` in --history is the reference for malformed input: a leading
# continuation byte is kept without counting, a run of any length is kept whole. The pin is
# behaviour (#439): the suite's malformed-name rows differ without it under a UTF-8 caller. Scope
# of the mask: in a single-byte encoding such as Windows-1252, bytes 0x80 to 0xBF include letters,
# so the report can show up to the whole name (a 3-letter name such as Ziz with carons prints
# unmasked); the awk copy does the same.
redact() {
  local LC_ALL=C n="$1" CHARS k p='' c nc re s='*'
  char_len "$n"; k=$(( CHARS - 2 ))
  if [ "$k" -le 0 ]; then printf '%s' "$n"; return; fi
  # The kept prefix in ONE anchored match: any leading continuation bytes, a lead byte and its
  # continuation bytes, twice. The classes sit in variables, the bash 3.2 form. A failed match
  # leaves p empty, so the name prints as stars only (fail closed): rc 2 keeps a stale BASH_REMATCH.
  c=$'[\200-\277]'; nc=$'[^\200-\277]'; re="^$c*$nc$c*$nc$c*"
  [[ $n =~ $re ]] && p=${BASH_REMATCH[0]}
  while [ ${#s} -lt "$k" ]; do s="$s$s"; done
  printf '%s%s' "$p" "${s:0:k}"
}
show_evidence() {  # show_evidence <rule> <evidence>: what the report prints for it
  if [ "$MODE" != history ] || [ "$SHOW_EVIDENCE" = 1 ]; then printf '%s' "$2"; return; fi
  local e="$2" root seg
  case "$1" in
    # IFS=/ read, not seg="${e%%/*}": on a segment of any length that cut is quadratic under a
    # UTF-8 locale (76 s at 1 MB), the shape rule C's IFS=@ read already avoids (#211, #217).
    home-path) root="${e%%/*}"; e="${e#/}"; root="/${e%%/*}"; e="${e#*/}"; IFS=/ read -r seg _ <<< "$e"
               printf '%s/%s/' "$root" "$(redact "$seg")" ;;
    home-root) e="${e#\~/}"; IFS=/ read -r seg _ <<< "$e"; printf '~/%s/' "$(redact "$seg")" ;;
    *)         printf '%s' "$(redact "$e")" ;;
  esac
}

# One match, one verdict. Shared by the tree modes and --history so the rules cannot drift between
# them: <label> is the file in a tree mode and "<path>@<oid>" in history.
judge() {
  local f="$1" n="$2" m="$3" raw seg allowed rawt p root rawroot addr local_part domain
  # Rule C's anchor (#211) leaves one leading byte on the match, and the dispatch below keys on the
  # FIRST byte, so "see docs/<name>@<host>.<tld>" would arrive as "/<name>@..." and be judged a home
  # path. Strip it BEFORE the dispatch, never inside the email arm. A match that already starts
  # with a class byte, or that is a rule A or rule B match, is left exactly as it was.
  # Rule A and B shapes are tested BEFORE the email arm (review of #230): a segment may contain
  # `@`, so `-/home/<name>@<host>.<tld>` would otherwise satisfy the email arm's class and keep its
  # anchor byte, and be judged an address.
  case "$m" in
    /home/*|/Users/*|'~'/*) ;;
    ?/home/*|?/Users/*) m="${m#?}" ;;   # rule A's anchor byte (#230)
    [A-Za-z0-9._%+-]*@*) ;;
    *@*) m="${m#?}" ;;
  esac
  case "$m" in
    /*)
      # NOT `seg="${raw##*/}"` (#239): a longest-match strip tries every prefix, so it is quadratic
      # in the segment and a 64 KB punctuation tail cost 3.3 s of the 3.5 s a scan took. RE_HOME
      # matches `(/home|/Users)/` followed by a class that excludes `/`, so the segment is exactly
      # the text after the first two slashes. A shortest-match `#` strip stops at the first
      # matching prefix (the root), whatever the segment holds, so it is linear where `##` tries
      # every prefix. Excluding `/` from the class is not what makes it fast: it is what makes
      # the result equal the old per-root `case`. The speed relies on RE_HOME guaranteeing that
      # early match (a `#` strip that never matches tests every prefix too). It holds for any
      # single-segment root, so a third root needs no new arm (#239, #243).
      # `${m%/}` is quadratic when the string does NOT end in `/`: bash tries every suffix and the
      # match fails at each (2.5 s at 256 KB, #239). Test the last byte first, then strip one.
      case "$m" in */) raw="${m%?}" ;; *) raw="$m" ;; esac
      seg="${raw#/*/}"
      # Checked at every strip step: "..." is entirely punctuation, so stripping the trailing dots
      # would leave nothing to compare and the guard would reject its own documented placeholder,
      # and "[redacted]." holds its marker one step in (#227).
      in_list_stripping "$seg" "${PLACEHOLDER_USERS[@]}" && return 0   # leaves the strip in STRIPPED (#239)
      # A segment that strips to nothing is entirely punctuation ("..", "...", a lone "}"): a
      # path idiom or a code fragment, not a person. No allow-file entry can name it (the prefix
      # parser above refuses to accept one), so without this it could never be suppressed.
      [ -n "$STRIPPED" ] || return 0
      # Punctuation is stripped here for the same reason as the placeholder check above, and
      # its absence was a real false positive: with the CI runner's home allowed as a prefix, an allowed path at
      # the end of a sentence or inside brackets still reported a leak.
      allowed=0
      strip_tail "$raw"; rawt="$STRIPPED"
      for p in ${ALLOW_PREFIXES+"${ALLOW_PREFIXES[@]}"}; do
        case "$rawt" in "$p"|"$p"/*) allowed=1; break ;; esac
      done
      [ "$allowed" = 1 ] && return 0
      report "$f" "$n" home-path "$(show_evidence home-path "$m")" ;;
    '~'/*)
      # Compared at every strip step, as rule A does with the segment: strip_tail pops a marker's
      # own "]" (it is in TAIL_PUNCT), so a stripped-only compare could never match the literal
      # `[redacted]`, and an allow-file `root [redacted]` only worked written without its closing
      # bracket; and "~/[redacted]." holds the marker one step in (#227).
      local rawroot; case "$m" in */) rawroot="${m%?}" ;; *) rawroot="$m" ;; esac   # never `${m%/}` (#239)
      rawroot="${rawroot#\~/}"
      in_list_stripping "$rawroot" "${ALLOW_ROOTS[@]}" && return 0   # every step (#227)
      root="$STRIPPED"                                              # the strip it already made (#239)
      # A root that strips to nothing is entirely punctuation ("~/..", "~/}"): a path idiom or a
      # code fragment, not a person's home. No allow-file `root` entry could name it either.
      [ -n "$root" ] || return 0
      report "$f" "$n" home-root "$(show_evidence home-root "$m")" ;;
    *)
      strip_tail "$m"; addr="$STRIPPED"
      # IFS=@ read, not "${addr#*@}": that expansion is quadratic in the match length (3.1 s at
      # 64 KB, 48 s at 256 KB), which would move the cost the anchor removed into bash (#211).
      IFS=@ read -r local_part domain <<< "$addr"
      # An address that cannot reach a mailbox is not a leak. noreply is the convention; the rest
      # are the TLDs reserved by RFC 2606 and RFC 6761 precisely so documentation can use them.
      set_lower "$local_part"
      case "$LOWER" in
        noreply*|no-reply*|donotreply*) return 0 ;;
        # "git@host" is the SSH clone user, not a mailbox. It is in the clone URL of essentially
        # every repository, so leaving it to each project's allow-file would make the first run of
        # this guard noise rather than signal.
        git) return 0 ;;
      esac
      set_lower "$domain"
      case "$LOWER" in
        *.example|*.invalid|*.test|*.localhost|*.local) return 0 ;;
        example.com|example.org|example.net|*.example.com|*.example.org|*.example.net) return 0 ;;
      esac
      in_list "$addr" ${ALLOW_EMAILS+"${ALLOW_EMAILS[@]}"} && return 0
      report "$f" "$n" email "$(show_evidence email "$addr")" ;;
  esac
}

# --- history mode --------------------------------------------------------------
# The reader and the object selection are leak-lib.sh (#206), sourced by the --history branch
# below and only there. This is the part that is this scanner's own: matching and reporting.
history_scan() {
  history_read " "
  local tagged="$TMPD/tagged" hits="$TMPD/hits"
  # Read. One cat-file, one tr, one awk; then ONE grep over the tagged stream and one more over the
  # hit lines only, with the tag prefix as an alternation branch so the label, the line and every
  # match arrive in order and no process runs per hit. -a on both: the stream carries raw bytes.
  LC_ALL=C grep -aE "$RE_ANY" "$tagged" > "$hits" || true
  # Into a file, not a process substitution: bash reads a pipe one byte per syscall, and this loop
  # read 25x slower from one on the store this was measured on.
  LC_ALL=C grep -aoE '^[^	]*	[^	]*	|'"$RE_ANY" "$hits" > "$TMPD/matches" || true
  local lab="" n="" g
  while IFS= read -r g; do
    case "$g" in
      *"	")   lab="${g%%	*}"; n="${g#*	}"; n="${n%	}" ;;
      *)      [ -n "$lab" ] && judge "$lab" "$n" "$g" ;;
    esac
  done < "$TMPD/matches"
}

if [ "$MODE" = history ]; then
  # Sourced HERE and nowhere else (#206): the tree modes, which both git hooks run, must work in a
  # project whose copy of the leak-guard assets predates leak-lib.sh. The message never prints the
  # directory looked in, which is an absolute home path in a refusal someone pastes into an issue.
  LIB="$(dirname "$SELF")/leak-lib.sh"
  [ -f "$LIB" ] || die "--history needs leak-lib.sh beside this script and it is not there; the tree modes do not need it. Install the leak-guard assets together"
  # -r as well: `.` on an unreadable file prints bash's own error, which carries the absolute path.
  [ -r "$LIB" ] || die "--history cannot read the leak-lib.sh beside this script"
  # shellcheck source=leak-lib.sh
  . "$LIB"
  type history_read >/dev/null 2>&1 || die "the leak-lib.sh beside this script does not define history_read; it is not the version this scanner expects"
  history_scan
  [ "$violations" -eq 0 ] || exit 1
  exit 0
fi

for f in "${FILES[@]}"; do
  skip_by_name "$f" && continue

  case "$MODE" in
    # ":0:$f", never ":$f": git reads ":<stage>:<path>" first, so a path shaped "0:x" was taken
    # for a stage spec and skipped (#208). Only a BLOB is read: a gitlink names a commit, and when
    # that commit happens to be in the store `git show` prints it and its message was scanned as
    # the file (review); a path git cannot show at all is skipped as before. A blob git has but
    # could not write (disk full under TMPDIR) is a refusal, since the old "|| continue" turned
    # that into a clean report. The whole group's stderr is closed, so neither git's message nor
    # the shell's own notice for a child killed by a signal (RLIMIT_FSIZE, an OOM kill) can print
    # this script's path; the message names the file, never $TMPD.
    staged) [ "$(git cat-file -t ":0:$f" 2>/dev/null)" = blob ] || continue
            { git show ":0:$f" > "$BLOB"; } 2>/dev/null || die "could not read $f"; scanfile="$BLOB" ;;
    range)  [ "$(git cat-file -t "HEAD:$f" 2>/dev/null)" = blob ] || continue
            { git show "HEAD:$f" > "$BLOB"; } 2>/dev/null || die "could not read $f"; scanfile="$BLOB" ;;
    # --head (#375): the mode and type come from `ls-tree`, so only blobs are in FILES. "HEAD:./$f",
    # never "HEAD:$f": `ls-tree` paths are relative to the current directory and a bare
    # "HEAD:<path>" is root-relative, so from a subdirectory the bare form reads the ROOT file of
    # the same name (a leaking sub/README.md judged by the clean ./README.md). Same failure rule.
    # Since #401 the tree modes run from the root, where the two forms agree; `./` stays so the read
    # does not depend on the anchor above, and the mutant that dropped it is retired as equivalent.
    # The arm stays on one line like the `range` arm above it (#384).
    head)   { git show "HEAD:./$f" > "$BLOB"; } 2>/dev/null || die "could not read $f"; scanfile="$BLOB" ;;
    *)      scanfile="$f" ;;
  esac
  # A tracked SYMLINK is its target text in git, and the worktree read followed it: a dangling
  # link whose target is a home path was reported by --staged and clean under --all, the pre-push
  # hook's mode (review of #208). The link text is what git commits, so it is what is scanned.
  # --head is deliberately NOT in the gate below: its scanfile is the regular-file $BLOB, so -L is
  # false and `git show` already yields the link text.
  if [ "$MODE" != staged ] && [ "$MODE" != range ] && [ -L "$scanfile" ]; then
    { readlink -- "$scanfile" > "$BLOB"; } 2>/dev/null || die "could not read $f"; scanfile="$BLOB"
  fi
  [ -f "$scanfile" ] || continue
  # A tracked file this process cannot OPEN (mode 000) used to fall through the greps below and
  # read as clean (#208); it is a refusal, and the message names the file, not the script.
  [ -r "$scanfile" ] || die "could not read $f"

  # Never report the guard's own source: it has to contain the patterns to apply them.
  # Compared against the NAMED path, never the file being read. In --staged and --range that file
  # is a temp blob, so comparing it here would never match and the scanner would report its own
  # source. Every project that vendors this asset and wires the commit hook hits that on the
  # commit that installs it, which is how it was found.
  # Gated on the basename first: abspath forks three times, and paying that on every file in the
  # tree costs more than the scan itself. Only a file that could BE the script is resolved.
  case "${f##*/}" in
    "${SELF##*/}") [ "$(abspath "$f")" = "$SELF" ] && continue ;;
  esac

  # Binary detection reads the file, never a shell variable, so null bytes are neither dropped nor
  # warned about. -I makes grep treat a binary file as non-matching, so an empty result means
  # "binary or empty", and both are nothing to scan.
  # The file is read by REDIRECTION, never as an operand: a tracked file named "-v" was an option
  # and one named "-" was stdin, and both were unscanned (#208). stderr is closed before the open so
  # a bash diagnostic, which carries this script's absolute path, cannot print.
  grep -Iq . 2>/dev/null < "$scanfile" || continue

  # ONE grep per file, not one per rule. The rules are distinguished by the SHAPE of the match,
  # which they already are: only rule A's starts with a slash and only rule B's with a tilde. Three
  # passes cost three process spawns per file, and process spawn is the whole cost here.
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    judge "$f" "${g%%:*}" "${g#*:}"
    # LC_ALL=C is the second half of #211 and it is not cosmetic: under a territory UTF-8 locale
    # grep stays off its byte-wise DFA and the anchored regex is still quadratic (162 s at 1 MB
    # against 0.08 s under C). The history pipeline above has always run under C; this is the path
    # a hook takes, and it did not. The cost is the letter-class narrowing named in the header.
  done < <(LC_ALL=C grep -onE "$RE_ANY" 2>/dev/null < "$scanfile")
done

[ "$violations" -eq 0 ] || exit 1
exit 0
