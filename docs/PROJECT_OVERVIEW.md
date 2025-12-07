# Project Overview

## 🎯 Mission

Automate bank transaction synchronization for Actual Budget servers, eliminating manual sync operations and ensuring financial data stays current across multiple budget instances.

---

## 📋 Objectives

1. **Automated Synchronization**: Periodically sync bank transactions without human intervention
2. **Multi-Server Support**: Manage multiple Actual Budget instances from a single service
3. **Reliable Operation**: Handle network failures, rate limits, and transient errors gracefully
4. **Minimal Maintenance**: Run unattended with comprehensive error handling and logging

---

## ✨ Key Features

### Core Capabilities

- **Scheduled Bank Sync**: Automated synchronization on configurable cron schedule
- **Multi-Server Management**: Support for multiple Actual Budget servers with independent configurations
- **Retry Logic**: Exponential backoff for rate limits and network failures
- **Account Discovery**: Utility to list all accessible bank accounts
- **Force Sync**: Manual trigger for immediate synchronization
- **Detailed Logging**: Comprehensive console output for monitoring and debugging

### Technical Features

- **Environment-Based Configuration**: Secure credential management via `.env` files
- **Independent Server Isolation**: Each server uses isolated data directories
- **Network Resilience**: Automatic retry for connection failures and DNS issues
- **Rate Limit Handling**: Intelligent backoff for GoCardless/Nordigen API limits
- **Graceful Shutdown**: Proper API cleanup after each sync operation

---

## 🏗️ Technology Stack

### Runtime & Language

- **Node.js**: JavaScript runtime for service execution
- **ECMAScript (ES6+)**: Modern JavaScript features

### Core Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@actual-app/api` | ^25.11.0 | Official Actual Budget API client |
| `ajv` | ^8.17.1 | JSON schema validation |
| `better-sqlite3` | ^12.5.0 | SQLite database |
| `dotenv` | ^16.6.1 | Environment variable management |
| `express` | ^5.2.1 | HTTP server (health checks) |
| `express-rate-limit` | ^7.5.0 | Rate limiting middleware |
| `moment-timezone` | ^0.6.0 | Timezone-aware date handling |
| `node-schedule` | ^2.1.1 | Cron-style job scheduling |
| `nodemailer` | ^7.0.11 | Email notifications |
| `prom-client` | ^15.1.3 | Prometheus metrics |
| `uuid` | ^11.1.0 | Unique identifier generation |

### External Services

- **Actual Budget Server**: Self-hosted budget management application
- **GoCardless/Nordigen**: Open banking API for transaction data

---

## 👥 Target Audience

### Primary Users

- **Personal Finance Enthusiasts**: Individuals running self-hosted Actual Budget instances
- **Multi-User Households**: Families managing separate budget servers per member
- **Budget Power Users**: Advanced users requiring automated, hands-off synchronization

### Technical Profile

- Comfortable with Node.js and command-line interfaces
- Running Actual Budget in Docker or bare-metal environments
- Have configured bank connections via GoCardless/Nordigen

---

## 📊 Current Status

### Maturity Level

**Beta / Production-Ready**

The service is functional and reliable for production use with proper configuration. Core features are stable, but some improvements remain (see [IMPROVEMENT_AREAS.md](./IMPROVEMENT_AREAS.md)).

### Feature Completeness

| Feature Category | Status |
|-----------------|--------|
| Core Sync Functionality | ✅ Complete |
| Multi-Server Support | ✅ Complete |
| Error Handling | ✅ Complete |
| Retry Logic | ✅ Complete |
| Scheduling | ✅ Complete |
| Logging | ✅ Complete |
| Testing | ✅ Complete (80.47% coverage, 255 tests) |
| Configuration Management | ✅ Complete (JSON schema validation) |
| Monitoring/Alerting | ✅ Complete (Prometheus + multi-channel notifications) |

### Known Limitations

1. ~~**No Database**~~: ✅ **RESOLVED** - SQLite sync history database implemented
2. ~~**Limited Observability**~~: ✅ **RESOLVED** - Prometheus metrics and health check endpoints
3. ~~**Manual Configuration**~~: ✅ **RESOLVED** - JSON-based configuration with schema validation
4. ~~**No Testing Suite**~~: ✅ **RESOLVED** - 255 tests with 80.47% coverage
5. **Single Instance**: No clustering or high-availability support (still applicable)

---

## 🎯 Success Metrics

### Operational Goals

- **Uptime**: 99%+ availability during scheduled sync windows
- **Sync Success Rate**: >95% successful syncs without manual intervention
- **Error Recovery**: Automatic recovery from transient failures within 5 retry attempts

### User Experience Goals

- **Zero Manual Syncs**: Users should not need to manually trigger bank syncs
- **Timely Updates**: Transactions appear in Actual Budget within 24 hours
- **Transparent Operations**: Clear logs for troubleshooting when issues occur

---

## 🔄 Version History

### Current Version

**v1.0.0** (Inferred - no formal versioning currently implemented)

### Major Milestones

1. Initial implementation with single-server support
2. Added multi-server configuration
3. Implemented retry logic with exponential backoff
4. Added rate limit detection and handling
5. Introduced force-run flag for manual execution

---

## 🔗 Related Projects

- **Actual Budget**: https://github.com/actualbudget/actual
- **Actual Budget API**: https://github.com/actualbudget/actual/tree/master/packages/api
- **GoCardless**: https://gocardless.com/
- **Nordigen (GoCardless)**: Open banking data provider

---

## 📞 Support & Resources

- **Documentation**: See `/docs` directory for comprehensive guides
- **Issues**: [Configure repository issue tracker]
- **Discussions**: [Configure repository discussions]

---

**Last Updated**: December 7, 2025

---

## 📄 README Updates

**Last README Update**: December 7, 2025  
**Version**: 1.4.0

### What's New in README

- ✅ Comprehensive professional README following industry best practices
- ✅ Added 15 sections with detailed documentation
- ✅ Included badges (build status, version, license, coverage, tests)
- ✅ Table of contents for easy navigation
- ✅ Quick start guide (5 minutes to deployment)
- ✅ Docker deployment examples (Docker Run, Docker Compose, Kubernetes)
- ✅ Monitoring & observability section (health checks, Prometheus metrics)
- ✅ Notification setup guide (Email, Telegram, Slack, Discord, Teams)
- ✅ Security best practices and audit results
- ✅ Troubleshooting guide with common issues
- ✅ Complete documentation index
- ✅ Roadmap with completed features and future plans
- ✅ Contributing guidelines
- ✅ **Docker Hub descriptions** (short ≤100 chars, long with markdown)
- ✅ Character count validation script for Docker descriptions

### Docker Hub Descriptions

**Short Description** (97/100 characters):
```
Automated bank synchronization service for Actual Budget with multi-server support and monitoring
```

**Long Description**: Complete markdown guide with quick start, configuration examples, monitoring instructions, and Docker Compose templates (see `docker/description/long.md`)

### README Highlights

- **Professional Formatting** - Emoji section headers, proper markdown structure
- **Visual Hierarchy** - Clear heading levels, code blocks with syntax highlighting
- **Copy-Paste Ready** - All commands tested and ready to use
- **Comprehensive Examples** - Configuration, Docker Compose, Kubernetes, Prometheus
- **Troubleshooting Section** - Common issues with solutions
- **Link Validation** - All internal links verified
