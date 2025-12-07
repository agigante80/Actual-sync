const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

/**
 * Configuration loader with validation
 * Loads configuration from config/config.json and validates against schema
 */
class ConfigLoader {
    constructor(configPath, schemaPath) {
        // If no paths provided, use defaults relative to project root
        if (!configPath) {
            // Find project root (where package.json is)
            const projectRoot = path.resolve(__dirname, '../..');
            this.configPath = path.join(projectRoot, 'config', 'config.json');
            this.schemaPath = path.join(projectRoot, 'config', 'config.schema.json');
        } else {
            // Use provided paths (assume absolute or relative to cwd)
            this.configPath = path.resolve(configPath);
            this.schemaPath = schemaPath ? path.resolve(schemaPath) : null;
        }
        this.config = null;
    }

    /**
     * Load and validate configuration
     * @returns {Object} Validated configuration object
     * @throws {Error} If configuration is invalid or missing
     */
    load() {
        // Check if config file exists
        if (!fs.existsSync(this.configPath)) {
            throw new Error(
                `Configuration file not found: ${this.configPath}\n` +
                `Please create a config/config.json file. See config/config.example.json for reference.`
            );
        }

        // Load configuration file
        let configContent;
        try {
            configContent = fs.readFileSync(this.configPath, 'utf8');
        } catch (error) {
            throw new Error(`Failed to read configuration file: ${error.message}`);
        }

        // Parse JSON
        let config;
        try {
            config = JSON.parse(configContent);
        } catch (error) {
            throw new Error(
                `Invalid JSON in configuration file: ${error.message}\n` +
                `Please check your config.json for syntax errors.`
            );
        }

        // Validate against schema if available
        if (fs.existsSync(this.schemaPath)) {
            try {
                const schema = JSON.parse(fs.readFileSync(this.schemaPath, 'utf8'));
                this.validateConfig(config, schema);
            } catch (error) {
                console.warn(`Warning: Could not validate config against schema: ${error.message}`);
            }
        }

        // Apply defaults for optional fields
        this.applyDefaults(config);

        // Additional validation
        this.validateLogic(config);

        this.config = config;
        return config;
    }

    /**
     * Validate configuration against JSON schema
     * @param {Object} config - Configuration object
     * @param {Object} schema - JSON schema
     * @throws {Error} If configuration doesn't match schema
     */
    validateConfig(config, schema) {
        const ajv = new Ajv({ allErrors: true });
        const validate = ajv.compile(schema);
        const valid = validate(config);

        if (!valid) {
            const errors = validate.errors
                .map(err => `  - ${err.instancePath || 'root'}: ${err.message}`)
                .join('\n');
            throw new Error(`Configuration validation failed:\n${errors}`);
        }
    }

    /**
     * Apply default values for optional configuration fields
     * @param {Object} config - Configuration object (modified in place)
     */
    applyDefaults(config) {
        // Sync defaults
        if (!config.sync) {
            config.sync = {};
        }
        config.sync.maxRetries = config.sync.maxRetries ?? 5;
        config.sync.baseRetryDelayMs = config.sync.baseRetryDelayMs ?? 3000;
        config.sync.schedule = config.sync.schedule ?? '03 03 */2 * *';

        // Logging defaults
        if (!config.logging) {
            config.logging = {};
        }
        config.logging.level = (config.logging.level ?? 'INFO').toUpperCase();
        config.logging.format = config.logging.format ?? 'pretty';
        config.logging.logDir = config.logging.logDir ?? null;
    }

    /**
     * Validate business logic constraints
     * @param {Object} config - Configuration object
     * @throws {Error} If validation fails
     */
    validateLogic(config) {
        // Ensure at least one server
        if (!config.servers || config.servers.length === 0) {
            throw new Error('Configuration must include at least one server');
        }

        // Validate each server
        config.servers.forEach((server, index) => {
            // Check required fields
            const requiredFields = ['name', 'url', 'password', 'syncId', 'dataDir'];
            for (const field of requiredFields) {
                if (!server[field]) {
                    throw new Error(
                        `Server ${index + 1} (${server.name || 'unnamed'}): Missing required field '${field}'`
                    );
                }
            }

            // Warn about insecure HTTP in production-like URLs
            if (server.url.startsWith('http://') && 
                !server.url.includes('localhost') && 
                !server.url.includes('127.0.0.1')) {
                console.warn(
                    `⚠️  Warning: Server "${server.name}" uses unencrypted HTTP connection.\n` +
                    `   Consider using HTTPS for production: ${server.url}`
                );
            }

            // Warn about weak passwords
            if (server.password && server.password.length < 8) {
                console.warn(
                    `⚠️  Warning: Server "${server.name}" has a weak password (< 8 characters).\n` +
                    `   Consider using a stronger password for security.`
                );
            }

            // Warn about default passwords
            if (server.password === 'hunter2' || server.password === 'password' || 
                server.password === 'your_password_here') {
                console.warn(
                    `⚠️  Warning: Server "${server.name}" appears to use a default/example password.\n` +
                    `   Please change to a secure password before production use.`
                );
            }
        });

        // Check for duplicate server names
        const serverNames = config.servers.map(s => s.name);
        const duplicates = serverNames.filter((name, index) => serverNames.indexOf(name) !== index);
        if (duplicates.length > 0) {
            throw new Error(
                `Duplicate server names found: ${[...new Set(duplicates)].join(', ')}\n` +
                `Each server must have a unique name.`
            );
        }

        // Validate retry settings
        if (config.sync.maxRetries < 0 || config.sync.maxRetries > 10) {
            throw new Error(
                `Invalid maxRetries value: ${config.sync.maxRetries}\n` +
                `Must be between 0 and 10.`
            );
        }

        if (config.sync.baseRetryDelayMs < 1000) {
            throw new Error(
                `Invalid baseRetryDelayMs value: ${config.sync.baseRetryDelayMs}\n` +
                `Must be at least 1000ms (1 second).`
            );
        }

        // Basic cron validation (5 fields)
        const cronParts = config.sync.schedule.split(/\s+/);
        if (cronParts.length !== 5) {
            throw new Error(
                `Invalid cron schedule: "${config.sync.schedule}"\n` +
                `Expected 5 fields: minute hour day month dayOfWeek`
            );
        }
    }

    /**
     * Get loaded configuration
     * @returns {Object} Configuration object
     * @throws {Error} If configuration not loaded yet
     */
    getConfig() {
        if (!this.config) {
            throw new Error('Configuration not loaded. Call load() first.');
        }
        return this.config;
    }

    /**
     * Get specific server configuration by name
     * @param {string} name - Server name
     * @returns {Object|null} Server configuration or null if not found
     */
    getServer(name) {
        if (!this.config) {
            throw new Error('Configuration not loaded. Call load() first.');
        }
        return this.config.servers.find(s => s.name === name) || null;
    }

    /**
     * Get all server configurations
     * @returns {Array} Array of server configurations
     */
    getServers() {
        if (!this.config) {
            throw new Error('Configuration not loaded. Call load() first.');
        }
        return this.config.servers;
    }
}

module.exports = ConfigLoader;
