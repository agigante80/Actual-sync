#!/usr/bin/env node

/**
 * Actual-sync - Automated bank synchronization service for Actual Budget
 * Entry point for the application
 */

const fs = require('fs');
const path = require('path');
const { ensureConfig, resolveDefaultsDir } = require('./src/lib/configBootstrap');
const ConfigLoader = require('./src/lib/configLoader');

// Get version from environment (CI build-arg) or package.json (#132)
const { resolveVersion } = require('./src/lib/version');
const VERSION = resolveVersion();

console.log(`\n🏦 Starting Actual-sync v${VERSION}\n`);

// Validate environment and configuration before starting
function validateStartup() {
    const errors = [];
    const warnings = [];

    // Check Node.js version
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
    if (majorVersion < 22) {
        errors.push(`Node.js version ${nodeVersion} is not supported. Please use Node.js 22 or higher.`);
    }

    // A single server can be configured via ACTUAL_SYNC_SERVER_* env vars, in
    // which case config.json is optional. (#120)
    const hasEnvServer = ConfigLoader.hasEnvServerConfig();

    const configDir = path.join(__dirname, 'config');
    const configFile = path.join(configDir, 'config.json');
    const configFileExists = fs.existsSync(configFile);

    if (configFileExists) {
        // Verify config.json is readable and valid JSON
        try {
            JSON.parse(fs.readFileSync(configFile, 'utf8'));
        } catch (error) {
            if (error.code === 'EACCES') {
                errors.push(`Configuration file is not readable: ${error.message}`);
            } else if (error instanceof SyntaxError) {
                errors.push(
                    `Configuration file contains invalid JSON:\n` +
                    `  ${error.message}\n` +
                    `  Please check config/config.json for syntax errors.`
                );
            } else {
                errors.push(`Failed to read configuration file: ${error.message}`);
            }
        }
    } else if (hasEnvServer) {
        // Env-var single-server setup: no config.json needed. (#120)
        console.log('Using single-server configuration from ACTUAL_SYNC_SERVER_* environment variables (no config.json).');
    } else if (!fs.existsSync(configDir)) {
        errors.push(
            'Configuration directory not found: config/\n' +
            '  Please create the config directory and add config.json file.\n' +
            '  See config/config.example.json for reference.'
        );
    } else {
        // First run: seed an example template into the (likely empty,
        // freshly-mounted) config dir so the user has something to fill in. (#96)
        const { seeded } = ensureConfig({ configDir });
        const syncIdHint = '  Sync ID: in Actual Budget open the budget → Settings → Advanced → "Sync ID".';
        if (seeded) {
            errors.push(
                'No config.json found — a starter template was written to config/config.example.json.\n' +
                '  Fill in each server\'s url / password / syncId, rename it to config.json, and restart.\n' +
                '  (Or configure a single server with the ACTUAL_SYNC_SERVER_* environment variables.)\n' +
                syncIdHint
            );
        } else {
            errors.push(
                'Configuration file not found: config/config.json\n' +
                '  Create config.json based on config.example.json, or use the ACTUAL_SYNC_SERVER_* env vars.\n' +
                syncIdHint
            );
        }
    }

    // Check if schema exists (optional, but warn if missing). Resolve from the
    // bundled defaults dir so a shadowed config mount doesn't degrade validation. (#96)
    const schemaFile = path.join(resolveDefaultsDir(__dirname), 'config.schema.json');
    if (!fs.existsSync(schemaFile)) {
        warnings.push('Configuration schema not found (validation will be limited)');
    }

    // Check if required npm packages are installed
    const packageJsonPath = path.join(__dirname, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
        const nodeModulesPath = path.join(__dirname, 'node_modules');
        if (!fs.existsSync(nodeModulesPath)) {
            errors.push(
                'Dependencies not installed: node_modules/ not found\n' +
                '  Please run: npm install'
            );
        } else {
            // Check critical dependencies
            const criticalPackages = ['@actual-app/api', 'node-schedule', 'ajv'];
            for (const pkg of criticalPackages) {
                const pkgPath = path.join(nodeModulesPath, pkg);
                if (!fs.existsSync(pkgPath)) {
                    errors.push(
                        `Critical dependency missing: ${pkg}\n` +
                        '  Please run: npm install'
                    );
                    break; // Don't spam with all missing packages
                }
            }
        }
    }

    // Display warnings
    if (warnings.length > 0) {
        console.warn('⚠️  Startup Warnings:');
        warnings.forEach(warning => console.warn(`  - ${warning}`));
        console.warn('');
    }

    // Display errors and exit if any
    if (errors.length > 0) {
        console.error('❌ Startup Validation Failed:\n');
        errors.forEach(error => console.error(`  ${error}\n`));
        console.error('Please fix the above errors before starting the service.');
        process.exit(1);
    }

    console.log('✅ Startup validation passed');
}

// Run validation
validateStartup();

// Export version for use by other modules
global.APP_VERSION = VERSION;

// Start the sync service
require('./src/syncService');
