/**
 * Unit tests for ConfigLoader
 */

const fs = require('fs');
const path = require('path');
const ConfigLoader = require('../lib/configLoader');
const {
    createTempDir,
    cleanupTempDir,
    createMockConfig,
    createTestConfigFile,
    createTestSchemaFile,
    suppressConsole
} = require('./helpers/testHelpers');

describe('ConfigLoader', () => {
    let tempDir;
    let consoleSuppress;

    beforeEach(() => {
        tempDir = createTempDir();
        consoleSuppress = suppressConsole();
    });

    afterEach(() => {
        cleanupTempDir(tempDir);
        consoleSuppress.restore();
    });

    describe('Constructor', () => {
        test('should use default paths when no arguments provided', () => {
            const loader = new ConfigLoader();
            expect(loader.configPath).toContain('config/config.json');
            expect(loader.schemaPath).toContain('config/config.schema.json');
        });

        test('should use custom paths when provided', () => {
            const configPath = path.join(tempDir, 'custom-config.json');
            const schemaPath = path.join(tempDir, 'custom-schema.json');
            const loader = new ConfigLoader(configPath, schemaPath);
            expect(loader.configPath).toBe(path.resolve(configPath));
            expect(loader.schemaPath).toBe(path.resolve(schemaPath));
        });
    });

    describe('load()', () => {
        test('should throw error if config file does not exist', () => {
            const configPath = path.join(tempDir, 'nonexistent.json');
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.load()).toThrow('Configuration file not found');
        });

        test('should throw error if config file is not readable', () => {
            const configPath = path.join(tempDir, 'config.json');
            fs.writeFileSync(configPath, '{}');
            fs.chmodSync(configPath, 0o000);
            
            const loader = new ConfigLoader(configPath);
            
            try {
                expect(() => loader.load()).toThrow();
            } finally {
                fs.chmodSync(configPath, 0o644);
            }
        });

        test('should throw error on invalid JSON', () => {
            const configPath = path.join(tempDir, 'config.json');
            fs.writeFileSync(configPath, '{invalid json}');
            
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.load()).toThrow('Invalid JSON in configuration file');
        });

        test('should load valid configuration successfully', () => {
            const config = createMockConfig();
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            const loadedConfig = loader.load();
            
            expect(loadedConfig).toBeDefined();
            expect(loadedConfig.servers).toHaveLength(1);
            expect(loadedConfig.servers[0].name).toBe('Test Server');
        });

        test('should validate against schema if available', () => {
            const config = createMockConfig();
            const configPath = createTestConfigFile(tempDir, config);
            const schemaPath = createTestSchemaFile(tempDir);
            const loader = new ConfigLoader(configPath, schemaPath);

            const loadedConfig = loader.load();

            expect(loadedConfig).toBeDefined();
        });

        test('T5: schema is read from a separate (bundled) dir, not the config dir (#96)', () => {
            const cfgDir = createTempDir();
            const schemaDir = createTempDir();
            // config dir has the config but NO schema; schema lives elsewhere (bundled defaults)
            const configPath = createTestConfigFile(cfgDir, { servers: [] });
            const schemaPath = createTestSchemaFile(schemaDir);
            expect(fs.existsSync(path.join(cfgDir, 'config.schema.json'))).toBe(false);

            const loader = new ConfigLoader(configPath, schemaPath);
            // The schema (found in the SEPARATE dir) is applied: its `servers`
            // minItems:1 rejects the empty array. Since #121 a hard schema rule
            // hard-fails the load with a schema message (proving the schema from the
            // separate dir was read and run) — the throw now comes from the schema
            // layer, ahead of validateLogic. (#96, #115, #121)
            expect(() => loader.load()).toThrow(/does not match the schema/);

            cleanupTempDir(cfgDir);
            cleanupTempDir(schemaDir);
        });

        test('schema validation HARD-FAILS on an invalid type at startup (#121)', () => {
            // Structurally fine (passes validateLogic) but schema-invalid: branding
            // must be a boolean. Since #121 a hard schema rule stops startup.
            const config = createMockConfig({ notifications: { branding: 'not-a-boolean' } });
            const configPath = createTestConfigFile(tempDir, config);
            const realSchemaPath = path.join(__dirname, '..', '..', 'config', 'config.schema.json');
            const loader = new ConfigLoader(configPath, realSchemaPath);
            expect(() => loader.load()).toThrow(/does not match the schema/);
        });

        test('CONFIG_STRICT=false downgrades a schema hard-fail to a warning (#121 escape hatch)', () => {
            const config = createMockConfig({ notifications: { branding: 'not-a-boolean' } });
            const configPath = createTestConfigFile(tempDir, config);
            const realSchemaPath = path.join(__dirname, '..', '..', 'config', 'config.schema.json');
            const loader = new ConfigLoader(configPath, realSchemaPath);
            const prev = process.env.CONFIG_STRICT;
            process.env.CONFIG_STRICT = 'false';
            try {
                expect(() => loader.load()).not.toThrow();
                expect(console.warn).toHaveBeenCalledWith(
                    expect.stringContaining('CONFIG_STRICT=false')
                );
            } finally {
                if (prev === undefined) delete process.env.CONFIG_STRICT;
                else process.env.CONFIG_STRICT = prev;
            }
        });

        test('a corrupt bundled schema fails with a clear, distinct message (#115)', () => {
            const config = createMockConfig();
            const configPath = createTestConfigFile(tempDir, config);
            const schemaPath = path.join(tempDir, 'config.schema.json');
            fs.writeFileSync(schemaPath, '{ this is not valid json');
            const loader = new ConfigLoader(configPath, schemaPath);
            expect(() => loader.load()).toThrow(/Could not load bundled config schema/);
        });

        test('should apply default values for optional fields', () => {
            const config = { servers: [{ name: 'Test', url: 'https://test.com', password: 'pass', syncId: 'id', dataDir: '/tmp' }] };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            const loadedConfig = loader.load();
            
            expect(loadedConfig.sync.maxRetries).toBe(5);
            expect(loadedConfig.sync.baseRetryDelayMs).toBe(3000);
            expect(loadedConfig.sync.schedule).toBe('03 03 */2 * *');
            expect(loadedConfig.logging.level).toBe('INFO');
            expect(loadedConfig.logging.format).toBe('pretty');
        });
    });

    describe('validateConfig()', () => {
        test('should pass validation for valid config', () => {
            const config = createMockConfig();
            const schema = {
                type: 'object',
                required: ['servers'],
                properties: {
                    servers: { type: 'array' }
                }
            };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.validateConfig(config, schema)).not.toThrow();
        });

        test('should fail validation for invalid config', () => {
            const config = { invalid: 'config' };
            const schema = {
                type: 'object',
                required: ['servers'],
                properties: {
                    servers: { type: 'array' }
                }
            };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);

            expect(() => loader.validateConfig(config, schema)).toThrow('Configuration validation failed');
        });

        test('compiles a schema with string formats instead of throwing (#115 regression)', () => {
            // The original bug: a `format` keyword made ajv.compile() throw, which
            // load() swallowed — silently disabling validation. ajv-formats fixes it.
            const loader = new ConfigLoader('x', 'y');
            const schema = {
                type: 'object',
                properties: { email: { type: 'string', format: 'email' } }
            };
            expect(() => loader.validateConfig({ email: 'a@b.com' }, schema)).not.toThrow();
            expect(() => loader.validateConfig({ email: 'not-an-email' }, schema))
                .toThrow('Configuration validation failed');
        });
    });

    describe('real bundled schema enforcement (#115)', () => {
        const realSchema = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'config.schema.json'), 'utf8')
        );
        const loader = new ConfigLoader('x', 'y');

        test('the example/mock config validates against the real schema', () => {
            expect(() => loader.validateConfig(createMockConfig(), realSchema)).not.toThrow();
        });

        test('enforces format: email on notifications.email.from', () => {
            const cfg = createMockConfig({
                notifications: { email: { enabled: true, from: 'definitely-not-an-email', to: [] } }
            });
            expect(() => loader.validateConfig(cfg, realSchema)).toThrow('Configuration validation failed');
        });

        test('enforces format: uri on notifications.ntfy.icon', () => {
            const cfg = createMockConfig({
                notifications: { ntfy: { enabled: true, url: 'https://ntfy.sh/t', icon: 'not a url' } }
            });
            expect(() => loader.validateConfig(cfg, realSchema)).toThrow('Configuration validation failed');
        });

        test('rejects a wrong-typed field (branding as the string "false")', () => {
            // The footgun: `"false"` is truthy, so without schema enforcement it would
            // leave branding ON — the opposite of intent. Schema now rejects it. (#115)
            const cfg = createMockConfig({ notifications: { branding: 'false' } });
            expect(() => loader.validateConfig(cfg, realSchema)).toThrow('Configuration validation failed');
        });

        test('allows ntfy.icon:"" — the documented opt-out (#1)', () => {
            const cfg = createMockConfig({ notifications: { ntfy: { enabled: true, url: 'https://ntfy.sh/t', icon: '' } } });
            expect(() => loader.validateConfig(cfg, realSchema)).not.toThrow();
        });

        test('does NOT enforce email format on a DISABLED stub (#2)', () => {
            const cfg = createMockConfig({ notifications: { email: { enabled: false, from: 'YOUR_EMAIL', to: [] } } });
            expect(() => loader.validateConfig(cfg, realSchema)).not.toThrow();
        });

        test('accepts numeric chatIds when telegram is enabled (#4)', () => {
            const cfg = createMockConfig({ notifications: { telegram: { enabled: true, botToken: '1:AAAA', chatIds: [123456] } } });
            expect(() => loader.validateConfig(cfg, realSchema)).not.toThrow();
        });

        test('rejects an enabled telegram with an EMPTY chatIds array (#4)', () => {
            const cfg = createMockConfig({ notifications: { telegram: { enabled: true, botToken: '1:AAAA', chatIds: [] } } });
            expect(() => loader.validateConfig(cfg, realSchema)).toThrow('Configuration validation failed');
        });

        test('rejects an enabled telegram with a BLANK chatId (#4)', () => {
            const cfg = createMockConfig({ notifications: { telegram: { enabled: true, botToken: '1:AAAA', chatId: '' } } });
            expect(() => loader.validateConfig(cfg, realSchema)).toThrow('Configuration validation failed');
        });

        test('rejects an unknown/misspelled telegram property (#9)', () => {
            const cfg = createMockConfig({ notifications: { telegram: { enabled: false, chatID: 'typo' } } });
            expect(() => loader.validateConfig(cfg, realSchema)).toThrow('Configuration validation failed');
        });
    });

    describe('validateLogic()', () => {
        test('should throw error if no servers configured', () => {
            const config = { servers: [] };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.validateLogic(config)).toThrow('must include at least one server');
        });

        test('should throw error for missing required server fields', () => {
            const config = {
                servers: [{ name: 'Test' }],
                sync: { maxRetries: 3, baseRetryDelayMs: 1000, schedule: '0 0 * * *' }
            };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.validateLogic(config)).toThrow('Missing required field');
        });

        test('should throw error for duplicate server names', () => {
            const config = {
                servers: [
                    { name: 'Test', url: 'https://test1.com', password: 'pass1', syncId: 'id1', dataDir: '/tmp1' },
                    { name: 'Test', url: 'https://test2.com', password: 'pass2', syncId: 'id2', dataDir: '/tmp2' }
                ],
                sync: { maxRetries: 3, baseRetryDelayMs: 1000, schedule: '0 0 * * *' }
            };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.validateLogic(config)).toThrow('Duplicate server names');
        });

        test('should throw error for invalid maxRetries', () => {
            const config = {
                servers: [{ name: 'Test', url: 'https://test.com', password: 'pass', syncId: 'id', dataDir: '/tmp' }],
                sync: { maxRetries: 20, baseRetryDelayMs: 1000, schedule: '0 0 * * *' }
            };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.validateLogic(config)).toThrow('Invalid maxRetries value');
        });

        test('should throw error for invalid baseRetryDelayMs', () => {
            const config = {
                servers: [{ name: 'Test', url: 'https://test.com', password: 'pass', syncId: 'id', dataDir: '/tmp' }],
                sync: { maxRetries: 3, baseRetryDelayMs: 500, schedule: '0 0 * * *' }
            };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.validateLogic(config)).toThrow('Invalid baseRetryDelayMs value');
        });

        test('should throw error for invalid cron schedule', () => {
            const config = {
                servers: [{ name: 'Test', url: 'https://test.com', password: 'pass', syncId: 'id', dataDir: '/tmp' }],
                sync: { maxRetries: 3, baseRetryDelayMs: 1000, schedule: 'invalid cron' }
            };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.validateLogic(config)).toThrow('Invalid cron schedule');
        });

        test('should warn about insecure HTTP connections', () => {
            const config = {
                servers: [{ name: 'Test', url: 'http://production.com', password: 'password123', syncId: 'id', dataDir: '/tmp' }],
                sync: { maxRetries: 3, baseRetryDelayMs: 1000, schedule: '0 0 * * *' }
            };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            loader.validateLogic(config);
            
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unencrypted HTTP'));
        });

        test('should warn about weak passwords', () => {
            const config = {
                servers: [{ name: 'Test', url: 'https://test.com', password: 'short', syncId: 'id', dataDir: '/tmp' }],
                sync: { maxRetries: 3, baseRetryDelayMs: 1000, schedule: '0 0 * * *' }
            };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            loader.validateLogic(config);
            
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('weak password'));
        });

        test('should warn about default passwords', () => {
            const config = {
                servers: [{ name: 'Test', url: 'https://test.com', password: 'hunter2', syncId: 'id', dataDir: '/tmp' }],
                sync: { maxRetries: 3, baseRetryDelayMs: 1000, schedule: '0 0 * * *' }
            };
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            loader.validateLogic(config);

            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('default/example password'));
        });

        test('should warn when healthCheck.host is a specific routable IP (#94)', () => {
            for (const host of ['192.168.50.224', '10.0.0.1']) {
                console.warn.mockClear();
                const config = {
                    servers: [{ name: 'Test', url: 'https://test.com', password: 'password123', syncId: 'id', dataDir: '/tmp' }],
                    sync: { maxRetries: 3, baseRetryDelayMs: 1000, schedule: '0 0 * * *' },
                    healthCheck: { port: 3000, host }
                };
                new ConfigLoader().validateLogic(config);
                expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('healthCheck.host'));
            }
        });

        test('should NOT warn for safe health hosts incl. IPv6 wildcard/loopback (#94)', () => {
            for (const host of ['0.0.0.0', '127.0.0.1', 'localhost', '::', '::1']) {
                console.warn.mockClear();
                const config = {
                    servers: [{ name: 'Test', url: 'https://test.com', password: 'password123', syncId: 'id', dataDir: '/tmp' }],
                    sync: { maxRetries: 3, baseRetryDelayMs: 1000, schedule: '0 0 * * *' },
                    healthCheck: { port: 3000, host }
                };
                new ConfigLoader().validateLogic(config);
                expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('healthCheck.host'));
            }
        });
    });

    describe('getConfig()', () => {
        test('should throw error if config not loaded', () => {
            const loader = new ConfigLoader();
            
            expect(() => loader.getConfig()).toThrow('Configuration not loaded');
        });

        test('should return loaded config', () => {
            const config = createMockConfig();
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            loader.load();
            const returnedConfig = loader.getConfig();
            
            expect(returnedConfig).toBeDefined();
            expect(returnedConfig.servers).toHaveLength(1);
        });
    });

    describe('getServer()', () => {
        test('should throw error if config not loaded', () => {
            const loader = new ConfigLoader();
            
            expect(() => loader.getServer('Test')).toThrow('Configuration not loaded');
        });

        test('should return server by name', () => {
            const config = createMockConfig();
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            loader.load();
            const server = loader.getServer('Test Server');
            
            expect(server).toBeDefined();
            expect(server.name).toBe('Test Server');
        });

        test('should return null for non-existent server', () => {
            const config = createMockConfig();
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            loader.load();
            const server = loader.getServer('NonExistent');
            
            expect(server).toBeNull();
        });
    });

    describe('getServers()', () => {
        test('should throw error if config not loaded', () => {
            const loader = new ConfigLoader();
            
            expect(() => loader.getServers()).toThrow('Configuration not loaded');
        });

        test('should return all servers', () => {
            const config = createMockConfig({
                servers: [
                    { name: 'Server1', url: 'https://test1.com', password: 'pass1', syncId: 'id1', dataDir: '/tmp1' },
                    { name: 'Server2', url: 'https://test2.com', password: 'pass2', syncId: 'id2', dataDir: '/tmp2' }
                ]
            });
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            loader.load();
            const servers = loader.getServers();
            
            expect(servers).toHaveLength(2);
            expect(servers[0].name).toBe('Server1');
            expect(servers[1].name).toBe('Server2');
        });
    });

    describe('Encrypted Budget Support', () => {
        test('should accept valid encryptionPassword field', () => {
            const config = createMockConfig({
                servers: [{
                    name: 'Encrypted Server',
                    url: 'https://test.com',
                    password: 'server-pass',
                    syncId: 'sync-123',
                    dataDir: '/tmp/test',
                    encryptionPassword: 'budget-encryption-password'
                }]
            });
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.load()).not.toThrow();
            const loadedConfig = loader.getConfig();
            expect(loadedConfig.servers[0].encryptionPassword).toBe('budget-encryption-password');
        });

        test('should accept server without encryptionPassword', () => {
            const config = createMockConfig({
                servers: [{
                    name: 'Unencrypted Server',
                    url: 'https://test.com',
                    password: 'server-pass',
                    syncId: 'sync-456',
                    dataDir: '/tmp/test'
                }]
            });
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            expect(() => loader.load()).not.toThrow();
            const loadedConfig = loader.getConfig();
            expect(loadedConfig.servers[0].encryptionPassword).toBeUndefined();
        });

        test('should accept empty string for encryptionPassword (treated as no encryption)', () => {
            const config = createMockConfig({
                servers: [{
                    name: 'Server',
                    url: 'https://test.com',
                    password: 'server-pass',
                    syncId: 'sync-789',
                    dataDir: '/tmp/test',
                    encryptionPassword: ''
                }]
            });
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            // Empty string is valid and treated as falsy (no encryption password)
            expect(() => loader.load()).not.toThrow();
            const loadedConfig = loader.getConfig();
            expect(loadedConfig.servers[0].encryptionPassword).toBe('');
        });

        test('should validate encryptionPassword minLength', () => {
            const config = createMockConfig({
                servers: [{
                    name: 'Server',
                    url: 'https://test.com',
                    password: 'server-pass',
                    syncId: 'sync-abc',
                    dataDir: '/tmp/test',
                    encryptionPassword: 'a'
                }]
            });
            const configPath = createTestConfigFile(tempDir, config);
            const loader = new ConfigLoader(configPath);
            
            // Single character should pass (minLength: 1)
            expect(() => loader.load()).not.toThrow();
        });
    });

    describe('validateLogic — duplicate budget / dataDir (#119)', () => {
        const loader = new ConfigLoader('x', 'y');
        const srv = (over) => ({ name: 'S', url: 'https://a.example.com', password: 'password123', syncId: 'sync-1', dataDir: '/tmp/a', ...over });
        const run = (servers) => {
            const cfg = createMockConfig({ servers });
            loader.applyDefaults(cfg);
            loader.validateLogic(cfg);
        };
        const warned = (re) => console.warn.mock.calls.some(c => re.test(String(c[0])));

        test('warns when two servers share the same (url, syncId)', () => {
            run([srv({ name: 'One' }), srv({ name: 'Two', dataDir: '/tmp/b' })]);
            expect(warned(/same budget \(url \+ syncId\) is configured more than once/)).toBe(true);
        });

        test('a trailing-slash url difference is still detected as the same budget', () => {
            run([srv({ name: 'One', url: 'https://a.example.com' }), srv({ name: 'Two', url: 'https://a.example.com/', dataDir: '/tmp/b' })]);
            expect(warned(/same budget/)).toBe(true);
        });

        test('host case is normalized (same budget), path case is preserved (distinct)', () => {
            // Uppercase host = same budget (host is case-insensitive)
            run([srv({ name: 'One', url: 'https://Host.Example.com', syncId: 'sx' }), srv({ name: 'Two', url: 'https://host.example.com', syncId: 'sx', dataDir: '/tmp/b' })]);
            expect(warned(/same budget/)).toBe(true);
            console.warn.mockClear();
            // Different-case PATHS are treated as distinct (paths can be case-sensitive)
            run([srv({ name: 'A', url: 'https://h.example.com/Budget', syncId: 'sy' }), srv({ name: 'B', url: 'https://h.example.com/budget', syncId: 'sy', dataDir: '/tmp/b' })]);
            expect(warned(/same budget/)).toBe(false);
        });

        test('the same syncId on a DIFFERENT url is not flagged', () => {
            run([srv({ name: 'One', url: 'https://a.example.com' }), srv({ name: 'Two', url: 'https://b.example.com', dataDir: '/tmp/b' })]);
            expect(warned(/same budget/)).toBe(false);
        });

        test('warns when two servers share the same dataDir', () => {
            run([srv({ name: 'One', url: 'https://a.example.com', syncId: 's1' }), srv({ name: 'Two', url: 'https://b.example.com', syncId: 's2', dataDir: '/tmp/a' })]);
            expect(warned(/share the same data directory/)).toBe(true);
        });

        test('resolves dataDir paths so "./data" and "data" collide', () => {
            run([srv({ name: 'One', url: 'https://a.example.com', syncId: 's1', dataDir: './data' }), srv({ name: 'Two', url: 'https://b.example.com', syncId: 's2', dataDir: 'data' })]);
            expect(warned(/share the same data directory/)).toBe(true);
        });

        test('a clean multi-server config emits no budget/dataDir warning', () => {
            run([
                srv({ name: 'One', url: 'https://a.example.com', syncId: 's1', dataDir: '/tmp/a' }),
                srv({ name: 'Two', url: 'https://b.example.com', syncId: 's2', dataDir: '/tmp/b' })
            ]);
            expect(warned(/same budget|share the same data directory/)).toBe(false);
        });
    });

    describe('env-var single-server config (#120)', () => {
        const ENV_KEYS = [
            'ACTUAL_SYNC_SERVER_URL', 'ACTUAL_SYNC_SERVER_PASSWORD', 'ACTUAL_SYNC_SERVER_SYNC_ID',
            'ACTUAL_SYNC_SERVER_NAME', 'ACTUAL_SYNC_SERVER_DATA_DIR', 'ACTUAL_SYNC_SERVER_ENCRYPTION_PASSWORD',
            'ACTUAL_SYNC_SERVER_SCHEDULE'
        ];
        const saved = {};
        beforeEach(() => { ENV_KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; }); });
        afterEach(() => { ENV_KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

        const NO_SCHEMA = () => path.join(tempDir, 'no-schema.json'); // skips schema validation

        test('buildServerFromEnv returns null when required vars are missing', () => {
            expect(ConfigLoader.buildServerFromEnv({})).toBeNull();
            expect(ConfigLoader.buildServerFromEnv({ ACTUAL_SYNC_SERVER_URL: 'https://x' })).toBeNull();
        });

        test('buildServerFromEnv builds a server with sensible defaults', () => {
            const s = ConfigLoader.buildServerFromEnv({
                ACTUAL_SYNC_SERVER_URL: 'https://x', ACTUAL_SYNC_SERVER_PASSWORD: 'pw', ACTUAL_SYNC_SERVER_SYNC_ID: 'sid'
            });
            expect(s).toMatchObject({ name: 'Default', url: 'https://x', password: 'pw', syncId: 'sid', dataDir: 'data/default' });
            expect(s.encryptionPassword).toBeUndefined();
            expect(s.sync).toBeUndefined();
        });

        test('buildServerFromEnv honors optional name/dataDir/encryption/schedule', () => {
            const s = ConfigLoader.buildServerFromEnv({
                ACTUAL_SYNC_SERVER_URL: 'https://x', ACTUAL_SYNC_SERVER_PASSWORD: 'pw', ACTUAL_SYNC_SERVER_SYNC_ID: 'sid',
                ACTUAL_SYNC_SERVER_NAME: 'My Budget', ACTUAL_SYNC_SERVER_DATA_DIR: '/d',
                ACTUAL_SYNC_SERVER_ENCRYPTION_PASSWORD: 'e2e', ACTUAL_SYNC_SERVER_SCHEDULE: '0 2 * * *'
            });
            expect(s).toMatchObject({ name: 'My Budget', dataDir: '/d', encryptionPassword: 'e2e', sync: { schedule: '0 2 * * *' } });
        });

        test('hasEnvServerConfig reflects presence of the required vars', () => {
            expect(ConfigLoader.hasEnvServerConfig({})).toBe(false);
            expect(ConfigLoader.hasEnvServerConfig({ ACTUAL_SYNC_SERVER_URL: 'u', ACTUAL_SYNC_SERVER_PASSWORD: 'p', ACTUAL_SYNC_SERVER_SYNC_ID: 's' })).toBe(true);
        });

        test('load() runs with env-only config when no config.json exists', () => {
            process.env.ACTUAL_SYNC_SERVER_URL = 'https://env.example.com';
            process.env.ACTUAL_SYNC_SERVER_PASSWORD = 'password123';
            process.env.ACTUAL_SYNC_SERVER_SYNC_ID = 'env-sync';
            const loader = new ConfigLoader(path.join(tempDir, 'does-not-exist.json'), NO_SCHEMA());
            const cfg = loader.load();
            expect(cfg.servers).toHaveLength(1);
            expect(cfg.servers[0]).toMatchObject({ url: 'https://env.example.com', syncId: 'env-sync', name: 'Default' });
        });

        test('load() with neither a file nor env vars still throws not-found', () => {
            const loader = new ConfigLoader(path.join(tempDir, 'does-not-exist.json'), NO_SCHEMA());
            expect(() => loader.load()).toThrow(/Configuration file not found/);
        });

        test('load() merges the env server alongside a distinct config.json server', () => {
            process.env.ACTUAL_SYNC_SERVER_URL = 'https://env.example.com';
            process.env.ACTUAL_SYNC_SERVER_PASSWORD = 'password123';
            process.env.ACTUAL_SYNC_SERVER_SYNC_ID = 'env-sync';
            const fileCfg = createMockConfig({ servers: [{ name: 'File', url: 'https://file.example.com', password: 'password123', syncId: 'file-sync', dataDir: '/tmp/file' }] });
            const loader = new ConfigLoader(createTestConfigFile(tempDir, fileCfg), NO_SCHEMA());
            const cfg = loader.load();
            expect(cfg.servers.map(s => s.syncId).sort()).toEqual(['env-sync', 'file-sync']);
        });

        test('load() auto-renames the env server when its name collides with a different file budget', () => {
            // Env server defaults to name "Default"; file also has "Default" but a
            // DIFFERENT budget. Both must sync — the env entry is renamed, not a crash.
            process.env.ACTUAL_SYNC_SERVER_URL = 'https://env.example.com';
            process.env.ACTUAL_SYNC_SERVER_PASSWORD = 'password123';
            process.env.ACTUAL_SYNC_SERVER_SYNC_ID = 'env-sync';
            const fileCfg = createMockConfig({ servers: [{ name: 'Default', url: 'https://file.example.com', password: 'password123', syncId: 'file-sync', dataDir: '/tmp/file' }] });
            const loader = new ConfigLoader(createTestConfigFile(tempDir, fileCfg), NO_SCHEMA());
            const cfg = loader.load();
            expect(cfg.servers).toHaveLength(2);
            const names = cfg.servers.map(s => s.name);
            expect(new Set(names).size).toBe(2); // unique → validateLogic won't throw
            expect(names).toContain('Default');
            expect(names).toContain('Default (2)');
        });

        test('load() drops the env server when it duplicates a config.json budget (file wins)', () => {
            process.env.ACTUAL_SYNC_SERVER_URL = 'https://dup.example.com';
            process.env.ACTUAL_SYNC_SERVER_PASSWORD = 'password123';
            process.env.ACTUAL_SYNC_SERVER_SYNC_ID = 'dup-sync';
            // file entry has a trailing slash + different name but the same budget
            const fileCfg = createMockConfig({ servers: [{ name: 'File', url: 'https://dup.example.com/', password: 'password123', syncId: 'dup-sync', dataDir: '/tmp/file' }] });
            const loader = new ConfigLoader(createTestConfigFile(tempDir, fileCfg), NO_SCHEMA());
            const cfg = loader.load();
            expect(cfg.servers).toHaveLength(1);
            expect(cfg.servers[0].name).toBe('File');
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('already present in config.json'));
        });
    });
});

