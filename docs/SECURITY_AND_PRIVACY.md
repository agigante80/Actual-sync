# Security and Privacy

## 🔒 Purpose

Define security policies, privacy protection measures, and safe handling practices for the Actual-sync project.

---

## 🎯 Security Objectives

1. **Protect Credentials**: Prevent exposure of passwords, API keys, and sync IDs
2. **Secure Communications**: Ensure all network traffic is encrypted
3. **Data Privacy**: Minimize data collection and protect sensitive financial information
4. **Access Control**: Limit access to sensitive operations and data
5. **Vulnerability Management**: Rapidly address security issues in dependencies

---

## 🔐 Credential Management

### Storage Requirements

**MUST**:
- ✅ Store credentials in environment variables (`.env` file)
- ✅ Add `.env` to `.gitignore` to prevent commits
- ✅ Use different credentials for development and production
- ✅ Rotate credentials periodically (recommended: quarterly)

**MUST NOT**:
- ❌ Hardcode credentials in source files
- ❌ Commit `.env` files to version control
- ❌ Share credentials in public channels (Slack, email, etc.)
- ❌ Use same password across multiple Actual servers

### Environment Variable Security

**Current Implementation**:
```javascript
const password = process.env.SERVICE_PASSWORD || 'hunter2';
```

**Security Concerns**:
- Default password is visible in code (should only be used for local dev)
- No validation that production password is strong
- No warning when defaults are used

**Recommended Enhancement**:
```javascript
const password = process.env.SERVICE_PASSWORD;
if (!password) {
    console.error('ERROR: SERVICE_PASSWORD not set. Exiting for security.');
    process.exit(1);
}
```

### Password Requirements

**Recommendations**:
- **Minimum Length**: 16 characters
- **Complexity**: Mix of uppercase, lowercase, numbers, symbols
- **Uniqueness**: Don't reuse passwords across servers
- **Storage**: Use password manager for tracking

**Note**: Since Actual Budget is self-hosted, users control their own password policies. Above are recommendations, not enforcements.

---

## 🌐 Network Security

### Transport Encryption

**Policy**: All external communication MUST use HTTPS/TLS

**Current Implementation**:
- Actual Budget API: HTTPS (when properly configured by user)
- GoCardless/Nordigen API: HTTPS (enforced by provider)

**Validation**:
Ensure server URLs use `https://` in production:
```javascript
if (url.startsWith('http://') && !url.includes('localhost')) {
    console.warn('Warning: Using unencrypted HTTP connection');
}
```

### Certificate Validation

**Policy**: SSL/TLS certificates MUST be validated

**Implementation**:
Node.js validates certificates by default. Never disable validation:

**Bad Practice (Don't Do This)**:
```javascript
// NEVER DO THIS:
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
```

### Rate Limiting

**Policy**: HTTP endpoints MUST have rate limiting to prevent abuse

**Current Implementation**:
- Health check endpoint: 60 requests/minute per IP
- Implemented using `express-rate-limit` middleware

```javascript
const limiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 60,                    // 60 requests per minute
  standardHeaders: true,
  message: 'Too many requests, please try again later.'
});
```

**Note**: Telegram bot API calls currently have no rate limiting (see Improvement Areas).

### Firewall Configuration

**Recommendations**:
- Restrict outbound connections to known Actual servers
- Allow outbound HTTPS to GoCardless API domains
- Block all inbound connections (service doesn't need to accept connections)

---

## 🔍 Data Privacy

### Financial Data Handling

**Principle**: Minimize exposure of sensitive financial information

**Current Data Flows**:
1. **Actual Budget Server → Sync Service**: Budget file with transactions
2. **GoCardless API → Actual Budget Server**: Bank transaction data
3. **Sync Service → Logs**: Account IDs and sync status (no balances/amounts)

**Privacy Controls**:
- ✅ Sync service doesn't log transaction amounts
- ✅ Sync service doesn't log account balances
- ✅ Sync service doesn't log account numbers
- ✅ Data cached locally in isolated directories per server
- ⚠️ Account names may appear in logs (consider if PII concern)

### Logging Best Practices

**DO Log**:
- Account IDs (UUIDs, not sensitive)
- Sync success/failure status
- Error types and retry attempts
- Timestamp and duration

**DON'T Log**:
- Transaction amounts
- Account balances
- Account numbers
- Payee names (if present)
- Transaction descriptions

**Example (Good)**:
```javascript
console.log(`Successfully synced account ${account.id}`);
```

**Example (Bad)**:
```javascript
console.log(`Account ${account.name}: Balance is $${account.balance}`);
```

### Data Retention

**Current Implementation**:
- No persistent storage of sync history
- Data directories contain cached budget files
- Logs retained based on system/container log rotation

**Recommendations**:
- Clear old cache files periodically (>30 days)
- Rotate logs regularly (daily/weekly)
- Don't store logs in persistent cloud storage without encryption

---

## 🛡️ Access Control

### File System Permissions

**Data Directories**:
- Should be readable/writable only by service user
- Recommended permissions: `700` (owner only)
- Should not be in shared/public directories

**Configuration Files**:
- `.env` should be `600` (owner read/write only)
- Source files can be `644` (world-readable)

**Setup Script**:
```bash
chmod 600 .env
chmod 700 /app/dataDir_*
```

### Service Account

**Recommendations**:
- Run service as dedicated user (not root)
- Use least-privilege principle
- Limit access to only required resources

**Docker Example**:
```dockerfile
USER node
```

---

## 🐛 Vulnerability Management

### Dependency Scanning

**Policy**: Check for vulnerabilities monthly at minimum

**Implementation**:
```bash
npm audit
```

**Response Protocol**:
1. **Critical/High**: Patch within 7 days
2. **Medium**: Patch within 30 days
3. **Low**: Patch in next regular update cycle

### Security Updates

**Automated Tools**:
- Dependabot (GitHub)
- Renovate Bot
- Snyk

**Manual Process**:
1. Review `npm audit` output
2. Update vulnerable packages: `npm update`
3. Test thoroughly after updates
4. Document in changelog

---

## 🚨 Incident Response

### Security Incident Definition

A security incident includes:
- Credential exposure (committed to git, leaked in logs)
- Unauthorized access to Actual Budget servers
- Dependency vulnerability exploitation
- Data breach or exposure

### Response Procedure

**Immediate Actions** (within 1 hour):
1. **Contain**: Stop affected service instances
2. **Assess**: Determine scope and impact
3. **Notify**: Alert stakeholders (if applicable)
4. **Document**: Record timeline and actions

**Short-term Actions** (within 24 hours):
1. **Rotate Credentials**: Change all potentially compromised passwords
2. **Patch**: Apply security fixes if vulnerability involved
3. **Verify**: Confirm incident is contained
4. **Communicate**: Update stakeholders on status

**Long-term Actions** (within 1 week):
1. **Root Cause Analysis**: Determine how incident occurred
2. **Prevention**: Implement measures to prevent recurrence
3. **Documentation**: Update security policies and procedures
4. **Review**: Conduct post-incident review

### Credential Exposure Response

**If credentials are committed to git**:
1. Immediately rotate all exposed credentials
2. Use `git filter-branch` or BFG Repo-Cleaner to remove from history
3. Force-push cleaned history
4. Notify anyone who may have cloned the repository
5. Review access logs for unauthorized access

**If credentials appear in logs**:
1. Rotate affected credentials
2. Purge logs containing credentials
3. Fix logging code to prevent recurrence
4. Review log aggregation systems for exposure

---

## 🤖 AI Safety Constraints

### AI Agent Security Rules

When AI agents interact with this codebase (see AI_INTERACTION_GUIDE.md):

**MUST**:
- Validate that `.env` is in `.gitignore`
- Warn if credentials appear in source files
- Check for common security anti-patterns
- Run `npm audit` before dependency changes

**MUST NOT**:
- Disable certificate validation
- Commit `.env` files
- Hardcode credentials
- Disable security features for convenience

### Code Review Triggers

AI agents must request human review for:
- Changes to authentication logic
- Modifications to credential handling
- Network security configuration changes
- Changes affecting rate limiting (DoS risk)

---

## 🔒 Compliance Considerations

### GDPR (EU Users)

**Relevant Provisions**:
- **Data Minimization**: Only collect necessary data
- **Purpose Limitation**: Use data only for sync purposes
- **Storage Limitation**: Don't retain data longer than needed

**Current Compliance**:
- ✅ No unnecessary data collection
- ✅ Data used only for intended sync purpose
- ⚠️ No automatic data cleanup (user responsible)

**User Rights**:
Users control their own Actual Budget data. This sync service doesn't create new data storage obligations.

### PCI-DSS (If Handling Card Data)

**Important**: This sync service should **never** handle raw payment card data.

GoCardless/Nordigen provides bank transaction data (already processed), not raw card numbers. Service is **not in scope** for PCI-DSS as it doesn't process, store, or transmit cardholder data.

---

## 🛠️ Security Testing

### Pre-Deployment Security Checks

Before deploying to production:
- [ ] Run `npm audit` and resolve issues
- [ ] Verify `.env` not committed to git
- [ ] Check no credentials in source files
- [ ] Validate HTTPS used for all external connections
- [ ] Confirm data directories have correct permissions
- [ ] Review logs for sensitive data exposure

### Ongoing Security Practices

**Monthly**:
- Run dependency vulnerability scan
- Review access logs (if available)
- Check for updates to Actual Budget API

**Quarterly**:
- Rotate credentials
- Review and update security policies
- Audit code for security improvements

**Annually**:
- Comprehensive security review
- Penetration testing (if applicable)
- Update threat model

---

## 📋 Security Checklist

### Development Environment

- [ ] `.env` file in `.gitignore`
- [ ] No credentials in source files
- [ ] Using strong, unique passwords
- [ ] Dependencies up to date
- [ ] `npm audit` shows no critical issues

### Production Environment

- [ ] Service running as non-root user
- [ ] Data directories have restrictive permissions (700)
- [ ] `.env` file has restrictive permissions (600)
- [ ] HTTPS used for all Actual server connections
- [ ] Logs don't contain sensitive data
- [ ] Regular backups of `.env` (stored securely)

### Ongoing Operations

- [ ] Monthly dependency vulnerability scans
- [ ] Quarterly credential rotation
- [ ] Log review for suspicious activity
- [ ] Monitoring for failed authentication attempts
- [ ] Incident response plan documented and accessible

---

## 🔍 Security Audit Findings

**Last Audit**: December 7, 2025  
**Overall Security Score**: 86/100 (🟢 GOOD)  
**Risk Level**: 🟡 LOW-MEDIUM

### Summary

- **Critical Vulnerabilities**: 0
- **High Severity**: 0
- **Medium Severity**: 2
- **Low Severity**: 5
- **Informational**: 3

### Positive Security Findings ✅

1. **No Hardcoded Credentials**: All secrets properly externalized
2. **Zero Dependency Vulnerabilities**: npm audit clean (0 CVEs)
3. **SQL Injection Protection**: Parameterized queries throughout
4. **Container Security**: Non-root user, multi-stage build, health checks
5. **Authentication & Authorization**: Chat ID verification implemented
6. **Rate Limiting**: HTTP endpoints protected (60 req/min)
7. **Comprehensive Documentation**: 437 lines of security documentation
8. **Input Validation**: Schema-based config validation
9. **No Dangerous Code Patterns**: No eval(), exec(), innerHTML usage
10. **Proper Error Handling**: Errors logged without exposing sensitive data

### Current Vulnerabilities

**Medium Severity**:
- **M-1**: Missing security headers (CVSS 5.3) - HTTP endpoints lack security headers
- **M-2**: Outdated dependencies (CVSS 4.3) - 3 packages have available updates

**Low Severity**:
- **L-1**: No automated secret scanning (CVSS 3.1)
- **L-2**: Missing HTTPS enforcement warnings (CVSS 3.7)
- **L-3**: No input sanitization for Telegram bot (CVSS 3.1)
- **L-4**: SQLite file permissions not enforced (CVSS 3.3)
- **L-5**: No rate limiting on Telegram API (CVSS 2.7)

**Informational**:
- **I-1**: Bot tokens logged in debug mode
- **I-2**: No security.txt/SECURITY.md file
- **I-3**: No Content Security Policy headers

### Remediation Plan

See `SECURITY_REMEDIATION_PLAN.md` for detailed implementation steps.

**Immediate Actions** (3 hours):
- Add security headers with helmet package (1h)
- Update dependencies to latest versions (2h)

**Short-Term Actions** (5 hours):
- Setup automated secret scanning with gitleaks (1h)
- Add input sanitization for Telegram bot (1h)
- Enforce SQLite file permissions (30m)
- Add HTTPS enforcement warnings (30m)

**Medium-Term Actions** (9 hours):
- Implement Telegram API rate limiting (2h)
- Create SECURITY.md file (15m)
- Add ESLint security plugin (1h)
- Build CI/CD security pipeline (2h)

### Compliance Assessment

**OWASP Top 10 (2021)**: 90% Compliant (9/10)
- ✅ A01: Broken Access Control - COMPLIANT
- ✅ A02: Cryptographic Failures - COMPLIANT
- ✅ A03: Injection - COMPLIANT
- ✅ A04: Insecure Design - COMPLIANT
- ⚠️ A05: Security Misconfiguration - PARTIAL (missing headers)
- ✅ A06: Vulnerable Components - COMPLIANT
- ✅ A07: Authentication Failures - COMPLIANT
- ✅ A08: Data Integrity Failures - COMPLIANT
- ✅ A09: Security Logging Failures - COMPLIANT
- ✅ A10: SSRF - COMPLIANT

**CIS Docker Benchmark**: Partial Compliance
- ✅ Non-root user implementation
- ✅ Multi-stage builds
- ✅ Health checks configured
- ⚠️ File permissions not explicitly enforced
- ⚠️ Resource limits not configured

### Security Testing Procedures

**Manual Security Checks**:
```bash
# 1. Dependency vulnerability scan
npm audit

# 2. Check for outdated packages
npm outdated

# 3. Secret scanning (requires gitleaks)
gitleaks detect --source . --verbose

# 4. Security linting (requires ESLint security plugin)
npm run lint:security

# 5. Container security scan (requires Docker)
docker scout cves actual-sync:latest
```

**Automated Security Scanning** (Planned):
- Pre-commit hooks with gitleaks
- GitHub Actions security workflow
- Dependabot for dependency updates
- ESLint security rules in CI/CD
- Container scanning with Trivy

### Tool Integration

**Recommended Security Tools**:

1. **gitleaks** - Secret scanning
   ```bash
   brew install gitleaks
   gitleaks detect --source . --verbose
   ```

2. **npm audit** - Dependency scanning (built-in)
   ```bash
   npm audit --audit-level=high
   ```

3. **ESLint Security Plugin** - Code pattern analysis
   ```bash
   npm install --save-dev eslint-plugin-security
   ```

4. **Snyk** - Comprehensive vulnerability scanning
   ```bash
   npm install -g snyk
   snyk test
   ```

5. **Trivy** - Container vulnerability scanning
   ```bash
   trivy image actual-sync:latest
   ```

---

## 🔍 Automated Security Scanning

### CI/CD Security Pipeline

Actual-sync includes automated security scanning in the CI/CD pipeline via GitHub Actions.

**Workflow File**: `.github/workflows/ci-cd.yml`

### Security Scanning Jobs

#### 1. Dependency Auditing

**Tool**: `npm audit`

**Runs**: Every push, pull request, and manual trigger

**Location**: Test job in CI/CD workflow

**What It Checks**:
- Known vulnerabilities in npm packages
- Dependency tree for security issues
- Severity levels: CRITICAL, HIGH, MEDIUM, LOW

**Action on Findings**:
- Pipeline continues (warnings only)
- Results logged in workflow summary
- Manual review recommended for HIGH/CRITICAL

**Example**:
```bash
# In CI/CD pipeline:
npm audit --audit-level=high
```

#### 2. Container Vulnerability Scanning

**Tool**: [Trivy](https://github.com/aquasecurity/trivy) by Aqua Security

**Runs**: After Docker test build completes

**Location**: `security-scan` job in CI/CD workflow

**What It Scans**:
- Alpine Linux OS packages
- Node.js application dependencies
- Filesystem for misconfigurations
- Hardcoded secrets (basic detection)

**Scan Coverage**:
```
┌─────────────────────┐
│  Docker Image Scan  │
│                     │
│  ├─ OS Packages     │  ← Alpine Linux CVEs
│  ├─ npm Packages    │  ← Node.js vulnerabilities
│  ├─ Filesystem      │  ← Config issues
│  └─ Secrets         │  ← Hardcoded credentials
└─────────────────────┘
```

**Severity Filters**:
- **CRITICAL**: Actively exploited, fix immediately
- **HIGH**: Serious vulnerabilities with known exploits
- **MEDIUM**: Moderate risk issues

**Report Formats**:
1. **SARIF** - Uploaded to GitHub Security tab
2. **Table** - Displayed in workflow summary
3. **JSON** - Archived for historical tracking

#### 3. SARIF Integration

**What is SARIF?**: Static Analysis Results Interchange Format

**Benefits**:
- Centralized security findings in GitHub Security tab
- Integration with GitHub Advanced Security
- Automated alerts for new vulnerabilities
- Historical vulnerability tracking
- Pull request annotations

**Where to View**:
1. Repository → **Security** tab
2. Click **Code scanning** alerts
3. Filter by tool: **Trivy**

**Alert Example**:
```
┌────────────────────────────────────────────┐
│ High Severity - CVE-2024-12345             │
│ Package: express@4.17.1                    │
│ Fixed in: express@4.18.2                   │
│ CVSS Score: 7.5                            │
│ Description: XSS vulnerability in query... │
└────────────────────────────────────────────┘
```

#### 4. Security Scanning Workflow

```
┌──────────────────┐
│  Docker Build    │
│  Completed       │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Build Image     │
│  for Scanning    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Run Trivy       │
│  Scan (SARIF)    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Upload SARIF    │
│  to GitHub       │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Run Trivy       │
│  Scan (Table)    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Display Summary │
│  in Workflow     │
└──────────────────┘
```

**Duration**: ~2-3 minutes per scan

### Scan Frequency

| Event | Frequency | Purpose |
|-------|-----------|---------|
| **Push to main** | Every push | Production security validation |
| **Push to develop** | Every push | Development build verification |
| **Pull Requests** | Every PR | Pre-merge security check |
| **Manual Trigger** | On-demand | Ad-hoc security validation |
| **Scheduled** | (Optional) | Continuous monitoring |

**Note**: Scheduled scans can be added via workflow cron trigger for continuous vulnerability monitoring.

### Handling Scan Results

#### Critical/High Severity Vulnerabilities

**Immediate Actions**:
1. Review finding in GitHub Security tab
2. Click vulnerability for detailed information
3. Check if exploit affects your use case
4. Review suggested fixes from Trivy

**Remediation Steps**:
```bash
# Update affected package
npm update <package>

# Or specific version
npm install <package>@<fixed-version>

# Run audit to verify fix
npm audit

# Test locally
npm test

# Commit and push
git add package*.json
git commit -m "fix: update <package> to resolve CVE-XXXX-XXXXX"
git push
```

**Verification**:
- New CI/CD run will re-scan
- Check GitHub Security tab for resolution
- Alert should auto-close if fixed

#### Medium/Low Severity Vulnerabilities

**Actions**:
1. Track in issue tracker
2. Prioritize in backlog
3. Include in next maintenance release
4. Monitor for exploit activity

**Documentation**:
- Add to `SECURITY_REMEDIATION_PLAN.md`
- Link GitHub Security alert
- Estimate fix effort

#### False Positives

**Suppression via .trivyignore**:
```bash
# Create suppression file
cat > .trivyignore << 'EOF'
# False positive: Not used in our code path
CVE-2024-12345

# Accepted risk: No fix available, low impact
CVE-2024-67890

# Waiting for upstream fix
CVE-2024-11111
EOF

# Commit suppression
git add .trivyignore
git commit -m "chore: suppress false positive security alerts"
git push
```

**Document Suppression**:
- Add comment explaining why suppressed
- Link to GitHub issue tracking fix
- Set reminder to review quarterly

### Security Scan Configuration

#### Customizing Trivy Scan

Edit `.github/workflows/ci-cd.yml`:

```yaml
- name: Run Trivy vulnerability scanner
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: ${{ env.DOCKER_IMAGE_NAME }}:scan
    format: 'sarif'
    output: 'trivy-results.sarif'
    
    # Severity levels to scan for
    severity: 'CRITICAL,HIGH,MEDIUM'
    
    # Ignore vulnerabilities with no fix
    ignore-unfixed: true
    
    # Exit code on findings (0 = continue, 1 = fail)
    exit-code: '0'
    
    # Vulnerability database
    vuln-type: 'os,library'
    
    # Scan secrets
    scanners: 'vuln,secret'
```

#### Pipeline Failure Thresholds

**Current Behavior**: Pipeline continues even with vulnerabilities (warnings only)

**To Fail on Vulnerabilities**:
```yaml
- name: Run Trivy vulnerability scanner
  uses: aquasecurity/trivy-action@master
  with:
    exit-code: '1'  # Fail pipeline on findings
    severity: 'CRITICAL,HIGH'  # Only fail on serious issues
```

**Recommendation**: Keep as warnings initially, then enable failure after baseline fixes are complete.

### Security Notifications

#### GitHub Security Alerts

**Automatic Notifications**:
- GitHub sends email when new vulnerabilities detected
- Dependabot alerts for dependency vulnerabilities
- Code scanning alerts for Trivy findings

**Configure**:
1. Settings → Security & analysis
2. Enable **Dependabot alerts**
3. Enable **Dependabot security updates**
4. Enable **Code scanning** (for Trivy)

#### Custom Notifications

Add to CI/CD workflow for Slack/Discord/Email:

```yaml
- name: Notify on security findings
  if: steps.trivy.outputs.vulnerabilities != '0'
  uses: slackapi/slack-github-action@v1
  with:
    webhook-url: ${{ secrets.SLACK_WEBHOOK }}
    payload: |
      {
        "text": "⚠️ Security vulnerabilities found in ${{ github.repository }}",
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "Security scan found vulnerabilities.\nCheck: ${{ github.server_url }}/${{ github.repository }}/security/code-scanning"
            }
          }
        ]
      }
```

### Security Metrics

#### Tracking Security Posture

**Metrics to Monitor**:
1. **Vulnerability Count**: Total open security findings
2. **Time to Remediation**: Days from discovery to fix
3. **Critical/High Count**: Serious vulnerabilities only
4. **Fix Rate**: Percentage resolved each sprint
5. **False Positive Rate**: Suppressed vs. actual issues

**View in GitHub**:
- Security tab → Overview → Metrics
- Insights tab → Security (for organizations)

#### Security Dashboard

Create custom dashboard using GitHub API:
```javascript
// Fetch code scanning alerts
GET /repos/{owner}/{repo}/code-scanning/alerts

// Filter by tool
?tool_name=Trivy

// Filter by severity
&severity=critical,high

// Get metrics
&state=open
```

### Security Best Practices

#### 1. Regular Dependency Updates

**Schedule**: Monthly dependency updates

**Process**:
```bash
# Check outdated packages
npm outdated

# Update non-breaking changes
npm update

# Check for security updates
npm audit

# Test after updates
npm test

# Commit if tests pass
git add package*.json
git commit -m "chore: update dependencies"
git push
```

#### 2. Monitor Security Advisories

**Resources**:
- GitHub Security Advisories: https://github.com/advisories
- npm Security Advisories: https://github.com/advisories?query=ecosystem%3Anpm
- Node.js Security Releases: https://nodejs.org/en/blog/vulnerability/

**Subscribe to**:
- GitHub repository watch → Security alerts
- npm security mailing list
- Dependabot pull requests

#### 3. Security Review Checklist

Before each release:

- [ ] Run `npm audit` and resolve HIGH/CRITICAL
- [ ] Check GitHub Security tab for open alerts
- [ ] Review `.trivyignore` suppressions (still valid?)
- [ ] Update dependencies to latest patch versions
- [ ] Run full test suite
- [ ] Scan Docker image with Trivy locally
- [ ] Review SECURITY_REMEDIATION_PLAN.md progress
- [ ] Update security documentation if needed

#### 4. Incident Response

If critical vulnerability discovered:

**Hour 0-1: Assessment**
- Confirm vulnerability affects your deployment
- Determine exploit likelihood
- Assess potential impact

**Hour 1-4: Mitigation**
- Apply temporary workaround if available
- Update to patched version
- Run full test suite
- Deploy fix to production

**Hour 4-24: Verification**
- Monitor for exploitation attempts
- Verify fix resolves vulnerability
- Update security documentation
- Notify stakeholders

**Day 1-7: Post-Incident**
- Conduct post-mortem
- Update incident response plan
- Improve detection/prevention

### Security Scanning Documentation

For complete CI/CD documentation including security scanning setup, see:
- **[docs/CI_CD.md](CI_CD.md)** - Comprehensive CI/CD guide
- **Security Scanning section** - Trivy configuration, SARIF integration, troubleshooting

---

## 🎓 Security Resources

### Documentation

- **Project Security Audit**: `SECURITY_AUDIT_REPORT.md`
- **Remediation Plan**: `SECURITY_REMEDIATION_PLAN.md`
- **Security Policy**: `SECURITY.md` (planned)
- Actual Budget Security: https://actualbudget.org/docs/security
- OWASP Top 10: https://owasp.org/www-project-top-ten/
- Node.js Security Best Practices: https://nodejs.org/en/docs/guides/security/
- CIS Docker Benchmark: https://www.cisecurity.org/benchmark/docker

### Tools

- **npm audit**: Built-in vulnerability scanner
- **gitleaks**: Secret scanning and pre-commit hooks
- **Snyk**: Dependency vulnerability scanning
- **Trivy**: Container security scanning
- **ESLint Security**: Code pattern analysis
- **Semgrep**: Static application security testing (SAST)
- **Docker Scout**: Container vulnerability analysis

---

## 📞 Security Contacts

### Reporting Vulnerabilities

If you discover a security vulnerability:

1. **Do NOT** create a public GitHub issue
2. Email project maintainer directly (configure in your project)
3. Provide detailed description and reproduction steps
4. Allow reasonable time for fix before public disclosure

### Security Response Team

[Configure your security contact information here]

---

## 📜 Security Policy Version

**Version**: 1.0

**Last Updated**: December 4, 2025

**Next Review**: March 4, 2026 (Quarterly)

**Changelog**:
- December 4, 2025: Initial security policy created

---

**Note**: This security policy should be reviewed and updated regularly as the project evolves and new threats emerge.
