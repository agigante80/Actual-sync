#!/usr/bin/env bash
# check-private-leaks-version: 30
#
# The private half of the leak guard: project and folder NAMES that must not become public.
#
# Its companion, check-public-leaks.sh, catches path shapes and addresses without needing to know
# anything about you; this one cannot, because deciding that a name is private requires knowing
# that it is (forge-kit issue #99, split as #156). The first line above is deliberately one whole
# sentence: the component index renders it verbatim.
#
# HONEST STATEMENT OF REACH. This header carried none until #185, which is its own small lesson:
# the public half states four limits carefully and this one stated nothing, so a reader comparing
# them would reasonably infer this half had none.
#
# THE TREE MODES NEVER LOOK AT HISTORY; --history DOES, AND IT IS OPT-IN (#185, #191). `--all`
# and `--head` change to the repository root first, so from any directory they cover every tracked
# file and print root-relative paths (#401). `--all`
# enumerates tracked files in the WORKING TREE, `--head` reads HEAD's COMMITTED tree (#375; the
# pre-push hook's mode, so an uncommitted edit or a file deleted only in the working tree cannot
# mask what a push publishes; HEAD's tree, not every pushed commit), `--staged` reads the index,
# and `--range` enumerates two endpoints (`--no-renames --diff-filter=ACMT`, so a renamed-and-edited
# file and a symlink replaced by a file are listed; both were invisible before #208) and reads each
# file at HEAD, so a
# name added and removed inside the range is invisible at both ends. The tree modes fail closed
# like `--history` (#208): a temp directory that cannot be made, a names file or blob that cannot
# be written, a tracked file this process cannot open, are each exit 2 naming the file. A private folder name committed once and deleted later stays readable
# forever in a public repository, and a NAME is exactly the thing someone scrubs from the tree and
# forgets in the history.
#
# `--history` reads the publishable history: every blob reachable from a branch or a tag, and every
# commit and tag MESSAGE (subject and body). The author, committer and tagger lines are NOT scanned
# by this half either: that identity is what the forge already displays beside every commit, public
# by construction: the forge shows it whether or not the scan does. The reader is the public
# half's: one `git cat-file --batch`, a POSIX awk reader that counts each object's declared BYTES
# (so a forged batch header hides nothing) and puts no content byte through a regex, NUL-bearing
# objects dropped whole, and an object scanned unless EVERY path it ever had is skipped. In this
# mode a listed name is redacted inside the printed PATH as well as in the evidence, since a path
# is the likeliest place for such a name to sit, though a name that appears ONLY in a path is not a
# finding here any more than in the tree modes; --show-names lifts both redactions. The set is
# what a mirror push sends: every ref except refs/stash, plus every worktree's HEAD
# (`--exclude=refs/stash --all`, the exclude before the selector it narrows), so remote-tracking
# refs, refs/notes, filter-branch's refs/original backups and custom namespaces are all in (#210:
# the first cut read branches, tags and remotes only) and a detached HEAD over-reports, the safe
# side. Refs/replace and grafts are ignored or refused, since they make git show what a push does
# not send.
# It is never wired into a hook: a pre-publish step, run by hand.
#
# `--history --orphans` also reads objects no ref reaches (amended or reset away, not yet pruned)
# and the stash, the one ref the set leaves out. A push (`--mirror` included) and a clone over a
# URL never send either; a bundle carries no orphan but `bundle create --all` does carry the
# stash; a clone from a local PATH and any copy of the .git directory carry both. A filter-branch backup under refs/original is a ref and needs no --orphans. With no path,
# the self-skip is the weaker content test.
#
# --history NEEDS leak-lib.sh BESIDE THIS SCRIPT (#206): the reader and the object selection are
# defined there once, for both scanners. Without it (or with one that is unreadable or too old)
# --history refuses, exit 2. The tree modes, which the git hooks run, never read it.
#
# WHAT --history REFUSES, exit 2: an alternates file (a `git clone --shared`, resolved through
# `git rev-parse --git-path`), GIT_ALTERNATE_OBJECT_DIRECTORIES or GIT_OBJECT_DIRECTORY set, a
# partial clone, which would fetch every missing object during the scan, a store git cannot read in
# full, a path map it cannot parse, and any pipeline stage that fails: a partial scan reporting
# clean is the one outcome worse than no scan. One cosmetic limit: a path containing a TAB prints
# truncated at the tab in the report label; the finding itself is not affected.
#
# Scanning the store by hand (#198):
# pass `grep -a` over a `git cat-file --batch` stream, since tree objects contain NUL and a grep
# then treats it as binary; GNU replaces matched lines with "binary file matches", and a wrapper
# passing `-I` skips the stream and reports no match at all.
#
# IT MATCHES LITERAL NAMES, not shapes. A name shortened or hyphenated differently is a different
# string and is not found. That is the price of the list being exact, and the alternative, matching
# loosely on names this short, would fire on ordinary prose.
#
# TWO MATCHING RULES, CHOSEN PER LINE (#222). A plain name matches as a case-insensitive SUBSTRING,
# so `bramble` also catches `bramble-social` and `bramble_v2`, and a name embedded in a larger word
# IS found (this header said the opposite until #222). A line starting with `=` is a WHOLE WORD:
# `=ana` matches `ana`, `Ana.`, `/proj/ana/` and `ana-signals`, never `banana` or `analysis`, which
# is the rule a short username needs. A whole-word token may hold only ASCII letters, digits and `_`,
# and its boundaries are that same ASCII set in every locale: a byte outside it, an accented letter
# included, is a boundary, so `=ana` IS reported inside `mañana` (a stated limit, pinned by the
# suite). The tree modes run the substring grep as before plus `LC_ALL=C grep -w` for the tokens;
# `--history` runs one pre-filter over both lists and the awk tests the boundary bytes. Path
# redaction under `--history` stays a substring match for every entry, so a token inside a longer
# path segment is over-redacted in the printed PATH, the safe direction. Multiple `-f` and `-Fwoi`
# on BSD grep are an unverified limit until #220's harness exists.
#
# REDACTION COST (#217). The bash `redact` counts the length once and builds its mask by doubling,
# as the public half's does, so it is linear in any locale. The awk `redact` that --history uses is
# LEFT as a per-byte loop on purpose (#416 made it a per-BYTE scan that keeps two whole characters,
# since it runs under LC_ALL=C and the old byte slice split a multibyte name in every caller
# locale). Its string concatenation is quadratic on busybox awk (re-measured at 262,144 bytes,
# gawk 0.07 s to 0.10 s and busybox awk 29.6 s to 31.6 s), but its input is always a listed name,
# so its cost is bounded by a list entry, and the one
# pre-filter `grep -aiF` before it is slower at every size, so the awk loop is never the first thing
# to stall. The suite's text-count ledger on that loop pins this DECISION, not behaviour: a change to
# the awk copy updates the ledger and this paragraph together.
#
# For the going-public case, run a credential scanner as well: `gitleaks git .` walks the whole
# history for SECRETS rather than identity, so it is a companion and not a substitute.
#
#   check-private-leaks.sh [--staged | --range <base> | --head | --all] [--list <path>]
#                          [--allow-file <path>] [--show-names] [paths...]
#   check-private-leaks.sh --history [--orphans] [--list <path>] [--show-names]
#
# Exit 0 clean, 1 on a finding, 2 when it could not run. One line per finding:
#   <file>:<line>: private-name: <redacted>                    (tree modes)
#   <path>@<oid>:<line>: private-name: <redacted>              (--history; commit@, tag@, or blob@
#                                                               when no path is known)
#
# WHY THE LIST IS NOT IN THE REPOSITORY. A committed file enumerating the names you have been
# hiding tells a reader exactly what to search the history for. It converts a guard into an index.
# So the list lives in the unpublished agent config directory, and this runs LOCALLY ONLY. Putting
# it in a CI secret is the same mistake in a place with more readers and worse access controls.
#
# WHY THE REPORT REDACTS BY DEFAULT. The class of leak this component exists to stop is pasted
# output: a traceback, a shell transcript, a failing hook. This hook's own output is exactly that
# kind of text, and printing the matched name in full makes pasting it into a public issue the next
# leak. The file and line are enough to act on; --show-names is there for when you need certainty
# and are not about to paste.
#
# THREE BEHAVIOURS THAT LOOK LIKE LENIENCY AND ARE NOT. Every one of them fails in the direction of
# the guard being REMOVED, which is the only failure mode that matters for something nobody is
# forced to keep:
#
#   - A MISSING LIST exits 0 and says so. A guard that blocks every fresh clone gets uninstalled.
#   - THE OWNING ACCOUNT'S NAME is dropped with a warning rather than obeyed, in the TREE MODES and
#     only when origin's host is a public forge (github.com, gitlab.com, codeberg.org,
#     bitbucket.org): there it is in the public clone URL, so a list containing it refuses every
#     commit that touches the README. Public identity and private identity are different sets. On
#     a private origin the list is obeyed, and --history obeys it everywhere (#209).
#   - A VERY SHORT ENTRY refuses the run. Two characters match nearly every file, and a guard that
#     fires on everything is one its owner switches off within a day.

# NO `awk -v` IN THIS FILE (#259). `-v` runs a backslash-escape pass over its value, and the temp
# paths this scanner hands to awk (`types`, `labels`, `names`) are built under `mktemp -d`, so they carry
# whatever the caller's TMPDIR is named. Under a TMPDIR named `t\tx` (backslash, t) the paths read
# back with a TAB, every `getline` failed, and `--history` reported CLEAN over a committed finding.
# Every value now reaches awk through ENVIRON (`LG_*`); the 0-or-1 flags (`orphans`, `show`) moved as
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
MIN_NAME_LEN=3
# The Unicode White_Space characters outside ASCII, as UTF-8 byte strings (#403): U+0085, U+00A0,
# U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. A list name may not begin or
# end with one.
UNI_EDGE_WS=($'\xc2\x85' $'\xc2\xa0' $'\xe1\x9a\x80'
  $'\xe2\x80\x80' $'\xe2\x80\x81' $'\xe2\x80\x82' $'\xe2\x80\x83' $'\xe2\x80\x84' $'\xe2\x80\x85'
  $'\xe2\x80\x86' $'\xe2\x80\x87' $'\xe2\x80\x88' $'\xe2\x80\x89' $'\xe2\x80\x8a'
  $'\xe2\x80\xa8' $'\xe2\x80\xa9' $'\xe2\x80\xaf' $'\xe2\x81\x9f' $'\xe3\x80\x80')

MODE=all
MODESET=0
BASE=""
LIST="${HOME}/.claude/forge-kit/private-names.txt"
SHOW_NAMES=0
DO_INIT=0
PATHS=()
ORPHANS=0

die()  { printf 'check-private-leaks: %s\n' "$1" >&2; exit 2; }
warn() { printf 'check-private-leaks: %s\n' "$1" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    # One mode per run. The last flag used to win silently, so "--history --staged" scanned the
    # index and reported clean on the history the user asked about. The five mode arms below carry
    # the same one-line refusal as their siblings and stay over 100 columns on purpose: they are
    # meant to be read as a column, and wrapping one would hide that they are identical (#384).
    --all)         [ "$MODESET" = 0 ] || die "one mode only: --all, --staged, --range, --head or --history"; MODESET=1; MODE=all ;;
    --staged)      [ "$MODESET" = 0 ] || die "one mode only: --all, --staged, --range, --head or --history"; MODESET=1; MODE=staged ;;
    --range)       [ "$MODESET" = 0 ] || die "one mode only: --all, --staged, --range, --head or --history"; MODESET=1
                   MODE=range; shift; [ $# -gt 0 ] || die "--range needs a base ref"; BASE="$1" ;;
    --history)     [ "$MODESET" = 0 ] || die "one mode only: --all, --staged, --range, --head or --history"; MODESET=1; MODE=history ;;
    --head)        [ "$MODESET" = 0 ] || die "one mode only: --all, --staged, --range, --head or --history"; MODESET=1; MODE=head ;;
    --orphans)     ORPHANS=1 ;;
    --list)        shift; [ $# -gt 0 ] || die "--list needs a path"; LIST="$1" ;;
    --allow-file)  shift; [ $# -gt 0 ] || die "--allow-file needs a path"; ALLOW_FILE="$1" ;;
    --show-names)  SHOW_NAMES=1 ;;
    --init)        DO_INIT=1 ;;
    # Prints the whole comment header, rather than a hardcoded line range. The range was the bug:
    # growing the header by seven lines truncated --help mid-sentence and dropped the synopsis, and
    # help text that rots silently is worse than none because it still reads as current.
    --help|-h)    awk 'NR==1{next} /^# *[a-z0-9-]+-version: [0-9]+$/{next} /^#/{sub(/^# ?/,""); print; next} {exit}' < "$SELF"; exit 0 ;;
    --)            shift; while [ $# -gt 0 ]; do PATHS+=("$1"); shift; done; break ;;
    -*)            die "unknown flag: $1" ;;
    *)             PATHS+=("$1") ;;
  esac
  shift
done

SKIP_PATHS=()
ALLOW_FILE="${ALLOW_FILE:-}"
# Paths only, never names. Listing a path discloses nothing; a name here would rebuild
# the index this component exists to avoid — which is why `skip` is the ONLY key.
if [ -n "$ALLOW_FILE" ]; then
  [ -f "$ALLOW_FILE" ] || die "allow-file not found: $ALLOW_FILE"
  lineno=0
  while IFS= read -r raw || [ -n "$raw" ]; do
    lineno=$((lineno+1))
    line="${raw%$'\r'}"
    # An ASCII byte list, never `[[:space:]]` (#403), as check-public-leaks.sh trims its allow-file:
    # a caller-locale class trimmed an edge U+2003 under UTF-8 only, so `skip s.md<EMSP>` was a
    # different path by locale.
    line="${line#"${line%%[!$' \t\n\v\f\r']*}"}"
    line="${line%"${line##*[!$' \t\n\v\f\r']}"}"
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%% *}"; val="${line#* }"
    val="${val#"${val%%[!$' \t\n\v\f\r']*}"}"              # two spaces after the key are not part of the value, as in check-public-leaks.sh (#240)
    # Neither this message nor the unknown-key one prints the line or the key: the names list is
    # not loaded yet, and a bare `<name>/x.md` line or a `<name> x` key can carry a listed name.
    [ "$key" != "$val" ] || die "$ALLOW_FILE:$lineno: entry has no value (the line is not printed)"
    case "$key" in
      # The public half's rule (#226): skip_by_name() compares the value QUOTED, as an exact path
      # or a slash-anchored suffix, so a `*` or `?` could never match and is refused. The message
      # leaves the value out: this runs before the names list is loaded, and a value such as
      # `<name>/*.md` can carry a listed name. `[` is literal and accepted.
      skip)
        case "$val" in *[*?]*) die "$ALLOW_FILE:$lineno: skip is matched as an exact path or a path suffix, so a wildcard could never match" ;; esac
        case "$val" in */) die "$ALLOW_FILE:$lineno: skip names a file, so a value ending in / could never match" ;; esac
        SKIP_PATHS+=("$val") ;;
      root|prefix|marker|email)
        # These belong to check-public-leaks.sh. Sharing one file is intended; silently
        # ignoring a key is not, so say which scanner owns it.
        : ;;
      *) die "$ALLOW_FILE:$lineno: unknown key, not printed (this scanner wants skip)" ;;
    esac
  done < "$ALLOW_FILE"
fi

# --history is a mode, and --orphans means nothing without it. Refused rather than ignored: a flag
# that silently does nothing is a scan the user believes ran wider than it did.
if [ "$MODE" = history ]; then
  [ "${#PATHS[@]}" -eq 0 ] || die "--history takes no paths"
else
  [ "$ORPHANS" = 0 ] || die "--orphans is only valid with --history"
fi
# Explicit paths would switch MODE to `paths` below and silently ignore --head (#375).
[ "$MODE" != head ] || [ "${#PATHS[@]}" -eq 0 ] || die "--head takes no paths"

# Messages show the list path with the home directory as "~": this scanner's own stderr is exactly
# the text the public half polices, and the default path is under $HOME. A case, not a pattern
# substitution: bash 5 tilde-expands "~" in a replacement string, so `${LIST/#$HOME/~}` printed
# the path unchanged there and only bash 3.2 showed the tilde (review). Segment-anchored, so
# HOME=/h/b never rewrites /h/bee/y.
case "$LIST" in "$HOME"/*) LIST_SHOWN="~${LIST#"$HOME"}" ;; *) LIST_SHOWN="$LIST" ;; esac

# --- --init: write a starter list ------------------------------------------
# The template is HERE rather than in a .txt beside this script, because forge-adapt installs a
# skill's `assets/*.sh` and nothing else: a separate template file would never reach the project,
# and the guidance would point at a file that was not installed. One asset, one marker, and no
# second copy of this text to drift out of step with the rules the script actually enforces.
if [ "$DO_INIT" = 1 ]; then
  [ -e "$LIST" ] && die "refusing to overwrite the existing list at $LIST_SHOWN"
  mkdir -p "$(dirname "$LIST")" || die "could not create $(dirname "$LIST_SHOWN")"
  cat > "$LIST" <<'TEMPLATE'
# private-names.txt -- the identity half of forge-kit's leak guard.
#
# Add the names you do not want reaching a public repository: sibling project names, client
# names, an employer, a filing scheme, the folder your projects live in. One per line. Blank
# lines and lines starting with # are ignored.
#
# THIS FILE MUST STAY UNTRACKED. Its entire security property is that it was never published: a
# committed list of the names you are hiding tells a reader exactly what to search the history
# for, which converts a guard into an index. That is also why this half never runs in CI, and why
# the list must not go in a CI secret. The scanner REFUSES to run against a tracked list.
#
# DO NOT ADD THE OWNING ACCOUNT NAME of a repository hosted on a PUBLIC forge. It is in that
# repository's public clone URL, so it would fire on the README, the workflows and the install
# instructions. Public identity and private identity are different sets. The scanner drops such an
# entry with a warning in the tree modes when origin is github.com, gitlab.com, codeberg.org or
# bitbucket.org; on a private forge origin, and always under --history, the list is obeyed, since
# the going-public scan is exactly where a private organisation name must be caught.
#
# Names shorter than three characters are refused: they match nearly every file, and a guard that
# fires on everything is one you switch off within a day. So is a name that begins or ends with an
# invisible non-ASCII space (a no-break or em space): it would never match its own leak.
#
# Matching is case insensitive and, for a plain name, matches anywhere in a line, so a short
# distinctive name also catches the longer names built from it. Prefer the shortest name that is
# still distinctive.
#
# A line starting with = is a WHOLE WORD instead: =ana matches "ana" and "Ana." but never "banana"
# or "analysis". Use it for a short username, which as a plain name fires inside ordinary words in
# several languages. After the = only ASCII letters, digits and _ are allowed. Example, left
# commented out so it is not a live entry:
# =ana
TEMPLATE
  printf 'check-private-leaks: wrote %s. Add your names to it.\n' "$LIST_SHOWN" >&2
  exit 0
fi

# --- the list ---------------------------------------------------------------
if [ ! -f "$LIST" ]; then
  warn "no private-name list at $LIST_SHOWN, so NAMES ARE NOT BEING CHECKED."
  warn "  this is not an error: the list is deliberately outside the repository, and a machine"
  warn "  that never had one must not be blocked. Run this with --init to write a starter list."
  exit 0
fi

# A TRACKED list is the exact disclosure this component exists to prevent: a committed file
# enumerating the names you are hiding points a reader straight at them. REFUSE rather than warn.
# A warning here would be advice about an active leak, and the fix is one command.
#
# The default path is under the home directory, so this can only fire when someone has pointed
# --list at a file inside the repository. That is the precondition the original design wanted a
# forge-adapt step to enforce; checked here, it is enforced everywhere the guard runs rather than
# only where the installer ran.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
   && git ls-files --error-unmatch -- "$LIST" >/dev/null 2>&1; then
  die "the private-name list at $LIST is TRACKED by this repository.
  That publishes the names you are hiding, which is worse than not checking at all.
  Fix it:  git rm --cached '$LIST'  then add it to .gitignore, or move it to
  ~/.claude/forge-kit/private-names.txt, which no project repository can track."
fi

# Two leading characters and the length, which is enough for the owner to recognise their own name
# and not enough for a reader of a pasted transcript to learn it.
# Linear (#217): one length count, a doubled mask, and the k <= 0 guard BEFORE any slice, since a
# negative length in ${s:0:k} is an error on bash 3.2 and, for a length-0 input, on bash 5 too.
# Characters, not bytes, in every locale (#416): the UTF-8 lead bytes, i.e. every byte but the 0x80 to
# 0xBF continuation bytes, so `${#n}` (bytes under C, characters under UTF-8) never decides a verdict.
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

# The account that owns this repository on a PUBLIC forge is public by definition: it is in the
# clone URL. A list entry matching it would fire on the README, the workflows, and the install
# instructions. That rationale is true of a public clone URL and false of a private one (#209):
# with origin on a self-hosted Forgejo and GitHub as the second remote, the going-public scan is
# exactly the one the drop used to defeat. So the drop applies ONLY in the tree modes, and ONLY
# when origin's HOST is exactly one of the four public forges below; never in --history, which
# obeys its list and leaves allowlisting to the user. The URL is parsed by FORM, following git's
# URL grammar: on the `scheme://` form the host is the authority minus `user@` (stripped first)
# and `:port` (only this form carries one), and the owner is the first path segment; on the scp
# form (no `/` before the first `:`) the host is the text before the colon, minus `user@`, and the
# owner the first segment after it; a local or relative path, or `file://`, yields no owner. No
# digit heuristic anywhere: all-digit GitHub owners exist, and v9 took `2222` in `host:2222/` for
# the owner. A look-alike host (`github.com.evil.internal`) and `@github.com/` in a path or query
# are not the host; the comparison is exact on the isolated authority.
OWNER=""; OWNER_HOST=""
remote_url="$(git remote get-url origin 2>/dev/null || true)"
if [ -n "$remote_url" ]; then
  u="${remote_url%.git}"
  case "$u" in
    *://*)
      rest="${u#*://}"
      case "$rest" in
        */*) auth="${rest%%/*}"; upath="${rest#*/}" ;;
        *)   auth="$rest"; upath="" ;;
      esac
      # The authority ends at the first of `/`, `?` or `#` (RFC 3986 3.2), not `/` alone: a query or
      # fragment before the first slash let `https://evil.internal?@github.com/o/r` read as
      # github.com and drop a listed owner on a private host (#212).
      auth="${auth%%\?*}"; auth="${auth%%#*}"
      auth="${auth##*@}"; OWNER_HOST="${auth%%:*}"
      [ -n "$OWNER_HOST" ] && OWNER="${upath%%/*}" ;;
    *)
      pre="${u%%:*}"
      case "$u" in
        *:*) case "$pre" in
               */*) : ;;                                   # a path with a colon in it, not scp form
               *)   OWNER_HOST="${pre##*@}"; upath="${u#*:}"; OWNER="${upath%%/*}" ;;
             esac ;;
      esac ;;
  esac
fi
set_lower "$OWNER_HOST"; OWNER_HOST="$LOWER"
DROP_OWNER=0
if [ "$MODE" != history ] && [ -n "$OWNER" ]; then
  case "$OWNER_HOST" in github.com|gitlab.com|codeberg.org|bitbucket.org) DROP_OWNER=1 ;; esac
fi

NAMES=()
WORDS=()
lineno=0
while IFS= read -r raw || [ -n "$raw" ]; do
  lineno=$((lineno + 1))
  n="${raw%$'\r'}"
  n="${n#"${n%%[!$' \t\n\v\f\r']*}"}"
  n="${n%"${n##*[!$' \t\n\v\f\r']}"}"
  case "$n" in ''|'#'*) continue ;; esac
  # A name the ASCII trim above leaves with a non-ASCII Unicode space at an edge is REFUSED (#403).
  # Kept, the name misses its leak (`secretproj<EMSP>` never matches `secretproj here`) and a line
  # of only U+2003 is a 3-byte "name" that reports every em space; trimmed, the verdict would follow
  # the caller's locale. The characters are compared as their UTF-8 BYTES, so C and UTF-8 agree.
  # This runs before the length floor, so an edge-space name gets this error in every locale. The
  # name is not echoed: the line number is enough, and this file is the one that must stay private.
  for ws in "${UNI_EDGE_WS[@]}"; do
    case "$n" in
      "$ws"*|*"$ws") die "$LIST_SHOWN:$lineno: this name begins or ends with a non-ASCII whitespace character (such as a no-break or em space), which is invisible and would make it miss its own leak. Delete the character." ;;
    esac
  done
  # A leading `=` marks a WHOLE-WORD token (#222). Exactly one `=` is stripped, after the trims and
  # the #403 refusal above, so they see the raw line; a non-ASCII space after the `=` is caught by
  # the byte rule below. EVERY byte must be a word constituent, not only the first and last: `=an a`
  # passes an edge rule, and the history awk, which skips a rejected occurrence by its whole length,
  # would then miss `an a` inside `an an a`. With every byte a constituent no overlapping occurrence
  # can be valid. The set is spelled out, never a range: bash before 5.0 under a UTF-8 locale lets
  # `[A-Za-z]` match `é`, so `=josé` would pass.
  word=0
  case "$n" in
    '='*)
      word=1
      # The re-trim goes through `t` so the #403 mutant ledger, which finds the leading name trim
      # by its `n="${n#"` text, still sees exactly one site.
      t="${n#=}"
      t="${t#"${t%%[!$' \t\n\v\f\r']*}"}"
      n="$t"
      [ -n "$n" ] || die "$LIST_SHOWN:$lineno: a '=' line marks a whole-word name, but no name follows it."
      case "$n" in
        *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_]*)
          die "$LIST_SHOWN:$lineno: '=$(redact "$n")' is not a whole word. After '=' only ASCII letters, digits and _ are
  allowed, so the token has a boundary on each side. List a name with other characters without '='." ;;
      esac ;;
  esac
  char_len "$n"
  if [ "$CHARS" -lt "$MIN_NAME_LEN" ]; then
    die "$LIST_SHOWN:$lineno: '$(redact "$n")' is too short (under $MIN_NAME_LEN characters). It would match almost
  every file, and a guard that fires on everything is one you switch off. Use the full name."
  fi
  set_lower "$n";     n_lc="$LOWER"
  set_lower "$OWNER"; owner_lc="$LOWER"
  if [ "$DROP_OWNER" = 1 ] && [ "$n_lc" = "$owner_lc" ]; then
    warn "$LIST_SHOWN:$lineno: dropping '$(redact "$n")': it is the OWNING ACCOUNT of this repository on $OWNER_HOST,"
    warn "  so it appears in the public clone URL and would refuse every commit touching the README."
    warn "  Public identity and private identity are different sets. --history never drops it."
    continue
  fi
  if [ "$word" = 1 ]; then WORDS+=("$n"); else NAMES+=("$n"); fi
done < "$LIST"

# Both arrays count: an all-`=` list exiting here would read as a clean scan (#222).
[ $(( ${#NAMES[@]} + ${#WORDS[@]} )) -gt 0 ] || exit 0

# --- which files ------------------------------------------------------------
FILES=()
if [ "${#PATHS[@]}" -gt 0 ]; then
  MODE=paths
  FILES=("${PATHS[@]}")
else
  # --history needs an object store, not a work tree: a bare mirror about to be published is a
  # natural target. The tree modes need the tree.
  if [ "$MODE" = history ]; then git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
  else git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "not inside a git work tree (pass explicit paths to scan without git)"; fi
  # THE TREE MODES SCAN THE WHOLE REPOSITORY FROM ANY DIRECTORY (#401). `ls-files` and `ls-tree`
  # list only the current directory's subtree, so a run from `sub/` used to pass clean over a
  # committed root leak. Anchoring here, after the allow file and the `--list` file is read (a caller-relative
  # `--allow-file ../x` or `--list ../x` still resolves against the caller's directory), makes `--all` and
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
    all)    while IFS= read -r -d '' f; do FILES+=("$f"); done < <(git ls-files -z) ;;
    staged) while IFS= read -r -d '' f; do FILES+=("$f"); done \
              < <(git diff --cached --no-renames --name-only --diff-filter=ACMT -z) ;;
    range)
      # Fail CLOSED on an absent base, rather than passing vacuously.
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

skip_by_name() {  # skip_by_name <path> [<lowercased basename>]
  # The second argument lets --history, which decides thousands of paths in one loop, pass a
  # basename awk already lowercased, so the loop forks nothing on the bash-3 slow path.
  if [ $# -ge 2 ]; then LOWER="$2"; else set_lower "${1##*/}"; fi
  case "$LOWER" in
    *.png|*.jpg|*.jpeg|*.gif|*.bmp|*.ico|*.webp|*.svgz|*.pdf|*.zip|*.gz|*.bz2|*.xz|*.tar \
    |*.woff|*.woff2|*.ttf|*.otf|*.eot|*.mp3|*.mp4|*.mov|*.wav|*.class|*.jar|*.so|*.dylib \
    |*.dll|*.exe|*.pyc|*.o|*.a|*.wasm) return 0 ;;
    *.lock|package-lock.json|npm-shrinkwrap.json|yarn.lock|pnpm-lock.yaml|composer.lock \
    |gemfile.lock|poetry.lock|cargo.lock|go.sum|*.lockb) return 0 ;;
  esac
  # The allow-file skip, in the one place both modes ask (#206: it was a loop after each call site,
  # and the --history copy kept the shared history block from being one). An exact path or the
  # same relative path under any parent, compared QUOTED exactly as check-public-leaks.sh does
  # (#226): it was an unquoted case glob, so `*` crossed `/` and `skip *` silenced the whole scan.
  # It applies to a KNOWN path: a --history blob with no path at all (--orphans, or one the map
  # never saw) is resolved to `keep=blob` before this is called, so it cannot be silenced by a
  # skip entry and is not meant to be.
  local s
  for s in ${SKIP_PATHS+"${SKIP_PATHS[@]}"}; do
    [ "$1" = "$s" ] && return 0
    case "$1" in */"$s") return 0 ;; esac
  done
  return 1
}


# The names as grep pattern files, written once: substring names in PATFILE, whole-word tokens in
# WORDFILE (#222). -F is literal, so nothing in a name is a regex. Each is written only when its
# array has entries, so `-s` means "has a pattern": `"${A[@]}"` on an empty array is fatal under
# set -u on bash before 4.4, and the `${A+...}` idiom would write one empty line, which matches
# every line in the history pre-filter and never advances the awk's index() loop.
PATFILE="$TMPD/names"
WORDFILE="$TMPD/words"
if [ "${#NAMES[@]}" -gt 0 ]; then
  printf '%s\n' "${NAMES[@]}" > "$PATFILE" || die "could not write the names file"
else
  : > "$PATFILE" || die "could not write the names file"
fi
if [ "${#WORDS[@]}" -gt 0 ]; then
  printf '%s\n' "${WORDS[@]}" > "$WORDFILE" || die "could not write the names file"
else
  : > "$WORDFILE" || die "could not write the names file"
fi

violations=0
# --- history mode --------------------------------------------------------------
# The reader and the object selection are leak-lib.sh (#206), sourced by the --history branch
# below and only there. This is the part that is this scanner's own: matching and reporting.
history_scan() {
  history_read ""
  local tagged="$TMPD/tagged" hits="$TMPD/hits"
  # Read. One cat-file, one tr, one awk; then ONE grep over the tagged stream for any name, and one
  # awk over the hit lines that matches in the TEXT column only (the label is part of the grepped
  # line, and a listed name in a PATH is not a finding: the tree modes never report a path either),
  # redacts names inside the printed path and in the evidence, and prints one finding per
  # occurrence. -a on the grep: the stream carries raw bytes. No process runs per finding.
  # ONE pre-filter over both lists (#222): a substring superset, since the awk applies the exact
  # boundary test. Two greps merged would feed a line matching both lists to the awk twice, and
  # taken[] resets per record, so every finding on it would print twice. An empty list file is not
  # passed: an empty `-f` matches every line on some greps and none on others.
  local pf=()
  [ -s "$PATFILE" ] && pf+=(-f "$PATFILE")
  [ -s "$WORDFILE" ] && pf+=(-f "$WORDFILE")
  LC_ALL=C grep -aiF "${pf[@]}" "$tagged" > "$hits" || true
  [ -s "$hits" ] || return 0
  local found
  found="$(LC_ALL=C LG_NAMES="$PATFILE" LG_WORDS="$WORDFILE" LG_SHOW="$SHOW_NAMES" awk '
    # Two whole characters, then one star per character (#416): awk runs under LC_ALL=C, so it walks
    # bytes, keeps every byte up to the second lead byte and the continuation bytes after it, and stars
    # a later lead byte (a later continuation byte, 0x80 to 0xBF, adds nothing).
    function redact(n,  i, b, c, o) { o = ""; c = 0
      for (i = 1; i <= length(n); i++) { b = substr(n, i, 1)
        if (b >= "\200" && b <= "\277") { if (c <= 2) o = o b }
        else { c++; if (c <= 2) o = o b; else o = o "*" } }
      return o }
    function hide(p,  k, lp, ln, i, out) {   # redact every listed name inside a path, case-insensitively
      if (show) return p
      for (k = 1; k <= nn; k++) {
        ln = lname[k]; lp = tolower(p); out = ""
        while ((i = index(lp, ln)) > 0) { out = out substr(p, 1, i - 1) redact(substr(p, i, length(ln))); p = substr(p, i + length(ln)); lp = substr(lp, i + length(ln)) }
        p = out p
      }
      return p
    }
    # Longest name first, so a list holding both "secret" and "secretproj" redacts the whole longer
    # name in a path (never "se****proj") and reports one finding per occurrence, as grep -o
    # does in the tree mode. Insertion sort: the list is short and this runs once.
    # wd[k] marks a whole-word token (#222) and is permuted in the SAME sort as name[], or a
    # substring name inherits the flag of a token. An empty line is never a name: index() with an empty
    # needle would never advance.
    BEGIN {
      names = ENVIRON["LG_NAMES"]; words = ENVIRON["LG_WORDS"]; show = ENVIRON["LG_SHOW"] + 0
      wc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_"
      while ((getline l < names) > 0) if (l != "") { name[++nn] = l; wd[nn] = 0 }
      close(names)
      while ((getline l < words) > 0) if (l != "") { name[++nn] = l; wd[nn] = 1 }
      close(words)
      for (i = 2; i <= nn; i++) { v = name[i]; vw = wd[i]; j = i - 1; while (j > 0 && length(name[j]) < length(v)) { name[j + 1] = name[j]; wd[j + 1] = wd[j]; j-- } name[j + 1] = v; wd[j + 1] = vw }
      for (i = 1; i <= nn; i++) lname[i] = tolower(name[i])
    }
    {
      i1 = index($0, "\t"); lab = substr($0, 1, i1 - 1); rest = substr($0, i1 + 1)
      i2 = index(rest, "\t"); ln = substr(rest, 1, i2 - 1); text = substr(rest, i2 + 1)
      # The oid follows the LAST "@": a path may itself contain one (npm @scope/ directories).
      at = 0; j = 0; while ((j = index(substr(lab, at + 1), "@")) > 0) at += j
      path = substr(lab, 1, at - 1); oid = substr(lab, at)
      ltext = tolower(text)
      # One finding per position: a byte already inside the match of a longer name is not reported
      # again for a shorter name listed beside it.
      split("", taken)
      for (k = 1; k <= nn; k++) {
        pos = 1
        while ((i = index(substr(ltext, pos), lname[k])) > 0) {
          start = pos + i - 1; len = length(name[k]); free = 1
          # A token needs a non-constituent byte (or the line edge) on each side. Skipping a
          # rejected occurrence by its whole length is safe: every token byte is a constituent.
          # The edge tests are explicit: index() with an empty needle is 1 in gawk and mawk.
          if (wd[k] && ((start > 1 && index(wc, substr(text, start - 1, 1)) > 0) \
                        || (start + len <= length(text) && index(wc, substr(text, start + len, 1)) > 0))) free = 0
          for (q = start; free && q < start + len; q++) if (q in taken) { free = 0; break }
          if (free) {
            for (q = start; q < start + len; q++) taken[q] = 1
            hit = substr(text, start, len)
            print hide(path) oid ":" ln ": private-name: " (show ? hit : redact(hit))
          }
          pos = start + len
        }
      }
    }' < "$hits")"
  [ -n "$found" ] || return 0
  printf '%s\n' "$found"
  violations=$(( violations + $(printf '%s\n' "$found" | grep -c .) ))
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
  # Compared against the NAMED path, never the file being read. In --staged and --range that file
  # is a temp blob, so comparing it here would never match and the scanner would report its own
  # source. Every project that vendors this asset and wires the commit hook hits that on the
  # commit that installs it, which is how it was found.
  # Gated on the basename first: abspath forks three times, and paying that on every file in the
  # tree costs more than the scan itself. Only a file that could BE the script is resolved.
  case "${f##*/}" in
    "${SELF##*/}") [ "$(abspath "$f")" = "$SELF" ] && continue ;;
  esac
  # Read by grep, never through a command substitution: null bytes would be dropped and warned
  # about once per occurrence, so a full scan would print a wall of noise and read fonts as text.
  # The file is read by REDIRECTION, never as an operand: a tracked file named "-v" was an option
  # and one named "-" was stdin, and both were unscanned (#208). stderr is closed before the open so
  # a bash diagnostic, which carries this script's absolute path, cannot print.
  grep -Iq . 2>/dev/null < "$scanfile" || continue

  # ONE grep per file per list, matching every name at once from a pattern file, rather than one
  # grep per (file x name). At ten names and five thousand files the old shape was fifty thousand
  # process spawns on every push, in a component shipped into other people's repositories. The
  # substring grep stays unpinned (pinning it would make a non-ASCII name miss its other case) but
  # reads with -a (#456): under a UTF-8 caller GNU grep otherwise treats a match whose bytes are
  # invalid UTF-8 (a Windows-1252 or Latin-1 name) as binary, prints "binary file matches" instead of
  # the line, and the name is never reported. The -Iq skip above only sees the first matching line, so
  # a file with a NUL later on is now scanned past it (before, grep stopped at that buffer): the safer
  # direction for a leak guard, and the whole-word grep below still stops there. The
  # whole-word grep (#222) runs only when there are tokens, under LC_ALL=C so its boundaries are the
  # ASCII set the list loop enforces.
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    hit="${g#*:}"
    if [ "$SHOW_NAMES" = 1 ]; then shown="$hit"; else shown="$(redact "$hit")"; fi
    printf '%s:%s: private-name: %s\n' "$f" "${g%%:*}" "$shown"
    violations=$((violations + 1))
  done < <(
    [ -s "$PATFILE" ] && grep -anoiF -f "$PATFILE" 2>/dev/null < "$scanfile"
    [ -s "$WORDFILE" ] && LC_ALL=C grep -noiFw -f "$WORDFILE" 2>/dev/null < "$scanfile"
  )
done

[ "$violations" -eq 0 ] || exit 1
exit 0
