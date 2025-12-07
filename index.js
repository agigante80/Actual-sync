#!/usr/bin/env node

/**
 * Actual-sync - Automated bank synchronization service for Actual Budget
 * Entry point for the application
 */

const fs = require('fs');
const path = require('path');

// Get version from environment or package.json
const VERSION = process.env.VERSION || (() => {
    try {
        return require('./package.json').version;
    } catch (error) {
        return 'unknown';
    }
})();

console.log(`\n🏦 Starting Actual-sync v${VERSION}\n`);

// Validate environment and configuration before starting
function validateStartup() {
    const errors = [];
    const warnings = [];

    // Check Node.js version
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
    if (majorVersion < 14) {
        errors.push(`Node.js version ${nodeVersion} is not supported. Please use Node.js 14 or higher.`);
    }

    // Check if config directory exists
    const configDir = path.join(__dirname, 'config');
    if (!fs.existsSync(configDir)) {
        errors.push(
            'Configuration directory not found: config/\n' +
            '  Please create the config directory and add config.json file.\n' +
            '  See config/config.example.json for reference.'
        );
    } else {
        // Check if config.json exists
        const configFile = path.join(configDir, 'config.json');
        if (!fs.existsSync(configFile)) {
            errors.push(
                'Configuration file not found: config/config.json\n' +
                '  Please create config.json based on config.example.json.\n' +
                '  Example: cp config/config.example.json config/config.json'
            );
        } else {
            // Verify config.json is readable and valid JSON
            try {
                const configContent = fs.readFileSync(configFile, 'utf8');
                JSON.parse(configContent);
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
        }

        // Check if schema exists (optional, but warn if missing)
        const schemaFile = path.join(configDir, 'config.schema.json');
        if (!fs.existsSync(schemaFile)) {
            warnings.push('Configuration schema not found: config/config.schema.json (validation will be limited)');
        }
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
