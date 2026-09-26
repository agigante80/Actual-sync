#!/usr/bin/env bash
# forge-lib-version: 27
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
#       The test is `= 1`, matching FORGE_DRY_RUN at six sites in this file; `!= 0` would have
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
# Add a line here whenever a change alters what a caller must do, not merely what the library
# does internally.

set -uo pipefail

# Never inherit these: an inherited _FORGE_TMPDIR would be trusted, written to with a predictable
# name and never cleaned; an inherited memo guard would suppress the first config load.
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
  for k in ${_FORGE_FROM_FILE-}; do
    eval "_forge_was=\${_FORGE_FILEVAL_$k-}"
    [ "${!k-}" = "$_forge_was" ] && unset "$k"
    unset "_FORGE_FILEVAL_$k"
  done
  unset _forge_was
  _FORGE_FROM_FILE=""
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
                              _FORGE_FROM_FILE="${_FORGE_FROM_FILE-} $k"; } ;;  # env wins; else file
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

_forge_token() {
  _forge_load_conf
  local var="${FORGE_TOKEN_ENV:-FORGEJO_TOKEN}"
  if [ -n "${!var:-}" ]; then printf '%s' "${!var}"; return 0; fi
  # Fallback: ask git's credential helper for this instance (the mise pattern,
  # see references/local-auth.md). Reads the same encrypted store already used
  # for git-over-HTTPS; never prompts (GIT_TERMINAL_PROMPT=0, askpass stubbed:
  # an inherited GIT_ASKPASS, e.g. VS Code's, would otherwise be invoked) and
  # never writes anything back. FORGE_NO_GIT_CREDENTIALS=1 disables the
  # fallback entirely (strict env-only mode, the pre-v7 behavior).
  # The stub is an ABSOLUTE path on purpose: a PATH-resolved name could be
  # hijacked by a planted binary inside this credential-handling flow. If
  # /bin/true is absent (NixOS-likes), the miss degrades to a clean rc!=0
  # with no prompt and no hang (verified), never to a prompt.
  local url proto host cred
  url="${FORGE_API_URL:-}"
  if [ -n "$url" ] && [ "${FORGE_NO_GIT_CREDENTIALS:-0}" != 1 ]; then
    proto="${url%%://*}"; [ "$proto" = "$url" ] && proto=https
    # The same authority rule as forge_host, port kept (#212): the old cut at `/` alone let
    # `https://evil.internal#@github.com` hand github.com's credential to evil.internal.
    case "$url" in *://*) host="$(_forge_url_host "$url" keep-port)" ;; *) host="$(_forge_url_host "https://$url" keep-port)" ;; esac
    cred=$(printf 'protocol=%s\nhost=%s\n\n' "$proto" "$host" \
             | GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true git credential fill 2>/dev/null \
             | sed -n 's/^password=//p' | head -n1)
    if [ -n "$cred" ]; then printf '%s' "$cred"; return 0; fi
  fi
  echo "forgejo: token env '$var' is empty and git's credential helper has no entry for '${host:-unset}'." >&2
  echo "         Mint a scoped token and supply it; see forge-host references/local-auth.md." >&2
  return 2
}

# forge_api <METHOD> <path> [json-body]   path is like  /repos/{owner}/{repo}/issues
# Prints the raw JSON response. FORGE_DRY_RUN=1 -> print the resolved request and return.
# On the forgejo path the HTTP status reaches the caller as an EXIT CODE (issue #78.2): 0 for 2xx,
# 44 for 404, 22 for any other non-2xx, and curl's own code for a transport failure. Not a
# variable: callers read the body with $(...), which runs this in a subshell where an assignment
# would be discarded.
forge_api() {
  local method="$1" path="$2" body="${3-}"
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    # to stderr, so it survives callers that redirect the JSON response to /dev/null
    printf '[dry-run] %s %s%s%s\n' "$method" "$(forge_api_base)" "$path" "${body:+  body=$body}" >&2
    return 0
  fi
  case "$(forge_host)" in
    github)
      if [ -n "$body" ]; then printf '%s' "$body" | gh api -X "$method" "${path#/}" --input -
      else gh api -X "$method" "${path#/}"; fi ;;
    forgejo)
      # || return 2: in conditional callers (if out=$(forge_api ...); forge_ci_status)
      # set -e does not fire on the assignment, and without the guard an EMPTY
      # Authorization header would go over the wire and mask the real cause.
      local base tok
      base="$(forge_api_base)" || return 2
      tok="$(_forge_token)"    || return 2
      # NOT `curl -f` (issue #78.2): -f collapses every HTTP >= 400 into exit 22 with no body and
      # no status, so a caller cannot tell 404 (an org with no labels: fine) from 401 or 500 (a
      # real failure). The status is appended on its own line and split off here.
      local out rc
      if [ -n "$body" ]; then
        out="$(curl -sSL -w '\n%{http_code}' -X "$method" -H "Authorization: token $tok" -H 'Content-Type: application/json' -d "$body" "$base$path")"; rc=$?
      else
        out="$(curl -sSL -w '\n%{http_code}' -X "$method" -H "Authorization: token $tok" "$base$path")"; rc=$?
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
      esac ;;
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
forge_api_paginate() {
  _forge_load_conf || true   # ONCE, in this shell: the per-page $(forge_api ...) subshells and
                             # their own $(forge_host) / $(_forge_token) subshells inherit the
                             # memo from here. Loading it deeper would be discarded each time.
  local path="$1" sep page=1 chunk n tmp rc
  case "$path" in *\?*) sep='&' ;; *) sep='?' ;; esac
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    forge_api GET "${path}${sep}limit=50&page=1" >/dev/null   # prints the dry-run line
    printf '[]\n'; return 0
  fi
  if [ "$(forge_host)" = github ]; then
    # gh --paginate emits each page as a SEPARATE JSON doc on modern gh (--slurp exists for
    # exactly this); older gh merged arrays into one. jq -s tolerates both shapes: slurp all
    # docs, box any non-array, flatten once.
    gh api --paginate "${path#/}" | jq -sc 'map(if type == "array" then . else [.] end) | add // []'
    return $?
  fi
  local cap="${FORGE_PAGINATE_MAX_PAGES:-500}"
  case "$cap" in ''|*[!0-9]*) cap=500 ;; esac   # a non-numeric override must not void the spin guard
  _forge_tmp_init || return 2
  # mktemp, NOT "paginate.$$": $$ is the PARENT pid inside every subshell, so two concurrent
  # paginations in one process shared a path and each returned the union of both streams, exit 0.
  tmp="$(mktemp "$_FORGE_TMPDIR/paginate.XXXXXX")" || return 2
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
# guessing which they meant is how the edit gets eaten.
#
# WHAT IT ENFORCES IS DISJOINTNESS, NOT OWNERSHIP. Nothing stops a caller declaring a prefix it does
# not own. That is acceptable because the failure prevented is a full-body overwrite by a buggy
# component, not impersonation by a hostile one.
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
_FORGE_AWK_MARKER='
  function norm(l) { sub(/\r$/, "", l); sub(/[ \t]+$/, "", l); return l }
  function mname(l,   n) {
    if (l !~ /^<!-- [^ \t]+:(start|end) -->$/) return ""
    n = l; sub(/^<!-- /, "", n); sub(/:(start|end) -->$/, "", n); return n
  }
  function mkind(l) { return (l ~ /:start -->$/) ? "start" : "end" }
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
      if (n == s) { nstart++; si = NR }
      else if (index(n, s) == 1) bad = 1
      if (n == e) { nend++; ei = NR }
      else if (index(n, e) == 1) bad = 1
    }
    END {
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
          if (NR > 0 && norm(line[NR]) != "") print ""
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
    { n = norm($0) }
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
  if [ "$mode" = set ] && printf '%s\n' "$content" | awk "$_FORGE_AWK_MARKER"'
       { if (mname(norm($0)) != "") { found = 1 } } END { exit !found }'; then
    echo "forge-lib: refusing content that carries a region marker line; it would lock '$region'" >&2
    return 103
  fi
  # THE DRY-RUN GUARD SITS HERE, BEFORE THE FETCH. forge_api short-circuits EVERY method including
  # GET under dry-run, returning 0 with an empty body, so a guard placed after the fetch would
  # splice against an empty string and report success.
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
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
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
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
        nm = mname(norm(l)); if (nm != "") present[nm] = 1
      }
    }
    { line[NR] = $0
      nm = mname(norm($0))
      if (nm != "") {
        if (mkind(norm($0)) == "start") { if (st[nm]) bad = 1; st[nm] = NR; order[++no] = nm }
        else { if (!st[nm] || en[nm]) bad = 1; en[nm] = NR }
      } else if ($0 ~ /^<!-- [^ \t]+:(start|end) -->/) bad = 1
    }
    END {
      for (k in st) if (!en[k]) bad = 1
      if (bad) exit 103
      for (i = 1; i <= nn; i++) print nl[i]
      for (i = 1; i <= no; i++) {
        k = order[i]
        if (present[k]) continue
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
    *)   _forge_tmp_done "$out"
         echo "forge-lib: could not compose issue #$n (awk exited $rc); nothing was sent" >&2
         return 2 ;;
  esac
  _forge_body_write forge_body_compose_preserving "$n" "$out" "$body"; rc=$?
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

forge_issue_comment() {
  local payload rc=0; payload="$(jq -nc --arg b "$2" '{body:$b}')"
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
# an empty body rather than erasing a ticket on a caller's unset variable.
forge_issue_edit() {
  [ -n "${2:-}" ] || { echo "forge_issue_edit: refusing to replace issue #${1:-?} with an empty body" >&2; return 2; }
  local payload; payload="$(jq -nc --arg b "$2" '{body:$b}')"
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    printf '[dry-run] replace body of issue %s on %s (%s bytes)\n' "$1" "$(forge_repo)" "${#2}" >&2
    return 0
  fi
  local rc=0; forge_api PATCH "/repos/$(forge_repo)/issues/$1" "$payload" >/dev/null || rc=$?   # #237, see forge_issue_comment
  _forge_write_rc forge_issue_edit "$1" "$rc"
}

# forge_issue_list [state]  (default open) -> JSON array of issues, PRs excluded, ALL pages.
# GitHub's /issues includes PRs and is paginated, so the github path filters PRs and paginates;
# Forgejo excludes PRs server-side with type=issues. Both return the same shape (a PR-free array).
forge_issue_list() {
  local repo state; repo="$(forge_repo)" || return 2; state="${1:-open}"
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
    printf '[dry-run] GET %s/repos/%s/issues?state=%s (issues only, all pages)\n' "$(forge_api_base)" "$repo" "$state" >&2; return 0
  fi
  case "$(forge_host)" in
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
  payload="$(jq -nc --arg t "$1" --arg b "$2" '{title:$t, body:$b}')"
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
  local repo; repo="$(forge_repo)" || return 2
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then printf '[dry-run] label issue %s on %s with: %s\n' "$n" "$repo" "$*" >&2; return 0; fi
  case "$(forge_host)" in
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
      tmp="$(mktemp "$_FORGE_TMPDIR/labels.XXXXXX")" || return 2
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
  local gh=false
  [ "$(forge_host)" = github ] && gh=true
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
# a real phase as missing (that is what forge_milestone_close does today, #254).
forge_issue_milestone() {
  local n="$1" title="$2" repo host id payload rc=0
  repo="$(forge_repo)" || return 2
  # The host is CAPTURED, never matched with a catch-all (review): forge_host refuses an invalid
  # FORGE_HOST by printing nothing, and a `*)` arm would read that refusal as "not forgejo" and
  # send the other host's wire form. `_forge_api_base` refuses the same way for the same reason.
  host="$(forge_host)" || return 2
  if [ "${FORGE_DRY_RUN:-0}" = 1 ]; then
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
    # one thing this function's refusal contract promises not to do. A non-numeric token instead
    # makes `--argjson` fail, leaving the payload empty and sending a body-less PATCH.
    case "$id" in
      ''|*[!0-9]*) echo "forge-lib: milestone id for '$title' on $repo is not a number: $id" >&2; return 2 ;;
    esac
    payload="$(jq -nc --argjson m "$id" '{milestone:$m}')" || return 2
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
    | jq -c '[.[] | select(has("pull_request") | not)
                  | {number, milestone: (.milestone.title // null)}]' || return 2
}

forge_tag_exists() { forge_api GET "/repos/$(forge_repo)/tags/$1" >/dev/null 2>&1; }

# forge_release_create <tag> [title] [notes]   (both hosts accept tag_name/name/body)
forge_release_create() {
  local payload; payload="$(jq -nc --arg t "$1" --arg n "${2:-$1}" --arg b "${3-}" '{tag_name:$t,name:$n,body:$b}')"
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
forge_ci_status() {
  case "$(forge_host)" in
    github)  gh run list --branch "$1" --limit 1 --json status,conclusion \
               -q '.[0] | if . == null then "none" elif .status != "completed" then "pending" else (.conclusion // "none") end' 2>/dev/null || echo none ;;
    forgejo)
      local repo sha cs total state
      repo="$(forge_repo)" || { echo not_configured; return 0; }         # unparseable remote -> can't query
      # --verify so a bad ref prints NOTHING (plain `git rev-parse badref` echoes the arg to stdout
      # too, which would double it via `|| printf`). Falls back to the literal ref if unresolved.
      sha=$(git rev-parse --verify "$1" 2>/dev/null || printf '%s' "$1")
      [ -n "$sha" ] || { echo not_configured; return 0; }                # empty ref arg
      cs=$(forge_api GET "/repos/$repo/commits/$sha/status" 2>/dev/null) || { echo not_configured; return 0; }
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
  tasks=$(forge_api GET "/repos/$repo/actions/tasks?limit=50&page=1" 2>/dev/null) || { echo not_configured; return 0; }
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
    detect) h="$(forge_host)"; printf 'host=%s  repo=%s' "$h" "$(forge_repo)"
            [ "$h" = forgejo ] && printf '  api=%s' "$(forge_api_base)"; printf '  ci=%s\n' "$(forge_ci_status "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)")" ;;
    *)      "$@" ;;
  esac
fi
