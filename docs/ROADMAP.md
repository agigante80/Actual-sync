# Roadmap

## 🎯 Purpose

Outline the future development priorities and planned improvements for the Actual-sync project, organized by timeframe and strategic goals.

---

## 🗓️ Planning Horizon

This roadmap covers planned work from Q1 2026 through Q4 2026, with a long-term vision extending into 2027.

**Last Updated**: December 4, 2025

**Next Review**: January 15, 2026

---

## 📊 Current Status (December 2025)

### Maturity Assessment

**Overall Maturity**: Level 4 - Production-Ready

| Dimension | Level | Status |
|-----------|-------|--------|
| **Core Functionality** | 5/5 | ✅ Production-ready with multi-server support |
| **Reliability** | 5/5 | ✅ Comprehensive error handling & retry logic |
| **Testing** | 5/5 | ✅ 84.77% coverage with 309 tests |
| **Documentation** | 5/5 | ✅ Comprehensive docs (17 files) |
| **Observability** | 5/5 | ✅ Dashboard, Prometheus, logs, WebSocket streaming |
| **Security** | 4/5 | ✅ Strong security practices, room for enhancement |

### Completed Features (2025)

- ✅ Multi-server sync automation with per-server config overrides
- ✅ Retry logic with exponential backoff & jitter
- ✅ Rate limit handling (429 detection)
- ✅ Scheduled execution (cron-based)
- ✅ Manual force-run option (`npm run sync`)
- ✅ Individual server sync (`npm run sync -- --server "Name"`)
- ✅ Automated testing (84.77% coverage, 309 tests)
- ✅ Health monitoring (`/health`, `/ready`, `/metrics` endpoints)
- ✅ Web Dashboard with real-time logs and manual sync controls
- ✅ WebSocket log streaming with infinite reconnection
- ✅ Prometheus metrics & Grafana dashboards
- ✅ Multi-channel notifications (Email, Telegram, webhooks)
- ✅ Interactive Telegram bot (8 commands)
- ✅ Sync history tracking (SQLite database)
- ✅ Enhanced structured logging with rotation and syslog
- ✅ Log rotation with gzip compression
- ✅ Per-server log levels and child loggers
- ✅ Performance tracking with configurable thresholds
- ✅ Encrypted budget (E2EE) support
- ✅ Docker deployment support (229MB Alpine image)
- ✅ CI/CD pipeline (GitHub Actions)
- ✅ Configuration validation (JSON schema with AJV)
- ✅ Per-server schedule and retry configuration
- ✅ MIT License

---

## 🚀 Q1 2026 (Jan-Mar): Enhanced User Experience

**Theme**: Usability & Control

**Primary Objective**: Improve user interaction and operational flexibility

### ✅ Milestone 1: Force Individual Sync (COMPLETED: December 2025)

**Goals**:
- Enable syncing specific servers on demand
- Improve CLI usability for troubleshooting

**Tasks**:
1. ✅ Add `--server` flag to sync command
2. ✅ Implement server name filtering
3. ✅ Add Telegram bot command for individual sync
4. ✅ Update documentation

**Success Criteria**:
- ✅ `npm run sync -- --server "Main"` syncs only specified server
- ✅ Telegram bot `/sync ServerName` works
- ✅ Clear error messages for invalid server names

**Impact**: Medium - Improves troubleshooting and operational control

**Effort**: 6-8 hours (actual)

---

### ✅ Milestone 2: Web Dashboard (COMPLETED: December 2025)

**Status**: ✅ **COMPLETED**

**Goals**:
- Visual status monitoring
- Real-time log streaming
- Manual sync triggering via web UI

**Completed Tasks**:
1. ✅ Designed responsive dashboard UI with dark theme
2. ✅ Extended HealthCheckService with dashboard routes (/dashboard, /api/dashboard/*)
3. ✅ Implemented WebSocket for real-time log streaming with keep-alive
4. ✅ Added sync trigger buttons with server selection (individual and "Sync All")
5. ✅ Display sync history from SQLite with recent 10 syncs
6. ✅ Show Prometheus metrics visualization (Chart.js charts)
7. ✅ Added authentication (basic auth, token-based, and none options)
8. ✅ Added encryption status indicators for servers
9. ✅ Implemented infinite WebSocket reconnection with exponential backoff
10. ✅ Added memory-efficient ring buffer for logs (500 capacity)
11. ✅ Added footer with GitHub and license links

**Success Criteria**:
- ✅ Dashboard accessible at configured port (http://localhost:3000/dashboard)
- ✅ Real-time logs visible in browser with WebSocket streaming
- ✅ Manual sync trigger works for individual servers and all servers
- ✅ Sync history displayed with filtering and status icons
- ✅ Protected by configurable authentication (basic, token, or none)
- ✅ Shows success rate, duration trends, and timeline charts
- ✅ Encryption status badges show encrypted/unencrypted servers
- ✅ Long-running stability (24/7 operation without memory leaks)

**Implementation Details**:
- Single-page application with vanilla JavaScript
- Chart.js for visualizations (success rates, duration trends, timeline)
- WebSocket with ping/pong keep-alive (30s interval)
- Ring buffer prevents unbounded memory growth
- Pause streaming when tab is hidden (resource optimization)
- Responsive design (mobile-friendly)
- 42 tests covering dashboard API and WebSocket functionality

**Impact**: High - Major usability improvement

**Effort**: 30-35 hours (actual)

---

### ✅ Milestone 3: Encrypted Budget Support (Completed: December 2025)

**Status**: ✅ **COMPLETED**

**Goals**:
- Support end-to-end encrypted Actual Budget files
- Secure encryption key storage

**Completed Tasks**:
1. ✅ Added `encryptionPassword` field to config schema (optional, per-server)
2. ✅ Pass encryption password to `downloadBudget(syncId, { password })` when provided
3. ✅ Updated ConfigLoader with validation for encryption password field
4. ✅ Documented encryption setup in CONFIG.md with examples
5. ✅ Added comprehensive tests (7 new tests for encrypted budget support)
6. ✅ Updated config.example.json with encryption password example

**Success Criteria**:
- ✅ Encrypted budgets sync successfully with correct password
- ✅ Encryption password optional per server (backward compatible)
- ✅ Clear logging shows when encryption is used
- ✅ Tests verify encryption password handling (empty, valid, missing)
- ✅ Documentation includes security best practices

**Implementation Details**:
- `encryptionPassword` is separate from server `password`
- Empty/omitted encryption password = unencrypted budget
- Logged as `encrypted: true/false` in budget loading
- 302 total tests passing (7 new encryption tests)
- ✅ Documentation updated

**Impact**: Medium - Enables encrypted budget users

**Effort**: 8-12 hours

---

## 🎯 Q2 2026 (Apr-Jun): Advanced Features

**Theme**: Intelligence & Automation

### Milestone 4: Intelligent Scheduling (Target: End of April)

**Goals**:
- Dynamic schedule adjustment based on sync success
- Retry failed syncs more aggressively
- Back off on consistent failures

**Tasks**:
1. Implement adaptive scheduling algorithm
2. Track sync success patterns per server
3. Adjust retry intervals based on history
4. Add configuration for adaptive behavior
5. Monitor and tune algorithm

**Success Criteria**:
- ✅ Failed syncs retried within 1 hour
- ✅ Successful syncs maintain regular schedule
- ✅ Persistent failures trigger longer backoff
- ✅ Configurable sensitivity

**Impact**: Medium - Improves reliability

**Effort**: 16-20 hours

---

### ✅ Milestone 3 (was 5): Enhanced Logging (COMPLETED: December 2025)

**Status**: ✅ **COMPLETED**

**Goals**:
- Better log management
- Log rotation and compression
- Structured search capabilities

**Completed Tasks**:
1. ✅ Implemented log rotation by size/date using rotating-file-stream
2. ✅ Added gzip compression for old logs (configurable)
3. ✅ Improved log streaming for dashboard with WebSocket
4. ✅ Added syslog support (UDP/TCP, RFC 5424 format)
5. ✅ Implemented performance tracking with configurable thresholds
6. ✅ Added per-server log level configuration
7. ✅ Implemented child loggers with context inheritance
8. ✅ Enhanced correlation ID tracking throughout lifecycle

**Success Criteria**:
- ✅ Logs auto-rotate at configurable size (default 10MB)
- ✅ Old logs compressed automatically with gzip
- ✅ Dashboard streams logs in real-time via WebSocket
- ✅ Per-server log levels allow granular control
- ✅ Correlation IDs track operations across components
- ✅ Performance tracking logs slow operations automatically
- ✅ Syslog integration for centralized logging

**Implementation Details**:
- rotating-file-stream library for rotation
- Configurable: maxSize (10M), maxFiles (10), compress (gzip)
- Syslog client with UDP/TCP support
- Performance thresholds: slow (1s), verySlow (5s)
- Child loggers inherit parent context
- 18 new tests for logging features
- Complete LOGGING.md documentation (1000+ lines)

**Impact**: Medium - Better operational visibility

**Effort**: 14-18 hours (actual)
4. Create notification templates
5. Add failure threshold configuration
6. Document notification setup

**Success Criteria**:
- ✅ Email alerts sent on persistent failures
- ✅ Webhook integrations functional
- ✅ Configurable alert thresholds
- ✅ Clear setup instructions

**Impact**: High - Reduces time to detect and resolve issues

**Resource Requirements**: 10-14 hours development time

---

## 📈 Q3 2026 (Jul-Sep): Performance & Scale

**Theme**: Optimization & Scalability

### Milestone 6: Performance Optimization (Target: End of July)

**Goals**:
- Enable parallel server synchronization
- Reduce total sync time
- Optimize resource usage

**Tasks**:
1. Implement concurrent server sync with configurable limits
2. Add rate limit coordination across parallel syncs
3. Benchmark performance improvements
4. Tune concurrency settings based on API limits
5. Add performance metrics to Prometheus

**Success Criteria**:
- ✅ Servers sync in parallel (default 3, configurable)
- ✅ Total sync time reduced by 40-60% for multi-server setups
- ✅ Rate limits respected across parallel operations
- ✅ Performance metrics visible in Grafana

**Impact**: Medium-High - Significant efficiency gain for large deployments

**Effort**: 10-14 hours

---

### Milestone 7: Multi-Account Improvements (Target: End of August)

**Goals**:
- Per-account sync configuration
- Selective account syncing
- Better error isolation

**Tasks**:
1. Add account-level configuration to schema
2. Implement account filtering for manual syncs
3. Isolate account-level errors (don't fail entire server)
4. Add per-account metrics
5. Update documentation

**Success Criteria**:
- ✅ Can configure specific accounts to sync
- ✅ Manual sync supports account filtering
- ✅ Single account failure doesn't stop other accounts
- ✅ Per-account success/failure tracking

**Impact**: Medium - Better control and reliability

**Effort**: 12-16 hours

---

## 🔮 Q4 2026 (Oct-Dec): Polish & Ecosystem

**Theme**: Integration & User Experience

### Milestone 8: Plugin System (Target: End of October)

**Goals**:
- Enable community extensions
- Pluggable notification channels
- Custom sync hooks

**Tasks**:
1. Design plugin API
2. Implement plugin loader
3. Create example plugins
4. Document plugin development
5. Add plugin marketplace/registry

**Success Criteria**:
- ✅ Plugins can add custom notification channels
- ✅ Pre/post sync hooks available
- ✅ Plugin development documented
- ✅ At least 3 example plugins available

**Impact**: Medium - Enables community contributions

**Effort**: 20-28 hours
### Milestone 9: Documentation & Tutorials (Target: End of December)

**Goals**:
- Video tutorials
- Interactive setup guide
- Community resources

**Tasks**:
1. Create video walkthrough of setup
2. Build interactive configuration wizard
3. Create troubleshooting flowcharts
4. Expand examples repository
5. Build community wiki/FAQ

**Success Criteria**:
- ✅ 5+ video tutorials available
- ✅ Interactive setup wizard works
- ✅ Visual troubleshooting guide
- ✅ 20+ example configurations

**Impact**: Medium - Lowers barrier to entry

**Effort**: 16-24 hours

---

## 🔮 Future Vision (2027+)

### Potential Major Features (Under Consideration)

#### 1. Multi-Instance Coordination

**Description**: Run multiple sync instances with distributed locking

**Features**:
- Distributed locking (Redis/etcd)
- Leader election
- Automatic failover
- Shared sync history

**Effort**: 40-60 hours

**Priority**: Low - Only needed for high-availability scenarios

---

#### 2. Advanced Analytics

**Description**: Machine learning for sync pattern analysis

**Features**:
- Anomaly detection
- Predictive failure detection
- Sync duration forecasting
- Resource usage optimization

**Effort**: 60+ hours

**Priority**: Low - Requires significant data collection first

---

#### 3. Mobile App Companion

**Description**: Mobile app for monitoring and control

**Features**:
- Push notifications
- Manual sync trigger
- Status monitoring
- Error resolution

**Effort**: 100+ hours

**Priority**: Low - Web dashboard covers most use cases

---

## 📊 Success Metrics

### Key Performance Indicators (KPIs)

**Current Status (December 2025)**:

**Reliability**:
- ✅ Sync Success Rate: >95% (tracked in Prometheus)
- ✅ Error Recovery Rate: >90% (with retry logic)
- ✅ Mean Time to Detect: <2 minutes (health check polling)

**Operational**:
- ✅ Time to Deploy: <5 minutes (Docker)
- ✅ Time to Detect Failure: <2 minutes (Telegram/email alerts)
- ✅ Time to Resolve Issues: <30 minutes (comprehensive logging)

**Development**:
- ✅ Test Coverage: 98.73% (exceeds 80% target)
- ✅ Documentation Coverage: 100% (16 comprehensive docs)
- ✅ Dependency Vulnerabilities: 0 critical (npm audit clean)

---

## 🎯 Strategic Priorities for 2026

### Priority 1: User Experience & Control

**Rationale**: With testing and monitoring complete, focus on usability improvements

**Focus**: Q1-Q2 2026

**Key Features**: Individual sync, web dashboard, encrypted budget support

**Investment**: ~40% of development time

---

### Priority 2: Advanced Features & Intelligence

**Rationale**: Differentiate with smart features that reduce manual intervention

**Focus**: Q2-Q3 2026

**Key Features**: Adaptive scheduling, enhanced logging, performance optimization

**Investment**: ~35% of development time

---

### Priority 3: Ecosystem & Community

**Rationale**: Enable community contributions and expand use cases

**Focus**: Q3-Q4 2026

**Key Features**: Plugin system, expanded examples, tutorials

**Investment**: ~25% of development time

---

## 🚧 Constraints & Dependencies

### Resource Constraints

**Development Time**: Estimated 90-150 hours total for 2026 roadmap

**Assumption**: Solo developer or small team working part-time

**Mitigation**: Prioritize ruthlessly, defer nice-to-haves

---

### Technical Dependencies

**External Services**:
- Actual Budget API stability
- GoCardless/Nordigen API availability
- No breaking changes in dependencies

**Infrastructure**:
- Access to test Actual Budget instances
- CI/CD platform (GitHub Actions)

---

### Risk Factors

**High Risk**:
- Actual Budget API changes requiring significant rework
- Team capacity constraints
- Security vulnerabilities requiring immediate attention

**Medium Risk**:
- Dependency breaking changes
- Scope creep on major features
- User needs shifting significantly

**Low Risk**:
- Performance issues under load
- Integration compatibility problems

---

## 🔄 Roadmap Maintenance

### Review Schedule

**Monthly**: Review progress, adjust Q1 priorities if needed

**Quarterly**: Major roadmap review, reprioritize future quarters

**Annually**: Strategic review, update long-term vision

### Feedback Integration

**User Feedback**: Incorporate user requests into priority assessment

**Lessons Learned**: Adjust estimates based on actual effort

**Technology Changes**: Adapt to new tools and best practices

---

## 📞 Stakeholder Communication

### Progress Updates

**Monthly**: Brief status update (this document updated)

**Quarterly**: Detailed progress report with demos

**Major Milestones**: Announcement with release notes

---

## ✅ Completed Milestones

### Q4 2025 (Oct-Dec)

#### Documentation Standardization (Completed: Dec 4, 2025)

**Goals**: Create comprehensive, synchronized documentation

**Delivered**:
- ✅ Complete `/docs` directory structure
- ✅ 9 standardized documentation files
- ✅ AI interaction guidelines
- ✅ Security and privacy policies
- ✅ Refactoring plan
- ✅ Testing strategy
- ✅ This roadmap

**Impact**: High - Provides foundation for all future development

---

**Last Updated**: December 4, 2025

**Version**: 1.0

**Next Major Update**: February 1, 2026 (after Q1 milestones)
