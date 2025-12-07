# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2025-12-05

### Added
- **Health Check HTTP Endpoints**:
  - `/health` endpoint for basic alive check
  - `/metrics` endpoint with detailed sync statistics and per-server status
  - `/ready` endpoint for Kubernetes readiness probes
  - Automatic status tracking (PENDING/HEALTHY/DEGRADED/UNHEALTHY)
  - Success rate calculation and reporting
  - Per-server sync status tracking
  - Error reporting with timestamps
  - 27 comprehensive health check tests
  - Complete health check documentation (HEALTH_CHECK.md)
- **Health Check Configuration**:
  - `healthCheck.port` - Configurable HTTP port (default: 3000)
  - `healthCheck.host` - Configurable bind address (default: 0.0.0.0)
- **Service Improvements**:
  - Graceful shutdown handlers (SIGTERM/SIGINT)
  - Automatic health status updates after sync operations
  - Express.js HTTP server integration

### Changed
- Updated syncService to report sync status to health check service
- Updated config schema with health check options
- Updated config example with health check defaults
- Total test count increased to 118 tests

### Documentation
- Added HEALTH_CHECK.md with:
  - Endpoint descriptions and examples
  - Docker and Kubernetes integration examples
  - Prometheus monitoring setup
  - Security considerations
  - Troubleshooting guide
  - Alerting examples

## [1.3.0] - 2025-12-05

### Added
- **Structured Logging System**:
  - Custom structured logger with log levels (DEBUG, INFO, WARN, ERROR)
  - Correlation IDs for tracking sync operations
  - JSON and pretty output formats
  - Optional file logging with daily log files
  - Automatic metadata attachment to log entries
  - Error object unwrapping with stack traces
  - 29 comprehensive logger tests
  - Complete logging documentation (LOGGING.md)
- **Logging Configuration**:
  - `logging.level` - Configurable log level
  - `logging.format` - JSON or pretty format
  - `logging.logDir` - Optional file output directory

### Changed
- Replaced all `console.log` calls with structured logger in syncService
- Updated listAccounts script to use structured logging
- Updated config schema with logging options
- Updated config example with logging defaults
- ConfigLoader now uppercases and validates log levels

### Fixed
- Better error tracking with structured metadata
- Production-ready logging for monitoring and debugging

## [1.2.0] - 2025-12-05

### Added
- **Comprehensive Testing Suite**:
  - Jest testing framework with 98.73% code coverage
  - 62 tests across 4 test suites
  - Unit tests for ConfigLoader (20 tests)
  - Unit tests for retry logic (18 tests)
  - Integration tests for sync service (11 tests)
  - Startup validation tests (13 tests)
  - Test helpers and utilities library
  - Coverage reporting with HTML output
- **NPM Test Scripts**:
  - `npm test` - Run all tests
  - `npm run test:watch` - Watch mode for development
  - `npm run test:coverage` - Generate coverage reports
- **Testing Documentation**:
  - Comprehensive TESTING.md guide
  - Test writing best practices
  - Coverage threshold configuration
  - CI/CD integration examples

### Changed
- Updated `.gitignore` to exclude test coverage and temporary test files
- Enhanced package.json with Jest configuration and test scripts
- Updated main README with testing instructions

### Fixed
- All code paths validated with comprehensive test coverage
- Edge cases and error scenarios thoroughly tested

## [1.1.0] - 2025-12-05

### Added
- Comprehensive startup validation in `index.js`:
  - Node.js version check (requires v14+)
  - Configuration directory existence check
  - Configuration file existence and readability check
  - JSON syntax validation at startup
  - Critical npm package installation verification
  - Schema file presence check (warning only)
- Clear, actionable error messages for each validation failure
- Fast-fail behavior to prevent confusing runtime errors
- Automatic validation on every service start

### Changed
- Entry point now validates environment before loading service code
- Enhanced error messages with specific fix instructions (e.g., "run npm install")

### Fixed
- Services no longer start with invalid or missing configuration
- Better developer experience with immediate feedback on setup issues

## [1.0.0] - 2025-12-04

### Added
- Professional project structure with organized directories
- `src/` directory for source code
- `config/` directory for configuration files
- `scripts/` directory for utility scripts
- Entry point file (`index.js`) for cleaner project root
- NPM scripts for common tasks:
  - `npm start` - Start scheduled sync service
  - `npm run sync` - Run immediate sync
  - `npm run list-accounts` - Discover accounts
  - `npm run validate-config` - Validate configuration
- Root-level `README.md` with quick start guide
- Comprehensive documentation suite in `/docs`
- Configuration system with JSON schema validation
- Configuration migration guide
- `.gitignore` with comprehensive rules

### Changed
- Renamed `sync_all_banks.js` → `src/syncService.js`
- Renamed `getAccounts.js` → `scripts/listAccounts.js`
- Moved `configLoader.js` → `src/lib/configLoader.js`
- Moved `config.example.json` → `config/config.example.json`
- Moved `config.schema.json` → `config/config.schema.json`
- Moved `CONFIG.md` → `docs/CONFIG.md`
- Moved `MIGRATION.md` → `docs/MIGRATION.md`
- Updated all import paths to reflect new structure
- Updated all documentation to reference new paths
- Improved `listAccounts.js` to support all configured servers
- Enhanced configuration loader with better error messages

### Removed
- `requirements.txt` (unused Python dependencies file)
- `syncBanks_working_backup.js` (redundant backup file)
- Hardcoded server configuration from source code

### Fixed
- Configuration file path resolution across different entry points
- Documentation cross-references
- Git ignore patterns for config files

### Security
- Configuration file (`config/config.json`) protected by `.gitignore`
- Security warnings for weak passwords
- Security warnings for unencrypted HTTP connections
- Validation prevents duplicate server names

## [0.9.0] - Pre-restructure baseline

### Features
- Multi-server bank synchronization
- Automatic retry with exponential backoff
- Rate limit handling
- Scheduled execution with cron
- Manual force-run option
- Environment-based configuration (via `.env`)
- Console logging

---

## Migration Guide

If upgrading from pre-1.0.0 version:

1. **Update imports:**
   ```bash
   # Old: node sync_all_banks.js
   npm start
   
   # Old: node getAccounts.js  
   npm run list-accounts
   ```

2. **Move configuration:**
   ```bash
   # If you have config.json in root:
   mv config.json config/config.json
   ```

3. **Update dependencies:**
   ```bash
   npm install
   ```

See [docs/MIGRATION.md](docs/MIGRATION.md) for complete migration guide.

---

**Note:** Version 1.0.0 represents the first stable release with professional project structure and comprehensive documentation.
