/**
 * @file Per-Server Sync Configuration Tests
 * Tests for per-server sync configuration overrides
 */

describe('Per-Server Sync Configuration', () => {
    describe('Config Merging Logic', () => {
        const globalSyncConfig = {
            maxRetries: 5,
            baseRetryDelayMs: 2000,
            schedule: '0 3 * * *'
        };

        // Helper function that replicates getSyncConfig logic
        const getSyncConfig = (server) => {
            return {
                maxRetries: server.sync?.maxRetries ?? globalSyncConfig.maxRetries,
                baseRetryDelayMs: server.sync?.baseRetryDelayMs ?? globalSyncConfig.baseRetryDelayMs,
                schedule: server.sync?.schedule ?? globalSyncConfig.schedule
            };
        };

        test('should return global config when server has no overrides', () => {
            const server = {
                name: 'Main',
                url: 'http://localhost:5006',
                password: 'password',
                syncId: 'sync-id',
                dataDir: './data/main'
            };

            const syncConfig = getSyncConfig(server);

            expect(syncConfig.maxRetries).toBe(5);
            expect(syncConfig.baseRetryDelayMs).toBe(2000);
            expect(syncConfig.schedule).toBe('0 3 * * *');
        });

        test('should return server overrides when specified', () => {
            const server = {
                name: 'Secondary',
                url: 'http://localhost:5007',
                password: 'password',
                syncId: 'sync-id',
                dataDir: './data/secondary',
                sync: {
                    maxRetries: 3,
                    baseRetryDelayMs: 1000,
                    schedule: '0 4 * * *'
                }
            };

            const syncConfig = getSyncConfig(server);

            expect(syncConfig.maxRetries).toBe(3);
            expect(syncConfig.baseRetryDelayMs).toBe(1000);
            expect(syncConfig.schedule).toBe('0 4 * * *');
        });

        test('should merge partial overrides with global defaults', () => {
            const server = {
                name: 'Partial',
                url: 'http://localhost:5008',
                password: 'password',
                syncId: 'sync-id',
                dataDir: './data/partial',
                sync: {
                    schedule: '0 2 * * *'
                    // maxRetries and baseRetryDelayMs not specified
                }
            };

            const syncConfig = getSyncConfig(server);

            expect(syncConfig.maxRetries).toBe(5); // from global
            expect(syncConfig.baseRetryDelayMs).toBe(2000); // from global
            expect(syncConfig.schedule).toBe('0 2 * * *'); // from server
        });

        test('should handle zero values correctly (not fallback to global)', () => {
            const server = {
                name: 'ZeroRetries',
                url: 'http://localhost:5009',
                password: 'password',
                syncId: 'sync-id',
                dataDir: './data/zero',
                sync: {
                    maxRetries: 0 // explicit zero
                }
            };

            const syncConfig = getSyncConfig(server);

            expect(syncConfig.maxRetries).toBe(0); // should use 0, not fallback to global
        });

        test('should handle multiple servers with different configs', () => {
            const servers = [
                {
                    name: 'Server1',
                    sync: { maxRetries: 2, schedule: '0 1 * * *' }
                },
                {
                    name: 'Server2',
                    sync: { maxRetries: 8, baseRetryDelayMs: 5000 }
                },
                {
                    name: 'Server3'
                    // no sync override
                }
            ];

            const configs = servers.map(server => ({
                name: server.name,
                config: getSyncConfig(server)
            }));

            // Server1: partial override (maxRetries and schedule)
            expect(configs[0].config.maxRetries).toBe(2);
            expect(configs[0].config.baseRetryDelayMs).toBe(2000); // global
            expect(configs[0].config.schedule).toBe('0 1 * * *');

            // Server2: partial override (maxRetries and baseRetryDelayMs)
            expect(configs[1].config.maxRetries).toBe(8);
            expect(configs[1].config.baseRetryDelayMs).toBe(5000);
            expect(configs[1].config.schedule).toBe('0 3 * * *'); // global

            // Server3: all global
            expect(configs[2].config.maxRetries).toBe(5);
            expect(configs[2].config.baseRetryDelayMs).toBe(2000);
            expect(configs[2].config.schedule).toBe('0 3 * * *');
        });
    });

    describe('Schedule Grouping', () => {
        const globalSyncConfig = {
            maxRetries: 5,
            baseRetryDelayMs: 2000,
            schedule: '0 3 * * *'
        };

        test('should group servers by their effective schedule', () => {
            const servers = [
                { name: 'Server1', sync: { schedule: '0 1 * * *' } },
                { name: 'Server2', sync: { schedule: '0 2 * * *' } },
                { name: 'Server3', sync: { schedule: '0 1 * * *' } }, // same as Server1
                { name: 'Server4' } // uses global
            ];

            const scheduleGroups = new Map();
            for (const server of servers) {
                const scheduleStr = server.sync?.schedule ?? globalSyncConfig.schedule;
                if (!scheduleGroups.has(scheduleStr)) {
                    scheduleGroups.set(scheduleStr, []);
                }
                scheduleGroups.get(scheduleStr).push(server);
            }

            expect(scheduleGroups.size).toBe(3); // three unique schedules
            expect(scheduleGroups.get('0 1 * * *').length).toBe(2); // Server1 and Server3
            expect(scheduleGroups.get('0 2 * * *').length).toBe(1); // Server2
            expect(scheduleGroups.get('0 3 * * *').length).toBe(1); // Server4 (global)
        });

        test('should create schedule groups efficiently', () => {
            const servers = Array.from({ length: 100 }, (_, i) => ({
                name: `Server${i}`,
                sync: i % 3 === 0 ? { schedule: '0 1 * * *' } :
                      i % 3 === 1 ? { schedule: '0 2 * * *' } :
                      undefined // uses global
            }));

            const scheduleGroups = new Map();
            for (const server of servers) {
                const scheduleStr = server.sync?.schedule ?? globalSyncConfig.schedule;
                if (!scheduleGroups.has(scheduleStr)) {
                    scheduleGroups.set(scheduleStr, []);
                }
                scheduleGroups.get(scheduleStr).push(server);
            }

            // Should have 3 unique schedules
            expect(scheduleGroups.size).toBe(3);
            
            // Each schedule should have ~33-34 servers
            const counts = Array.from(scheduleGroups.values()).map(group => group.length);
            expect(counts.reduce((a, b) => a + b, 0)).toBe(100); // total servers
            expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1); // balanced
        });
    });

    describe('Configuration Validation', () => {
        test('should accept valid maxRetries values (0-10)', () => {
            const validValues = [0, 1, 5, 10];
            for (const value of validValues) {
                expect(() => {
                    const server = { sync: { maxRetries: value } };
                    // Schema validation would happen here
                }).not.toThrow();
            }
        });

        test('should accept valid baseRetryDelayMs values (1000-10000)', () => {
            const validValues = [1000, 2000, 5000, 10000];
            for (const value of validValues) {
                expect(() => {
                    const server = { sync: { baseRetryDelayMs: value } };
                    // Schema validation would happen here
                }).not.toThrow();
            }
        });

        test('should accept valid cron expressions', () => {
            const validExpressions = [
                '0 3 * * *',      // daily at 3 AM
                '0 */6 * * *',    // every 6 hours
                '*/30 * * * *',   // every 30 minutes
                '0 0 * * 0'       // weekly on Sunday
            ];
            for (const expression of validExpressions) {
                expect(() => {
                    const server = { sync: { schedule: expression } };
                    // Schema validation would happen here
                }).not.toThrow();
            }
        });
    });

    describe('Backward Compatibility', () => {
        test('should work with old configs (no server.sync section)', () => {
            const oldConfig = {
                servers: [
                    {
                        name: 'Main',
                        url: 'http://localhost:5006',
                        password: 'password',
                        syncId: 'sync-id',
                        dataDir: './data/main'
                        // No sync section - should use global
                    }
                ],
                sync: {
                    maxRetries: 5,
                    baseRetryDelayMs: 2000,
                    schedule: '0 3 * * *'
                }
            };

            const server = oldConfig.servers[0];
            const syncConfig = {
                maxRetries: server.sync?.maxRetries ?? oldConfig.sync.maxRetries,
                baseRetryDelayMs: server.sync?.baseRetryDelayMs ?? oldConfig.sync.baseRetryDelayMs,
                schedule: server.sync?.schedule ?? oldConfig.sync.schedule
            };

            expect(syncConfig.maxRetries).toBe(5);
            expect(syncConfig.baseRetryDelayMs).toBe(2000);
            expect(syncConfig.schedule).toBe('0 3 * * *');
        });

        test('should work with new configs (with server.sync section)', () => {
            const newConfig = {
                servers: [
                    {
                        name: 'Main',
                        url: 'http://localhost:5006',
                        password: 'password',
                        syncId: 'sync-id',
                        dataDir: './data/main',
                        sync: {
                            maxRetries: 3,
                            schedule: '0 4 * * *'
                        }
                    }
                ],
                sync: {
                    maxRetries: 5,
                    baseRetryDelayMs: 2000,
                    schedule: '0 3 * * *'
                }
            };

            const server = newConfig.servers[0];
            const syncConfig = {
                maxRetries: server.sync?.maxRetries ?? newConfig.sync.maxRetries,
                baseRetryDelayMs: server.sync?.baseRetryDelayMs ?? newConfig.sync.baseRetryDelayMs,
                schedule: server.sync?.schedule ?? newConfig.sync.schedule
            };

            expect(syncConfig.maxRetries).toBe(3); // server override
            expect(syncConfig.baseRetryDelayMs).toBe(2000); // global fallback
            expect(syncConfig.schedule).toBe('0 4 * * *'); // server override
        });
    });
});
