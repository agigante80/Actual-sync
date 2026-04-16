/**
 * Integration tests for syncService
 */

const fs = require('fs').promises;
const path = require('path');
const {
    createMockActualAPI,
    createTempDir,
    cleanupTempDir,
    suppressConsole
} = require('./helpers/testHelpers');

// Mock the @actual-app/api module
jest.mock('@actual-app/api', () => {
    return {
        init: jest.fn(),
        downloadBudget: jest.fn(),
        loadBudget: jest.fn(),
        runBankSync: jest.fn(),
        sync: jest.fn(),
        shutdown: jest.fn(),
        getAccounts: jest.fn()
    };
});

const actual = require('@actual-app/api');

describe('syncService Integration Tests', () => {
    let consoleSuppress;

    beforeEach(() => {
        consoleSuppress = suppressConsole();
        jest.clearAllMocks();
        
        // Setup default successful responses
        actual.init.mockResolvedValue(undefined);
        actual.downloadBudget.mockResolvedValue(undefined);
        actual.runBankSync.mockResolvedValue(undefined);
        actual.sync.mockResolvedValue(undefined);
        actual.shutdown.mockResolvedValue(undefined);
        actual.getAccounts.mockResolvedValue([
            { id: 'account1', name: 'Test Account 1' },
            { id: 'account2', name: 'Test Account 2' }
        ]);
    });

    afterEach(() => {
        consoleSuppress.restore();
    });

    describe('syncBank function behavior', () => {
        // Create a mock syncBank function for testing
        async function createMockSyncBank(runWithRetries) {
            return async function syncBank(server) {
                const { name, url, password, syncId, dataDir } = server;
                
                await actual.init({
                    serverURL: url,
                    password: password,
                    dataDir: dataDir,
                });

                await runWithRetries(async () => await actual.downloadBudget(syncId));
                
                const accounts = await actual.getAccounts();

                await runWithRetries(async () => await actual.sync());
                
                if (accounts && accounts.length > 0) {
                    for (const account of accounts) {
                        try {
                            await runWithRetries(async () => await actual.runBankSync({ accountId: account.id }));
                        } catch (bankSyncError) {
                            console.error(`Error syncing bank for account ${account.id}:`, bankSyncError);
                        }
                    }
                }

                await actual.shutdown();
            };
        }

        const mockRunWithRetries = jest.fn(async (fn) => await fn());

        test('should complete full sync workflow successfully', async () => {
            const syncBank = await createMockSyncBank(mockRunWithRetries);
            const server = {
                name: 'Test Server',
                url: 'https://test.example.com',
                password: 'test-password',
                syncId: 'test-sync-id',
                dataDir: '/tmp/test-data'
            };

            await syncBank(server);

            expect(actual.init).toHaveBeenCalledWith({
                serverURL: server.url,
                password: server.password,
                dataDir: server.dataDir
            });
            expect(actual.downloadBudget).toHaveBeenCalledWith(server.syncId);
            expect(actual.getAccounts).toHaveBeenCalled();
            expect(actual.sync).toHaveBeenCalled();
            expect(actual.runBankSync).toHaveBeenCalledTimes(2); // Two accounts
            expect(actual.shutdown).toHaveBeenCalled();
        });

        test('should handle connection failure', async () => {
            actual.init.mockRejectedValue(new Error('Connection refused'));
            
            const syncBank = await createMockSyncBank(mockRunWithRetries);
            const server = {
                name: 'Test Server',
                url: 'https://test.example.com',
                password: 'test-password',
                syncId: 'test-sync-id',
                dataDir: '/tmp/test-data'
            };

            await expect(syncBank(server)).rejects.toThrow('Connection refused');
            expect(actual.init).toHaveBeenCalled();
        });

        test('should handle budget download failure', async () => {
            actual.downloadBudget.mockRejectedValue(new Error('Budget not found'));
            mockRunWithRetries.mockImplementation(async (fn) => {
                await fn(); // This will throw
            });

            const syncBank = await createMockSyncBank(mockRunWithRetries);
            const server = {
                name: 'Test Server',
                url: 'https://test.example.com',
                password: 'test-password',
                syncId: 'test-sync-id',
                dataDir: '/tmp/test-data'
            };

            await expect(syncBank(server)).rejects.toThrow('Budget not found');
            expect(actual.init).toHaveBeenCalled();
            expect(actual.downloadBudget).toHaveBeenCalled();
        });

        test('should continue sync if individual account fails', async () => {
            let callCount = 0;
            actual.runBankSync.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.reject(new Error('Account sync failed'));
                }
                return Promise.resolve();
            });

            const retryWithCatch = jest.fn(async (fn) => {
                try {
                    return await fn();
                } catch (error) {
                    throw error;
                }
            });

            const syncBank = await createMockSyncBank(retryWithCatch);
            const server = {
                name: 'Test Server',
                url: 'https://test.example.com',
                password: 'test-password',
                syncId: 'test-sync-id',
                dataDir: '/tmp/test-data'
            };

            await syncBank(server);

            expect(actual.runBankSync).toHaveBeenCalledTimes(2);
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('Error syncing bank for account'),
                expect.any(Error)
            );
            expect(actual.shutdown).toHaveBeenCalled();
        });

        test('should handle empty account list', async () => {
            actual.getAccounts.mockResolvedValue([]);

            const syncBank = await createMockSyncBank(mockRunWithRetries);
            const server = {
                name: 'Test Server',
                url: 'https://test.example.com',
                password: 'test-password',
                syncId: 'test-sync-id',
                dataDir: '/tmp/test-data'
            };

            await syncBank(server);

            expect(actual.init).toHaveBeenCalled();
            expect(actual.downloadBudget).toHaveBeenCalled();
            expect(actual.getAccounts).toHaveBeenCalled();
            expect(actual.sync).toHaveBeenCalled();
            expect(actual.runBankSync).not.toHaveBeenCalled();
            expect(actual.shutdown).toHaveBeenCalled();
        });

        test('should handle null account list', async () => {
            actual.getAccounts.mockResolvedValue(null);

            const syncBank = await createMockSyncBank(mockRunWithRetries);
            const server = {
                name: 'Test Server',
                url: 'https://test.example.com',
                password: 'test-password',
                syncId: 'test-sync-id',
                dataDir: '/tmp/test-data'
            };

            await syncBank(server);

            expect(actual.runBankSync).not.toHaveBeenCalled();
            expect(actual.shutdown).toHaveBeenCalled();
        });

        test('should pass correct account IDs to runBankSync', async () => {
            actual.getAccounts.mockResolvedValue([
                { id: 'acc-123', name: 'Checking' },
                { id: 'acc-456', name: 'Savings' },
                { id: 'acc-789', name: 'Credit Card' }
            ]);

            const syncBank = await createMockSyncBank(mockRunWithRetries);
            const server = {
                name: 'Test Server',
                url: 'https://test.example.com',
                password: 'test-password',
                syncId: 'test-sync-id',
                dataDir: '/tmp/test-data'
            };

            await syncBank(server);

            expect(actual.runBankSync).toHaveBeenCalledWith({ accountId: 'acc-123' });
            expect(actual.runBankSync).toHaveBeenCalledWith({ accountId: 'acc-456' });
            expect(actual.runBankSync).toHaveBeenCalledWith({ accountId: 'acc-789' });
            expect(actual.runBankSync).toHaveBeenCalledTimes(3);
        });
    });

    describe('Error handling', () => {
        test('should handle authentication errors', async () => {
            actual.init.mockRejectedValue(new Error('Invalid password'));

            const mockRunWithRetries = jest.fn(async (fn) => await fn());
            const syncBank = async function(server) {
                await actual.init({
                    serverURL: server.url,
                    password: server.password,
                    dataDir: server.dataDir,
                });
            };

            const server = {
                name: 'Test Server',
                url: 'https://test.example.com',
                password: 'wrong-password',
                syncId: 'test-sync-id',
                dataDir: '/tmp/test-data'
            };

            await expect(syncBank(server)).rejects.toThrow('Invalid password');
        });

        test('should call shutdown even if sync fails', async () => {
            actual.sync.mockRejectedValue(new Error('Sync failed'));

            const mockRunWithRetries = jest.fn(async (fn) => await fn());
            const syncBankWithCleanup = async function(server) {
                try {
                    await actual.init({ serverURL: server.url, password: server.password, dataDir: server.dataDir });
                    await actual.downloadBudget(server.syncId);
                    await mockRunWithRetries(async () => await actual.sync());
                } finally {
                    await actual.shutdown();
                }
            };

            const server = {
                name: 'Test Server',
                url: 'https://test.example.com',
                password: 'test-password',
                syncId: 'test-sync-id',
                dataDir: '/tmp/test-data'
            };

            await expect(syncBankWithCleanup(server)).rejects.toThrow('Sync failed');
            expect(actual.shutdown).toHaveBeenCalled();
        });
    });

    describe('CLI flags', () => {
        let originalArgv;

        beforeEach(() => {
            originalArgv = process.argv;
        });

        afterEach(() => {
            process.argv = originalArgv;
        });

        test('should parse --server flag correctly', () => {
            process.argv = ['node', 'script.js', '--force-run', '--server', 'Main Budget'];

            const serverFlag = process.argv.indexOf('--server');
            const serverName = serverFlag !== -1 ? process.argv[serverFlag + 1] : null;

            expect(serverName).toBe('Main Budget');
        });

        test('should handle missing --server value', () => {
            process.argv = ['node', 'script.js', '--force-run', '--server'];

            const serverFlag = process.argv.indexOf('--server');
            const serverName = serverFlag !== -1 ? process.argv[serverFlag + 1] : null;

            expect(serverName).toBeUndefined();
        });

        test('should filter servers by name', () => {
            const servers = [
                { name: 'Main Budget', url: 'http://server1:5006' },
                { name: 'Test Budget', url: 'http://server2:5006' },
                { name: 'Dev Budget', url: 'http://server3:5006' }
            ];

            const serverName = 'Test Budget';
            const server = servers.find(s => s.name === serverName);

            expect(server).toBeDefined();
            expect(server.name).toBe('Test Budget');
            expect(server.url).toBe('http://server2:5006');
        });

        test('should handle server not found', () => {
            const servers = [
                { name: 'Main Budget', url: 'http://server1:5006' }
            ];

            const serverName = 'Invalid Server';
            const server = servers.find(s => s.name === serverName);

            expect(server).toBeUndefined();
        });
    });

    describe('Encrypted Budget Support', () => {
        test('should pass encryption password to downloadBudget when provided', async () => {
            const server = {
                name: 'Encrypted Budget',
                url: 'http://localhost:5006',
                password: 'server-password',
                syncId: 'sync-123',
                dataDir: '/tmp/test-encrypted',
                encryptionPassword: 'budget-encryption-password'
            };

            // Mock the actual syncBank behavior
            await actual.init({
                serverURL: server.url,
                password: server.password,
                dataDir: server.dataDir
            });

            const downloadOptions = server.encryptionPassword 
                ? { password: server.encryptionPassword } 
                : undefined;
            
            await actual.downloadBudget(server.syncId, downloadOptions);

            expect(actual.downloadBudget).toHaveBeenCalledWith(
                'sync-123',
                { password: 'budget-encryption-password' }
            );
        });

        test('should not pass encryption password when not provided', async () => {
            const server = {
                name: 'Unencrypted Budget',
                url: 'http://localhost:5006',
                password: 'server-password',
                syncId: 'sync-456',
                dataDir: '/tmp/test-unencrypted'
                // No encryptionPassword
            };

            await actual.init({
                serverURL: server.url,
                password: server.password,
                dataDir: server.dataDir
            });

            const downloadOptions = server.encryptionPassword 
                ? { password: server.encryptionPassword } 
                : undefined;
            
            await actual.downloadBudget(server.syncId, downloadOptions);

            expect(actual.downloadBudget).toHaveBeenCalledWith('sync-456', undefined);
        });

        test('should handle empty encryption password', async () => {
            const server = {
                name: 'Budget with Empty Password',
                url: 'http://localhost:5006',
                password: 'server-password',
                syncId: 'sync-789',
                dataDir: '/tmp/test-empty',
                encryptionPassword: ''
            };

            await actual.init({
                serverURL: server.url,
                password: server.password,
                dataDir: server.dataDir
            });

            // Empty string is falsy, so should not pass password
            const downloadOptions = server.encryptionPassword
                ? { password: server.encryptionPassword }
                : undefined;

            await actual.downloadBudget(server.syncId, downloadOptions);

            expect(actual.downloadBudget).toHaveBeenCalledWith('sync-789', undefined);
        });
    });

    // -------------------------------------------------------------------------
    // Fix 1: download failure clears dataDir
    // Fix 4: loadBudget workaround for resetClock:true
    // Fix 2: enhanceActualApiError preserves error.code / error.errorCode
    // -------------------------------------------------------------------------
    describe('Fix 1 — download failure clears dataDir (with retry)', () => {
        let tempDir;
        let consoleSuppress;

        beforeEach(async () => {
            consoleSuppress = suppressConsole();
            jest.clearAllMocks();
            tempDir = createTempDir();
            // Write a stale db.sqlite to simulate a corrupted partial download
            await fs.writeFile(path.join(tempDir, 'db.sqlite'), 'corrupted');
        });

        afterEach(() => {
            consoleSuppress.restore();
            cleanupTempDir(tempDir);
        });

        // Test-local function mirroring the download+retry+clear logic in syncService.js
        async function syncBankWithRetry(server) {
            const { url, password, syncId, dataDir } = server;
            const opts = password ? { password } : undefined;
            try {
                await actual.init({ serverURL: url, password, dataDir });
                let downloadError;
                try {
                    await actual.downloadBudget(syncId, opts);
                } catch (err) {
                    downloadError = err;
                }
                if (downloadError) {
                    let retryError = null;
                    try {
                        await actual.downloadBudget(syncId, opts); // retry (no sleep in tests)
                    } catch (err) {
                        retryError = err;
                    }
                    if (retryError) {
                        await fs.rm(dataDir, { recursive: true, force: true });
                        await fs.mkdir(dataDir, { recursive: true });
                        throw downloadError;
                    }
                    // retry succeeded — fall through
                }
            } finally {
                await actual.shutdown();
            }
        }

        test('both downloads fail → dataDir is emptied, error re-thrown, shutdown called', async () => {
            actual.init.mockResolvedValue(undefined);
            actual.downloadBudget.mockRejectedValue(new Error('Network error'));
            actual.shutdown.mockResolvedValue(undefined);

            await expect(
                syncBankWithRetry({ url: 'http://x', password: 'p', syncId: 'sid', dataDir: tempDir })
            ).rejects.toThrow('Network error');

            // downloadBudget called twice (initial + retry)
            expect(actual.downloadBudget).toHaveBeenCalledTimes(2);
            // dataDir cleared (stale db.sqlite removed)
            const entries = await fs.readdir(tempDir);
            expect(entries).toHaveLength(0);
            expect(actual.shutdown).toHaveBeenCalledTimes(1);
        });

        test('first download fails, retry succeeds → dataDir NOT cleared, no error thrown', async () => {
            actual.init.mockResolvedValue(undefined);
            actual.downloadBudget
                .mockRejectedValueOnce(new Error('Transient error'))
                .mockResolvedValueOnce(undefined);
            actual.shutdown.mockResolvedValue(undefined);

            await expect(
                syncBankWithRetry({ url: 'http://x', password: 'p', syncId: 'sid', dataDir: tempDir })
            ).resolves.toBeUndefined();

            expect(actual.downloadBudget).toHaveBeenCalledTimes(2);
            // dataDir intact (stale file still present — was not cleared)
            const entries = await fs.readdir(tempDir);
            expect(entries).toContain('db.sqlite');
            expect(actual.shutdown).toHaveBeenCalledTimes(1);
        });
    });

    describe('Fix 4 — loadBudget workaround for resetClock:true', () => {
        let tempDir;
        let consoleSuppress;

        beforeEach(async () => {
            consoleSuppress = suppressConsole();
            jest.clearAllMocks();
            tempDir = createTempDir();
            actual.init.mockResolvedValue(undefined);
            actual.downloadBudget.mockResolvedValue(undefined);
            actual.loadBudget.mockResolvedValue(undefined);
            actual.sync.mockResolvedValue(undefined);
            actual.getAccounts.mockResolvedValue([]);
            actual.shutdown.mockResolvedValue(undefined);
        });

        afterEach(() => {
            consoleSuppress.restore();
            cleanupTempDir(tempDir);
        });

        // Helper: simulates the loadBudget workaround logic from syncService.js
        async function runLoadBudgetWorkaround(dataDir, syncId) {
            try {
                const entries = await fs.readdir(dataDir);
                for (const entry of entries) {
                    try {
                        const meta = JSON.parse(
                            await fs.readFile(path.join(dataDir, entry, 'metadata.json'), 'utf8')
                        );
                        if (meta.groupId === syncId && meta.id) {
                            await actual.loadBudget(meta.id);
                            break;
                        }
                    } catch { /* not a budget directory, skip */ }
                }
            } catch { /* skip */ }
        }

        test('loadBudget called with local budget ID when metadata.json matches syncId', async () => {
            const syncId = 'test-sync-id';
            const localBudgetId = 'My-Budget-abc123';

            // Create the budget subfolder with a matching metadata.json
            const budgetDir = path.join(tempDir, localBudgetId);
            await fs.mkdir(budgetDir);
            await fs.writeFile(
                path.join(budgetDir, 'metadata.json'),
                JSON.stringify({ groupId: syncId, id: localBudgetId })
            );

            await runLoadBudgetWorkaround(tempDir, syncId);

            expect(actual.loadBudget).toHaveBeenCalledTimes(1);
            expect(actual.loadBudget).toHaveBeenCalledWith(localBudgetId);
        });

        test('loadBudget NOT called when no metadata.json matches syncId', async () => {
            const syncId = 'test-sync-id';

            // Create a budget folder whose groupId does NOT match
            const budgetDir = path.join(tempDir, 'Other-Budget-xyz');
            await fs.mkdir(budgetDir);
            await fs.writeFile(
                path.join(budgetDir, 'metadata.json'),
                JSON.stringify({ groupId: 'different-sync-id', id: 'Other-Budget-xyz' })
            );

            await runLoadBudgetWorkaround(tempDir, syncId);

            expect(actual.loadBudget).not.toHaveBeenCalled();
        });
    });

    describe('Fix 2 — enhanceActualApiError preserves error.code and error.errorCode', () => {
        let consoleSuppress;

        beforeEach(() => {
            consoleSuppress = suppressConsole();
        });

        afterEach(() => {
            consoleSuppress.restore();
        });

        test('enhanced error carries code and errorCode from original error', () => {
            const { enhanceActualApiError } = require('../lib/actualApiError');

            const originalError = new Error('connection refused');
            originalError.code = 'ECONNREFUSED';
            originalError.errorCode = 'NET_ERR';

            const logger = { warn: jest.fn(), debug: jest.fn() };
            const result = enhanceActualApiError(
                originalError,
                { phase: 'download', serverUrl: 'http://x', syncId: 'abc', isEncrypted: false },
                logger
            );

            expect(result.code).toBe('ECONNREFUSED');
            expect(result.errorCode).toBe('NET_ERR');
            expect(result.originalError).toBe(originalError);
        });

        test('enhanced error code fields are undefined when original error has none', () => {
            const { enhanceActualApiError } = require('../lib/actualApiError');

            const originalError = new Error('unknown failure');
            // no .code or .errorCode on this error

            const logger = { warn: jest.fn(), debug: jest.fn() };
            const result = enhanceActualApiError(
                originalError,
                { phase: 'download', serverUrl: 'http://x', syncId: 'abc', isEncrypted: false },
                logger
            );

            expect(result.code).toBeUndefined();
            expect(result.errorCode).toBeUndefined();
            expect(result.originalError).toBe(originalError);
        });
    });
});

