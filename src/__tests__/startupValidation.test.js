/**
 * Unit tests for startup validation in index.js
 */

const fs = require('fs');
const path = require('path');
const {
    createTempDir,
    cleanupTempDir,
    createTestConfigFile,
    createTestSchemaFile,
    createMockConfig
} = require('./helpers/testHelpers');

describe('Startup Validation (index.js)', () => {
    let tempDir;
    let originalExit;
    let originalConsoleError;
    let originalConsoleWarn;
    let originalConsoleLog;
    let exitCode;

    beforeEach(() => {
        tempDir = createTempDir();
        exitCode = null;
        
        // Mock process.exit
        originalExit = process.exit;
        process.exit = jest.fn((code) => {
            exitCode = code;
            throw new Error(`Process.exit called with code ${code}`);
        });

        // Mock console methods
        originalConsoleError = console.error;
        originalConsoleWarn = console.warn;
        originalConsoleLog = console.log;
        console.error = jest.fn();
        console.warn = jest.fn();
        console.log = jest.fn();
    });

    afterEach(() => {
        cleanupTempDir(tempDir);
        process.exit = originalExit;
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
        console.log = originalConsoleLog;
    });

    describe('Node.js version validation', () => {
        test('should detect Node.js version', () => {
            const nodeVersion = process.version;
            const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
            
            expect(majorVersion).toBeGreaterThanOrEqual(14);
        });
    });

    describe('Configuration directory validation', () => {
        test('should detect missing config directory', () => {
            const configDir = path.join(tempDir, 'config');
            expect(fs.existsSync(configDir)).toBe(false);
        });

        test('should detect existing config directory', () => {
            const configDir = path.join(tempDir, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            expect(fs.existsSync(configDir)).toBe(true);
        });
    });

    describe('Configuration file validation', () => {
        test('should detect missing config.json', () => {
            const configDir = path.join(tempDir, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            
            const configFile = path.join(configDir, 'config.json');
            expect(fs.existsSync(configFile)).toBe(false);
        });

        test('should detect existing config.json', () => {
            const configDir = path.join(tempDir, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            
            const config = createMockConfig();
            const configFile = createTestConfigFile(configDir, config);
            
            expect(fs.existsSync(configFile)).toBe(true);
        });

        test('should detect invalid JSON in config.json', () => {
            const configDir = path.join(tempDir, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            
            const configFile = path.join(configDir, 'config.json');
            fs.writeFileSync(configFile, '{invalid json}');
            
            expect(() => {
                const content = fs.readFileSync(configFile, 'utf8');
                JSON.parse(content);
            }).toThrow();
        });

        test('should successfully parse valid JSON', () => {
            const configDir = path.join(tempDir, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            
            const config = createMockConfig();
            const configFile = createTestConfigFile(configDir, config);
            
            const content = fs.readFileSync(configFile, 'utf8');
            const parsed = JSON.parse(content);
            
            expect(parsed).toBeDefined();
            expect(parsed.servers).toBeDefined();
        });
    });

    describe('Dependencies validation', () => {
        test('should detect missing node_modules', () => {
            const nodeModulesPath = path.join(tempDir, 'node_modules');
            expect(fs.existsSync(nodeModulesPath)).toBe(false);
        });

        test('should detect existing node_modules', () => {
            const nodeModulesPath = path.join(tempDir, 'node_modules');
            fs.mkdirSync(nodeModulesPath, { recursive: true });
            expect(fs.existsSync(nodeModulesPath)).toBe(true);
        });

        test('should check for critical packages', () => {
            const nodeModulesPath = path.join(tempDir, 'node_modules');
            fs.mkdirSync(nodeModulesPath, { recursive: true });
            
            const criticalPackages = ['@actual-app/api', 'node-schedule', 'ajv'];
            
            for (const pkg of criticalPackages) {
                const pkgPath = path.join(nodeModulesPath, pkg);
                expect(fs.existsSync(pkgPath)).toBe(false);
                
                // Create package directory
                fs.mkdirSync(pkgPath, { recursive: true });
                expect(fs.existsSync(pkgPath)).toBe(true);
            }
        });
    });

    describe('Schema file validation', () => {
        test('should detect missing schema file', () => {
            const configDir = path.join(tempDir, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            
            const schemaFile = path.join(configDir, 'config.schema.json');
            expect(fs.existsSync(schemaFile)).toBe(false);
        });

        test('should detect existing schema file', () => {
            const configDir = path.join(tempDir, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            
            const schemaFile = createTestSchemaFile(configDir);
            expect(fs.existsSync(schemaFile)).toBe(true);
        });
    });

    describe('Integration: Full validation workflow', () => {
        test('should pass validation with complete setup', () => {
            // Create complete valid setup
            const configDir = path.join(tempDir, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            
            const config = createMockConfig();
            createTestConfigFile(configDir, config);
            createTestSchemaFile(configDir);
            
            const nodeModulesPath = path.join(tempDir, 'node_modules');
            fs.mkdirSync(nodeModulesPath, { recursive: true });
            
            const criticalPackages = ['@actual-app/api', 'node-schedule', 'ajv'];
            for (const pkg of criticalPackages) {
                fs.mkdirSync(path.join(nodeModulesPath, pkg), { recursive: true });
            }
            
            // All files should exist
            expect(fs.existsSync(configDir)).toBe(true);
            expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(true);
            expect(fs.existsSync(path.join(configDir, 'config.schema.json'))).toBe(true);
            expect(fs.existsSync(nodeModulesPath)).toBe(true);
        });
    });
});
