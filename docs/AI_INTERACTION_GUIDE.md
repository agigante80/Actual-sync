# AI Interaction Guide

## 🤖 Purpose

This document defines the rules, boundaries, and workflows that AI agents must follow when interacting with the Actual-sync codebase. It ensures consistent, safe, and high-quality automated development practices.

---

## 🎯 Core Principles

### 1. Safety First
- **Never push untested code** to GitHub or production environments
- **Always run tests locally** before committing changes
- **Validate configurations** before applying them
- **Preserve existing functionality** unless explicitly asked to change it

### 2. Documentation Synchronization
- **Update documentation immediately** when code changes affect system behavior
- **Maintain cross-references** between related documentation sections
- **Keep examples current** with actual code implementations

### 3. Incremental Progress
- **Make small, focused changes** rather than large refactors
- **Test after each change** to identify issues early
- **Commit working states frequently** to preserve progress

### 4. Human Collaboration
- **Request clarification** when requirements are ambiguous
- **Explain complex decisions** in commit messages and comments
- **Highlight trade-offs** when multiple approaches are viable

---

## 🚦 Automation Boundaries

### ✅ AI Agent CAN Do (Automated)

1. **Code Analysis**
   - Read and understand existing code
   - Identify bugs, security issues, and code smells
   - Suggest refactoring opportunities

2. **Documentation Updates**
   - Update `/docs` files to reflect code changes
   - Fix broken cross-references
   - Add missing documentation sections

3. **Code Modifications**
   - Fix bugs based on clear error messages
   - Implement well-defined features
   - Refactor code per approved plans
   - Add error handling and logging

4. **Testing**
   - Run existing test suites
   - Write unit tests for new code
   - Validate configuration files

5. **Dependency Management**
   - Update package versions (with testing)
   - Add new dependencies (with justification)
   - Remove unused dependencies

### ⚠️ AI Agent SHOULD NOT Do (Requires Human Review)

1. **Security-Sensitive Changes**
   - Modify authentication logic
   - Change credential handling
   - Alter rate limiting behavior
   - Modify retry logic for sensitive operations

2. **Breaking Changes**
   - Remove public functions/APIs
   - Change configuration file formats
   - Modify environment variable names
   - Alter database schemas (when implemented)

3. **Infrastructure Changes**
   - Modify CI/CD pipelines
   - Change deployment configurations
   - Alter Docker configurations
   - Modify systemd services

4. **Data Operations**
   - Delete or migrate production data
   - Modify existing budget files
   - Change data directory locations without backup

### ❌ AI Agent MUST NOT Do (Prohibited)

1. **Dangerous Operations**
   - Push code to GitHub without local testing
   - Commit code with failing tests
   - Deploy to production directly
   - Modify `.env` files in repositories

2. **Security Violations**
   - Hardcode credentials in source code
   - Disable security features
   - Bypass authentication
   - Expose sensitive data in logs

3. **Destructive Actions**
   - Delete production data directories
   - Remove backup files without confirmation
   - Force-push to main/master branches
   - Delete entire modules without migration path

---

## 🧪 Required Testing Policy

### Before Every Commit

**Mandatory Validation Steps:**

1. **Syntax Check**
   ```bash
   node --check sync_all_banks.js
   node --check getAccounts.js
   ```

2. **Dependency Verification**
   ```bash
   npm install
   npm audit
   ```

3. **Configuration Validation**
   - Verify `.env` file has required variables
   - Check data directories are accessible
   - Validate server URLs are reachable

4. **Functional Testing**
   ```bash
   # Test account discovery
   node getAccounts.js
   
   # Test forced sync (non-production environment)
   node sync_all_banks.js --force-run
   ```

5. **Documentation Sync Check**
   - Verify affected documentation files are updated
   - Check cross-references are still valid
   - Ensure examples match current code

### Test Failure Protocol

If **any test fails**:
1. ❌ **STOP** - Do not commit or push
2. 🔍 **Investigate** - Determine root cause
3. 🛠️ **Fix** - Correct the issue
4. 🔄 **Re-test** - Run full test suite again
5. ✅ **Proceed** - Only after all tests pass

---

## 📝 Documentation Update Triggers

AI agents must update documentation when these events occur:

| Event | Documents to Update |
|-------|---------------------|
| New feature added | `README.md`, `PROJECT_OVERVIEW.md`, `ARCHITECTURE.md`, `ROADMAP.md` |
| Configuration changed | `README.md`, `ARCHITECTURE.md` |
| Security change | `SECURITY_AND_PRIVACY.md`, `ARCHITECTURE.md` |
| Dependency added/removed | `PROJECT_OVERVIEW.md`, `ARCHITECTURE.md` |
| Refactoring completed | `REFACTORING_PLAN.md`, `ARCHITECTURE.md` |
| Bug fixed | `IMPROVEMENT_AREAS.md` (remove item if applicable) |
| Test added | `TESTING_AND_RELIABILITY.md` |
| Known limitation addressed | `IMPROVEMENT_AREAS.md` (remove), `ROADMAP.md` (update) |

---

## 🔐 Security Constraints

### Credential Handling

**Rules:**
- Never hardcode credentials in source files
- Always use environment variables via `dotenv`
- Never commit `.env` files to version control
- Validate environment variables exist before use

**Example (Correct):**
```javascript
const password = process.env.SERVICE_PASSWORD || 'default_dev_password';
if (!process.env.SERVICE_PASSWORD) {
    console.warn('Warning: Using default password');
}
```

### API Rate Limiting

**Rules:**
- Maintain exponential backoff for rate limits
- Never remove or disable rate limit handling
- Log rate limit events for monitoring
- Consider reducing sync frequency if limits hit frequently

### Data Privacy

**Rules:**
- Never log sensitive financial data
- Don't expose account numbers or balances in logs
- Minimize data retention in local caches
- Document data handling in `SECURITY_AND_PRIVACY.md`

---

## 🛠️ Development Workflows

### Feature Implementation Workflow

1. **Planning Phase**
   - Review `ROADMAP.md` for feature priority
   - Check `REFACTORING_PLAN.md` for related work
   - Update `REFACTORING_PLAN.md` with task breakdown

2. **Implementation Phase**
   - Write code following existing patterns
   - Add error handling and logging
   - Update inline code comments

3. **Testing Phase**
   - Run full test suite locally
   - Test edge cases and error conditions
   - Validate on non-production server if possible

4. **Documentation Phase**
   - Update all relevant `/docs` files
   - Add usage examples to `README.md`
   - Update architecture diagrams if needed

5. **Review Phase**
   - Create pull request with detailed description
   - Link to related issues/tasks
   - Request human review for security-sensitive changes

6. **Completion Phase**
   - Mark task complete in `REFACTORING_PLAN.md`
   - Update `ROADMAP.md` milestone progress
   - Tag release version if applicable

### Bug Fix Workflow

1. **Investigation**
   - Reproduce the bug locally
   - Identify root cause in code
   - Document in `IMPROVEMENT_AREAS.md` if not immediately fixable

2. **Fix Implementation**
   - Write minimal fix addressing root cause
   - Add error handling to prevent recurrence
   - Add logging for debugging future issues

3. **Validation**
   - Test that bug is resolved
   - Verify no new issues introduced
   - Run full test suite

4. **Documentation**
   - Update `IMPROVEMENT_AREAS.md` (remove if fixed)
   - Add to changelog/release notes
   - Update relevant documentation

### Refactoring Workflow

1. **Approval**
   - Ensure refactoring is in `REFACTORING_PLAN.md`
   - Verify no blocking dependencies
   - Confirm no active feature work conflicts

2. **Implementation**
   - Make small, incremental changes
   - Test after each change
   - Preserve existing functionality

3. **Validation**
   - Run comprehensive tests
   - Check performance hasn't degraded
   - Verify logs still provide useful information

4. **Documentation**
   - Update `ARCHITECTURE.md` with new structure
   - Update `REFACTORING_PLAN.md` status
   - Update code comments

---

## 🚨 Incident Response

### If Tests Fail After Your Changes

1. **Immediate Actions**
   - Stop all commits/pushes
   - Revert changes to last working state
   - Document the failure

2. **Investigation**
   - Identify what broke
   - Determine if issue is in your changes or existing code
   - Check for environmental factors

3. **Resolution**
   - Fix the issue
   - Re-run tests
   - Document the root cause

### If Security Issue Discovered

1. **Immediate Actions**
   - Stop all development work
   - Document the issue in detail
   - Alert human maintainers

2. **Do NOT**
   - Commit code mentioning the vulnerability
   - Push fixes without security review
   - Discuss in public channels

3. **After Human Review**
   - Implement approved fix
   - Update `SECURITY_AND_PRIVACY.md`
   - Add tests to prevent regression

---

## 📊 Quality Standards

### Code Quality

- Follow existing code style and conventions
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions focused and small

### Documentation Quality

- Use clear, concise language
- Include code examples where helpful
- Maintain consistent formatting
- Keep cross-references accurate

### Commit Quality

- Write descriptive commit messages
- Reference related issues/tasks
- Keep commits focused on single changes
- Include testing evidence in PR descriptions

---

## 🔄 Continuous Improvement

### Regular Reviews

AI agents should periodically:
- Audit documentation for staleness
- Check for deprecated dependencies
- Identify new refactoring opportunities
- Update improvement tracking documents

### Metric Tracking

Track and document:
- Test coverage percentage
- Sync success rate
- Error frequency by type
- Documentation coverage

---

## 💬 Communication Guidelines

### When to Ask for Human Input

- **Ambiguous requirements**: Need clarification on feature behavior
- **Multiple valid approaches**: Trade-offs need business decision
- **Security-sensitive changes**: Risk assessment required
- **Breaking changes**: Impact on users needs evaluation
- **Large refactorings**: Architectural decisions needed

### How to Request Input

Include in your request:
- Clear description of the issue/decision
- Proposed options with pros/cons
- Recommendation (if applicable)
- Impact assessment
- Timeline implications

---

## 🎓 Learning and Adaptation

### Knowledge Base

AI agents should:
- Learn from past mistakes documented in issues
- Understand project-specific patterns and conventions
- Reference existing implementations for consistency
- Build on established architectural decisions

### Pattern Recognition

Identify and follow patterns for:
- Error handling approaches
- Logging conventions
- Configuration management
- Testing strategies

---

**Last Updated**: December 4, 2025

**Version**: 1.0

**Review Schedule**: Update after significant project changes or every 3 months
