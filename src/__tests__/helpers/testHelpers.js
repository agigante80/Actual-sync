/**
 * Test helpers and utilities
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a temporary test directory
 * @returns {string} Path to temp directory
 */
function createTempDir() {
    const tempDir = path.join(__dirname, '../../../test-temp', `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
}

/**
 * Clean up temporary directory
 * @param {string} dir - Directory to remove
 */
function cleanupTempDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Create a mock configuration object
 * @param {Object} overrides - Properties to override
 * @returns {Object} Mock configuration
 */
function createMockConfig(overrides = {}) {
    return {
        servers: [
            {
                name: 'Test Server',
                url: 'https://test.example.com',
                password: 'test-password-123',
                syncId: 'test-sync-id',
                dataDir: '/tmp/test-data'
            }
        ],
        sync: {
            maxRetries: 3,
            baseRetryDelayMs: 1000,
            schedule: '0 0 * * *'
        },
        logging: {
            level: 'info'
        },
        ...overrides
    };
}

/**
 * Create a mock Actual API instance
 * @returns {Object} Mock API
 */
function createMockActualAPI() {
    return {
        init: jest.fn().mockResolvedValue(undefined),
        downloadBudget: jest.fn().mockResolvedValue(undefined),
        runBankSync: jest.fn().mockResolvedValue(undefined),
        sync: jest.fn().mockResolvedValue(undefined),
        shutdown: jest.fn().mockResolvedValue(undefined),
        getAccounts: jest.fn().mockResolvedValue([
            { id: 'account1', name: 'Test Account 1' },
            { id: 'account2', name: 'Test Account 2' }
        ])
    };
}

/**
 * Create a test configuration file
 * @param {string} dir - Directory to create file in
 * @param {Object} config - Configuration object
 * @returns {string} Path to config file
 */
function createTestConfigFile(dir, config) {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
}

/**
 * Create a test schema file
 * @param {string} dir - Directory to create file in
 * @returns {string} Path to schema file
 */
function createTestSchemaFile(dir) {
    const schemaPath = path.join(dir, 'config.schema.json');
    const schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "required": ["servers"],
        "properties": {
            "servers": {
                "type": "array",
                "minItems": 1
            },
            "sync": {
                "type": "object"
            },
            "logging": {
                "type": "object"
            }
        }
    };
    fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
    return schemaPath;
}

/**
 * Suppress console output during tests
 * @returns {Object} Object with restore function
 */
function suppressConsole() {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();

    return {
        restore: () => {
            console.log = originalLog;
            console.warn = originalWarn;
            console.error = originalError;
        }
    };
}

/**
 * Wait for a specified time
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise}
 */
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    createTempDir,
    cleanupTempDir,
    createMockConfig,
    createMockActualAPI,
    createTestConfigFile,
    createTestSchemaFile,
    suppressConsole,
    wait
};
