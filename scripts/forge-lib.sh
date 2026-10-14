#!/usr/bin/env bash
# forge-lib-version: 47
# forge-lib.sh: host-aware forge operations (GitHub | Forgejo). Source it; governance components
# call the forge_* functions instead of `gh` directly, so the same logic works whether a repo lives
# on GitHub or a self-hosted Forgejo. ADDITIVE: a repo with no Forgejo config defaults to GitHub and
# behaves exactly as before.
#
# Design note: both backends use the REST API (GitHub via `gh api`, Forgejo via `curl`), NOT gh's
# porcelain, because Forgejo's API is the Gitea API, whose JSON shapes (issues, releases, comments)
# closely match GitHub's REST. Using REST on both sides keeps the jq parsing in callers identical.
#
# Host detection (first match wins, so automation is DETERMINISTIC and never "asks"):
#   1. $FORGE_HOST env var                      (explicit override, e.g. in CI)
#   2. a committed .forge.conf at the repo root (see forge.conf.example)
#   3. the git remote URL                       (github.com -> github; otherwise forgejo IFF a
#                                                Forgejo API URL is configured, else github)
#
# Requires: git, jq. GitHub backend uses `gh` (its existing auth); Forgejo backend uses `curl` + a
# token. Set FORGE_DRY_RUN=1 to print would-be API requests instead of sending them; this also
# short-circuits every GET, so a read under the flag returns empty stdout with rc 0, not real data.
# CONTRACT CHANGES (read this before `forge-adapt refresh forge-lib` lands a new copy).
# `refresh` is report-first for assets, so a human sees the diff; this list is what makes that
# diff mean something, because a byte diff does not say whether a CALLER has to change.
#   v4  forge_issue_label REFUSES ATOMICALLY on any unresolvable name (it used to apply what it
#       could and exit 0). A caller that ignored the exit code now silently applies NO labels
#       where it previously applied some. Check every call site (issue #63).
#   v5  forge_api reports the HTTP status through its EXIT CODE on the forgejo path: 44 for 404,
#       22 for other non-2xx, and curl's own code for a transport failure. A caller that treated
#       any non-zero as fatal now sees 44 for the ordinary "no such org" case. NOTE a 3xx that
#       survives -L now returns 22 where `curl -f` returned 0, because -f only failed on >= 400
#       (issue #78).
#   v6  the config is parsed ONCE per process per working directory instead of on every call. A
#       caller that edited .forge.conf mid-run and expected the next call to see it must now cd
#       out and back, or unset _FORGE_CONF_PWD (issue #78.1).
#   v7  file-derived FORGE_* values are no longer EXPORTED, so they do not reach a child process.
#       This is what makes a child running in a different repo read its OWN .forge.conf. A caller
#       that relied on sourcing forge-lib and then having a child inherit the repo identity must
#       now export the value itself, which is the documented env-wins path anyway (issue #78).
#   v14 forge_issue_comments <n> is NEW (#192): the first read of comments, all pages. Additive; no
#       caller changes. Named here because ticket-gate's round count now depends on it existing,
#       so a project holding forge-lib below v14 gets a round count that cannot run.
#   v15 forge_ci_status on Forgejo returns `cancelled` for a superseded run (it was `failure`), and
#       total_count == 0 is now `pending` (a task exists for the sha) or `none` (asked, nothing
#       there) instead of `not_configured`, which is RESERVED for "could not ask" (#193). A caller
#       that treated not_configured as "fall back to a local test gate" keeps that fallback for
#       the API-error case only; on `none` it must WAIT or confirm there is no CI, and on
#       `cancelled` re-dispatch and re-check. Neither is a local-gate case. `release` is the one
#       caller in the kit that branches on the value, and it does both.
#   v16 forge_host decides the host from the URL's AUTHORITY, by form (#212): on `scheme://` the
#       text after `://` up to the first `/`, `?` or `#`, minus `user@` (stripped first) and
#       `:port`; on the scp form (no `/` before the first `:`) the text before the colon minus
#       `user@`; compared case-insensitively. The old `*://*@github.com/*` glob let `*` cross `/`,
#       so `https://evil.internal/x?z=@github.com/` read as github. The rule is now "any URL
#       whose authority host is github.com (or ssh.github.com)", so answers that were `forgejo`
#       with FORGE_API_URL set are `github` for every such URL the globs missed: a port on the
#       scheme form (`https://github.com:443/o/r`, `ssh://git@github.com:22/o/r`), the scp form
#       without or with a user (`github.com:o/r`, `<user>@github.com:o/r`), a mixed-case
#       spelling, and no path at all.
#       _forge_token's credential host is the same authority, port kept, so a FORGE_API_URL of
#       `https://evil.internal#@github.com` asks git for evil.internal's credential, not github's.
#   v17 forge_repo cuts the slug after the SAME authority _forge_url_host isolates (#216). Three
#       answers change: `git@[::1]:o/r` prints `o/r` (was `:1]:o/r`); a scheme-form `?query` or
#       `#fragment` is stripped (`https://h/o/r?x=1` prints `o/r`, was `o/r?x=1`; the scp form
#       keeps its bytes); and `o/r.git/` prints `o/r` (was `o/r.git`). A URL with no authority is
#       refused with one message naming the URL, with scheme-form userinfo redacted, where v16
#       named a fabricated sub-path (`colon/o/r` for `/path/with:colon/o/r`).
#   v18 forge_api_paginate STOPS on a page whose stable keys (id, else number) equal the previous
#       page's, and says so on stderr; it also names the ordinary empty-page end there (#228). On
#       a host that ignores page= (Gitea's per-issue comments endpoint, go-gitea #6132) a call
#       that spun to the 500-page cap and returned 2 now returns the page once, rc 0, in two
#       requests, so count-gate-rounds reads a number instead of `unknown`. A caller that
#       treated any stderr from a paginate as a failure now sees one line per call. Termination
#       on an EMPTY page is unchanged and `length < limit` is still not a stop.
#   v19 forge_issue_comment, forge_issue_close and forge_issue_edit print ONE stderr line when
#       forge_api returns 44 (`forge-lib: <function>: issue #<n>: HTTP 404 (no such issue)`) and
#       propagate the code (#229). Every other code is unchanged and adds no line, since forge_api,
#       curl or gh already printed one. Success is still silent on both streams. forge_api's own
#       404 arm stays quiet, so read callers that treat 404 as ordinary are untouched.
#   v20 the three writers capture forge_api's code in the errexit-safe shape, so the v19 line is
#       printed under a `set -e` caller too (#237). No caller changes; the codes are unchanged.
#   v21 forge_repo REFUSES an scp remote whose path carries an @ (#235): v20 printed
#       `TOKEN@host:o/r` as the slug for `x-access-token:TOKEN@host:o/r` and every request path
#       carried it. rc 2, nothing on stdout, the remote redacted at its last @ in the message.
#       `git@host:o/r` and `a@b@host:o/r` are unchanged.
#   v22 forge_issue_milestone <n> <title|""> is NEW (#245): the write half of the milestone
#       primitives, setting or clearing a ticket's milestone by title. Additive; no caller
#       changes. It is what lets a phase move happen on a self-hosted forge at all, and the
#       clear form is host-specific (`null` on GitHub, the literal `0` on Forgejo, where a
#       `null` is a silent no-op that returns success).
#   v23 FORGE_DEBUG is NEW (#236): `FORGE_DEBUG=1` makes forge_api_paginate name its ORDINARY
#       end-of-list condition on stderr; every other value, including unset and `0`, is quiet.
#       v18 printed that line unconditionally on every list call, so `/phase` (which reaches
#       the paginator through forge_milestone_list and does not redirect stderr) and a gate run
#       filing a ticket both opened with lines of routine noise. Quiet is the new default and
#       matches what every caller that was redirecting the line away already saw.
#       THE ANOMALY LINES ARE NOT GATED and must not be: the identical-page stop says the server
#       is ignoring `page`, and the two rc-2 lines say the walk could not continue. A caller
#       needs all three whether or not it asked for debugging.
#       The test is `= 1`, matching every FORGE_DRY_RUN guard in this file; `!= 0` would have
#       made `FORGE_DEBUG=no` turn debugging on.
#   v24 forge_body_region_get / _set / _clear and forge_body_compose_preserving are NEW (#248):
#       the write-authority contract for the three components that edit a ticket body. Additive;
#       forge_issue_edit is unchanged and still destroys what was there, which is why the governed
#       writers stop calling it. New return codes 101 (a prefix refusal), 102 (the body moved since
#       it was read) and 103 (a malformed or unterminated marker pair), chosen above curl's 1 to 99
#       so a refusal cannot be confused with a transport failure this library propagates.
#       The contract lives HERE rather than in a governance doc because a governance guard cannot
#       reach the third writer at all: that writer ships in an OPTIONAL group the guard neither
#       scans nor can be made to scan. Every group that needs this already depends on this one, so
#       the contract travels down an edge that exists. Nothing here names a component or a group,
#       deliberately: an earlier draft of this very comment named one and the isolation guard
#       refused the build, which is the second time a comment in this file explaining a boundary
#       has crossed it.
#   v25 forge_body_compose_preserving LOSES its <prefix> argument (#248 review round 1). v24 took
#       one and re-threaded only the regions that did NOT match it, so a caller rewriting an author
#       section with its OWN prefix deleted its own regions and returned 0. It now re-threads every
#       region present in the current body and absent from the new one, so a caller keeps a region
#       it deliberately restates and loses none by omission. CALLERS MUST DROP THE ARGUMENT.
#       Also in v25, all defects rather than contract changes: one marker grammar shared by every
#       function, so the composer refuses what the splice refuses and preserves a CRLF body rather
#       than dropping its regions; content carrying a marker line is refused, since it locked the
#       region permanently; content travels by FILE, removing the MAX_ARG_STRLEN ceiling; a non-2xx
#       or non-issue response no longer reads as an empty body; a fetch failure in the region
#       reader is no longer indistinguishable from an absent region.
#   v27 forge_body_region_set takes an optional FIFTH argument, `top` (#284): the region is placed
#       at the top of the body (after a leading template-version marker line), and an existing one
#       is MOVED there. Additive: without it the output is byte-identical to v26. Any other fifth
#       argument exits 2, since a typo that silently appended would hide the region it was moving.
#   v28 forge_milestone_close decides FORGE_DRY_RUN BEFORE it resolves the title (#254). v27
#       resolved first, and under the flag the paginator returns a literal `[]`, so every title
#       was unresolvable: a dry run returned 2 and said `no milestone titled` for a milestone
#       that exists. It now prints `[dry-run] close milestone <title> on <repo>` to stderr and
#       returns 0, sending nothing. A caller that saw rc 2 under the flag now sees rc 0, and a
#       title that does NOT exist also returns 0 under the flag (the caller resolved it from a
#       real read; forge_issue_milestone makes the same trade). A real run is unchanged.
#   v29 An INVALID host is refused instead of read as success (#256). forge_host refuses an
#       invalid FORGE_HOST (printing nothing on stdout), and every consumer that matched its
#       output with a `case` fell through: the writers returned 0 having sent nothing. Each now
#       captures the host and returns 2, with exactly one stderr line (forge_host's own), and the
#       capture sits ABOVE every dry-run guard, so FORGE_DRY_RUN=1 refuses too: no `[dry-run]`
#       line, rc 2. Covers forge_api, forge_api_paginate, forge_issue_list, forge_issue_label,
#       forge_milestone_list, forge_milestone_close, forge_issue_edit, _forge_region_write (so
#       forge_body_region_set and _clear) and forge_body_compose_preserving; the writers that go
#       through forge_api inherit it for real sends. Two exceptions to the literal `return 2`:
#       forge_ci_status prints `not_configured` and returns 0, since that word is its documented
#       "could not ask" answer and a caller acts on it (rc 2 with empty stdout would break that
#       contract); the executed-directly `detect` CLI is top-level code, so it `exit 2`s with
#       nothing on stdout.
#       forge_tag_exists returns 2 under an invalid host (it hides stderr), which means "could
#       not ask", NOT "tag absent". A caller that saw rc 0 from a write now sees rc 2; valid
#       hosts are unchanged. forge_api_base already refused and is left alone.
#   v32 No caller changes (#264). forge_issue_edit's dry-run line says `characters` where it said
#       `bytes`: the number was always `${#2}`, a character count in a multibyte locale, and
#       nothing parses the line. The splice's whitespace and line-ending behaviour is now stated
#       (see the body-region block) and pinned by tests; the code behind it is unchanged.
#   v35 forge_issue_milestone_list returned [] on Forgejo (#446). It excluded PRs with
#       `has("pull_request") | not`, and Forgejo sends `"pull_request": null` on EVERY plain issue,
#       so every issue was dropped and check-phases rules 1 and 4 and reassess's emptied check ran
#       over nothing. It now uses `.pull_request | not`, false for an absent key and for null alike,
#       the filter forge_issue_list already used. GitHub output is unchanged.
#   v36 The Forgejo token is bound to where it may go (#442). A FORGE_API_URL from .forge.conf
#       needs its host[:port] in ${XDG_CONFIG_HOME:-$HOME/.config}/forge/hosts or forge_api
#       refuses with rc 2 and sends nothing; an exported FORGE_API_URL needs no entry. Every
#       FORGE_API_URL must be https (http only with FORGE_ALLOW_HTTP=1 exported). The file may
#       set FORGE_TOKEN_ENV only to FORGEJO_TOKEN or FORGE_TOKEN; another name must be exported.
#       Redirects are no longer followed (a 3xx is rc 22). The token reaches curl through -K,
#       never argv. New: forge_token_present, for a caller that only asks whether a token is set.
#   v38 Review lows of #442 (#449). New public forge_url_check: silent rc 0 when FORGE_API_URL would
#       be accepted (https, and on the allowlist if it came from .forge.conf), else the refusal and
#       rc 2; a no-op on GitHub, reads no token. Every dry-run branch now calls it first on
#       Forgejo, so a dry run refuses what the real run refuses (forge_api_paginate returns
#       forge_api's rc instead of printing `[]` after a refusal). A 3xx is rc 22: the remedy is a
#       FORGE_API_URL that names the final location. Comment fixes only otherwise.
#   v37 forge_ci_status and forge_ci_no_status_kind stop discarding forge_api's stderr (#450). A
#       refusal (host not in the allowlist, non-https, empty or unsafe token, bad FORGE_TOKEN_ENV,
#       invalid host) now reaches the caller's stderr, once, instead of leaving a bare
#       `not_configured` with no reason. stdout is unchanged (one vocabulary word) and so is rc 0.
#       Side effects, intended: a real HTTP failure prints forge_api's own `HTTP <n>` line, and
#       FORGE_DRY_RUN=1 prints its single `[dry-run]` request line. 404 and an empty body stay
#       silent. The GitHub arm is unchanged.
#       Both curl calls in forge_api now start with -q, so the user's .curlrc is never read: a
#       `verbose` line there would print the Authorization header to the stderr this change exposes.
#       Migration: -q drops EVERY .curlrc setting, so a private CA (`cacert`) or proxy set only there
#       now fails (curl rc 60 or 7). Set it through CURL_CA_BUNDLE, SSL_CERT_FILE or https_proxy.
#   v40 The #442 host allowlist is gone (#468, maintainer decision 2026-10-11). A FORGE_API_URL read
#       from .forge.conf is trusted exactly like an exported one, so ${XDG_CONFIG_HOME:-$HOME/.config}
#       /forge/hosts is never read and the v0.9.0 migration step (writing it) is not needed; a stale
#       file is harmless. Kept from v36: https only (http with FORGE_ALLOW_HTTP=1 exported), no -L,
#       --proto, the token through -K, xtrace suspended, FORGE_TOKEN_ENV limited in the file. The
#       accepted residual risk: a cloned repository's .forge.conf can name the server that receives
#       the token, so run forge commands only in repositories you trust.
#   v41 New: forge_token_available (#454), for a status check that asks whether forge_api would find
#       a token: the environment variable's name, or `git's credential helper` when only the helper
#       holds one (FORGE_NO_GIT_CREDENTIALS=1 still turns that off). forge_token_present is
#       unchanged and still never asks the helper. health-check step 9 now calls the new probe.
#   v47 New: forge_body_section_append <issue> <label> <content> (#494), the gate's Step 6 item 2
#       write into one author section. It finds the section by a whole heading line outside fences
#       and regions and refuses with 108 a section holding author text (WRITE ONCE), 107 an absent
#       heading, 109 a duplicated one; 103 refuses content carrying a region marker line or a
#       heading line or an unlabelled block, or ending inside an unclosed fence. Every existing
#       function is unchanged.
# Add a line here whenever a change alters what a caller must do, not merely what the library
# does internally.

set -uo pipefail

# Clear every key a .forge.conf set that still holds exactly what the file wrote; anything else is
# the caller's, and env wins. Only the six known keys, so a listed name is never eval'd blind.
# The loop walks the six LITERAL names and looks each up in the list: splitting the list itself
# would use the caller's IFS, and a strict-mode IFS=$'\n\t' then cleared nothing (#442 round 2).
_forge_clear_file_vals() {
  local k
  for k in FORGE_HOST FORGE_API_URL FORGE_REPO FORGE_TOKEN_ENV FORGE_REMOTE FORGE_NO_GIT_CREDENTIALS; do
    case " ${_FORGE_FROM_FILE-} " in *" $k "*) ;; *) continue ;; esac
    eval "_forge_was=\${_FORGE_FILEVAL_$k-}"
    [ "${!k-}" = "$_forge_was" ] && unset "$k"
    unset "_FORGE_FILEVAL_$k"
  done
  unset _forge_was
  _FORGE_FROM_FILE=""
}

# These must not survive from the caller, so they are unset here, and the loader tries not to export
# them (export -n on _FORGE_FROM_FILE; under `set -a` some can still leak, which is harmless because
# a child re-sources and unsets them here): an inherited _FORGE_TMPDIR would be trusted, written to
# with a predictable name and never cleaned; an inherited memo guard would suppress the first config
# load; an inherited _FORGE_FROM_FILE would make a child treat the caller's own values as
# file-sourced.
# A RE-SOURCE in the same shell first clears what the file set (#442 review): otherwise the next
# load finds FORGE_API_URL already set and takes it for the caller's own (which would also let the
# file's FORGE_TOKEN_ENV restriction be skipped).
# _forge_clear_file_vals runs BEFORE the unset, so an INHERITED _FORGE_FROM_FILE and
# _FORGE_FILEVAL_* list is acted on at source time: a key it names whose value matches is unset
# (#449 item 10). That is not a security boundary: whoever controls the environment can set or
# unset the config keys directly, so the list grants nothing they did not already have.
_forge_clear_file_vals
unset _FORGE_TMPDIR _FORGE_CONF_PWD _FORGE_FROM_FILE

_forge_root() { git rev-parse --show-toplevel 2>/dev/null || pwd; }

# Load .forge.conf (KEY=value lines) if present. Env vars already set WIN over the file.
# Memoized per process and per working directory (issue #78.1). Every page of a paginated call used
# to re-run this about four times, via forge_host, forge_api_base and _forge_token, each costing a
# `git rev-parse` plus a fork per config line.
#
# File-derived values are set as PLAIN shell variables and deliberately NOT exported, so they never
# reach a child process; a child sourcing this library in another repo reads that repo's own file.
# Exporting them was a long-standing bug, not one this branch introduced: measured on the pre-#78
# baseline and on this branch, any forge_* call made OUTSIDE a command substitution leaked the repo
# identity to every later child, identically on both. What #78.1 changed is the REACH, because
# loading in forge_api_paginate's own shell (which is what makes the memo pay) turned the common
# paginated path into one of those direct calls.
#
# Values set FROM THE FILE are also tracked and cleared when the working directory changes, so a
# process that moves between repos re-reads correctly in-shell.
#
# The tracking records the VALUE the file wrote, not just the key (#131.1). By key alone, a caller
# that exported a FORGE_* value AFTER a load which had set that same key from a file had its export
# cleared on the next chdir, contradicting the env-wins contract stated above and in
# references/local-auth.md. Comparing the current value against what the file wrote distinguishes
# the two without reading the export attribute, whose portable readings cost a fork per key
# (`declare -p`) or need bash 5.0 (`${!k@a}`) in a library that runs on 3.1.
#
# A caller who exports the SAME string the file wrote is indistinguishable, and is left alone. That
# is the right way round: the value is what the caller asked for either way.
_forge_load_conf() {
  # The guard keys on $PWD, a shell builtin that costs nothing, NOT on the resolved root: resolving
  # the root runs `git rev-parse`, and doing that BEFORE the guard is why the first version of this
  # memo saved nothing measurable (25 git calls per 6-page paginate, before and after, measured).
  # $PWD is a sound proxy: the root cannot change without the working directory changing.
  local f line k v root
  [ "${_FORGE_CONF_PWD-}" != "${PWD-}" ] || return 0
  root="$(_forge_root)"
  # Reachable, and removed once as "dead": in a DELETED working directory both `git rev-parse` and
  # the `pwd` fallback fail, root is empty, and "$root/.forge.conf" collapses to /.forge.conf, whose
  # FORGE_API_URL and FORGE_TOKEN_ENV this library would then adopt.
  [ -n "$root" ] || return 0
  # Clear anything a PREVIOUS directory's file set, or env-wins would make the new file a no-op.
  # Loading in the caller's shell (which is what makes the memo pay) means these values persist,
  # so a process moving between repos would otherwise keep the first repo's identity.
  # Only clear a key that still holds exactly what the file put there. Anything else is the
  # caller's, and env wins.
  _forge_clear_file_vals
  _FORGE_CONF_PWD="${PWD-}"
  f="$root/.forge.conf"
  [ -f "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"                                  # tolerate CRLF line endings
    case "$line" in ''|\#*) continue ;; esac              # skip blanks + comments
    case "$line" in *=*) ;; *) continue ;; esac           # skip lines without '='
    k="${line%%=*}"; v="${line#*=}"                        # split on FIRST '=' (values may contain '=')
    k="${k//[[:space:]]/}"                                 # keys never contain spaces, so trim fully
    v="${v%%#*}"; v="$(printf '%s' "$v" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"//; s/"$//')"
    case "$k" in
      FORGE_HOST|FORGE_API_URL|FORGE_REPO|FORGE_TOKEN_ENV|FORGE_REMOTE|FORGE_NO_GIT_CREDENTIALS)
        [ -n "${!k:-}" ] || { printf -v "$k" '%s' "$v"     # NOT exported: see the header note
                              printf -v "_FORGE_FILEVAL_$k" '%s' "$v"   # what the file wrote (#131.1)
                              # set -a, or an exported empty value, would export it anyway, and a
                              # child would take it for the caller's own (#442 review)
                              export -n "$k" "_FORGE_FILEVAL_$k"
                              _FORGE_FROM_FILE="${_FORGE_FROM_FILE-} $k"
                              export -n _FORGE_FROM_FILE; } ;;  # env wins; else file
    esac
  done < "$f"
}

# forge_host: print 'github' or 'forgejo'.
# _forge_url_host <url> [keep-port]: the host from a git URL, by URL FORM (git's grammar, #212).
# scheme://: the authority is the text after `://` up to the first `/`, `?` or `#` (RFC 3986 3.2);
# strip `user@` FIRST (a password may contain a colon), then `:port` unless asked to keep it (the
# credential protocol takes host:port). A bracketed IPv6 authority keeps its brackets whole. scp
# form: no `/` before the first `:` (a bracketed IPv6 host, `[::1]:o/r`, is cut at its `]:`), host
# is the text before the colon minus `user@`. Anything else (a local or relative path, `file://`
# with an empty authority) prints nothing. The CASE of the host is preserved: git's credential
# store keys on the spelling as given, so the caller that compares lowercases and the caller that
# asks for a credential does not (review). This is the ONLY place a host is taken from a URL: a
# `case` glob cannot do it, because `*` crosses `/`.
_forge_url_host() {
  local u="$1" auth="" host=""
  case "$u" in
    *://*)
      auth="${u#*://}"; auth="${auth%%/*}"; auth="${auth%%\?*}"; auth="${auth%%#*}"
      auth="${auth##*@}" ;;
    \[*\]:*|*@\[*\]:*)
      # scp form with a bracketed host, only when the text before "[" is a bare user (no "/" or
      # ":" in it); otherwise the brackets sit in a PATH and the generic arms decide (review).
      case "${u%%\[*}" in
        */*|*:*) case "${u%%:*}" in */*|"$u") return 0 ;; *) auth="${u%%:*}"; auth="${auth##*@}" ;; esac ;;
        *) auth="${u%%\]:*}]"; auth="${auth##*@}" ;;
      esac ;;
    *)
      case "${u%%:*}" in
        */*|"$u") return 0 ;;                       # a path with a colon, or no colon at all: not scp form
        *) auth="${u%%:*}"; auth="${auth##*@}" ;;
      esac ;;
  esac
  case "$auth" in
    \[*\]*) host="${auth%%\]*}]"; [ "${2:-}" = keep-port ] && host="$auth" ;;
    *)     if [ "${2:-}" = keep-port ]; then host="$auth"; else host="${auth%%:*}"; fi ;;
  esac
  printf '%s\n' "$host"
}

forge_host() {
  _forge_load_conf
  if [ -n "${FORGE_HOST:-}" ]; then
    case "$FORGE_HOST" in github|forgejo) printf '%s\n' "$FORGE_HOST"; return 0 ;;
      *) echo "forge-lib: FORGE_HOST='$FORGE_HOST' is invalid (use github|forgejo)" >&2; return 2 ;; esac
  fi
  local url; url="$(git remote get-url "${FORGE_REMOTE:-origin}" 2>/dev/null || true)"
  [ -n "$url" ] || { echo github; return 0; }        # no remote -> assume github
  case "$(_forge_url_host "$url" | tr '[:upper:]' '[:lower:]')" in
    github.com|ssh.github.com) echo github ;;           # github.com in the HOST slot only (#212); ssh.github.com is GitHub's documented SSH-over-443 host
    *) if [ -n "${FORGE_API_URL:-}" ]; then echo forgejo; else echo github; fi ;;
  esac
}

# forge_repo: print owner/repo on the active host (config wins; else parse the remote URL).
# The slug is cut after the SAME authority _forge_url_host isolates (#216), so the two can never
# disagree on what a host is: scheme form is the path after the authority, minus `?query` and
# `#fragment` (RFC 3986; new on v17, and scheme form only, since the scp form has no query
# syntax); scp form is the text after `]:` for a bracketed host, else after the first `:`. A URL
# with no authority (a local path, `./x`, `file://` with an empty authority) is refused with ONE
# message whatever its shape: it is the same branch, and three messages for one branch is a
# split a later editor would collapse anyway. Inherited and NOT resolved: `C:/x/o/r` is a Windows
# drive path that the scp arm reads as host `C`, which git itself also cannot tell apart.
# A refusal names the URL with scheme-form userinfo redacted, because a remote can carry
# `user:token@` and the message lands in a hook's output (#229 review). An scp remote whose PATH
# carries an @ is refused outright (#235): git reads it as a credential-shaped path, no slug names
# a repository, and the string would otherwise reach every API request path.
forge_repo() {
  _forge_load_conf
  if [ -n "${FORGE_REPO:-}" ]; then printf '%s\n' "$FORGE_REPO"; return 0; fi
  local url host path shown; url="$(git remote get-url "${FORGE_REMOTE:-origin}" 2>/dev/null || true)"
  # Redact at the LAST @ of the AUTHORITY, the same cut _forge_url_host makes: a password may
  # contain @ (review: the first-@ form printed the tail of `p@ss`), and an @ in the path is not
  # userinfo at all.
  shown="$url"
  case "$url" in *://*)
    path="${url#*://}"; host="${path%%[/?#]*}"
    case "$host" in *@*) shown="${url%%://*}://***@${host##*@}${path#"$host"}" ;; esac ;;
  esac
  host="$(_forge_url_host "$url")"
  if [ -z "$host" ]; then
    echo "forge-lib: cannot parse owner/repo from remote '$shown' (a local path has no host); set FORGE_REPO in .forge.conf" >&2; return 2
  fi
  case "$url" in
    *://*)
      path="${url#*://}"; path="${path#"${path%%[/?#]*}"}"   # drop the authority: up to the first / ? or #
      path="${path%%\?*}"; path="${path%%#*}"; path="${path#/}" ;;
    *)
      case "$host" in
        \[*\]*) path="${url#*\]:}" ;;   # bracket-aware cut: the #216 mutant replaces this line
        *)     path="${url#*:}" ;;
      esac
      # git reads `x-access-token:TOKEN@host:o/r` as host x-access-token and path TOKEN@host:o/r,
      # so no slug names a clonable repository and the pasted token would be interpolated into
      # every API request path this library builds. The message redacts at the LAST @ of the
      # whole remote, since the text before it is the credential shape.
      case "$path" in *@*) shown="***@${url##*@}"; path="" ;; esac   # an @ in the scp path is a credential shape, refuse (#235)
      ;;
  esac
  path="${path%/}"; path="${path%.git}"      # a trailing slash first, so `o/r.git/` reads as o/r
  case "$path" in
    */*/*) echo "forge-lib: remote path '$path' is not a plain owner/repo; set FORGE_REPO in .forge.conf" >&2; return 2 ;;
    */*)   case "$path" in /*|*/) ;; *) printf '%s\n' "$path"; return 0 ;; esac ;;
  esac
  echo "forge-lib: cannot parse owner/repo from remote '$shown'; set FORGE_REPO in .forge.conf" >&2; return 2   # 0 or 1 segment
}

# forge_api_base: REST base URL for the active host.
forge_api_base() {
  case "$(forge_host)" in
    github)  echo "https://api.github.com" ;;
    forgejo) _forge_load_conf; printf '%s/api/v1\n' "${FORGE_API_URL:?forgejo: FORGE_API_URL must be set in .forge.conf}" ;;
    *)       echo "forge-lib: cannot resolve API base; host is not github|forgejo" >&2; return 2 ;;
  esac
}

# The characters a token variable name and a validated host may contain, spelled out rather than
# written as ranges so no locale can widen them (#442: a UTF-8 [A-Za-z] admits a dotless i).
_FORGE_ALNUM='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

# xtrace guard: every function that holds the token runs with xtrace off (#442), because `set -x`
# in a caller printed it on four lines. Each uses the inline pair `case $- in *x*) _fx=1; set +x ;;
# esac` ... `[ "$_fx" = 0 ] || set -x`; the previous state is kept in the function's own
# `local _fx`, so nesting restores correctly.
#
# _forge_token_var: print the validated name of the variable that holds the Forgejo token (#442).
# The name is checked BEFORE `${!var}`: a subscript such as `x[$(cmd)]` is evaluated by indirect
# expansion, so an unchecked name from a committed .forge.conf ran code. A name from the file may
# only be one of the two the docs use; any other identifier must come from the environment, which
# is the user's own.
_forge_token_var() {
  _forge_load_conf
  local var="${FORGE_TOKEN_ENV:-FORGEJO_TOKEN}"
  case "$var" in
    [0123456789]*|*[!${_FORGE_ALNUM}_]*)
      echo "forge-lib: FORGE_TOKEN_ENV is not a valid variable name" >&2; return 2 ;;
  esac
  case " ${_FORGE_FROM_FILE-} " in *" FORGE_TOKEN_ENV "*)
    case "$var" in FORGEJO_TOKEN|FORGE_TOKEN) ;; *)
      echo "forge-lib: FORGE_TOKEN_ENV in .forge.conf may only name FORGEJO_TOKEN or FORGE_TOKEN; export it in your environment to use another variable" >&2
      return 2 ;; esac ;;
  esac
  printf '%s\n' "$var"
}

# forge_token_present: print the token variable's name; rc 0 when it holds a value, 1 when it is
# empty, 2 when the name is refused. It never prints the token and never asks git's credential
# helper, so a status check (health-check step 9) can call it without indirect expansion of its own.
forge_token_present() {
  local _fx=0 var rc=0; case $- in *x*) _fx=1; set +x ;; esac
  if var="$(_forge_token_var)"; then
    printf '%s\n' "$var"; [ -n "${!var:-}" ] || rc=1
  else rc=2; fi
  [ "$_fx" = 0 ] || set -x
  return "$rc"
}

# forge_token_available: would forge_api find a token? Prints the variable's name, or the text
# `git's credential helper` when only the helper holds one; rc as forge_token_present (#454). The
# helper is asked through _forge_token_impl itself, so this probe and the request path cannot
# disagree, and only after the name is validated and forge_url_check accepts the URL, as in
# forge_api. The helper read is bounded at _FORGE_CRED_SECS (default 10) where `timeout` exists, so
# a helper that waits on an unlock dialog or a browser sign-in cannot stall a health check; stock
# macOS has no `timeout` and stays unbounded (#454 review). On a refused URL it still reports the environment token, so a caller can print both
# problems. Its own guard is the ONLY xtrace guard on the helper read: the token sits in a local
# and is never printed. forge_token_present stays env only.
forge_token_available() {
  local _fx=0 var rc=0 tok=""; case $- in *x*) _fx=1; set +x ;; esac
  local _FORGE_CRED_SECS="${_FORGE_CRED_SECS:-10}"
  if ! var="$(_forge_token_var)"; then rc=2
  elif [ -n "${!var:-}" ]; then printf '%s\n' "$var"
  elif forge_url_check >/dev/null 2>&1 && tok="$(_forge_token_impl 2>/dev/null)"; then
    printf '%s\n' "git's credential helper"
  else printf '%s\n' "$var"; rc=1; fi
  tok=""
  [ "$_fx" = 0 ] || set -x
  return "$rc"
}

# forge_url_check: would FORGE_API_URL be accepted? Silent rc 0 if so, else forge_api's own
# refusal on stderr and rc 2. Forgejo only (a no-op on GitHub); reads no token. forge_api_base
# is called inside $(...) because its ${FORGE_API_URL:?} would exit a non-interactive caller.
forge_url_check() {
  local host base=""
  host="$(forge_host)" || return 2
  [ "$host" = forgejo ] || return 0
  base="$(forge_api_base)" || return 2
  : "$base"
  _forge_check_url
}

_forge_token() {
  local _fx=0 rc; case $- in *x*) _fx=1; set +x ;; esac
  _forge_token_impl; rc=$?
  [ "$_fx" = 0 ] || set -x
  return "$rc"
}

_forge_token_impl() {
  _forge_load_conf
  local var tok=""
  var="$(_forge_token_var)" || return 2
  if [ -n "${!var:-}" ]; then tok="${!var}"; fi
  # Fallback: ask git's credential helper for this instance (the mise pattern,
  # see references/local-auth.md). Reads the same encrypted store already used
  # for git-over-HTTPS; never prompts (GIT_TERMINAL_PROMPT=0, askpass stubbed:
  # an inherited GIT_ASKPASS, e.g. VS Code's, would otherwise be invoked) and
  # never writes anything back. FORGE_NO_GIT_CREDENTIALS=1 disables the
  # fallback entirely (strict env-only mode, the pre-v7 behavior).
  # The stub is an ABSOLUTE path on purpose: a PATH-resolved name could be
  # hijacked by a planted binary inside this credential-handling flow. If
  # /bin/true is absent (NixOS-likes), the miss degrades to a clean rc!=0
  # with no prompt and no hang (verified), never to a prompt. GCM_INTERACTIVE=never stops
  # git-credential-manager opening its own sign-in. A caller that sets _FORGE_CRED_SECS to digits
  # gets the read under `timeout` when it exists; forge_api sets none and is unbounded as before.
  # A branch, not an unquoted `$cmd` word: a strict-mode IFS without a space would not split it.
  local url proto host cred _secs=""
  case "${_FORGE_CRED_SECS:-}" in ''|*[!0123456789]*) ;; *) command -v timeout >/dev/null 2>&1 && _secs="$_FORGE_CRED_SECS" ;; esac
  url="${FORGE_API_URL:-}"
  if [ -z "$tok" ] && [ -n "$url" ] && [ "${FORGE_NO_GIT_CREDENTIALS:-0}" != 1 ]; then
    proto="${url%%://*}"; [ "$proto" = "$url" ] && proto=https
    # The same authority rule as forge_host, port kept (#212): the old cut at `/` alone let
    # `https://evil.internal#@github.com` hand github.com's credential to evil.internal.
    case "$url" in *://*) host="$(_forge_url_host "$url" keep-port)" ;; *) host="$(_forge_url_host "https://$url" keep-port)" ;; esac
    cred=$(printf 'protocol=%s\nhost=%s\n\n' "$proto" "$host" \
             | { if [ -n "$_secs" ]; then GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS=/bin/true timeout "$_secs" git credential fill
                 else GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS=/bin/true git credential fill; fi; } 2>/dev/null \
             | sed -n 's/^password=//p' | head -n1)
    [ -z "$cred" ] || { tok="$cred"; var="git's credential helper"; }
  fi
  if [ -z "$tok" ]; then
    echo "forgejo: token env '$var' is empty and git's credential helper has no entry for '${host:-unset}'." >&2
    echo "         Mint a scoped token and supply it; see forge-host references/local-auth.md." >&2
    return 2
  fi
  # The token is written into a curl config line (#442), whose quoted-string syntax gives a quote,
  # a backslash or a line break meaning; refuse rather than escape, since no real token has them.
  case "$tok" in *[\"\\]*|*[[:cntrl:]]*)
    echo "forge-lib: token in $var cannot be passed to curl safely (it contains a quote, a backslash or a control character)" >&2
    return 2 ;;
  esac
  printf '%s' "$tok"
}

# _forge_check_url: may the token be sent to FORGE_API_URL? rc 0 or rc 2 with a message (#442).
# Every URL must be https, or http with FORGE_ALLOW_HTTP=1 exported (the file cannot set it, since
# it is not a key _forge_load_conf reads). A URL from .forge.conf is trusted like an exported one
# (#468): the host allowlist #442 added here was dropped by the maintainer, who accepted that a
# cloned repository's .forge.conf can name the server that gets the token. Do not reintroduce a
# per-machine trust file. The URL reaches curl only behind --url and only the token goes in the -K
# config, so no URL content can inject curl options. The scheme check lives here and NOT in
# forge_host or forge_api_base, which adapt/SKILL.md calls with a scheme-less sentinel URL.
_forge_check_url() {
  _forge_load_conf   # in THIS shell: forge_api_base loaded it in a $(...) that is gone
  local url="${FORGE_API_URL-}"
  case "$url" in
    https://*) ;;
    http://*) [ "${FORGE_ALLOW_HTTP:-0}" = 1 ] || {
      echo "forge-lib: refusing to send the token over http; use an https FORGE_API_URL, or export FORGE_ALLOW_HTTP=1 for a trusted LAN instance" >&2
      return 2; } ;;
    *) echo "forge-lib: FORGE_API_URL must be an https URL, not an option or another scheme" >&2; return 2 ;;
  esac
}

# forge_api <METHOD> <path> [json-body]   path is like  /repos/{owner}/{repo}/issues
# Prints the raw JSON response. FORGE_DRY_RUN=1 -> print the resolved request and return.
# On the forgejo path the HTTP status reaches the caller as an EXIT CODE (issue #78.2): 0 for 2xx,
# 44 for 404, 22 for any other non-2xx, and curl's own code for a transport failure. Not a
# variable: callers read the body with $(...), which runs this in a subshell where an assignment
# would be discarded.
forge_api() {
  local method="$1" path="$2" body="${3-}"
  local host
  host="$(forge_host)" || return 2   # forge_api-host-capture: ABOVE the dry-run guard, so a dry run refuses an invalid host too (#256)
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    forge_url_check || return 2   # #449: a dry run refuses what the real run refuses
    # to stderr, so it survives callers that redirect the JSON response to /dev/null
    printf '[dry-run] %s %s%s%s\n' "$method" "$(forge_api_base)" "$path" "${body:+  body=$body}" >&2
    return 0
  fi
  case "$host" in
    github)
      if [ -n "$body" ]; then printf '%s' "$body" | gh api -X "$method" "${path#/}" --input -
      else gh api -X "$method" "${path#/}"; fi ;;
    forgejo)
      # The whole arm runs with xtrace off (#442): the token passes through it.
      local _fx=0 rc; case $- in *x*) _fx=1; set +x ;; esac
      _forge_api_forgejo "$method" "$path" "$body"; rc=$?
      [ "$_fx" = 0 ] || set -x
      return "$rc" ;;
  esac
}

_forge_api_forgejo() {
  local method="$1" path="$2" body="$3"
  # || return 2: in conditional callers (if out=$(forge_api ...); forge_ci_status)
  # set -e does not fire on the assignment, and without the guard an EMPTY
  # Authorization header would go over the wire and mask the real cause.
  # The URL is checked BEFORE the token is read, so a refused host never reaches git's
  # credential helper either (#442).
  local base tok proto=https
  base="$(forge_api_base)" || return 2
  _forge_check_url         || return 2
  tok="$(_forge_token)"    || return 2
  [ "${FORGE_ALLOW_HTTP:-0}" = 1 ] && proto=https,http
  # NOT `curl -f` (issue #78.2): -f collapses every HTTP >= 400 into exit 22 with no body and
  # no status, so a caller cannot tell 404 (an org with no labels: fine) from 401 or 500 (a
  # real failure). The status is appended on its own line and split off here.
  # #442: no -L, so a 3xx is reported rather than followed to wherever it points with the
  # header; --proto refuses any other scheme; -g stops [] and {} in a path being globbed; --url
  # means a URL beginning with - can never be read as an option; and the header travels in a -K
  # config on a pipe, so the token is in no process's argv.
  local out rc
  if [ -n "$body" ]; then
    # The body goes on STDIN (#409): `-d "$body"` put the whole payload in one execve argument,
    # which Linux caps at MAX_ARG_STRLEN (131072), so a large body failed with rc 126.
    out="$(printf '%s' "$body" | curl -q -sS -g --proto "=$proto" -K <(printf 'header = "Authorization: token %s"\n' "$tok") -w '\n%{http_code}' -X "$method" -H 'Content-Type: application/json' --data-binary @- --url "$base$path")"; rc=$?
  else
    out="$(curl -q -sS -g --proto "=$proto" -K <(printf 'header = "Authorization: token %s"\n' "$tok") -w '\n%{http_code}' -X "$method" --url "$base$path")"; rc=$?
  fi
  [ "$rc" -eq 0 ] || return "$rc"          # transport failure: curl's own code, no status
  local status="${out##*$'\n'}"
  printf '%s' "${out%$'\n'*}"
  # The status is reported through the EXIT CODE, not a variable. Every caller reads the body
  # with $(...), which runs this function in a SUBSHELL, so any variable set here is discarded
  # before the caller can read it. An exit code is the one channel that survives.
  case "$status" in
    2*)  return 0 ;;
    404) return 44 ;;
    *)   echo "forge-lib: HTTP $status from $method $path" >&2; return 22 ;;
  esac
}

# forge_api_paginate <path>  GET every page of a LIST endpoint and print ONE concatenated
# JSON array, host-aware: github delegates to `gh api --paginate` (which merges pages into one
# array without -q); forgejo loops page/limit itself, appending '?' or '&' as the path needs.
# Forgejo termination is an EMPTY page or an IDENTICAL page (#228, keys compared, see the loop),
# deliberately NOT `length < limit`: the server clamps
# `limit` to its admin-set MAX_RESPONSE_ITEMS (stock default 50), so a clamped page satisfies
# `< limit` while pages remain, which would silently reproduce the exact single-page
# truncation this helper exists to fix (issue #62). One extra request per call is the price
# of being clamp-proof. Guards, each an ERROR (return 2), never a silent end-of-list: a
# non-array body (a JSON error object's `length` counts KEYS, which would read as items and
# loop forever), an empty or unparseable body mid-run (a `[ '' -gt 0 ]` would break the loop
# and return rc 0 on a partial list), and a page cap (FORGE_PAGINATE_MAX_PAGES, default 500 =
# 25k items at stock clamp) so a server that ignores `page` spins the cap, not forever.
# Pages accumulate in a TEMP FILE, never a jq --argjson argument: a single execve argument is
# capped at MAX_ARG_STRLEN (~128KiB on Linux), and one real page of template-v4-sized issues
# measures at that ceiling, so argv accumulation hard-fails on exactly the repos pagination
# exists for. File/stdin input has no such limit (and avoids re-parsing prior pages each loop).
# The WRITE path follows the same rule since #409: every body travels on stdin (`_forge_payload`,
# and `--data-binary @-` on Forgejo), never as one argument.
forge_api_paginate() {
  _forge_load_conf || true   # ONCE, in this shell: the per-page $(forge_api ...) subshells and
                             # their own $(forge_host) / $(_forge_token) subshells inherit the
                             # memo from here. Loading it deeper would be discarded each time.
  local path="$1" sep page=1 chunk n tmp rc host
  case "$path" in *\?*) sep='&' ;; *) sep='?' ;; esac
  host="$(forge_host)" || return 2   # above the dry-run guard (#256)
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    rc=0; forge_api GET "${path}${sep}limit=50&page=1" >/dev/null || rc=$?   # prints the dry-run line
    [ "$rc" = 0 ] || return "$rc"
    printf '[]\n'; return 0
  fi
  if [ "$host" = github ]; then
    # gh --paginate emits each page as a SEPARATE JSON doc on modern gh (--slurp exists for
    # exactly this); older gh merged arrays into one. jq -s tolerates both shapes: slurp all
    # docs, box any non-array, flatten once.
    gh api --paginate "${path#/}" | jq -sc 'map(if type == "array" then . else [.] end) | add // []'
    return $?
  fi
  local cap="${FORGE_PAGINATE_MAX_PAGES:-500}"
  case "$cap" in ''|*[!0-9]*) cap=500 ;; esac   # a non-numeric override must not void the spin guard
  _forge_tmp_init || return 2
  # A failed file mktemp must still release the directory _forge_tmp_init just made (#303).
  # mktemp, NOT "paginate.$$": $$ is the PARENT pid inside every subshell, so two concurrent
  # paginations in one process shared a path and each returned the union of both streams, exit 0.
  tmp="$(mktemp "$_FORGE_TMPDIR/paginate.XXXXXX")" || { _forge_tmp_done ""; return 2; }
  local prev="" sig
  while :; do
    chunk="$(forge_api GET "${path}${sep}limit=50&page=${page}")" || { rc=$?; _forge_tmp_done "$tmp"; return "$rc"; }
    n="$(printf '%s' "$chunk" | jq 'if type == "array" then length else -1 end' 2>/dev/null)"
    case "$n" in
      ''|*[!0-9-]*|-1)
        echo "forge-lib: paginate: non-array or empty response from ${path} page ${page}" >&2
        _forge_tmp_done "$tmp"; return 2 ;;
    esac
    if [ "$n" -le 0 ]; then
      # The ordinary end of a list, which is not news. Gated on FORGE_DEBUG (#236) because it
      # printed once per list call and `/phase` reads a milestone's every ticket. The `break`
      # is a statement of its own rather than the tail of an `&&`, so an off gate cannot become
      # a non-zero status for the arm under `set -e`.
      [ "${FORGE_DEBUG:-0}" = 1 ] && echo "forge-lib: paginate: empty page ${page}: end of ${path}" >&2
      break
    fi
    # #228: a host that IGNORES page= returns the same page for ever (Gitea's per-issue comments
    # endpoint has since before the Forgejo fork, go-gitea #6132), so no page is ever empty and
    # v16 spun to the cap: 500 requests, then rc 2. The stop compares each page's STABLE KEYS
    # (id, else number) with the previous page's, not its bytes, because a live response can
    # carry a field that changes between calls; a row with no key falls back to the bytes, so
    # null keys can never read as equal. It runs BEFORE the append, or the page would land
    # twice. Residual, accepted: a comment written between two reads makes page 2 a superset of
    # page 1, page 3 then matches page 2, and page 1 is carried twice; the next read is correct.
    sig="$(printf '%s' "$chunk" | jq -c 'if all(.[]; type == "object" and (.id // .number) != null) then map(.id // .number) else . end' 2>/dev/null)"
    if [ -n "$prev" ] && [ "$sig" = "$prev" ]; then
      echo "forge-lib: paginate: identical page: server ignores page (stopped at page ${page} of ${path})" >&2
      break
    fi
    prev="$sig"
    printf '%s\n' "$chunk" >> "$tmp"
    page=$((page + 1))
    if [ "$page" -gt "$cap" ]; then
      echo "forge-lib: paginate: exceeded $cap pages on ${path}; server may be ignoring the page param" >&2
      _forge_tmp_done "$tmp"; return 2
    fi
  done
  jq -sc 'add // []' "$tmp"; rc=$?
  _forge_tmp_done "$tmp"
  return $rc
}

# _forge_tmp_init  create the per-process temp DIR once and install ONE cleanup.
# Issue #78.3: the previous `mktemp` files were removed on every return path but not on a signal,
# so a Ctrl-C mid-pagination left one behind per call. A single directory means one cleanup point.
#
# It sets a variable rather than PRINTING a path, because a caller would have to use $( ) to read
# a printed one, and a command substitution runs in a SUBSHELL: the assignment and the trap would
# both be discarded, so every call would create a new directory and none would ever be cleaned.
#
# The EXIT trap is installed ONLY when the caller has none. A sourced library that overwrites its
# caller's trap is a worse bug than a leaked file. Where the caller does have one, the normal
# return paths still remove the file and the SIGNAL case is the caller's to handle; that cannot be
# fixed from inside a library, so it is stated rather than hidden.
_forge_tmp_init() {
  # Check the DIRECTORY, not just the variable: a subshell that finished a paginate may have
  # rmdir'd it, and its `unset` cannot escape the subshell, so the parent can hold a stale path.
  if [ -n "${_FORGE_TMPDIR-}" ] && [ -d "$_FORGE_TMPDIR" ]; then return 0; fi
  # ONE retry (#131.3): a concurrent pagination can remove the shared directory between the check
  # above and this line, and the second caller then returned 2 with a raw mktemp error. Narrow (0
  # flakes in 200 stress runs) but it made the concurrency test load-dependent.
  _FORGE_TMPDIR="$(mktemp -d)" || _FORGE_TMPDIR="$(mktemp -d)" || return 2
  # Install ONLY when the caller has no EXIT trap. Re-installing the caller's command is worse than
  # standing aside: a subshell that inherits the trap string would then run the CALLER's cleanup at
  # SUBSHELL exit, tearing down the caller's state mid-run. Measured, painfully: appending to the
  # trap made this repo's own suite delete its scratch dir in the middle of a test.
  [ -n "$(trap -p EXIT)" ] || trap 'rm -rf "${_FORGE_TMPDIR-}"' EXIT
  return 0
}

# _forge_tmp_done <file>  drop a temp file and, when it was the last one, the directory too.
# This is what stops the leak on the NORMAL path when the caller already had an EXIT trap and the
# signal trap above was therefore not installed: without it the files went but the directory stayed,
# and this repo's own suite left 18 behind per run. rmdir only succeeds when empty, so a concurrent
# pagination still holding a file is unaffected.
_forge_tmp_done() {
  rm -f "$1"
  [ -n "${_FORGE_TMPDIR-}" ] || return 0
  rmdir "$_FORGE_TMPDIR" 2>/dev/null && unset _FORGE_TMPDIR
  return 0
}


# _forge_resolve_names <listfile> <name...>  resolve names against the label lists (JSON arrays,
# one per line) in <listfile> -> [{name, id|null}]. ONE resolution pass drives BOTH the refusal
# check and the POST body in forge_issue_label, so the two can never drift apart; a divergence
# there is exactly the silent-partial class of #63.
_forge_resolve_names() {
  local listfile="$1"; shift
  printf '%s\n' "$@" | jq -R . | jq -sc --slurpfile lists "$listfile" \
    '($lists | add) as $labels | map(. as $l | {name:$l, id:($labels | map(select(.name==$l) | .id) | first)})'
}

# --- Issue operations (REST shapes match across GitHub + Forgejo/Gitea) ---

# forge_issue_view <n>  -> the full issue JSON (number, title, body, state, labels[].name,
# milestone.title, assignees, and so on: the raw REST object, near-identical on GitHub and Forgejo)
forge_issue_view() { forge_api GET "/repos/$(forge_repo)/issues/$1"; }

# --- the body-region primitives (#248) ----------------------------------------------------------
#
# forge_issue_edit is "the one write in this library that DESTROYS what was there". Three components
# will write a ticket body once the phase reviews land, and the rule keeping two of them apart was
# one sentence of prose. A rule in a GOVERNANCE doc cannot reach the third writer at all: it ships
# in an OPTIONAL group the governance guard neither scans nor can be made to scan. So the contract
# lives HERE, every group that needs it already declares this one as a dependency, and it fires at
# the write rather than at a guard over prose. This file names no component and no group.
#
# ONE DEFINITION OF A MARKER, SHARED BY EVERY FUNCTION. The first cut had two: the splice matched a
# prefix and the composer matched an anchored regex, so five ordinary bodies (CRLF from the GitHub
# web form, a region name with a dot, a marker with trailing text, an unterminated region, content
# holding a stray end marker) made the COMPOSER silently drop regions and return 0, while the splice
# refused the same shapes. The one function that rewrites a whole body was the one with no guard.
# Both now normalise a line the same way and refuse the same shapes.
#
# A MARKER IS A WHOLE LINE, after a trailing CR and trailing blanks are stripped, exactly
# `<!-- <name>:start -->` or `<!-- <name>:end -->`. A line that BEGINS with one and carries other
# text is REFUSED rather than read as a marker or as prose, because it is a body a human edited and
# guessing which they meant is how the edit gets eaten. A marker-shaped line INSIDE A FENCED CODE
# BLOCK is neither (#486): it is plain text, and the grammar and its precedence sit above
# _FORGE_AWK_MARKER. A body ending inside an unclosed fence with no marker line in it gets one
# matching closer before a bottom-appended region, the only author-text change a writer here ever
# makes; one ending inside an unclosed fence that holds a marker line is refused instead.
#
# WHAT IT ENFORCES IS DISJOINTNESS, NOT OWNERSHIP. Nothing stops a caller declaring a prefix it does
# not own. That is acceptable because the failure prevented is a full-body overwrite by a buggy
# component, not impersonation by a hostile one.
#
# WHAT THE SPLICE DOES TO WHITESPACE AND LINE ENDINGS IT DID NOT AUTHOR (#264). It writes LF, and
# it does not normalise what is around a region. A body filed through the GitHub web form is CRLF,
# so after a set the author's lines keep their CRLF while the marker lines and the content are LF:
# the body ends up with mixed line endings, and every marker still matches (a trailing CR is
# stripped before comparison). An EMPTY body gains exactly one leading blank line before the start
# marker. The body's trailing newlines collapse to exactly one (the read is a command substitution),
# so an author's trailing blank lines are dropped. Compose (forge_body_compose_preserving), not this
# splice, decides the spacing before a re-threaded region. Line endings are documented rather than
# normalised on purpose: normalising would rewrite author lines the splice has no business touching.
# Tests pin the CRLF, empty-body and trailing-newline behaviours, so changing one is deliberate.
#
# LAST-WRITER-WINS IS STRUCTURAL. GitHub offers no If-Match on an issue-body PATCH, so the re-read
# before the write NARROWS the window and cannot close it. Do not propose a lock as the fix.
#
# CODES 101 (a prefix refusal), 102 (the body moved since it was read) and 103 (a malformed,
# unterminated or duplicated marker pair, or content that would create one). Above curl's 1 to 99,
# because forge_api propagates curl's own code and a collision would make a refusal look like a
# network error; below the 126 the shell reserves. A splice that fails for ANY OTHER reason returns
# 2 and says so, rather than being laundered into 103 and sending someone to fix markers that are
# fine.
#
# CONTENT TRAVELS BY FILE, NOT BY ENVIRONMENT. A single execve argument is capped at
# MAX_ARG_STRLEN, about 128KiB on Linux, which this library's own paginator header already warns
# about; Forgejo puts no cap on a body, so a large one is reachable. Only the region NAME goes
# through ENVIRON, and never through `-v`, which Apple's awk refuses a newline in.

_forge_body_of() {   # <n>: the issue body, or non-zero if the response is not an issue
  local raw
  raw="$(forge_issue_view "$1")" || return $?
  printf '%s' "$raw" | jq -e 'has("body")' >/dev/null 2>&1 || {
    echo "forge-lib: issue #$1: the response carries no body field; refusing to treat it as empty" >&2
    return 2
  }
  printf '%s' "$raw" | jq -r '.body // ""'
}

# The shared normaliser and marker grammar, textually identical in every awk below.
#
# FENCED CODE BLOCKS (#486). A region marker inside a fenced code block is plain text, as the forge
# renders it: it is never counted, replaced, removed or returned. Before this, a ticket quoting a
# marker inside a fence made the splice refuse with 103, made compose refuse or silently DROP a
# real region (its new-body scan read the quote as present), made get return the closing fence and
# everything after it, and a quoted COMPLETE pair was overwritten by set and deleted by clear.
# The grammar is #485's (check-ticket-mechanics.sh FENCE_AWK), CommonMark 0.31.2 section 4.5, on a
# line already through norm(): an opener is at most 3 spaces of indent, then 3 or more backticks
# or 3 or more tildes; a backtick opener whose info string holds a backtick is not a fence; a
# closer is at most 3 spaces of indent, the opener's character, at least as long, nothing after
# it; a tab-indented or 4-space-indented line neither opens nor closes; an unclosed fence runs to
# the end of the body. This is a SEPARATE COPY of that rule, because forge-kit-devops may not
# source a governance asset; gate-status.sh fingerprint() is a third, and scripts/test-forge-lib.sh
# pins all three against one fixture list (the parity row). INDENT IS MEASURED WITH match() AND
# RLENGTH, never `sub(/^ ? ? ?/, ...)`, which mawk 1.3.4 reads as stripping ONE space (#485).
#
# PRECEDENCE. Fence state is evaluated first: a marker inside an open fence opens or closes no
# region. Inside a real region fence state is FROZEN: a fence line there neither opens nor closes.
# The freeze covers ANY real region (a whole-line start outside a fence until the end marker of
# the SAME name), not only the one being written, to match #485's any-region skip. The freeze only
# ever makes MORE lines count as markers (HEAD's counting), so a stray fence line inside a region
# can never hide the marker that ends it. It FAILS CLOSED ONLY BECAUSE OF THE END-OF-BODY CHECK in
# _forge_splice (and the existing one in compose): an unterminated start of any region freezes
# fence state to the end of the body, so on its own the freeze would let a fenced complete pair
# after it count as real and be spliced. Neither the freeze nor that check may be removed without
# the other. fenced() is the one entry point: it returns 1 for a fence line or a line inside an
# open fence (plain text), and otherwise tracks the open real region. Globals: fopen, fch, flen,
# fin (the opener's indent, copied into any closer this library writes), rgn (the open region),
# fmark (the open fence holds a whole marker line).
#
# AN UNCLOSED FENCE HOLDING A MARKER LINE IS AMBIGUOUS (#486 round 1). A body that ends inside an
# unclosed fence may be quoting markers or may have lost its closer above a real region, and
# nothing in the body says which. Reading them as text dropped or duplicated a real region, so the
# splice and compose REFUSE that body (exit 103, its own message), and compose refuses a NEW body
# ending that way too (#486 round 2): writing it would lock the issue. An unclosed fence with no
# marker line inside is unambiguous and keeps the closer-then-append path. get does NOT refuse:
# no get refuses a malformed body (an unterminated start returns to the end of the body), and it
# returns empty here, the markers read as fenced text, so the writes are where this fails closed.
_FORGE_AWK_MARKER='
  function norm(l) { sub(/\r$/, "", l); sub(/[ \t]+$/, "", l); return l }
  function mname(l,   n) {
    if (l !~ /^<!-- [^ \t]+:(start|end) -->$/) return ""
    n = l; sub(/^<!-- /, "", n); sub(/:(start|end) -->$/, "", n); return n
  }
  function mkind(l) { return (l ~ /:start -->$/) ? "start" : "end" }
  function fence_open(s,   o, n, ind, info) {
    match(s, /^ */); if (RLENGTH > 3) return 0; ind = substr(s, 1, RLENGTH); o = substr(s, RLENGTH + 1)
    if (substr(o, 1, 3) == "```") match(o, /^`+/)
    else if (substr(o, 1, 3) == "~~~") match(o, /^~+/)
    else return 0
    n = RLENGTH; info = substr(o, n + 1)
    if (substr(o, 1, 1) == "`" && index(info, "`")) return 0
    fch = substr(o, 1, 1); flen = n; fin = ind; return 1
  }
  function fence_close(s,   c, pat) {
    match(s, /^ */); if (RLENGTH > 3) return 0; c = substr(s, RLENGTH + 1)
    if (fch == "`") pat = "^`+$"; else pat = "^~+$"
    return c ~ pat && length(c) >= flen
  }
  function fence_closer(   c, i) { c = fin; for (i = 0; i < flen; i++) c = c fch; return c }
  function fenced(l,   nm) {
    if (rgn == "") {
      if (fopen) { if (fence_close(l)) { fopen = 0; fmark = 0 } else if (mname(l) != "") fmark = 1; return 1 }
      if (fence_open(l)) { fopen = 1; fmark = 0; return 1 }
    }
    nm = mname(l)
    if (rgn == "") { if (nm != "" && mkind(l) == "start") rgn = nm }
    else if (nm == rgn && mkind(l) == "end") rgn = ""
    return 0
  }
'

# _forge_splice: body on stdin, new body on stdout. FL_REGION, FL_MODE (set|clear), FL_POS (empty or
# top); content in the file named by FL_CONTENT_FILE. Exit 103 on any malformed marker shape.
# TOP (#284) is its own branch rather than a tweak to the two below, so the v26 paths every existing
# caller relies on are untouched: remove any existing copy (and the blank line that separated it
# from what came before, when nothing but blank lines follows it or it sat between two blanks),
# then emit the leading template-version line if the body has one, the region, and the rest with
# its leading blank lines dropped.
_forge_splice() {
  awk "$_FORGE_AWK_MARKER"'
    BEGIN {
      r = ENVIRON["FL_REGION"]; mode = ENVIRON["FL_MODE"]
      s = "<!-- " r ":start -->"; e = "<!-- " r ":end -->"
    }
    {
      line[NR] = $0
      n = norm($0)
      if (fenced(n)) next
      if (n == s) { nstart++; si = NR }
      else if (index(n, s) == 1) bad = 1
      if (n == e) { nend++; ei = NR }
      else if (index(n, e) == 1) bad = 1
    }
    END {
      # The end-of-body check (#486): a region of ANY name still open here refuses, because the
      # freeze inside it would otherwise let a fenced pair after it count as real. See fenced().
      # Another region left open exits 104 with its name on stdout, so the message names it; the
      # caller still returns 103. 105 is the ambiguous unclosed fence (see _FORGE_AWK_MARKER).
      if (rgn != "" && rgn != r) { print rgn; exit 104 }
      if (rgn != "") exit 103
      if (fopen && fmark) exit 105
      if (bad || nstart != nend || nstart > 1) exit 103
      if (nstart == 1 && si > ei) exit 103
      if (mode == "set" && ENVIRON["FL_POS"] == "top") {
        nk = 0
        for (i = 1; i <= NR; i++) {
          if (nstart == 1 && i >= si && i <= ei) continue
          if (nstart == 1 && i == si - 1 && norm(line[i]) == "" && (ei == NR || norm(line[ei + 1]) == "")) continue
          keep[++nk] = line[i]
        }
        k = 1
        if (nk >= 1 && norm(keep[1]) ~ /^<!-- template-version: [0-9]+ -->$/) { print keep[1]; print ""; k = 2 }
        while (k <= nk && norm(keep[k]) == "") k++
        print s
        while ((getline c < ENVIRON["FL_CONTENT_FILE"]) > 0) print c
        print e
        if (k <= nk) print ""
        for (; k <= nk; k++) print keep[k]
        exit 0
      }
      if (nstart == 0) {
        for (i = 1; i <= NR; i++) print line[i]
        if (mode == "set") {
          # A body ending inside an unclosed fence (one with no marker line in it; END refused the
          # other kind above) gets the matching closer first (#486): the indent, character and
          # length of the opener. Render-identical (the fence already ended at
          # the end of the body), and the next set finds the region outside any fence instead of
          # appending another. The only author-text change this library makes, at most once.
          if (fopen) { print fence_closer(); print "" }
          else if (NR > 0 && norm(line[NR]) != "") print ""
          print s
          while ((getline c < ENVIRON["FL_CONTENT_FILE"]) > 0) print c
          print e
        }
        exit 0
      }
      for (i = 1; i < si; i++) print line[i]
      if (mode == "set") {
        print s
        while ((getline c < ENVIRON["FL_CONTENT_FILE"]) > 0) print c
        print e
      } else if (si > 1 && norm(line[si - 1]) == "" && ei < NR && norm(line[ei + 1]) == "") ei++
      for (i = ei + 1; i <= NR; i++) print line[i]
    }
  '
}

# _forge_body_write <function> <n> <new-body-file> <original-body>: re-read, compare, then PATCH.
_forge_body_write() {
  local fn="$1" n="$2" file="$3" original="$4" now payload rc=0
  now="$(_forge_body_of "$n")" || return $?
  if [ "$now" != "$original" ]; then
    echo "forge-lib: $fn: issue #$n changed since it was read; refusing to write" >&2
    return 102
  fi
  payload="$(jq -Rs '{body:.}' < "$file")" || return 2
  forge_api PATCH "/repos/$(forge_repo)/issues/$n" "$payload" >/dev/null || rc=$?
  _forge_write_rc "$fn" "$n" "$rc"
}

# forge_body_region_get <issue> <region>
# No prefix argument and no check: reading another component's region is not a write, and a caller
# legitimately reads one it does not own. An absent region is empty with rc 0; a FETCH FAILURE is
# not, because a caller that cannot tell them apart reads a dead network as "no previous round".
forge_body_region_get() {
  local n="${1-}" region="${2-}" body rc=0
  [ -n "$n" ] && [ -n "$region" ] || { echo "forge-lib: usage: forge_body_region_get <issue> <region>" >&2; return 2; }
  body="$(_forge_body_of "$n")" || rc=$?
  [ "$rc" = 0 ] || return "$rc"
  printf '%s\n' "$body" | FL_REGION="$region" awk "$_FORGE_AWK_MARKER"'
    BEGIN { r = ENVIRON["FL_REGION"]; s = "<!-- " r ":start -->"; e = "<!-- " r ":end -->" }
    { n = norm($0); if (fenced(n)) next }
    n == s { inside = 1; next }
    n == e { inside = 0; next }
    inside { print }
  '
}

forge_body_region_set()   { _forge_region_write set   "${1-}" "${2-}" "${3-}" "${4-}" "${5-}"; }
forge_body_region_clear() { _forge_region_write clear "${1-}" "${2-}" "${3-}" "" ""; }

_forge_region_write() {
  local mode="$1" n="${2-}" prefix="${3-}" region="${4-}" content="${5-}" pos="${6-}" body tmp out rc=0
  [ -n "$n" ] && [ -n "$prefix" ] && [ -n "$region" ] && { [ -z "$pos" ] || [ "$pos" = top ]; } || {
    echo "forge-lib: usage: forge_body_region_$mode <issue> <prefix> <region> [content] [top]" >&2; return 2; }
  case "$region" in
    "$prefix"-*|"$prefix") ;;
    *) echo "forge-lib: region '$region' is not owned by prefix '$prefix'; refusing" >&2; return 101 ;;
  esac
  # CONTENT MAY NOT CARRY A MARKER LINE. Without this, a gate review quoting a marker writes a
  # second end marker into its own region, and every later set, clear and get on that region
  # refuses or truncates: the region is unrecoverable except by the whole-body write rule 1
  # forbids. This repository gates its own tickets, so the quoting case is ordinary.
  # FENCED OR NOT (#486): this guard deliberately does not call fenced(). Content lands INSIDE a
  # region, where fence state is frozen, so a marker line in it is a real marker even when the
  # content wraps it in a fence; ignoring the fence here is what keeps the region recoverable.
  if [ "$mode" = set ] && printf '%s\n' "$content" | awk "$_FORGE_AWK_MARKER"'
       { if (mname(norm($0)) != "") { found = 1 } } END { exit !found }'; then
    echo "forge-lib: refusing content that carries a region marker line; it would lock '$region'" >&2
    return 103
  fi
  forge_host >/dev/null || return 2   # an invalid host refuses even under dry run (#256); stderr is the one line
  # THE DRY-RUN GUARD SITS HERE, BEFORE THE FETCH. forge_api short-circuits EVERY method including
  # GET under dry-run, returning 0 with an empty body, so a guard placed after the fetch would
  # splice against an empty string and report success.
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    forge_url_check || return 2
    printf '[dry-run] %s region %s of issue %s on %s (%s characters)\n' "$mode" "$region" "$n" "$(forge_repo)" "${#content}" >&2
    return 0
  fi
  body="$(_forge_body_of "$n")" || return $?
  _forge_tmp_init || return 2
  tmp="$_FORGE_TMPDIR/region.$$"; out="$_FORGE_TMPDIR/out.$$"
  printf '%s\n' "$content" > "$tmp" || { _forge_tmp_done "$tmp"; return 2; }
  rc=0
  printf '%s\n' "$body" | FL_REGION="$region" FL_MODE="$mode" FL_POS="$pos" FL_CONTENT_FILE="$tmp" _forge_splice > "$out" || rc=$?
  _forge_tmp_done "$tmp"
  case "$rc" in
    0) ;;
    103) _forge_tmp_done "$out"
         echo "forge-lib: issue #$n has a malformed, unterminated or duplicated '$region' marker pair; refusing" >&2
         return 103 ;;
    104) echo "forge-lib: issue #$n leaves a '$(head -n 1 "$out")' region open at the end of the body; refusing" >&2
         _forge_tmp_done "$out"; return 103 ;;
    105) _forge_tmp_done "$out"
         echo "forge-lib: issue #$n ends inside an unclosed code fence holding a region marker line; refusing" >&2
         return 103 ;;
    *)   _forge_tmp_done "$out"
         echo "forge-lib: could not rewrite issue #$n (awk exited $rc); nothing was sent" >&2
         return 2 ;;
  esac
  _forge_body_write "forge_body_region_$mode" "$n" "$out" "$body"; rc=$?
  _forge_tmp_done "$out"
  return "$rc"
}

# forge_body_compose_preserving <issue> <new-body>
#
# NO PREFIX ARGUMENT, and that is the fix for the defect the first cut shipped. It took one and
# re-threaded only the regions that did NOT match it, so a caller rewriting an author section with
# its own prefix DELETED ITS OWN REGIONS and returned 0. For the governance writer that meant a
# Step 6 author write erasing the context its own Step 2.9 had just written, which is exactly the
# silently-dropped-write this whole contract exists to end.
#
# The rule instead: a region present in the CURRENT body and ABSENT from the new one is re-threaded.
# A caller that deliberately restates a region in its new body keeps its own version. Regions are
# otherwise managed with _set and _clear, which is where the prefix check belongs.
forge_body_compose_preserving() {
  local n="${1-}" new="${2-}" body tmp out rc=0
  [ -n "$n" ] && [ -n "$new" ] || {
    echo "forge-lib: usage: forge_body_compose_preserving <issue> <new-body>" >&2; return 2; }
  forge_host >/dev/null || return 2   # above the dry-run guard (#256)
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    forge_url_check || return 2
    printf '[dry-run] compose body of issue %s on %s (%s characters)\n' "$n" "$(forge_repo)" "${#new}" >&2
    return 0
  fi
  body="$(_forge_body_of "$n")" || return $?
  _forge_tmp_init || return 2
  tmp="$_FORGE_TMPDIR/new.$$"; out="$_FORGE_TMPDIR/composed.$$"
  printf '%s\n' "$new" > "$tmp" || { _forge_tmp_done "$tmp"; return 2; }
  rc=0
  printf '%s\n' "$body" | FL_NEW_FILE="$tmp" awk "$_FORGE_AWK_MARKER"'
    BEGIN {
      while ((getline l < ENVIRON["FL_NEW_FILE"]) > 0) {
        nl[++nn] = l
        if (fenced(norm(l))) continue   # a quoted marker is not a region the new body restates (#486)
        nm = mname(norm(l)); if (nm != "") present[nm] = 1
      }
      # Remember whether the new body ends inside an unclosed fence, then RESET the fence and
      # region state so the current-body pass below starts from a clean slate (#486).
      newopen = fopen; if (newopen) newcloser = fence_closer()
      newamb = fopen && fmark   # the NEW body is the ambiguous kind: refused in END, never written
      fopen = 0; fmark = 0; rgn = ""
    }
    { line[NR] = $0
      if (fenced(norm($0))) next
      nm = mname(norm($0))
      if (nm != "") {
        if (mkind(norm($0)) == "start") { if (st[nm]) bad = 1; st[nm] = NR; order[++no] = nm }
        else { if (!st[nm] || en[nm]) bad = 1; en[nm] = NR }
      } else if ($0 ~ /^<!-- [^ \t]+:(start|end) -->/) bad = 1
    }
    END {
      if (newamb) exit 106           # a flag, not an exit in BEGIN, so the read pass still runs
      if (fopen && fmark) exit 105   # the ambiguous unclosed fence (see _FORGE_AWK_MARKER)
      for (k in st) if (!en[k]) bad = 1
      if (bad) exit 103
      for (i = 1; i <= nn; i++) print nl[i]
      for (i = 1; i <= no; i++) {
        k = order[i]
        if (present[k]) continue
        if (newopen) { print newcloser; newopen = 0 }   # close the new body fence first, once
        print ""
        for (j = st[k]; j <= en[k]; j++) print line[j]
      }
    }
  ' > "$out" || rc=$?
  _forge_tmp_done "$tmp"
  case "$rc" in
    0) ;;
    103) _forge_tmp_done "$out"
         echo "forge-lib: issue #$n has a malformed, unterminated or duplicated marker pair; refusing" >&2
         return 103 ;;
    105) _forge_tmp_done "$out"
         echo "forge-lib: issue #$n ends inside an unclosed code fence holding a region marker line; refusing" >&2
         return 103 ;;
    106) _forge_tmp_done "$out"
         echo "forge-lib: issue #$n: the new body ends inside an unclosed code fence holding a region marker line; refusing" >&2
         return 103 ;;
    *)   _forge_tmp_done "$out"
         echo "forge-lib: could not compose issue #$n (awk exited $rc); nothing was sent" >&2
         return 2 ;;
  esac
  _forge_body_write forge_body_compose_preserving "$n" "$out" "$body"; rc=$?
  _forge_tmp_done "$out"
  return "$rc"
}

# forge_body_section_append <issue> <label> <content> (v47, #494)
#
# WRITE ONCE AS CODE. The gate's Step 6 item 2 used to compose the whole body freehand, and on #493
# a search for `## Unit tests` matched an inline code span mid-line: the author's line was cut in
# two and the section's tail duplicated. This writes into ONE author section, found by a WHOLE
# heading line, and refuses a section that already holds author text.
#
# THE TARGET is a line that, after norm() (CR and trailing blanks stripped), is an ATX heading (at
# most 3 spaces, 1 to 6 `#`, a space) whose text equals the label, outside a fence (the fenced()
# grammar of _FORGE_AWK_MARKER, not a third copy) and outside any region. Indent and hash runs are
# measured with match() and RLENGTH: mawk 1.3.4 has no {m,n} interval. THE SECTION ends at the next
# such heading of level at most the target's, or at a region start marker. A deeper sub-heading
# stays inside it and is an ordinary line: an unlabelled one is author text, like any other.
#
# OWNERSHIP IS PER BLOCK: a maximal run of non-blank lines, a fence line and every line inside a
# fence counting as non-blank. A block whose first line ENDS with `(gate-written, round N)` is the
# gate's (a label quoted mid-line is author text), its later lines included; a block that is exactly `_No response_` is a placeholder; any
# other block is author text and refuses the whole write (108). Placement: after the last gate
# block plus one blank line (placeholders dropped); else where the first placeholder was; else
# after the heading and one blank line. One blank line then separates the insert from whatever
# ends the section, replacing the blank lines that stood there. Every other line keeps its bytes,
# CRs included; inserted lines are LF.
#
# CONTENT IS CHECKED BEFORE ANY FETCH and refused with 103 when it carries a region marker line, ends
# inside an unclosed fence, holds a heading line of any level outside a fence, or has a block whose
# first line does not end with the gate label: each would change how every later write reads the
# body (a planted region, a fence swallowing the regions below, a section ended early or its
# heading duplicated so the next append gets 107 or 109, or the gate's own write read back as
# author text so the next append gets 108).
#
# EXIT CODES 107 (no target heading), 108 (author text) and 109 (the heading twice) are the awk's
# own and pass through. They are distinct from the awk-internal 104 to 106 that the splice and
# compose remap to 103; this awk never exits with those.
# hlevel(h): the ATX level of a line already through norm(), or 0; the heading text in htext.
_FORGE_AWK_HEADING='
    function hlevel(h,   r, lv) {
      match(h, /^ */); if (RLENGTH > 3) return 0
      r = substr(h, RLENGTH + 1)
      if (!match(r, /^#+/) || RLENGTH > 6) return 0
      lv = RLENGTH
      if (substr(r, lv + 1, 1) != " ") return 0
      htext = substr(r, lv + 2); sub(/^[ \t]+/, "", htext); return lv
    }
'
forge_body_section_append() {
  local n="${1-}" label="${2-}" content="${3-}" body tmp out rc=0
  [ -n "$n" ] && [ -n "$label" ] && [ -n "$content" ] || {
    echo "forge-lib: usage: forge_body_section_append <issue> <label> <content>" >&2; return 2; }
  # The content check (see above). A marker line is refused fenced or not, as _forge_region_write
  # does; a heading line only outside a fence, where it would be read as one. Blocks are cut as the
  # ownership pass below cuts them: a fence line and every line inside a fence are non-blank.
  rc=0
  printf '%s\n' "$content" | awk "$_FORGE_AWK_MARKER$_FORGE_AWK_HEADING"'
    BEGIN { first = 1 }
    { n = norm($0); if (mname(n) != "") mk = 1
      f = fenced(n)
      if (!f && n == "") { first = 1; next }
      if (first) { first = 0; if (n !~ /\(gate-written, round [0-9]+\)$/) un = 1 }
      if (!f && hlevel(n)) hd = 1 }
    END { if (mk) exit 3; if (fopen) exit 4; if (hd) exit 5; if (un) exit 6 }' || rc=$?
  case "$rc" in
    0) ;;
    3) echo "forge-lib: refusing content that carries a region marker line; it would plant a region in '$label'" >&2; return 103 ;;
    4) echo "forge-lib: refusing content that ends inside an unclosed code fence; it would swallow what follows '$label'" >&2; return 103 ;;
    5) echo "forge-lib: refusing content that carries a heading line (any level is refused); one at or above '$label' would end or duplicate it" >&2; return 103 ;;
    6) echo "forge-lib: refusing content with a block whose first line does not end with (gate-written, round N); the next append to '$label' would read it as author text" >&2; return 103 ;;
    *) echo "forge-lib: could not check the content for '$label' (awk exited $rc); nothing was sent" >&2; return 2 ;;
  esac
  forge_host >/dev/null || return 2   # above the dry-run guard (#256)
  # Before the fetch, as in _forge_region_write: forge_api answers a dry-run GET with an empty body,
  # which a guard after the fetch would read as a body with no heading. 107 to 109 are therefore
  # unreachable under dry run.
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    forge_url_check || return 2
    printf '[dry-run] append to section %s of issue %s on %s (%s characters)\n' "$label" "$n" "$(forge_repo)" "${#content}" >&2
    return 0
  fi
  body="$(_forge_body_of "$n")" || return $?
  _forge_tmp_init || return 2
  tmp="$_FORGE_TMPDIR/append.$$"; out="$_FORGE_TMPDIR/appended.$$"
  printf '%s\n' "$content" > "$tmp" || { _forge_tmp_done "$tmp"; return 2; }
  rc=0
  printf '%s\n' "$body" | FL_LABEL="$label" FL_CONTENT_FILE="$tmp" awk "$_FORGE_AWK_MARKER$_FORGE_AWK_HEADING"'
    BEGIN { lab = ENVIRON["FL_LABEL"] }
    {
      line[NR] = $0; nl = norm($0); h = nl
      before = rgn; f = fenced(nl)
      if (f) { kind[NR] = "f"; next }   # a fence line or a line inside a fence: plain text
      if (before == "" && rgn != "") { kind[NR] = "s"; next }   # a region start marker
      if (before != "") { kind[NR] = "r"; next }                # inside a region, end marker included
      if (nl == "") { kind[NR] = "b"; next }
      lv = hlevel(h)
      if (lv) { kind[NR] = "h"; lvl[NR] = lv; if (htext == lab) { nt++; t = NR } ; next }
      kind[NR] = "t"
    }
    END {
      if (nt == 0) exit 107
      if (nt > 1) exit 109
      L = lvl[t]; e = NR + 1
      for (i = t + 1; i <= NR; i++)
        if (kind[i] == "s" || (kind[i] == "h" && lvl[i] <= L)) { e = i; break }
      anchor = 0; ph = 0; first = 1
      for (i = t + 1; i < e; i++) {
        k = kind[i]
        if (k == "b") { first = 1; continue }
        if (first) {   # the first line of a block decides who owns all of it
          first = 0
          if (norm(line[i]) !~ /\(gate-written, round [0-9]+\)$/) {
            if (norm(line[i]) == "_No response_" && (i + 1 >= e || kind[i + 1] == "b")) {
              if (!ph) ph = i
              drop[i] = 1; continue
            }
            exit 108   # WRITE ONCE: author text in the section
          }
        }
        anchor = i
      }
      if (anchor) last = anchor; else if (ph) last = ph - 1; else last = t
      for (i = 1; i <= last; i++) if (!drop[i]) print line[i]
      if (anchor || !ph) print ""
      while ((getline c < ENVIRON["FL_CONTENT_FILE"]) > 0) print c
      if (e <= NR) { print ""; for (i = e; i <= NR; i++) print line[i] }
    }
  ' > "$out" || rc=$?
  _forge_tmp_done "$tmp"
  case "$rc" in
    0) ;;
    107) _forge_tmp_done "$out"
         echo "forge-lib: issue #$n has no '$label' heading line outside fences and regions; refusing" >&2
         return 107 ;;
    108) _forge_tmp_done "$out"
         echo "forge-lib: issue #$n: section '$label' already holds author text (WRITE ONCE); refusing" >&2
         return 108 ;;
    109) _forge_tmp_done "$out"
         echo "forge-lib: issue #$n has the '$label' heading more than once; refusing" >&2
         return 109 ;;
    *)   _forge_tmp_done "$out"
         echo "forge-lib: could not append to issue #$n (awk exited $rc); nothing was sent" >&2
         return 2 ;;
  esac
  _forge_body_write forge_body_section_append "$n" "$out" "$body"; rc=$?
  _forge_tmp_done "$out"
  return "$rc"
}

# forge_issue_comment <n> <body>
# _forge_write_rc <function> <issue> <rc>: a WRITE addressed by issue number speaks on a 404 (#229).
# forge_api's 404 arm is quiet on purpose, because for a READ a 404 is often ordinary (an org with
# no labels), and the three writers below redirect the body to /dev/null; under v16 a comment to a
# mistyped issue number therefore produced nothing on either stream and rc 44, and a caller reading
# silence as success could not tell a landed write from a miss. Only 44 gets a line: rc 22, a
# transport failure and the GitHub arm's `gh` already print one, and a second line would say less
# than the first. The line carries the function, the issue and the status, never a path.
_forge_write_rc() {
  [ "$3" -eq 44 ] && echo "forge-lib: $1: issue #$2: HTTP 404 (no such issue)" >&2
  return "$3"
}

# _forge_payload <fn> <jq-filter> [jq --arg name value ...]: the request JSON, built with the BODY
# read from STDIN and bound as $b (#409). A body passed as `jq --arg` is one execve argument, capped
# at MAX_ARG_STRLEN (131072 bytes) on Linux: above it jq failed, the payload came back empty, and the
# caller sent nothing in a dry run (rc 0, a false pass) or a request with no body live. Only short
# fields (a title, a tag) go as --arg. A failed build returns 2 with one stderr line naming <fn>.
# Callers feed it with `printf '%s' "$body" |`, a builtin, so the body never reaches an argv.
_forge_payload() {
  local fn=$1 filter=$2 out; shift 2
  out="$(jq -c -Rs "$@" ". as \$b | $filter")" && [ -n "$out" ] \
    || { echo "forge-lib: $fn: could not build the request body" >&2; return 2; }
  printf '%s' "$out"
}

forge_issue_comment() {
  local payload rc=0
  payload="$(printf '%s' "$2" | _forge_payload forge_issue_comment '{body:$b}')" || return 2   # forge-lib: payload (comment)
  # `rc=0; ... || rc=$?`, never `...; rc=$?` (#237): under a `set -e` caller errexit fires on the
  # forge_api line before rc=$? runs, and the 404 line is never printed. The || form is the one
  # shape that survives -e for 0, 22 and 44; a subshell or `|| true` swallows the code.
  forge_api POST "/repos/$(forge_repo)/issues/$1/comments" "$payload" >/dev/null || rc=$?
  _forge_write_rc forge_issue_comment "$1" "$rc"
}

# forge_issue_comments <n> -> JSON array of the issue's comments, oldest first, ALL pages (#192).
# The one READ of comments in this library. ticket-gate's round count is derived from it, because a
# body region is erased by any ordinary edit and a posted comment is not; a caller that counts
# rounds must therefore never read a single page, which is why this goes through the paginator.
forge_issue_comments() {
  local repo; repo="$(forge_repo)" || return 2
  forge_api_paginate "/repos/$repo/issues/$1/comments"
}

# forge_issue_close <n>
forge_issue_close() {
  local rc=0; forge_api PATCH "/repos/$(forge_repo)/issues/$1" '{"state":"closed"}' >/dev/null || rc=$?   # #237, see forge_issue_comment
  _forge_write_rc forge_issue_close "$1" "$rc"
}

# forge_issue_edit <n> <body>   REPLACES the issue body on either host (#129).
# Both hosts PATCH the issue itself, so there is no host branch here. It is the one write in this
# library that DESTROYS what was there, and the host's edit history is the only copy, so it refuses
# an empty body rather than erasing a ticket on a caller's unset variable. The dry-run line counts
# CHARACTERS in the caller's locale (`${#2}`), not bytes: `aé b` is 4 under a UTF-8 locale, 5 under C.
forge_issue_edit() {
  [ -n "${2:-}" ] || { echo "forge_issue_edit: refusing to replace issue #${1:-?} with an empty body" >&2; return 2; }
  forge_host >/dev/null || return 2   # above the dry-run guard (#256): both hosts PATCH, but an invalid one must not dry-run clean
  local payload; payload="$(printf '%s' "$2" | _forge_payload forge_issue_edit '{body:$b}')" || return 2   # forge-lib: payload (edit)
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    forge_url_check || return 2
    printf '[dry-run] replace body of issue %s on %s (%s characters)\n' "$1" "$(forge_repo)" "${#2}" >&2
    return 0
  fi
  local rc=0; forge_api PATCH "/repos/$(forge_repo)/issues/$1" "$payload" >/dev/null || rc=$?   # #237, see forge_issue_comment
  _forge_write_rc forge_issue_edit "$1" "$rc"
}

# forge_issue_list [state]  (default open) -> JSON array of issues, PRs excluded, ALL pages.
# GitHub's /issues includes PRs and is paginated, so the github path filters PRs and paginates;
# Forgejo excludes PRs server-side with type=issues. Both return the same shape (a PR-free array).
forge_issue_list() {
  local repo state host; repo="$(forge_repo)" || return 2; state="${1:-open}"
  host="$(forge_host)" || return 2   # above the dry-run guard (#256)
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    forge_url_check || return 2
    printf '[dry-run] GET %s/repos/%s/issues?state=%s (issues only, all pages)\n' "$(forge_api_base)" "$repo" "$state" >&2; return 0
  fi
  case "$host" in
    # Shared pager on both hosts; its github arm normalises gh's page-doc output to ONE array,
    # so the PR filter runs over a guaranteed single array.
    github)  forge_api_paginate "/repos/$repo/issues?state=$state" | jq 'map(select(.pull_request | not))' ;;
    forgejo) forge_api_paginate "/repos/$repo/issues?state=$state&type=issues" ;;
  esac
}

# forge_issue_create <title> <body>  -> JSON of the created issue (number, html_url, ...)
# Labels are intentionally omitted: GitHub's create takes label NAMES, Forgejo's takes label IDs, so
# add them in a follow-up host-specific step rather than risk a cross-host mismatch here.
forge_issue_create() {
  local repo payload; repo="$(forge_repo)" || return 2
  payload="$(printf '%s' "$2" | _forge_payload forge_issue_create '{title:$t, body:$b}' --arg t "$1")" || return 2   # forge-lib: payload (create)
  forge_api POST "/repos/$repo/issues" "$payload"
}

# forge_issue_label <n> <label> [label...]  (add labels BY NAME on either host). GitHub's API takes
# names directly; Forgejo's takes label IDs, so the forgejo path resolves names -> IDs via the
# repo's label list (all pages). An unresolvable name REFUSES the whole call: non-zero exit,
# stderr naming the label(s), nothing written. Refuse-all (not apply-partial) is deliberate
# (issue #63): callers are automation, and a partial apply makes the final state depend on which
# of several names was mistyped; atomic refusal means fix the input and re-run. A repo with no
# labels at all gets its own message, since the operator action differs (create labels vs fix a
# typo). This is the host-aware way to set the labels forge_issue_create intentionally omits.
forge_issue_label() {
  local n="$1"; shift; [ "$#" -gt 0 ] || return 0
  local repo host; repo="$(forge_repo)" || return 2
  host="$(forge_host)" || return 2   # above the dry-run guard (#256)
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    forge_url_check || return 2
    printf '[dry-run] label issue %s on %s with: %s\n' "$n" "$repo" "$*" >&2; return 0
  fi
  case "$host" in
    github)
      forge_api POST "/repos/$repo/issues/$n/labels" "$(printf '%s\n' "$@" | jq -R . | jq -sc '{labels: .}')" >/dev/null ;;
    forgejo)
      # Labels can be defined on the REPO or on the owning ORG: the issue-labels endpoint accepts
      # ids from either, but /repos/.../labels lists only the repo's own, so refusing against the
      # repo list alone would wrongly reject valid org labels. The org list is fetched ONLY when a
      # name fails to resolve against the repo list (the common all-repo-labels call costs no org
      # round-trips); the /orgs endpoint 404s for user-owned repos, which reads as an empty set,
      # and any other org-fetch failure is flagged in the error rather than silently narrowing
      # the label universe. Label lists go to jq via --slurpfile (file input), never --argjson
      # (argv-capped; see forge_api_paginate).
      local all org org_failed=0 resolved nmissing missing ids nlabels tmp
      all="$(forge_api_paginate "/repos/$repo/labels")" || return 2
      _forge_tmp_init || return 2
      tmp="$(mktemp "$_FORGE_TMPDIR/labels.XXXXXX")" || { _forge_tmp_done ""; return 2; }
      printf '%s\n' "$all" > "$tmp"
      resolved="$(_forge_resolve_names "$tmp" "$@")"
      if [ "$(printf '%s' "$resolved" | jq '[.[] | select(.id == null)] | length')" -gt 0 ]; then
        # With the status available (#78.2), a 404 is the ordinary "this owner is a user, or the
        # org declares no labels" case and is NOT a failure worth flagging; anything else is.
        # 44 is a 404 (this owner is a user, or the org declares no labels): ordinary, not a
        # failure worth flagging. Anything else narrows the label universe for a reason the
        # operator needs to know about.
        org="$(forge_api_paginate "/orgs/${repo%%/*}/labels" 2>/dev/null)" || {
          [ "$?" -eq 44 ] || org_failed=1; org='[]'; }
        printf '%s\n%s\n' "$all" "$org" > "$tmp"
        resolved="$(_forge_resolve_names "$tmp" "$@")"
      fi
      nlabels="$(jq -s 'add | length' "$tmp")"
      _forge_tmp_done "$tmp"
      # Gate on the COUNT of unresolved entries, not on a joined string: join(" ") of [""] is
      # empty, so a string-emptiness gate lets an empty-string name slip through and POST null.
      nmissing="$(printf '%s' "$resolved" | jq '[.[] | select(.id == null)] | length')"
      if [ "${nmissing:-0}" -gt 0 ]; then
        missing="$(printf '%s' "$resolved" | jq -r '[.[] | select(.id == null) | .name | @json] | join(" ")')"
        if [ "${nlabels:-0}" -eq 0 ]; then
          echo "forge-lib: cannot label issue #$n: the repository and its org have no labels defined (create them first)" >&2
        elif [ "$org_failed" -eq 1 ]; then
          echo "forge-lib: cannot label issue #$n: unresolvable label name(s): $missing (org-level labels could not be listed; if these are org labels, fix org access or define them on the repo)" >&2
        else
          echo "forge-lib: cannot label issue #$n: unresolvable label name(s): $missing" >&2
        fi
        return 2
      fi
      ids="$(printf '%s' "$resolved" | jq -c 'map(.id)')"
      forge_api POST "/repos/$repo/issues/$n/labels" "$(jq -nc --argjson l "$ids" '{labels:$l}')" >/dev/null ;;
  esac
}

# --- Release / tag operations ---

# forge_tag_exists <tag>  -> exit 0 if the tag exists on the forge
# --- milestones -------------------------------------------------------------------------------
# A HOST capability, not a planning concept: dep-auditor already reads them, and a project using any
# planning method at all still wants them. They live here rather than in the optional planning group
# that consumes them, so that group's dependency runs ONE WAY ONLY and declining it costs the host
# adapter nothing. (Naming that group here would itself be the coupling
# scripts/check-group-isolation.sh refuses, which is how this comment was first written and caught.)
forge_milestone_list() {
  local repo; repo="$(forge_repo)" || return 2
  # PAGINATED. /milestones is a LIST endpoint, so a plain GET returns one server page and silently
  # truncates past it, the class #62 fixed for issues. Narrowed to the three fields callers use, so
  # a host adding a field cannot change what a caller sees.
  #
  # THE `id` IS HOST-DEPENDENT, and getting it wrong is a 404 rather than a wrong answer. GitHub's
  # milestone endpoints address a milestone by its per-repo NUMBER; the `id` it also returns is a
  # global identifier that 404s on PATCH. Gitea and Forgejo have no `number` and address by `id`.
  # Normalised here so every caller sees one field, which is the whole reason this adapter exists.
  # Found by a live close failing, not by review.
  local gh=false host
  host="$(forge_host)" || return 2   # captured, never a bare `= github` test (#256); no guard of its own, the paginator's follows
  [ "$host" = github ] && gh=true
  forge_api_paginate "/repos/$repo/milestones?state=all" \
    | jq -c --argjson gh "$gh" '[.[] | {id: (if $gh then .number else .id end), title, state}]' || return 2
}

forge_milestone_create() {
  local title="$1" desc="${2-}" repo
  repo="$(forge_repo)" || return 2
  forge_api POST "/repos/$repo/milestones" \
    "$(jq -nc --arg t "$title" --arg d "$desc" '{title:$t, description:$d}')" >/dev/null
}

_forge_milestone_id() {
  local id
  id="$(forge_milestone_list | jq -r --arg t "$1" '.[] | select(.title == $t) | .id' | head -1)"
  [ -n "$id" ] || return 1
  printf '%s' "$id"
}

forge_milestone_close() {
  local title="$1" repo id
  repo="$(forge_repo)" || return 2
  # The dry-run guard runs BEFORE the resolution, as forge_issue_label's and forge_issue_milestone's
  # do (#254). Resolving first made every title unresolvable under the flag, because the paginator
  # returns a literal `[]` there. Clearing the flag around the resolution read is rejected: it
  # would perform a real GET inside a dry run. The accepted trade: a title that does not exist
  # also prints the line and returns 0, because the caller already resolved it from a real read.
  forge_host >/dev/null || return 2   # above the dry-run guard: an invalid host must not dry-run clean (#256)
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    forge_url_check || return 2
    printf '[dry-run] close milestone %s on %s\n' "$title" "$repo" >&2
    return 0
  fi
  # FAILS on an unknown title rather than no-opping. A close that quietly did nothing would let a
  # roadmap say `done` while the milestone stayed open, which is the exact drift a caller asks this
  # to prevent.
  id="$(_forge_milestone_id "$title")" || {
    echo "forge-lib: no milestone titled '$title' on $repo" >&2; return 2; }
  forge_api PATCH "/repos/$repo/milestones/$id" '{"state":"closed"}' >/dev/null
}

# forge_issue_milestone <issue> <title|"">  set or clear a ticket's milestone (#245).
# The WRITE half the milestone primitives never had: the kit could list, create and close a
# milestone and list its issues, and could not put a ticket in one, so every phase move went
# through `gh issue edit --milestone` and was GitHub-only. `/phase` is the consumer.
#
# Two host differences, both verified at source rather than assumed. The id to send is the
# per-repo NUMBER on GitHub ("the number of the milestone", issue PATCH) and the `id` on
# Forgejo, whose handler passes it to a primary-key lookup; `forge_milestone_list` already
# normalises the two into one field, and `_forge_milestone_id` resolves it, so the resolution
# is reused rather than rewritten. And the CLEAR form differs: GitHub documents `null`, while
# Forgejo and Gitea declare the field `*int64` and gate the handler on it being non-nil, so a
# `null` there is a SILENT no-op returning success and only the literal `0` unsets it. A wrong
# clear form is therefore loud on neither host and indistinguishable from success on one, which
# is the #229 class.
#
# The dry-run guard runs BEFORE the resolution, as forge_issue_label's does: under FORGE_DRY_RUN
# the paginator returns a literal `[]`, so every title is unresolvable and a dry run would report
# a real phase as missing (forge_milestone_close had that defect until v28, #254).
forge_issue_milestone() {
  local n="$1" title="$2" repo host id payload rc=0
  repo="$(forge_repo)" || return 2
  # The host is CAPTURED, never matched with a catch-all (review): forge_host refuses an invalid
  # FORGE_HOST by printing nothing, and a `*)` arm would read that refusal as "not forgejo" and
  # send the other host's wire form. `forge_api_base` refuses the same way for the same reason.
  # It sits ABOVE the dry-run block on purpose: a dry run against a host the library cannot
  # address must refuse (rc 2, forge_host's one line) rather than pretend it would have worked
  # (#256 AC4, #257). The ordering is pinned by inv256's dry-mode
  # milestone cases (set and clear); the real-mode ones pin the refusal itself.
  host="$(forge_host)" || return 2
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    forge_url_check || return 2
    if [ -n "$title" ]; then printf '[dry-run] set milestone of issue %s to %s on %s\n' "$n" "$title" "$repo" >&2
    else printf '[dry-run] clear the milestone of issue %s on %s\n' "$n" "$repo" >&2; fi
    return 0
  fi
  if [ -n "$title" ]; then
    # REFUSE rather than clear on an unresolvable title: a phase move that silently unset the
    # phase leaves the ticket where check-phases rule 1 finds it, which reads as a roadmap bug.
    id="$(_forge_milestone_id "$title")" || {
      echo "forge-lib: no milestone titled '$title' on $repo" >&2; return 2; }
    # An id must be DIGITS, and the check is not defensive clutter (review): `jq -r` renders a
    # JSON null as the four characters `null`, so a milestone object missing its id field would
    # otherwise build `{"milestone":null}` and a SET would silently CLEAR the field, which is the
    # one thing this function's refusal contract promises not to do. This gate is the SOLE guard:
    # a digits-only token always parses as a JSON number (verified on jq 1.7), so the `jq` call
    # below cannot fail on it, and a missing jq never gets this far because `_forge_milestone_id`
    # pipes through jq and fails first. It also admits `0`, Forgejo's CLEAR form; neither host
    # issues milestone id 0, so that is noted rather than guarded.
    case "$id" in
      ''|*[!0-9]*) echo "forge-lib: milestone id for '$title' on $repo is not a number: $id" >&2; return 2 ;;
    esac
    payload="$(jq -nc --argjson m "$id" '{milestone:$m}')"
  else
    case "$host" in
      forgejo) payload='{"milestone":0}' ;;
      github)  payload='{"milestone":null}' ;;
    esac
  fi
  forge_api PATCH "/repos/$repo/issues/$n" "$payload" >/dev/null || rc=$?
  _forge_write_rc forge_issue_milestone "$n" "$rc"
}

# Open issues with their milestone TITLE (or null). Excludes pull requests, for the same reason
# forge_issue_list does: the Gitea issues endpoint returns both, and a caller asking about tickets
# does not mean PRs.
forge_issue_milestone_list() {
  local repo; repo="$(forge_repo)" || return 2
  forge_api_paginate "/repos/$repo/issues?state=open" \
    | jq -c '[.[] | select(.pull_request | not)
                  | {number, milestone: (.milestone.title // null)}]' || return 2
}

forge_tag_exists() { forge_api GET "/repos/$(forge_repo)/tags/$1" >/dev/null 2>&1; }

# forge_release_create <tag> [title] [notes]   (both hosts accept tag_name/name/body)
forge_release_create() {
  local payload; payload="$(printf '%s' "${3-}" | _forge_payload forge_release_create '{tag_name:$t,name:$n,body:$b}' --arg t "$1" --arg n "${2:-$1}")" || return 2   # forge-lib: payload (release)
  forge_api POST "/repos/$(forge_repo)/releases" "$payload" >/dev/null
}

# --- CI status (runner-dependent) ---

# forge_ci_status <branch>  -> success | failure | cancelled | pending | none | not_configured
# (github also passes other raw GH conclusions like timed_out/skipped through). `cancelled` = a
# run was superseded, not broken, and both hosts can return it. `pending` = a run exists but has not
# concluded; `none` = asked, and no run exists; `not_configured` = COULD NOT ASK (unparseable remote,
# empty ref, API error, empty body), so callers (release) degrade gracefully (e.g. a local
# `make test` gate) instead of hard-failing. The two hosts agree on this vocabulary since v14.
#
# Forgejo: Forgejo Actions writes a COMMIT STATUS per job, so the combined commit-status endpoint
# (`/commits/{sha}/status`) is the simple, correct "is CI green?" check, better than the
# version-split /actions/runs|/actions/tasks API. (On GitHub the combined status does NOT reflect
# Actions (those are Checks), so the github path uses `gh run list`.) We resolve to a SHA because
# the combined status has known quirks on branch/tag refs.
#
# TWO EXCEPTIONS, and the first cost a wrongly filed ticket to find (#193).
#
# The combined status reports a CANCELLED run as `failure`. Pushing twice in quick succession
# supersedes the first run, so a healthy branch shows red commits with no failing step anywhere,
# and "why did it fail?" has no answer because nothing did; v13 was wrong on 23 of 39 red commits in
# the sample that ticket measured. The answer is ALREADY IN THE RESPONSE: Forgejo writes a hard-coded
# English description per job (services/actions/commit_status.go: "Has been cancelled",
# "Failing after 12s", ...), so the red path decides from the rows it holds and asks NOTHING else.
# Red state, every red row "Has been cancelled" -> cancelled; any red row saying anything else, or
# nothing -> failure. An unknown string therefore falls to v13's answer, never to a false green.
# The alternative, walking /actions/tasks, was rejected: it is paginated, version-split, and under
# a server-clamped page it reported `cancelled` with a failure on the next page.
#
# `total_count == 0` does NOT mean "this repo has no CI". It means no status row exists YET: a
# queued or just-started run has none, and reading that as not_configured told the caller to stop
# looking while the task was running. ONE page of /actions/tasks decides (never a walk): a task for
# the sha is `pending`, none is `none`, and an endpoint that cannot be asked stays `not_configured`,
# which keeps the runner-less fallback exactly where v13 had it. The sha match is a PREFIX match,
# because the ref falls back to its literal, possibly short, form for a sha in another repository.
# forge_api's stderr is NOT discarded at either call site (#450): a refusal (non-https,
# empty or unsafe token, bad FORGE_TOKEN_ENV, invalid host) is the only explanation a caller gets
# for `not_configured`. Passthrough means untouched: nothing here adds, filters or rewrites it, and
# a new stdout word was rejected because every caller `case`s on the vocabulary above.
forge_ci_status() {
  local host
  # An invalid host is "could not ask": the one host line is already on stderr, and the answer is
  # the documented word, rc 0, never empty stdout (#256). Not `return 2` like the other sites.
  host="$(forge_host)" || { echo not_configured; return 0; }
  case "$host" in
    github)  gh run list --branch "$1" --limit 1 --json status,conclusion \
               -q '.[0] | if . == null then "none" elif .status != "completed" then "pending" else (.conclusion // "none") end' 2>/dev/null || echo none ;;
    forgejo)
      local repo sha cs total state
      repo="$(forge_repo)" || { echo not_configured; return 0; }         # unparseable remote -> can't query
      # --verify so a bad ref prints NOTHING (plain `git rev-parse badref` echoes the arg to stdout
      # too, which would double it via `|| printf`). Falls back to the literal ref if unresolved.
      sha=$(git rev-parse --verify "$1" 2>/dev/null || printf '%s' "$1")
      [ -n "$sha" ] || { echo not_configured; return 0; }                # empty ref arg
      cs=$(forge_api GET "/repos/$repo/commits/$sha/status") || { echo not_configured; return 0; }
      [ -n "$cs" ] || { echo not_configured; return 0; }                 # empty body / dry-run
      total=$(printf '%s' "$cs" | jq -r '.total_count // 0' 2>/dev/null)
      case "$total" in ''|*[!0-9]*) total=0 ;; esac
      [ "$total" -eq 0 ] && { forge_ci_no_status_kind "$repo" "$sha"; return 0; }   # no row YET, see above
      state=$(printf '%s' "$cs" | jq -r '.state // "unknown"' 2>/dev/null)
      case "$state" in
        success)       echo success ;;
        pending)       echo pending ;;
        failure|error) _forge_ci_failure_kind_from_status "$cs" ;;      # failure | cancelled
        *)             echo "${state:-unknown}" ;;
      esac ;;
  esac
}

# _forge_ci_failure_kind_from_status <combined-status-json> -> failure | cancelled
# Only ever called on a red state. Red rows are status failure or error; the verdict is cancelled
# only when there is at least one red row and EVERY red row carries Forgejo's cancellation string.
_forge_ci_failure_kind_from_status() {
  printf '%s' "$1" | jq -r '
    [ .statuses[]? | select(.status == "failure" or .status == "error") ] as $red
    | if ($red | length) > 0 and all($red[]; (.description // "") == "Has been cancelled")
      then "cancelled" else "failure" end' 2>/dev/null || echo failure
}

# forge_ci_no_status_kind <repo> <sha> -> pending | none | not_configured
# Both envelope shapes are accepted (`{workflow_runs: [...]}` and a bare array), because the shape
# has differed across Forgejo versions and `.workflow_runs // .` RAISES on a bare array: jq's `//`
# catches null and false, not a type error.
forge_ci_no_status_kind() {
  local repo="$1" sha="$2" tasks hit
  tasks=$(forge_api GET "/repos/$repo/actions/tasks?limit=50&page=1") || { echo not_configured; return 0; }
  [ -n "$tasks" ] || { echo not_configured; return 0; }
  hit=$(printf '%s' "$tasks" | jq -r --arg sha "$sha" \
    '[(if type == "object" then (.workflow_runs // []) else . end)[]?
      | select((.head_sha // "") | startswith($sha))] | length' 2>/dev/null)
  case "$hit" in ''|*[!0-9]*) hit=0 ;; esac
  if [ "$hit" -gt 0 ]; then echo pending; else echo none; fi
}

# Executed directly: a diagnostics CLI, or call any forge_* function.
#   forge-lib.sh detect            # print host/repo/api
#   forge-lib.sh forge_issue_close 5
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-detect}" in
    detect) h="$(forge_host)" || exit 2   # top-level code: exit, not return; nothing on stdout (#256)
            printf 'host=%s  repo=%s' "$h" "$(forge_repo)"
            [ "$h" = forgejo ] && printf '  api=%s' "$(forge_api_base)"; printf '  ci=%s\n' "$(forge_ci_status "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)")" ;;
    *)      "$@" ;;
  esac
fi
