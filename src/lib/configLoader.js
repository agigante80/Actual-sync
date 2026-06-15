const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { resolveDefaultsDir } = require('./configBootstrap');

// AJV combinator keywords whose failures are pure structural noise: when an
// allOf/if-then/anyOf branch fails, AJV (allErrors:true) ALSO emits the concrete
// leaf errors (the actual missing/invalid fields), so the combinator line adds
// nothing actionable to the human-facing message. The schema uses none of `not`
// /`oneOf`/`else`, so filtering these never removes a sole signal. (#121)
const NOISE_SCHEMA_KEYWORDS = new Set(['if', 'then', 'else', 'allOf', 'anyOf', 'oneOf']);

/**
 * Whether strict config validation is on (the default). Set CONFIG_STRICT to a
 * falsy spelling (`false`/`0`/`no`/`off`, case-insensitive, whitespace-trimmed)
 * to downgrade schema hard-fails to warnings during a migration. (#121)
 * @param {object} [env] environment to read (defaults to process.env)
 * @returns {boolean}
 */
function isConfigStrict(env = process.env) {
    const v = String(env.CONFIG_STRICT ?? '').trim().toLowerCase();
    return !['false', '0', 'no', 'off'].includes(v);
}

/**
 * Normalize an Actual server URL for identity comparison: lowercase
 * protocol+host+path and drop any trailing slash, so `https://X/` and
 * `https://x` compare equal. Falls back to a trimmed lowercase string for
 * anything URL() can't parse. Used to detect duplicate budgets. (#119)
 * @param {string} url
 * @returns {string}
 */
function normalizeServerUrl(url) {
    const raw = String(url == null ? '' : url).trim();
    try {
        const u = new URL(raw);
        // Scheme + host are case-insensitive (lowercase them); the path is NOT
        // (leave its case alone), and query/fragment aren't part of the server
        // identity. Drop a trailing slash so `https://x/` == `https://x`.
        return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
        return raw.replace(/\/+$/, '').toLowerCase();
    }
}

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
            // Load the schema from the bundled defaults dir so it's still found
            // when the config dir is a fresh/empty bind mount in a container. (#96)
            this.schemaPath = path.join(resolveDefaultsDir(projectRoot), 'config.schema.json');
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
        const envServer = ConfigLoader.buildServerFromEnv();
        const fileExists = fs.existsSync(this.configPath);

        // A single server can be configured entirely via ACTUAL_SYNC_SERVER_* env
        // vars (Unraid/Docker-friendly), so config.json is only required when no
        // env server is provided. (#120)
        if (!fileExists && !envServer) {
            throw new Error(
                `Configuration file not found: ${this.configPath}\n` +
                `Please create a config/config.json file (see config/config.example.json), ` +
                `or configure a single server with the ACTUAL_SYNC_SERVER_* environment variables.`
            );
        }

        let config;
        if (fileExists) {
            // Load configuration file
            let configContent;
            try {
                configContent = fs.readFileSync(this.configPath, 'utf8');
            } catch (error) {
                throw new Error(`Failed to read configuration file: ${error.message}`);
            }

            // Parse JSON
            try {
                config = JSON.parse(configContent);
            } catch (error) {
                throw new Error(
                    `Invalid JSON in configuration file: ${error.message}\n` +
                    `Please check your config.json for syntax errors.`
                );
            }
        } else {
            // Env-only: no file on disk, build the config around the env server.
            config = { servers: [] };
        }

        // Merge the env-var single server into the server list, deduped by budget
        // identity (url + syncId). The config.json entry wins on a collision so a
        // server present in both sources is never synced twice. (#120, #119)
        if (envServer) {
            config.servers = Array.isArray(config.servers) ? config.servers : [];
            const fileKeys = new Set(config.servers.map(s => `${normalizeServerUrl(s.url)}|${s.syncId}`));
            const envKey = `${normalizeServerUrl(envServer.url)}|${envServer.syncId}`;
            if (fileKeys.has(envKey)) {
                console.warn(
                    `⚠️  The ACTUAL_SYNC_SERVER_* environment variables describe a budget already ` +
                    `present in config.json (same url + syncId); using the config.json entry and ignoring the env vars.`
                );
            } else {
                // Ensure a unique name so merging the env server alongside a file
                // server that happens to share its name (e.g. both "Default", but
                // DIFFERENT budgets) doesn't trip validateLogic's duplicate-name
                // hard-fail. Auto-rename the env entry instead of crashing. (#120)
                const names = new Set(config.servers.map(s => s.name));
                if (names.has(envServer.name)) {
                    const base = envServer.name;
                    let n = 2;
                    while (names.has(`${base} (${n})`)) n++;
                    envServer.name = `${base} (${n})`;
                }
                config.servers.push(envServer);
            }
        }

        // Validate against schema if available. (#115)
        if (fs.existsSync(this.schemaPath)) {
            let schema;
            try {
                schema = JSON.parse(fs.readFileSync(this.schemaPath, 'utf8'));
            } catch (error) {
                // A corrupt/unreadable BUNDLED schema is a packaging defect the user
                // cannot fix from their config — fail with a clear, distinct message
                // rather than a raw SyntaxError that sends them hunting their config.
                throw new Error(
                    `Could not load bundled config schema (${this.schemaPath}): ${error.message}\n` +
                    `This is an installation/build problem, not a problem with your config.json.`
                );
            }

            const { hard, unknownKeys } = this.collectSchemaErrors(config, schema);

            // Hard schema rules (type, range, required, format, pattern) had their
            // advisory cycle in #115/#116 and now HARD-FAIL the load (#121): an
            // invalid config.json stops startup with an aggregated, actionable
            // message instead of syncing with bad settings. CONFIG_STRICT=false is a
            // temporary migration escape hatch that downgrades these to a warning.
            if (hard.length) {
                const message =
                    `Configuration is invalid — it does not match the schema:\n${hard.join('\n')}`;
                if (!isConfigStrict()) {
                    console.warn(
                        `⚠️  ${message}\n` +
                        `CONFIG_STRICT is off: downgraded to a warning — fix these; they hard-fail once the escape hatch is removed. ` +
                        `(CONFIG_STRICT only affects schema validation, not the business-logic checks below.)`
                    );
                } else {
                    throw new Error(
                        `${message}\n\n` +
                        `Fix config.json and restart. Run \`npm run validate-config\` to check it before starting. ` +
                        `Set CONFIG_STRICT=false to temporarily downgrade these to warnings during migration.`
                    );
                }
            }

            // Unknown keys stay ADVISORY (warn-forever, #121 decision): they keep the
            // typo signal without crash-looping on a stray "_comment", a legacy key,
            // or a forward/backward-compatible field. AJV reports them via
            // additionalProperties:false (#123); unknown keys are ignored at runtime.
            if (unknownKeys.length) {
                console.warn(
                    `⚠️  Configuration has ${unknownKeys.length === 1 ? 'an unknown property' : 'unknown properties'} ` +
                    `(advisory — likely a typo; unknown keys are ignored, not fatal):\n${unknownKeys.join('\n')}`
                );
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
     * Build a single server object from ACTUAL_SYNC_SERVER_* environment
     * variables, for a config-file-free single-budget setup (Unraid/Docker). The
     * three core vars are required to activate it; everything else is optional
     * with sensible defaults. Returns null when not configured. (#120)
     * @param {object} [env] environment to read (defaults to process.env)
     * @returns {object|null} a server object, or null if the env path isn't used
     */
    static buildServerFromEnv(env = process.env) {
        const url = env.ACTUAL_SYNC_SERVER_URL;
        const password = env.ACTUAL_SYNC_SERVER_PASSWORD;
        const syncId = env.ACTUAL_SYNC_SERVER_SYNC_ID;
        if (!url || !password || !syncId) return null; // env path not activated

        const name = env.ACTUAL_SYNC_SERVER_NAME || 'Default';
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
        const server = {
            name,
            url,
            password,
            syncId,
            dataDir: env.ACTUAL_SYNC_SERVER_DATA_DIR || `data/${slug}`
        };
        if (env.ACTUAL_SYNC_SERVER_ENCRYPTION_PASSWORD) {
            server.encryptionPassword = env.ACTUAL_SYNC_SERVER_ENCRYPTION_PASSWORD;
        }
        if (env.ACTUAL_SYNC_SERVER_SCHEDULE) {
            server.sync = { schedule: env.ACTUAL_SYNC_SERVER_SCHEDULE };
        }
        return server;
    }

    /**
     * Whether a single server is configured via ACTUAL_SYNC_SERVER_* env vars.
     * Lets startup skip the "config.json not found" error/seed-and-exit. (#120)
     * @param {object} [env]
     * @returns {boolean}
     */
    static hasEnvServerConfig(env = process.env) {
        return ConfigLoader.buildServerFromEnv(env) !== null;
    }

    /**
     * Validate configuration against JSON schema
     * @param {Object} config - Configuration object
     * @param {Object} schema - JSON schema
     * @throws {Error} If configuration doesn't match schema
     */
    validateConfig(config, schema) {
        const { hard, unknownKeys } = this.collectSchemaErrors(config, schema);
        const all = [...hard, ...unknownKeys];
        if (all.length) {
            throw new Error(`Configuration validation failed:\n${all.join('\n')}`);
        }
    }

    /**
     * Compile the schema and partition AJV errors by how load() treats them:
     *  - `hard`: type / range / required / format / pattern / enum rules — these
     *    had their advisory cycle in #115/#116 and now hard-fail load() (#121).
     *  - `unknownKeys`: `additionalProperties` violations — kept advisory
     *    (warn-forever) so a stray "_comment", legacy, or forward-compat key never
     *    crash-loops a deploy (#121 decision; flagged via #123).
     * `validateConfig()` (and `npm run validate-config`) throw on ANY of these;
     * load() applies the softer per-class policy above.
     * @param {Object} config - Configuration object
     * @param {Object} schema - JSON schema
     * @returns {{hard: string[], unknownKeys: string[]}} formatted error lines
     */
    collectSchemaErrors(config, schema) {
        // allowUnionTypes: the schema legitimately uses union item types (e.g.
        // telegram.chatIds accepts string|number); without it ajv prints a strict
        // warning on every compile. (#115)
        const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
        // Register the standard string formats (email, uri, ...). Without this,
        // a `format` keyword in the schema makes ajv.compile() THROW, which used
        // to be swallowed in load() — silently disabling ALL validation. (#115)
        addFormats(ajv);
        const validate = ajv.compile(schema);
        if (validate(config)) return { hard: [], unknownKeys: [] };

        const hard = [];
        const unknownKeys = [];
        for (const err of validate.errors) {
            if (err.keyword === 'additionalProperties') {
                unknownKeys.push(this.formatSchemaError(err));
            } else if (!NOISE_SCHEMA_KEYWORDS.has(err.keyword)) {
                hard.push(this.formatSchemaError(err));
            }
        }
        // Safety net: if every error was a combinator (no concrete leaf survived
        // — impossible with the current schema, but never let noise-filtering make
        // an invalid config look valid), fall back to the unfiltered errors.
        if (!hard.length && !unknownKeys.length && validate.errors.length) {
            return { hard: validate.errors.map(e => this.formatSchemaError(e)), unknownKeys: [] };
        }
        return { hard, unknownKeys };
    }

    /**
     * Turn a raw ajv error into a line a human can act on. ajv's defaults are
     * terse (e.g. "must match pattern ..."); add the offending property name,
     * allowed values, or limit so the operator does not have to decode it. (#115)
     * @param {Object} err - an ajv error object
     * @returns {string} a single formatted bullet line
     */
    formatSchemaError(err) {
        const where = err.instancePath || '(root)';
        const p = err.params || {};
        let detail = err.message;
        if (p.missingProperty) {
            detail = `missing required property '${p.missingProperty}'`;
        } else if (p.additionalProperty) {
            detail = `unknown property '${p.additionalProperty}' (check for a typo)`;
        } else if (p.allowedValues) {
            detail = `${err.message} (allowed: ${p.allowedValues.join(', ')})`;
        }
        return `  - ${where}: ${detail}`;
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
        // logDir defaults to './logs' in logger constructor if not specified
        // Don't set a default here to allow logger to use its own logic
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

        // Warn on duplicate BUDGETS: two servers pointing at the same budget
        // (same normalized url + syncId) double-sync the same accounts — provider
        // rate limits, duplicate notifications/history, and duplicate dashboard
        // groups. The budget identity is (url, syncId); deduping by name alone
        // misses this. Same syncId on a DIFFERENT url is allowed (distinct
        // instances). Advisory for now; see #121 for promotion to hard-fail. (#119)
        const budgetKeys = config.servers.map(s => `${normalizeServerUrl(s.url)}|${s.syncId}`);
        const dupBudgetKeys = [...new Set(budgetKeys.filter((k, i) => budgetKeys.indexOf(k) !== i))];
        if (dupBudgetKeys.length > 0) {
            const groups = dupBudgetKeys.map(k =>
                config.servers.filter((_, i) => budgetKeys[i] === k).map(s => `"${s.name}"`).join(' + ')
            );
            console.warn(
                `⚠️  Warning: the same budget (url + syncId) is configured more than once: ${groups.join('; ')}.\n` +
                `   It will be synced multiple times (duplicate bank-syncs, notifications and dashboard entries). Remove the duplicate entry.`
            );
        }

        // Warn on shared data directories: multi-server isolation requires a
        // distinct dataDir per server, or two syncs corrupt the same budget
        // cache. Compare resolved paths so './data' and 'data' match. (#119)
        const dataDirs = config.servers.map(s => path.resolve(s.dataDir));
        const dupDirs = [...new Set(dataDirs.filter((d, i) => dataDirs.indexOf(d) !== i))];
        if (dupDirs.length > 0) {
            console.warn(
                `⚠️  Warning: multiple servers share the same data directory: ${dupDirs.join(', ')}.\n` +
                `   Each server needs its own dataDir to avoid budget-cache collisions.`
            );
        }

        // Warn if the health-check server is bound to a specific routable IP.
        // In a container the host's LAN IP isn't bindable in bridge mode, so the
        // server fails with EADDRNOTAVAIL and the dashboard is unreachable.
        // 0.0.0.0 / 127.0.0.1 / localhost are safe. (#94)
        const hcHost = config.healthCheck && config.healthCheck.host;
        // Safe binds: IPv4/IPv6 wildcard + loopback. (#94)
        if (hcHost && !['0.0.0.0', '::', '::1', '127.0.0.1', 'localhost'].includes(hcHost)) {
            console.warn(
                `⚠️  Warning: healthCheck.host is set to "${hcHost}".\n` +
                `   In containers use "0.0.0.0" — a specific host IP may not be bindable (EADDRNOTAVAIL) and the dashboard will be unreachable.`
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

        // Basic cron field-count validation. node-schedule accepts the standard
        // 5-field form and a 6-field form with a leading seconds field, so allow
        // both (kept in sync with the schema pattern). Authoritative per-field
        // validation is deferred to #121. (#116)
        const cronParts = config.sync.schedule.trim().split(/\s+/);
        if (cronParts.length < 5 || cronParts.length > 6) {
            throw new Error(
                `Invalid cron schedule: "${config.sync.schedule}"\n` +
                `Expected 5 fields (minute hour day month dayOfWeek) or 6 with a leading seconds field`
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
