# Versioning Strategy

## Overview

Actual-sync uses **Semantic Versioning 2.0.0** with build metadata for consistent, automated version management across all environments.

## Version Format

### Semantic Versioning Pattern

```
MAJOR.MINOR.PATCH[-PRERELEASE][+METADATA]
```

### Version Examples

| Stage          | Version Format      | Example          | Notes                                           |
|----------------|---------------------|------------------|-------------------------------------------------|
| Stable Release | `MAJOR.MINOR.PATCH` | `1.4.0`          | Clean semantic version from git tags            |
| Dev Build      | `X.Y.Z-dev+HASH`    | `1.4.1-dev+abcdef7` | Pre-release + build metadata (all branches) |
| RC Preview     | `X.Y.Z-rc.N`        | `1.5.0-rc.1`     | Release candidate (optional, manual tagging)    |

### Version Components

- **MAJOR**: Breaking changes (incompatible API changes)
- **MINOR**: New features (backwards compatible)
- **PATCH**: Bug fixes (backwards compatible)
- **PRERELEASE**: `-dev`, `-rc.1`, etc. (indicates unstable/pre-release)
- **METADATA**: `+abcdef7` (commit hash, ignored in version precedence)

## How It Works

### 1. Version Source

The base version is stored in the `VERSION` file at the repository root:

```bash
1.1.0
```

**Fallback**: If `VERSION` doesn't exist, reads from `package.json` → `version` field.

### 2. Version Generation

The `get_version.sh` script generates versions based on Git state:

#### Stable Release (Tagged)
```bash
# On commit with tag v1.4.0
$ ./get_version.sh
1.4.0
```

#### Development Build (Any Branch)
```bash
# On main branch (no tag)
$ ./get_version.sh
1.4.1-dev+71f02b6

# On development branch
$ ./get_version.sh
1.4.1-dev+a3b8f21

# On feature branch
$ ./get_version.sh
1.4.1-dev+9cd4e12
```

**Key Points:**
- All non-tagged builds use `-dev+HASH` format
- Build metadata (`+HASH`) includes 7-character commit hash
- Fully compliant with [Semantic Versioning 2.0.0](https://semver.org/)

## Automated Version Management

### CI/CD Integration

The GitHub Actions workflow automatically handles versioning:

#### For Development Builds (All Branches)
```yaml
- name: Generate dynamic version
  id: version
  run: |
    chmod +x ./get_version.sh
    VERSION=$(./get_version.sh)
    echo "version=$VERSION" >> $GITHUB_OUTPUT
```

Output: `1.4.1-dev+abcdef7`

#### For Stable Releases (Tags)
```bash
# Create and push tag
git tag v1.4.0
git push origin v1.4.0
```

The workflow detects the tag and generates clean version: `1.4.0`

### Docker Image Tagging

Docker images are tagged based on the version type:

**Important**: Docker tags don't support the `+` character, so build metadata is converted from `+` to `-` for Docker tags only. The full semver version (with `+`) is preserved in image labels and build args.

#### Development Builds
```bash
# Semver version: 1.4.1-dev+abcdef7
# Docker tags (+ replaced with -)
agigante80/actual-sync:1.4.1-dev-abcdef7
agigante80/actual-sync:dev
ghcr.io/agigante80/actual-sync:1.4.1-dev-abcdef7
ghcr.io/agigante80/actual-sync:dev

# Image label still contains full semver
org.opencontainers.image.version=1.4.1-dev+abcdef7
```

#### Stable Releases
```bash
# Semver version: 1.4.0 (no build metadata)
# Docker tags (unchanged)
agigante80/actual-sync:1.4.0
agigante80/actual-sync:1.4
agigante80/actual-sync:1
agigante80/actual-sync:latest
ghcr.io/agigante80/actual-sync:1.4.0
ghcr.io/agigante80/actual-sync:latest
```

## Version Bumping Workflow

### Manual Bumping (Recommended)

1. **Update VERSION file** (on `main` branch):
   ```bash
   echo "1.5.0" > VERSION
   git add VERSION
   git commit -m "chore: bump version to 1.5.0"
   git push origin main
   ```

2. **Create release tag**:
   ```bash
   git tag v1.5.0
   git push origin v1.5.0
   ```

3. **GitHub Actions automatically**:
   - Builds Docker images with `1.5.0` tags
   - Publishes to Docker Hub and GHCR
   - Creates GitHub Release with changelog
   - Marks images as stable (`:latest` tag)

### Automated Bumping (Optional)

You can automate version bumping on merge to `main`:

```yaml
# .github/workflows/bump-version.yml
name: Auto Bump Version
on:
  push:
    branches:
      - main

jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Bump version
        id: bump
        uses: anothrNick/github-tag-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DEFAULT_BUMP: patch
          WITH_V: true
          RELEASE_BRANCHES: main
      
      - name: Update VERSION file
        run: |
          echo "${{ steps.bump.outputs.new_tag }}" | sed 's/^v//' > VERSION
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add VERSION
          git commit -m "chore: bump VERSION to ${{ steps.bump.outputs.new_tag }}"
          git push
```

**Note**: This is optional and not currently implemented. Manual control is preferred for production releases.

## Version Bumping Guidelines

### When to Bump MAJOR (X.0.0)

Breaking changes that require user action:

- ❌ Configuration schema changes (removed/renamed fields)
- ❌ Removed API endpoints or features
- ❌ Changed CLI argument behavior
- ❌ Database schema changes requiring migration
- ❌ Docker image breaking changes (new required env vars)

**Example**: `1.4.2` → `2.0.0`

### When to Bump MINOR (x.Y.0)

New features that are backwards compatible:

- ✅ New dashboard tabs or features
- ✅ New notification channels
- ✅ New configuration options (with defaults)
- ✅ New API endpoints
- ✅ New CLI commands
- ✅ Enhanced logging or monitoring

**Example**: `1.4.2` → `1.5.0`

### When to Bump PATCH (x.y.Z)

Bug fixes and minor improvements:

- 🐛 Bug fixes
- 🔒 Security patches
- 📝 Documentation updates
- 🎨 UI/styling tweaks
- ⚡ Performance improvements
- 🔧 Dependency updates (no breaking changes)

**Example**: `1.4.2` → `1.4.3`

## Release Process

### Full Release Workflow

1. **Prepare release branch** (optional for complex releases):
   ```bash
   git checkout -b release/1.5.0
   ```

2. **Update VERSION file**:
   ```bash
   echo "1.5.0" > VERSION
   git add VERSION
   git commit -m "chore: prepare release 1.5.0"
   ```

3. **Update CHANGELOG.md** (if maintained):
   ```markdown
   ## [1.5.0] - 2024-12-10
   
   ### Added
   - New feature X
   - Enhanced Y with Z
   
   ### Fixed
   - Bug in component A
   - Issue with B when C
   ```

4. **Merge to main**:
   ```bash
   git checkout main
   git merge --no-ff release/1.5.0
   git push origin main
   ```

5. **Create and push tag**:
   ```bash
   git tag -a v1.5.0 -m "Release v1.5.0"
   git push origin v1.5.0
   ```

6. **GitHub Actions handles**:
   - ✅ Runs all tests
   - ✅ Builds Docker images
   - ✅ Publishes to registries
   - ✅ Creates GitHub Release
   - ✅ Generates changelog

### Quick Patch Release

For urgent fixes:

```bash
# 1. Update VERSION
echo "1.4.3" > VERSION
git add VERSION
git commit -m "chore: bump to 1.4.3"
git push origin main

# 2. Tag and push
git tag v1.4.3
git push origin v1.4.3
```

## Pre-Release Versions (Optional)

For release candidates or beta testing:

```bash
# Create RC tag
git tag v1.5.0-rc.1
git push origin v1.5.0-rc.1
```

Docker images will be tagged as:
```
agigante80/actual-sync:1.5.0-rc.1
```

**Note**: Pre-releases are not tagged as `:latest`.

## Version Verification

### Check Current Version

```bash
# From script
./get_version.sh

# From package.json
node -p "require('./package.json').version"

# From VERSION file
cat VERSION

# From Docker image
docker run --rm agigante80/actual-sync:latest node -p "require('./package.json').version"
```

### View Git Tags

```bash
# List all tags
git tag -l

# Show latest tag
git describe --tags --abbrev=0

# Show tags for current commit
git tag --points-at HEAD
```

## Troubleshooting

### VERSION File Not Found

**Symptom**: Script falls back to `package.json`

**Solution**: Create VERSION file at repository root
```bash
echo "1.1.0" > VERSION
git add VERSION
git commit -m "chore: add VERSION file"
```

### Wrong Version Generated

**Symptom**: Unexpected version format

**Debug**:
```bash
# Run with verbose logging
VERBOSE=true ./get_version.sh

# Check git state
git status
git describe --tags --exact-match  # Should show tag if on tagged commit
git rev-parse --short HEAD         # Shows commit hash
```

### Docker Image Has Wrong Version

**Symptom**: Image metadata shows incorrect version

**Verify**:
```bash
# Check image labels (should show full semver with +)
docker inspect agigante80/actual-sync:latest | jq '.[0].Config.Labels."org.opencontainers.image.version"'

# Check package.json in image
docker run --rm agigante80/actual-sync:latest cat package.json | jq .version
```

### Docker Build Fails with "invalid tag" Error

**Symptom**: `ERROR: invalid tag "agigante80/actual-sync:1.1.0-dev+abc123": invalid reference format`

**Cause**: Docker tags cannot contain the `+` character (used in semver build metadata)

**Solution**: The CI/CD workflow automatically converts `+` to `-` for Docker tags:
- Semver version: `1.1.0-dev+abc123`
- Docker tag: `1.1.0-dev-abc123`
- Image label: `org.opencontainers.image.version=1.1.0-dev+abc123` (preserves full semver)

This is handled automatically in `.github/workflows/ci-cd.yml`

## Best Practices

### ✅ Do

- **Keep VERSION file in sync** with tags
- **Use semantic versioning** strictly (MAJOR.MINOR.PATCH)
- **Tag releases** from `main` branch only
- **Write descriptive tag messages** (`git tag -a v1.5.0 -m "..."`)
- **Test before tagging** (ensure CI passes on main)
- **Document breaking changes** in commit messages and releases

### ❌ Don't

- **Don't delete tags** after publishing (breaks version history)
- **Don't reuse tags** (creates confusion and breaks caching)
- **Don't manually edit** version in Docker images
- **Don't skip version numbers** (go 1.4.0 → 1.5.0, not 1.4.0 → 1.6.0)
- **Don't use custom version formats** (stick to semver)

## Integration with Other Tools

### Dependabot / Renovate

Update `package.json` version automatically:

```json
{
  "version": "1.5.0",
  "name": "actual-sync"
}
```

Keep `VERSION` file synced manually or with automation.

### Docker Compose

Pin to specific versions:

```yaml
services:
  actual-sync:
    image: agigante80/actual-sync:1.5.0  # Stable
    # OR
    image: agigante80/actual-sync:dev    # Latest dev build
```

### Kubernetes

Use image pull policy based on version:

```yaml
spec:
  containers:
    - name: actual-sync
      image: agigante80/actual-sync:1.5.0
      imagePullPolicy: IfNotPresent  # Stable versions
      # OR
      image: agigante80/actual-sync:dev
      imagePullPolicy: Always         # Dev builds
```

## References

- [Semantic Versioning 2.0.0](https://semver.org/)
- [GitHub Tags Documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [Docker Image Tagging Best Practices](https://docs.docker.com/engine/reference/commandline/tag/)
- [Keep a Changelog](https://keepachangelog.com/)

## Quick Reference

| Action | Command |
|--------|---------|
| Get current version | `./get_version.sh` |
| Update base version | `echo "1.5.0" > VERSION` |
| Create release tag | `git tag v1.5.0 && git push origin v1.5.0` |
| Create RC tag | `git tag v1.5.0-rc.1 && git push origin v1.5.0-rc.1` |
| List all tags | `git tag -l` |
| Delete local tag | `git tag -d v1.5.0` |
| Delete remote tag | `git push origin :refs/tags/v1.5.0` |
| Check tag on commit | `git describe --exact-match` |

---

**Last Updated**: December 2025  
**Versioning Scheme**: Semantic Versioning 2.0.0  
**Current Version**: See `VERSION` file
