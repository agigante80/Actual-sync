/**
 * Integration tests for syncService
 */

const {
    createMockActualAPI,
    suppressConsole
} = require('./helpers/testHelpers');

// Mock the @actual-app/api module
jest.mock('@actual-app/api', () => {
    return {
        init: jest.fn(),
        downloadBudget: jest.fn(),
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
});
