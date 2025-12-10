# Versioning Quick Reference

## 🎯 Version Formats

```
Stable:      1.4.0
Dev Build:   1.4.1-dev+abcdef7
Pre-release: 1.5.0-rc.1
```

## 🔧 Common Commands

```bash
# Get current version
./get_version.sh

# Update base version
echo "1.5.0" > VERSION

# Create stable release
git tag v1.5.0
git push origin v1.5.0

# Create pre-release
git tag v1.5.0-rc.1
git push origin v1.5.0-rc.1
```

## 📦 Version Bumping Rules

| Change Type | Bump | Example |
|-------------|------|---------|
| Breaking changes | MAJOR | 1.4.2 → 2.0.0 |
| New features | MINOR | 1.4.2 → 1.5.0 |
| Bug fixes | PATCH | 1.4.2 → 1.4.3 |

## 🚀 Release Workflow

```bash
# 1. Update VERSION file
echo "1.5.0" > VERSION
git add VERSION
git commit -m "chore: bump version to 1.5.0"
git push origin main

# 2. Create and push tag
git tag v1.5.0
git push origin v1.5.0

# 3. GitHub Actions automatically:
#    - Builds Docker images
#    - Publishes to registries
#    - Creates GitHub Release
```

## 🐳 Docker Image Tags

**Note**: Docker tags use `-` instead of `+` (e.g., `1.5.1-dev-abcdef7` not `1.5.1-dev+abcdef7`)

**Stable Release (v1.5.0):**
```
agigante80/actual-sync:1.5.0
agigante80/actual-sync:1.5
agigante80/actual-sync:1
agigante80/actual-sync:latest
```

**Dev Build (main/develop/feature):**
```
# Semver: 1.5.1-dev+abcdef7 → Docker: 1.5.1-dev-abcdef7
agigante80/actual-sync:1.5.1-dev-abcdef7
agigante80/actual-sync:dev
```

## ✅ Best Practices

- ✅ Keep VERSION file in sync with tags
- ✅ Use semantic versioning strictly
- ✅ Tag releases from main branch only
- ✅ Test before tagging
- ✅ Document breaking changes

## 🔍 Version Verification

```bash
# Check VERSION file
cat VERSION

# Check git tags
git tag -l

# Check if on tagged commit
git describe --exact-match

# Test version script
./get_version.sh
```

---

**For detailed documentation, see [docs/VERSIONING.md](../docs/VERSIONING.md)**
