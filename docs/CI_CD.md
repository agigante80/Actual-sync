# CI/CD Pipeline Documentation

## Overview

This document describes the comprehensive Continuous Integration and Continuous Deployment (CI/CD) pipeline for Actual-sync. The pipeline automates testing, building, Docker image publishing, security scanning, and release management.

## Table of Contents

- [Pipeline Architecture](#pipeline-architecture)
- [Dynamic Versioning](#dynamic-versioning)
- [Workflow Jobs](#workflow-jobs)
- [Setup Instructions](#setup-instructions)
- [Manual Triggers](#manual-triggers)
- [Docker Publishing](#docker-publishing)
- [Security Scanning](#security-scanning)
- [Troubleshooting](#troubleshooting)

---

## Pipeline Architecture

The CI/CD pipeline consists of 10 interconnected jobs that run in a specific order:

```
┌─────────────┐
│   Version   │
│ Generation  │
└──────┬──────┘
       │
       ├────────────┬──────────────┬────────────────────┐
       ▼            ▼              ▼                    ▼
   ┌──────┐    ┌──────┐      ┌───────┐    ┌──────────────────┐
   │ Lint │    │ Test │      │ Build │    │ Validate Docker  │
   │      │    │      │      │       │    │  Description     │
   └───┬──┘    └───┬──┘      └───┬───┘    └────────┬─────────┘
       │           │             │                  │
       └───────────┴─────────────┴──────────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  Docker Test    │
                   │     Build       │
                   └────────┬────────┘
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
       ┌──────────────┐       ┌──────────────┐
       │   Docker     │       │  Security    │
       │   Publish    │       │    Scan      │
       └──────┬───────┘       └──────┬───────┘
              │                      │
              ├──────────────────────┘
              │
              ▼
      ┌────────────────┐
      │  Deployment    │
      │     Test       │
      └────────┬───────┘
               │
               ▼  (on success on main)
   ┌──────────────────────────┐
   │  Auto Release workflow    │
   │  (separate; patch-bump +  │
   │   tag + GitHub Release)    │
   └──────────────────────────┘
```

### Pipeline Triggers

The pipeline runs automatically on:

- **Push to main branch**: Full pipeline + Docker publish; on success triggers the separate Auto Release workflow (patch-bump + GitHub Release)
- **Push to develop branch**: Full pipeline with development tags
- **Pull requests**: Testing and validation only (no publishing)
- **Git tags (v*)**: Full pipeline with Docker publish for the version tag (the release itself is created by the Auto Release workflow, which also pushes the tag)
- **Manual dispatch**: Configurable workflow with custom options

**Docs-only changes are skipped.** Pushes/PRs that touch only `**/*.md`, `docs/**`, or `LICENSE` do not trigger the pipeline (`paths-ignore`), so documentation edits don't run builds/tests/publish — and a docs-only push to `main` does not fire the Auto Release.

**Chromium download is skipped in CI.** The workflow sets `PUPPETEER_SKIP_DOWNLOAD=true`, so `npm ci` in the lint/test/build jobs does not download Puppeteer's ~170 MB Chromium (it's only needed by the local screenshots script, never in CI).

---

## Dynamic Versioning

The pipeline uses a dynamic versioning system via `get_version.sh` that generates context-aware version strings.

### Version Format

```
<base_version>-<context>-<commit_hash>
```

### Version Examples

| Branch/Tag | Generated Version | Description |
|------------|------------------|-------------|
| `main` with tag `v1.2.3` | `1.2.3` | Production release |
| `main` without tag | `1.0.0-main-abc1234` | Main branch build |
| `develop` | `1.0.0-dev-abc1234` | Development build |
| `feature/auth` | `1.0.0-feature-auth-abc1234` | Feature branch |
| `bugfix/api-error` | `1.0.0-bugfix-api-error-abc1234` | Bug fix branch |

### How It Works

1. **Base Version**: Read from `package.json` version field
2. **Git Context**: Detect current branch name
3. **Commit Hash**: Short Git commit hash (7 characters)
4. **Tag Detection**: Check if commit is on an exact Git tag
5. **Sanitization**: Clean branch names (remove special characters)

### Version in Application

The version is available throughout the application:

```javascript
// Environment variable
process.env.VERSION

// Global variable
global.APP_VERSION

// Health endpoint
curl http://localhost:3000/health
{
  "status": "UP",
  "version": "1.0.0-dev-abc1234",
  ...
}

// Metrics endpoint
curl http://localhost:3000/metrics
{
  "version": "1.0.0-dev-abc1234",
  ...
}
```

### Testing Version Script

```bash
# Test locally
./get_version.sh

# Verbose output with logs
./get_version.sh --verbose

# Expected output format
1.0.0-main-abc1234
```

---

## Workflow Jobs

### 1. Version Generation

**Purpose**: Generate dynamic version string for the entire pipeline

**Runs on**: All triggers

**Outputs**:
- `version`: Generated version string
- `is_release`: Boolean indicating if this is a release build

**Duration**: ~10 seconds

**Example Output**:
```
📦 Generated version: 1.0.0-dev-abc1234
🔨 This is a development build
```

---

### 2. Lint

**Purpose**: Validate code syntax and formatting

**Runs on**: All triggers

**Dependencies**: `version`

**Steps**:
1. Checkout code
2. Setup Node.js with caching
3. Install dependencies
4. Check JavaScript syntax

**Duration**: ~30 seconds

**What It Checks**:
- JavaScript syntax errors
- File accessibility
- Module dependencies

---

### 3. Test

**Purpose**: Run unit tests and collect coverage

**Runs on**: All triggers (unless `skip_tests=true`)

**Dependencies**: `version`

**Steps**:
1. Checkout code
2. Setup Node.js
3. Install dependencies
4. Run npm audit for vulnerabilities
5. Execute Jest tests with coverage
6. Upload coverage to Codecov

**Duration**: ~2-3 minutes

**Coverage Requirements** (defined in package.json):
- Branches: 70%
- Functions: 70%
- Lines: 70%
- Statements: 70%

**Test Reports**:
- Uploaded to Codecov
- Available in GitHub Actions summary
- LCOV format for detailed analysis

---

### 4. Build

**Purpose**: Build application and verify artifacts

**Runs on**: All triggers

**Dependencies**: `version`, `lint`, `test`

**Steps**:
1. Checkout code
2. Setup Node.js
3. Install production dependencies only
4. Verify build artifacts

**Duration**: ~45 seconds

**What It Verifies**:
- Production dependencies install correctly
- No missing modules
- Application structure is valid

---

### 5. Validate Docker Description

**Purpose**: Ensure Docker Hub short description meets length requirements

**Runs on**: All triggers

**Dependencies**: `version`

**Steps**:
1. Checkout code
2. Run validation script
3. Check character count ≤ 100

**Duration**: ~5 seconds

**Files Checked**:
- `docker/description/short.md`: Must be ≤ 100 characters
- Docker Hub enforces this limit strictly

**Current Status**: ✅ 97/100 characters (3 remaining)

---

### 6. Docker Test Build

**Purpose**: Test Docker build process without publishing

**Runs on**: All triggers

**Dependencies**: `version`, `build`, `validate-short-description`

**Steps**:
1. Checkout code
2. Setup Docker Buildx
3. Build Docker image locally
4. Test container startup
5. Verify health check

**Duration**: ~3-5 minutes

**What It Tests**:
- Dockerfile syntax and build process
- Multi-stage build completion
- Container starts successfully
- Health check endpoint responds
- Application logs show correct version

**Why This Matters**:
- Catches Docker build errors before publishing
- Validates VERSION build argument
- Ensures container runs properly
- Prevents broken images from being published

---

### 7. Docker Publish

**Purpose**: Build and publish Docker images to registries

**Runs on**: Push to `main` or `develop` branches, or tags

**Dependencies**: `version`, `docker-test`

**Condition**: Only if `skip_docker_publish != true`

**Steps**:
1. Checkout code
2. Setup QEMU for multi-architecture builds
3. Setup Docker Buildx
4. Login to Docker Hub
5. Login to GitHub Container Registry
6. Generate Docker tags
7. Build and push multi-platform images
8. Update Docker Hub description (main branch only)

**Duration**: ~10-15 minutes (multi-platform builds)

**Platforms Built**:
- `main` and `v*` tags → **`linux/amd64` + `linux/arm64`** (multi-arch release builds)
- `development` and other pushes → **`linux/amd64` only**

> arm64 is built via QEMU emulation and is slow, so it is reserved for release
> builds on `main`/tags. `development` pushes build amd64 only to keep the
> pipeline fast. The published `main`/tag images remain multi-arch.

**Tags Generated**:

| Branch/Tag | Docker Hub Tags | GHCR Tags |
|------------|----------------|-----------|
| `main` with tag | `latest`, `1.0.0`, `main` | `latest`, `1.0.0`, `main` |
| `main` without tag | `1.0.0-main-abc1234`, `main` | `1.0.0-main-abc1234`, `main` |
| `develop` | `1.0.0-dev-abc1234`, `develop` | `1.0.0-dev-abc1234`, `develop` |

**Published Registries**:
- **Docker Hub**: `<username>/actual-sync:<tag>`
- **GitHub Container Registry**: `ghcr.io/<owner>/actual-sync:<tag>`

---

### 8. Security Scan

**Purpose**: Scan Docker images for vulnerabilities

**Runs on**: All triggers (after Docker test build)

**Dependencies**: `version`, `docker-test`

**Steps**:
1. Checkout code
2. Build image for scanning
3. Run Trivy vulnerability scanner
4. Generate SARIF report
5. Upload to GitHub Security tab
6. Display summary table

**Duration**: ~2-3 minutes

**Scanner**: [Trivy](https://github.com/aquasecurity/trivy) by Aqua Security

**Severity Levels Scanned**:
- CRITICAL
- HIGH
- MEDIUM

**Reports Generated**:
- SARIF format for GitHub Security
- Table format for workflow summary
- Detailed JSON for archival

**Where to View Results**:
1. GitHub Security tab → Code scanning
2. Workflow summary page
3. Pull request checks

**Action on Vulnerabilities**:
- Pipeline continues (warnings only)
- Critical/High vulnerabilities logged
- Manual review recommended
- Automatic fixes suggested when available

---

### Release (separate workflow)

Releases are **not** a job in this pipeline. They are handled by the dedicated
**Auto Release** workflow (`.github/workflows/auto-release.yml`), which runs
*after* this CI/CD Pipeline finishes successfully on `main`.

Why separate: keying a release off an unbumped `package.json` version meant the
duplicate-tag guard skipped every release, so dependency updates never produced a
new release (issue #86). The Auto Release workflow instead **patch-bumps** the
version on each successful `main` run and creates the release.

**Trigger**: `workflow_run` — when "CI/CD Pipeline" completes on `main`.

**Guard**: only runs if `workflow_run.conclusion == 'success'`; skips its own bump
commit (message prefix `chore(release): bump version`) to avoid a release loop.

**Steps**:
1. Generate a GitHub App token (`APP_ID` / `APP_PRIVATE_KEY` secrets).
2. Check out the exact validated commit (`workflow_run.head_sha`).
3. `npm run version:bump -- patch` (updates `VERSION`, `package.json`, `package-lock.json`).
4. Commit, tag `vX.Y.Z`, push commit + tag to `main`.
5. Create the GitHub Release with auto-generated notes.

> The App token is required (not `GITHUB_TOKEN`) so the new `v*` tag triggers this
> pipeline's tag-based `docker-publish`, producing a version-tagged image.

See [VERSIONING.md](VERSIONING.md#automated-releases) for the full flow.

---

### 10. Deployment Test

**Purpose**: Verify published Docker images work correctly

**Runs on**: After Docker publish

**Dependencies**: `version`, `docker-publish`

**Steps**:
1. Pull image from Docker Hub
2. Test Docker Hub image
3. Pull image from GHCR
4. Test GHCR image
5. Verify version environment variable

**Duration**: ~1-2 minutes

**What It Tests**:
- Images are publicly accessible
- Images can be pulled without errors
- Containers start successfully
- Node.js version is correct
- VERSION environment variable is set

**Why This Matters**:
- Confirms images are usable by end users
- Validates registry permissions
- Ensures multi-platform builds work
- Catches publishing errors immediately

---

## Setup Instructions

### Prerequisites

1. **GitHub Repository**: Your code must be in a GitHub repository
2. **Docker Hub Account**: Create at https://hub.docker.com
3. **Node.js Project**: With `package.json` and tests

### Required Repository Secrets

Configure these secrets in GitHub repository settings:

1. Navigate to: `Settings` → `Secrets and variables` → `Actions` → `New repository secret`

2. Add the following secrets:

| Secret Name | Description | Where to Get It |
|-------------|-------------|-----------------|
| `DOCKER_USERNAME` | Docker Hub username | Your Docker Hub account |
| `DOCKER_TOKEN` | Docker Hub access token | Docker Hub → Account Settings → Security → New Access Token |

**Note**: `GITHUB_TOKEN` is automatically provided by GitHub Actions.

### Docker Hub Access Token Creation

1. Login to [Docker Hub](https://hub.docker.com)
2. Click your profile → **Account Settings**
3. Navigate to **Security** tab
4. Click **New Access Token**
5. Name it: `GitHub Actions CI/CD`
6. Permissions: **Read, Write, Delete**
7. Click **Generate**
8. Copy the token (you won't see it again!)
9. Add it to GitHub secrets as `DOCKER_TOKEN`

### GitHub Container Registry Setup

GHCR is automatically configured and uses `GITHUB_TOKEN`. No additional setup required.

**Package Visibility**:
- Go to: `https://github.com/users/<username>/packages/container/actual-sync/settings`
- Set visibility to **Public** (optional, for public access)

### First-Time Setup Steps

1. **Clone repository**:
   ```bash
   git clone https://github.com/<username>/actual-sync.git
   cd actual-sync
   ```

2. **Verify get_version.sh works**:
   ```bash
   chmod +x get_version.sh
   ./get_version.sh --verbose
   ```

3. **Add Docker Hub secrets to GitHub**:
   - Settings → Secrets → Actions → New repository secret
   - Add `DOCKER_USERNAME`
   - Add `DOCKER_TOKEN`

4. **Test workflow locally** (optional):
   ```bash
   # Install act (GitHub Actions local runner)
   brew install act  # macOS
   # or
   curl https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash  # Linux
   
   # Run workflow locally
   act push --secret DOCKER_USERNAME=<your-username> --secret DOCKER_TOKEN=<your-token>
   ```

5. **Push to trigger pipeline**:
   ```bash
   git add .
   git commit -m "Add CI/CD pipeline"
   git push origin develop
   ```

6. **Monitor workflow**:
   - Go to: `Actions` tab in GitHub
   - Click on the running workflow
   - Watch jobs execute in real-time

### Updating Docker Hub Description

The pipeline automatically updates Docker Hub descriptions on `main` branch:

- **Short description**: `docker/description/short.md` (≤ 100 characters)
- **Long description**: `docker/description/long.md` (markdown supported)

**To update descriptions**:
1. Edit files in `docker/description/`
2. Run validation: `./docker/validate-docker-desc.sh`
3. Commit and push to `main`
4. Pipeline will update Docker Hub automatically

---

## Manual Triggers

The workflow can be manually triggered with custom options.

### How to Manually Trigger

1. Go to: `Actions` tab in GitHub
2. Select: **CI/CD Pipeline** workflow
3. Click: **Run workflow** dropdown
4. Select branch
5. Configure options
6. Click: **Run workflow** button

### Manual Trigger Options

#### 1. Skip Tests (`skip_tests`)

**Default**: `false`

**Options**: `true` or `false`

**Use Case**: Emergency deployments when tests are known to pass

**Example**:
```yaml
skip_tests: true
```

**Warning**: ⚠️ Use cautiously - skipping tests can introduce bugs

---

#### 2. Skip Docker Publish (`skip_docker_publish`)

**Default**: `false`

**Options**: `true` or `false`

**Use Case**: Testing CI pipeline without publishing images

**Example**:
```yaml
skip_docker_publish: true
```

**What Still Runs**:
- Version generation
- Linting
- Testing
- Building
- Docker test build
- Security scanning

**What's Skipped**:
- Docker Hub publishing
- GHCR publishing
- Deployment tests
- Release creation

---

#### 3. Docker Tag Suffix (`docker_tag_suffix`)

**Default**: (empty)

**Format**: String (alphanumeric and hyphens)

**Use Case**: Create custom-tagged images for specific testing

**Example**:
```yaml
docker_tag_suffix: "hotfix-123"
```

**Result**:
```
<username>/actual-sync:1.0.0-dev-abc1234-hotfix-123
ghcr.io/<owner>/actual-sync:1.0.0-dev-abc1234-hotfix-123
```

**Use Cases**:
- Hotfix deployments
- A/B testing
- Customer-specific builds
- Feature testing

---

### Manual Trigger Examples

#### Example 1: Quick Test Run

**Scenario**: Test changes without publishing

**Configuration**:
```yaml
Branch: develop
skip_tests: false
skip_docker_publish: true
docker_tag_suffix: (empty)
```

**Result**: Full testing, no publishing

---

#### Example 2: Emergency Hotfix

**Scenario**: Critical bug fix that needs immediate deployment

**Configuration**:
```yaml
Branch: main
skip_tests: true  # Tests already passed locally
skip_docker_publish: false
docker_tag_suffix: "hotfix-critical-auth"
```

**Result**: Fast deployment with custom tag

**Warning**: ⚠️ Use only in true emergencies

---

#### Example 3: Feature Branch Testing

**Scenario**: Test feature branch with custom tag

**Configuration**:
```yaml
Branch: feature/new-auth
skip_tests: false
skip_docker_publish: false
docker_tag_suffix: "test-staging"
```

**Result**: Full pipeline with additional custom tag

---

## Docker Publishing

### Registries

The pipeline publishes to two registries simultaneously:

#### 1. Docker Hub

**Registry**: `docker.io`

**Image Names**:
```
<DOCKER_USERNAME>/actual-sync:<tag>
```

**Examples**:
```bash
docker pull myusername/actual-sync:latest
docker pull myusername/actual-sync:1.0.0
docker pull myusername/actual-sync:develop
```

**Visibility**: Public (configurable in Docker Hub)

**Limits**: 
- Free tier: 200 pulls per 6 hours (anonymous)
- Authenticated: Higher limits

---

#### 2. GitHub Container Registry (GHCR)

**Registry**: `ghcr.io`

**Image Names**:
```
ghcr.io/<GITHUB_OWNER>/actual-sync:<tag>
```

**Examples**:
```bash
docker pull ghcr.io/myusername/actual-sync:latest
docker pull ghcr.io/myorganization/actual-sync:1.0.0
```

**Visibility**: Configurable (public or private)

**Authentication** (for private packages):
```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin
```

**Limits**: Much higher than Docker Hub free tier

---

### Tag Strategy

#### Branch-Based Tags

| Branch | Tags Generated | Purpose |
|--------|---------------|---------|
| `main` | `latest`, `main`, `<version>` | Production releases |
| `develop` | `develop`, `<version>-dev-<hash>` | Development builds |
| `feature/*` | `<version>-feature-<name>-<hash>` | Feature testing |

#### Version Tags

Format: `<base>-<context>-<commit>`

**Examples**:
```
1.0.0                     # Tagged release on main
1.0.0-main-abc1234        # Untagged commit on main
1.0.0-dev-def5678         # Develop branch
1.0.0-feature-auth-ghi901 # Feature branch
```

---

### Multi-Platform Builds

The pipeline builds images for multiple architectures:

**Platforms**:
- `linux/amd64` - Intel/AMD 64-bit (x86_64)
- `linux/arm64` - ARM 64-bit (Apple Silicon, Raspberry Pi 4+)

**Docker automatically selects the correct platform**:
```bash
# On x86_64 machine
docker pull myusername/actual-sync:latest  # Pulls amd64

# On ARM64 machine (Apple M1/M2)
docker pull myusername/actual-sync:latest  # Pulls arm64
```

**Build Time**:
- Single platform: ~5 minutes
- Multi-platform: ~10-15 minutes

---

### Using Published Images

#### Pull Latest Version

```bash
# Docker Hub
docker pull myusername/actual-sync:latest

# GHCR
docker pull ghcr.io/myusername/actual-sync:latest
```

#### Pull Specific Version

```bash
docker pull myusername/actual-sync:1.0.0
```

#### Run Container

```bash
docker run -d \
  --name actual-sync \
  -p 3000:3000 \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/data:/app/data \
  myusername/actual-sync:latest
```

#### Docker Compose

```yaml
version: '3.8'

services:
  actual-sync:
    image: myusername/actual-sync:latest
    # or: ghcr.io/myusername/actual-sync:latest
    container_name: actual-sync
    ports:
      - "3000:3000"
    volumes:
      - ./config:/app/config
      - ./data:/app/data
    restart: unless-stopped
```

---

## Security Scanning

### Overview

Every build is automatically scanned for vulnerabilities using [Trivy](https://github.com/aquasecurity/trivy) by Aqua Security.

### What Trivy Scans

1. **OS Packages**: Alpine Linux packages
2. **Application Dependencies**: Node.js packages (package.json)
3. **Filesystem**: Configuration files, scripts
4. **Secrets**: Hardcoded credentials (basic detection)

### Severity Levels

| Severity | Description | Action |
|----------|-------------|--------|
| CRITICAL | Actively exploited vulnerabilities | Fix immediately |
| HIGH | Serious vulnerabilities with known exploits | Fix in next release |
| MEDIUM | Moderate risk vulnerabilities | Fix when convenient |
| LOW | Minor issues with low impact | Optional fix |
| UNKNOWN | Unclassified | Review manually |

### SARIF Upload

Results are uploaded to GitHub Security in [SARIF format](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) (Static Analysis Results Interchange Format).

**Where to View**:
1. Repository → **Security** tab
2. Click **Code scanning**
3. Filter by **Trivy**

**Benefits**:
- Centralized vulnerability tracking
- Integration with GitHub Advanced Security
- Automated alerts for new vulnerabilities
- Historical tracking

### Scan Frequency

- **Every push**: Main and develop branches
- **Every PR**: Pull request builds
- **Manual runs**: Workflow dispatch
- **Scheduled**: Can add cron schedule (optional)

### Handling Vulnerabilities

#### Critical/High Vulnerabilities

1. **Immediate Review**: Check Security tab
2. **Assess Impact**: Determine if it affects your use case
3. **Update Dependencies**: Run `npm update` or `npm audit fix`
4. **Rebuild**: Push updated `package.json` and `package-lock.json`
5. **Verify**: New scan should show vulnerability resolved

#### Medium/Low Vulnerabilities

1. **Track**: Add to backlog
2. **Monitor**: Watch for updates
3. **Plan**: Include in next maintenance release

### Example Scan Results

```
┌───────────────┬─────────────────┬──────────┬────────────────┬───────────────┬───────────────┐
│    Library    │  Vulnerability  │ Severity │ Installed Ver. │  Fixed Ver.   │     Title     │
├───────────────┼─────────────────┼──────────┼────────────────┼───────────────┼───────────────┤
│ express       │ CVE-2024-12345  │ HIGH     │ 4.17.1         │ 4.18.2        │ XSS in query  │
│ sqlite3       │ CVE-2024-67890  │ MEDIUM   │ 5.0.0          │ 5.1.0         │ DoS issue     │
└───────────────┴─────────────────┴──────────┴────────────────┴───────────────┴───────────────┘
```

### Suppressing False Positives

Create `.trivyignore` file in repository root:

```
# False positive: Not used in our code
CVE-2024-12345

# Accepted risk: No fix available yet
CVE-2024-67890
```

### Custom Scan Configuration

Modify workflow to customize scanning:

```yaml
- name: Run Trivy vulnerability scanner
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: ${{ env.DOCKER_IMAGE_NAME }}:scan
    format: 'sarif'
    output: 'trivy-results.sarif'
    severity: 'CRITICAL,HIGH,MEDIUM,LOW'  # Add LOW
    ignore-unfixed: true  # Ignore vulnerabilities with no fix
```

---

## Troubleshooting

### Common Issues

#### Issue 1: Workflow Not Triggering

**Symptoms**: Push to branch doesn't start workflow

**Possible Causes**:
1. Workflow file has syntax errors
2. Branch name doesn't match triggers
3. `.github/workflows/` directory in wrong location

**Solutions**:
```bash
# Validate workflow syntax
cat .github/workflows/ci-cd.yml | grep -v "^#" | grep -v "^$"

# Check branch name
git branch --show-current

# Verify file location
ls -la .github/workflows/

# Push to correct branch
git push origin main
```

---

#### Issue 2: Docker Login Fails

**Symptoms**: Error: `Error: Cannot perform an interactive login from a non TTY device`

**Cause**: Missing or incorrect Docker Hub credentials

**Solutions**:
1. Verify secrets exist:
   - Go to: Settings → Secrets → Actions
   - Check: `DOCKER_USERNAME` and `DOCKER_TOKEN` are present

2. Regenerate Docker Hub token:
   - Docker Hub → Account Settings → Security
   - Delete old token
   - Create new token
   - Update `DOCKER_TOKEN` secret in GitHub

3. Check token permissions:
   - Token must have: Read, Write, Delete
   - Read-only tokens will fail on push

---

#### Issue 3: Version Script Fails

**Symptoms**: Error: `get_version.sh: command not found` or permission denied

**Cause**: Script not executable or missing

**Solutions**:
```bash
# Make script executable
chmod +x get_version.sh

# Commit permission change
git add get_version.sh
git commit -m "Make version script executable"
git push

# Verify locally
./get_version.sh --verbose
```

---

#### Issue 4: Docker Build Fails

**Symptoms**: Error during Docker build step

**Common Errors**:

**Error: `failed to solve: process "/bin/sh -c npm ci" did not complete successfully`**

**Solution**:
```dockerfile
# In Dockerfile, ensure package.json is copied before npm ci
COPY package*.json ./
RUN npm ci
```

**Error: `VERSION: unset variable`**

**Solution**:
```dockerfile
# Add default value for VERSION
ARG VERSION=unknown
ENV VERSION=${VERSION}
```

**Error: `Health check failed`**

**Solution**:
```dockerfile
# Increase start-period in HEALTHCHECK
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ...
```

---

#### Issue 5: Tests Fail in CI But Pass Locally

**Symptoms**: Tests pass on local machine but fail in GitHub Actions

**Possible Causes**:
1. Different Node.js versions
2. Missing environment variables
3. Timezone differences
4. Filesystem path differences

**Solutions**:
```bash
# Test with same Node version as CI
nvm use 20
npm test

# Run tests in Docker (same as CI)
docker run --rm -v $(pwd):/app -w /app node:20-alpine npm test

# Check for hardcoded paths
grep -r "$(pwd)" src/

# Add debug logging
npm test -- --verbose
```

---

#### Issue 6: Security Scan Fails

**Symptoms**: Trivy scan step fails or reports many vulnerabilities

**Solutions**:

**For CRITICAL/HIGH vulnerabilities**:
```bash
# Update all dependencies
npm update

# Run audit and fix automatically
npm audit fix

# For breaking changes, upgrade manually
npm install <package>@latest

# Commit updated dependencies
git add package*.json
git commit -m "Update dependencies to fix vulnerabilities"
git push
```

**For false positives**:
```bash
# Create .trivyignore file
cat > .trivyignore << EOF
# False positive for our use case
CVE-2024-12345
EOF

git add .trivyignore
git commit -m "Suppress false positive CVE-2024-12345"
git push
```

---

#### Issue 7: Multi-Platform Build Timeout

**Symptoms**: Docker build takes too long or times out

**Cause**: Multi-platform builds (amd64 + arm64) are slow

**Solutions**:

**Option 1: Reduce platforms**:
```yaml
env:
  DOCKER_PLATFORMS: linux/amd64  # Only build for amd64
```

**Option 2: Use GitHub larger runners**:
```yaml
docker-publish:
  runs-on: ubuntu-latest-4-cores  # Requires GitHub Teams/Enterprise
```

**Option 3: Enable build caching**:
```yaml
- name: Build and push
  uses: docker/build-push-action@v5
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max  # Already enabled
```

---

#### Issue 8: GHCR Push Fails

**Symptoms**: Docker Hub push works but GHCR fails

**Cause**: Package visibility or permissions issue

**Solutions**:
1. Check package exists:
   - Go to: `https://github.com/<username>/actual-sync/pkgs/container/actual-sync`

2. Set visibility to public:
   - Package settings → Change visibility → Public

3. Grant workflow permissions:
   - Repository Settings → Actions → General
   - Workflow permissions → Read and write permissions

4. Verify token scopes:
   - `GITHUB_TOKEN` should have: `write:packages`

---

#### Issue 9: Release Not Created

**Symptoms**: Docker images published but no GitHub release

**Cause**: Release job only runs on tagged commits on main

**Requirements**:
1. Must be on `main` branch
2. Must have Git tag starting with `v`
3. Docker publish must succeed
4. Security scan must succeed

**Create release manually**:
```bash
# On main branch
git tag v1.0.0
git push origin v1.0.0

# Watch Actions tab for release job
```

---

#### Issue 10: Short Description Validation Fails

**Symptoms**: `validate-short-description` job fails

**Cause**: Docker Hub short description exceeds 100 characters

**Check character count**:
```bash
wc -c < docker/description/short.md
# Must output <= 100
```

**Fix description**:
```bash
# Edit file to be shorter
nano docker/description/short.md

# Validate
./docker/validate-docker-desc.sh

# Commit
git add docker/description/short.md
git commit -m "Shorten Docker Hub description"
git push
```

---

### Debugging Workflows

#### View Detailed Logs

1. Go to: Actions tab
2. Click on failed workflow
3. Click on failed job
4. Expand failed step
5. Review error messages

#### Re-run Failed Jobs

1. Go to: Actions → Failed workflow
2. Click: **Re-run jobs** dropdown
3. Select: **Re-run failed jobs** or **Re-run all jobs**

#### Enable Debug Logging

Add secrets to repository:
- `ACTIONS_STEP_DEBUG` = `true`
- `ACTIONS_RUNNER_DEBUG` = `true`

**Result**: Much more verbose logging in workflow runs

#### Download Artifacts

Some jobs upload artifacts (test results, coverage, etc.):

1. Go to: Actions → Workflow run
2. Scroll to: **Artifacts** section
3. Click: Download artifact

---

### Getting Help

#### Resources

1. **GitHub Actions Documentation**: https://docs.github.com/en/actions
2. **Trivy Documentation**: https://aquasecurity.github.io/trivy/
3. **Docker Build Documentation**: https://docs.docker.com/build/
4. **Node.js CI Best Practices**: https://nodejs.org/en/docs/guides/

#### Support Channels

1. **Repository Issues**: Create issue with workflow run link
2. **GitHub Community**: https://github.community/
3. **Stack Overflow**: Tag questions with `github-actions`, `docker`, `nodejs`

#### Reporting Workflow Bugs

When reporting issues, include:
1. Workflow run URL
2. Error messages
3. Repository structure (anonymized if needed)
4. Secrets configuration (names only, not values!)
5. Expected vs actual behavior

---

## Maintenance

### Regular Tasks

#### Weekly
- Review security scan results
- Update dependencies if vulnerabilities found
- Monitor Docker image sizes

#### Monthly
- Review workflow performance
- Update GitHub Actions versions
- Clean up old Docker images in registries

#### Quarterly
- Audit workflow efficiency
- Review and update documentation
- Test disaster recovery procedures

### Updating Workflow

To modify the CI/CD pipeline:

1. **Edit workflow file**:
   ```bash
   nano .github/workflows/ci-cd.yml
   ```

2. **Test changes locally** (with act):
   ```bash
   act push -j lint  # Test single job
   ```

3. **Push to feature branch**:
   ```bash
   git checkout -b feature/update-cicd
   git add .github/workflows/ci-cd.yml
   git commit -m "Update CI/CD workflow"
   git push origin feature/update-cicd
   ```

4. **Create pull request** and verify workflow runs

5. **Merge to main** after verification

### Monitoring

#### Workflow Success Rate

GitHub provides metrics:
- Go to: Insights → Actions
- View success/failure rates
- Track job duration trends

#### Docker Image Pulls

**Docker Hub**:
- Go to: Repositories → actual-sync → Insights
- View pull statistics

**GHCR**:
- Go to: Package settings → Insights
- View pull statistics

---

## Advanced Topics

### Workflow Optimization

#### Caching Strategy

The workflow uses multiple caching layers:

1. **npm cache** (via `actions/setup-node`):
   ```yaml
   - uses: actions/setup-node@v4
     with:
       cache: 'npm'  # Caches ~/.npm
   ```

2. **Docker build cache** (via GitHub Actions cache):
   ```yaml
   cache-from: type=gha
   cache-to: type=gha,mode=max
   ```

**Benefits**:
- Faster dependency installation (~30s → ~5s)
- Faster Docker builds (~5min → ~2min)
- Reduced bandwidth usage

#### Parallel Job Execution

Jobs run in parallel when possible:
```
lint, test, validate-description ← All run simultaneously
```

**Total time saved**: ~2-3 minutes per workflow run

### Custom Notifications

Add workflow notifications to Slack, Discord, or email.

#### Slack Example

Add to workflow:
```yaml
- name: Notify Slack on failure
  if: failure()
  uses: slackapi/slack-github-action@v1
  with:
    webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
    payload: |
      {
        "text": "CI/CD Pipeline failed for ${{ github.repository }}",
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": ":x: *Build Failed*\n*Repository:* ${{ github.repository }}\n*Branch:* ${{ github.ref_name }}\n*Version:* ${{ needs.version.outputs.version }}"
            }
          }
        ]
      }
```

---

## Best Practices

### Version Control

1. **Tag releases properly**:
   ```bash
   git tag -a v1.0.0 -m "Release version 1.0.0"
   git push origin v1.0.0
   ```

2. **Use semantic versioning**: `MAJOR.MINOR.PATCH`
   - MAJOR: Breaking changes
   - MINOR: New features (backward compatible)
   - PATCH: Bug fixes

3. **Keep version in package.json updated**

### Security

1. **Never commit secrets** to repository
2. **Rotate Docker Hub tokens** every 90 days
3. **Review security scans** weekly
4. **Update dependencies** monthly
5. **Use minimal Docker base images** (Alpine Linux)

### Performance

1. **Enable all caching** (npm, Docker layers)
2. **Run jobs in parallel** when possible
3. **Skip unnecessary steps** (use conditions)
4. **Use multi-stage Docker builds**
5. **Monitor workflow duration**

### Documentation

1. **Keep this document updated** with changes
2. **Document custom modifications** inline
3. **Add comments to complex workflow steps**
4. **Update README** with CI/CD badges

---

## CI/CD Badges

Add these badges to README.md:

```markdown
![CI/CD](https://github.com/<username>/actual-sync/actions/workflows/ci-cd.yml/badge.svg)
![Docker](https://img.shields.io/docker/v/<username>/actual-sync?label=docker)
![Security](https://img.shields.io/badge/security-scanned-green)
```

**Result**:

![CI/CD](https://github.com/username/actual-sync/actions/workflows/ci-cd.yml/badge.svg)
![Docker](https://img.shields.io/docker/v/username/actual-sync?label=docker)
![Security](https://img.shields.io/badge/security-scanned-green)

---

## Conclusion

This CI/CD pipeline provides:

✅ **Automated testing** on every push  
✅ **Dynamic versioning** based on Git context  
✅ **Multi-platform Docker builds** (amd64 + arm64)  
✅ **Dual registry publishing** (Docker Hub + GHCR)  
✅ **Security vulnerability scanning** with SARIF upload  
✅ **Automated releases** with changelogs  
✅ **Deployment verification** for published images  
✅ **Comprehensive monitoring** and summaries  

**Total pipeline time**: ~15-20 minutes for full run

**Next Steps**:
1. Complete setup instructions above
2. Push code to trigger first run
3. Monitor Actions tab
4. Review and adjust as needed

**Questions?** Open an issue in the repository!
