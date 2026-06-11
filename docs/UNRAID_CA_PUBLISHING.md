# Publishing a Project to Unraid Community Applications (CA)

A reusable playbook for getting a self-hosted Docker project listed in the Unraid
**Community Applications** store (the "Apps" tab inside Unraid). Written so a future
maintainer or AI agent can repeat the process for a new project quickly.

`actual-sync` is used as the worked example throughout. Replace the repo name,
image, ports, and paths with the new project's values.

> **Style note:** keep replies and docs in this repo free of em dashes and en dashes.

---

## 1. The model in one paragraph

Community Applications does not host your files. You keep a public GitHub repo that
contains (a) a maintainer profile file and (b) one Docker template XML per app. You
then register the repo through the official submission portal. CA's scanner reads
your repo's **default branch** over raw GitHub URLs, validates it, checks for
duplicates, and (after moderation) lists it. Users install from the Apps tab; Unraid
pulls the image by tag, so a `:latest` tag means they always get your newest build
with no template change.

---

## 2. Key websites

| Purpose | URL |
|---|---|
| Submission portal (start here, sign in with Unraid/forum account) | https://ca.unraid.net/submit |
| Submission help / docs | https://ca.unraid.net/submit/help |
| Repository XML format guide | https://ca.unraid.net/submit/help/repository-xml |
| XML field reference (required vs optional) | https://ca.unraid.net/submit/help/xml-field-reference |
| Official CA documentation | https://docs.unraid.net/community-applications/ |
| Browse catalog (check for duplicate names before submitting) | https://ca.unraid.net/apps |
| Community how-to thread (older, still useful context) | https://forums.unraid.net/topic/101424-how-to-publish-docker-templates-to-community-applications-on-unraid/ |
| Legacy "request" repo (being retired, do NOT use as the route) | https://github.com/selfhosters/unRAID-CA-templates |

The portal pages are the source of truth. The forum thread and selfhosters repo are
older mechanisms kept here for context only.

---

## 3. Prerequisites

Before touching CA, the project needs:

1. A **public** GitHub repo, reasonably active.
2. An **OSI-approved `LICENSE`** file at the repo root (MIT, Apache 2.0, GPL, etc).
3. A published container image on a public registry, ideally tagged **`:latest`**
   (GHCR, Docker Hub). Pin the template to `:latest` so you never regenerate it per
   release (see Section 7).
4. A square **icon** (PNG, commonly 64x64 to 256x256) committed to the repo and
   reachable over a raw URL.

---

## 4. Files to create

Two files. Put the profile at the repo root. The template can live anywhere the
scanner can read (root, `/unraid`, or the documented `/templates` folder all work);
what matters is that `<TemplateURL>` points at its real raw path.

### 4a. `ca_profile.xml` (repo root)

Repository overview / author metadata. **The root element is `<CommunityApplications>`,
with `<Profile>` (non-empty) as a child.** This is the root the official submission
portal and the starter repo use. (Note: some long-established repos like binhex use a
`<Maintainer>` root, which the legacy CA still accepts, but new submissions should
follow the documented `<CommunityApplications>` root to pass the scan cleanly.)

```xml
<?xml version="1.0" encoding="utf-8"?>
<CommunityApplications>
  <Profile>Describe the repo: what apps/plugins you maintain and where to get support. Markdown supported.</Profile>
  <Icon>https://raw.githubusercontent.com/USER/REPO/main/path/to/icon.png</Icon>
  <WebPage>https://github.com/USER/REPO</WebPage>
  <Forum>https://forums.unraid.net/topic/YOUR_SUPPORT_TOPIC</Forum>
  <!-- Optional: <Discord>, <DonateLink>, <DonateText>, <Photo>, <Video> -->
</CommunityApplications>
```

Source of truth: the starter repo's `ca_profile.xml` (https://github.com/unraid/unraid-community-apps-starter) and https://ca.unraid.net/submit/help/repository-info-xml.

### 4b. The container template, e.g. `unraid/PROJECT.xml`

```xml
<?xml version="1.0"?>
<Container version="2">
  <Name>PROJECT</Name>
  <Repository>ghcr.io/USER/PROJECT:latest</Repository>
  <Registry>https://github.com/USER/REPO/pkgs/container/PROJECT</Registry>
  <Network>bridge</Network>
  <MyIP/>
  <Shell>sh</Shell>
  <Privileged>false</Privileged>
  <Support>https://github.com/USER/REPO/issues</Support>
  <Project>https://github.com/USER/REPO</Project>
  <Overview>Short summary shown in the Apps listing. Mention first-run setup.</Overview>
  <Category>Productivity: Tools:Utilities</Category>
  <WebUI>http://[IP]:[PORT:8080]/</WebUI>
  <TemplateURL>https://raw.githubusercontent.com/USER/REPO/main/unraid/PROJECT.xml</TemplateURL>
  <Icon>https://raw.githubusercontent.com/USER/REPO/main/unraid/PROJECT-icon.png</Icon>
  <ExtraParams/>
  <PostArgs/>
  <Description>Longer description. BAKE IN the gotchas that cause support load (see Section 8). Use &#xD;&#xD; for paragraph breaks.</Description>

  <!-- One <Config> per port, path, and env var the user must set -->
  <Config Name="WebUI Port" Target="8080" Default="8080" Mode="tcp" Description="..." Type="Port" Display="always" Required="true" Mask="false">8080</Config>
  <Config Name="Config" Target="/app/config" Default="/mnt/user/appdata/PROJECT/config" Mode="rw" Description="..." Type="Path" Display="always" Required="true" Mask="false">/mnt/user/appdata/PROJECT/config</Config>
  <Config Name="PUID" Target="PUID" Default="99" Mode="" Description="Unraid: 99 (nobody) so it can write appdata." Type="Variable" Display="always" Required="false" Mask="false">99</Config>
  <Config Name="PGID" Target="PGID" Default="100" Mode="" Description="Unraid: 100 (users)." Type="Variable" Display="always" Required="false" Mask="false">100</Config>
  <Config Name="Timezone" Target="TZ" Default="Europe/Madrid" Mode="" Description="..." Type="Variable" Display="always" Required="false" Mask="false">Europe/Madrid</Config>
</Container>
```

### 4c. (Optional) A CI check for well-formedness

Mirror the official gate (xmllint well-formedness) so a broken edit fails CI:

```yaml
name: Validate Unraid templates
on:
  push:
    paths: ['unraid/**.xml', 'ca_profile.xml', '.github/workflows/unraid-xmllint.yml']
  pull_request:
    paths: ['unraid/**.xml', 'ca_profile.xml', '.github/workflows/unraid-xmllint.yml']
  workflow_dispatch:
jobs:
  xmllint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update && sudo apt-get install -y libxml2-utils
      - run: xmllint --noout unraid/*.xml ca_profile.xml
```

Locally, prefer `xmllint --noout ca_profile.xml unraid/*.xml` (install `libxml2-utils`).
If you must check in Python, use `defusedxml` rather than the stdlib parser, which is
vulnerable to XXE and billion-laughs by default:
`python3 -c "from defusedxml.ElementTree import parse; [parse(f) for f in ['ca_profile.xml','unraid/PROJECT.xml']]"`
(These are your own trusted files, so the risk is low, but do not teach the unsafe
pattern in a doc others will copy.)

---

## 5. Template fields: required vs recommended

| Field | Status | Notes |
|---|---|---|
| `Name` | Required | Display name in Apps |
| `Repository` | Required | Image reference; use `:latest` |
| `Overview` | Recommended | Primary summary shown to users |
| `Category` | Recommended | Space-separated tags, each colon-terminated, e.g. `Productivity: Tools:Utilities` |
| `Icon` | Recommended | Raw URL to a square PNG |
| `Project` | Recommended | Homepage / source repo |
| `Support` | Recommended | Forum thread or GitHub issues |
| `TemplateURL` | Recommended | Canonical raw URL of THIS file; used for identity and review. Do not leave it empty. |
| `Registry`, `Network`, `WebUI`, `Description`, `Config`, `Privileged`, `Shell`, `ExtraParams` | Optional | Fill what applies |

---

## 6. Submission steps (done by a human at the portal)

The scanner reads your default branch, so make sure Sections 4 files are merged to
**main** first (Section 7).

1. Go to https://ca.unraid.net/submit and sign in.
2. Point it at the GitHub repo.
3. Run **Validate** and **Scan**. Fix anything flagged, push, re-scan.
4. Preview the listing.
5. Submit to join the catalog. It then goes through CA moderation/review.

An AI agent cannot complete this step: it is an authenticated action on the
maintainer's account. Prepare the repo, then hand the human the four steps above.

---

## 7. Branch and release behavior (important)

- **The scanner reads the DEFAULT branch (usually `main`).** `<TemplateURL>` and
  `<Icon>` use `/main/` raw URLs. If your work lands only on a `development` branch,
  the scanner will not see it. Merge to `main` before submitting.
- **Nothing here is regenerated per release.** The template pins `:latest`, carries no
  version string, and the profile is maintainer-level metadata. New releases reach
  users through the image tag, not template edits.
- **You only edit the template when the container's configuration surface changes:**
  a new env var, port, volume, renamed config path, or a description/category update.
  Those are occasional and unrelated to version bumps.

---

## 8. Major painpoints (read this before you start)

These caused real time loss. Front-loading them saves the next attempt.

1. **`ca_profile.xml` root is `<CommunityApplications>`** (per the official portal and
   starter), with `<Profile>` as a non-empty child. The phrasing "non-empty Profile
   section" misleads into thinking `<Profile>` is the root. (The legacy `<Maintainer>`
   root that some old repos use also parses, but follow the documented root.)
2. **Default-branch requirement.** Files on `development` are invisible to the scanner.
   Get them onto `main`, and make `<TemplateURL>` point at the branch that actually
   holds the file.
3. **Use `:latest`, not a pinned tag**, unless you want to edit and re-submit the
   template every release. `:latest` plus Unraid's update check (or Watchtower) keeps
   users current hands-off.
4. **The selfhosters "request" repo is being retired.** Use `ca.unraid.net/submit`.
   Old guides that tell you to open a PR there are stale.
5. **Template location is flexible but `<TemplateURL>` is the identity.** Root,
   `/unraid`, or `/templates` all scan fine. The one hard rule: `<TemplateURL>` must
   resolve to the real raw path. An empty `<TemplateURL/>` is a common miss.
6. **Category format.** Space-separated, each token ends in a colon, optional
   subcategory after it: `Productivity: Tools:Utilities`. Check existing categories at
   https://ca.unraid.net/apps.
7. **Icon must resolve publicly** over its raw URL and be roughly square. A 404 icon
   is an easy rejection.
8. **Bridge vs host networking is the number one end-user support issue.** Bake the
   guidance into `<Description>` so you field fewer tickets:
   - Keep the app's bind host at `0.0.0.0` (do not set it to the Unraid LAN IP, or the
     WebUI is unreachable in bridge mode).
   - On host networking, Docker container-name DNS stops working, so any internal URL
     the app needs (for example a sibling service) must use the LAN IP, or both
     containers must share a user-defined Docker network.
9. **PUID/PGID for appdata writability.** On Unraid use `99:100` (nobody:users) and
   chown the data dirs on startup, or the app cannot write its volumes.
10. **First-run config.** If the app needs a config file, ship a self-seeding first run
    (write an example and exit) and say so in `<Description>`. Saves a round trip.
11. **Moderation expectations.** As maintainer you are expected to respond in your
    support thread, keep the listing working across new Unraid versions, and clearly
    label beta or experimental builds.
12. **No repeatable config groups.** An Unraid template is a fixed flat list of
    `<Config>` elements (Variable / Path / Port / Label / Device) — there is **no
    array or repeatable-group construct**, so you cannot offer a clean "+ add another
    X" in the UI for a multi-field group (e.g. N servers each with url+password+id).
    A user can hand-add individual entries via Advanced → "Add another Path, Port,
    Variable or Label", but that is undiscoverable and per-field. See the pattern in
    Section 11. (Sources: selfhosters.net/docker/templating, wiki.unraid.net/DockerTemplateSchema.)

---

## 9. Checklist for a new project

```
[ ] Repo is public and active
[ ] OSI LICENSE at repo root
[ ] Image published with a :latest tag on a public registry
[ ] Square icon committed and reachable via raw URL
[ ] ca_profile.xml at repo root (<CommunityApplications> root, non-empty <Profile>)
[ ] Template XML present, well-formed, with Name + Repository
[ ] <TemplateURL> filled with the real raw /main/ path (not empty)
[ ] <Category> valid (space-separated, colon-terminated)
[ ] Description bakes in networking + first-run gotchas
[ ] (optional) xmllint CI workflow added
[ ] All of the above merged to the DEFAULT branch (main)
[ ] Duplicate name check at ca.unraid.net/apps
[ ] Human submits at ca.unraid.net/submit (Validate, Scan, Preview, Join)
[ ] Only announce / tell testers to use the Apps tab AFTER it is published
```

---

## 10. Worked example

`actual-sync` shipped:
- `ca_profile.xml` at repo root.
- `unraid/actual-sync.xml` (template, `:latest`, filled `<TemplateURL>`). As of 1.8.0
  it also carries the single-budget `ACTUAL_SYNC_SERVER_*` Variable fields (the
  "single instance via UI, many via a file" pattern from Section 11), with the two
  password fields `Mask="true"`.
- `unraid/actual-sync-icon.png` (icon).
- `.github/workflows/unraid-xmllint.yml` (well-formedness gate).

See those files in this repo for a concrete, working reference.

---

## 11. Config UX: single instance via UI, many via a file

Because the template has no repeatable groups (Section 8, point 12), an app that
supports an arbitrary **number** of configured instances (N servers, N targets, …)
cannot expose "add as many as you want" in the Unraid UI. The idiomatic pattern:

- **One instance via env-var template fields.** Predefine `<Config Type="Variable">`
  entries for a single instance (e.g. URL / password / id). A user with one of the
  thing fills the fields and runs — no config file, no pre-created config folder.
  This is how config-light apps (e.g. the Actual *server* template) avoid first-run
  friction entirely; an app that genuinely needs config can offer it for the common
  single-instance case.
- **Many via a mounted config file.** Keep the JSON/YAML config as the canonical
  multi-instance source, mounted at a Path the user provides.
- **Merge the two sources, deduped by a STABLE IDENTITY, not the display name.**
  If the same instance is configured in both the env vars and the file, dedup on a
  real identity key and drop the duplicate with a warning — otherwise you
  double-process it (double bank-sync, duplicate notifications, state collisions).
  Deduping on the user-facing *name* alone is not enough; two entries can name the
  same underlying resource differently.

**Shipped in actual-sync 1.8.0 (#119 + #120).** Concrete behavior, for reference:

- **Env-var server (#120).** A single budget is configured entirely via
  `ACTUAL_SYNC_SERVER_*` env vars: `URL`, `PASSWORD`, `SYNC_ID` (required), plus
  optional `NAME`, `ENCRYPTION_PASSWORD`, `DATA_DIR`, `SCHEDULE`. With these set, an
  Unraid/Docker user needs no `config.json` and no pre-created config folder. The
  template exposes the matching `<Config Type="Variable">` fields, with `PASSWORD`
  and `ENCRYPTION_PASSWORD` set `Mask="true"`.
- **Precedence.** The file stays the canonical multi-server source. The env-var
  server is merged into the file's list; if its `NAME` collides with a file server it
  is auto-renamed rather than overwriting. A budget is never synced twice.
- **Budget identity for dedup (#119).** Two servers are the same BUDGET when their
  normalized `url` + `syncId` match (host compared case-insensitively, path
  case-sensitively). `validateLogic()` also warns when two servers share a `dataDir`
  (which would corrupt the same cache). This is implemented in
  `src/lib/configLoader.js`.
- **Advisory for now.** Duplicate-budget and shared-dataDir detection currently
  *warns*; turning it into a hard startup failure is tracked by #121.
