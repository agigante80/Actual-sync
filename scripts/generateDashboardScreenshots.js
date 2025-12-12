#!/usr/bin/env node

/**
 * Dashboard Screenshot Generator
 * 
 * Generates screenshots of the Actual-sync dashboard with sample data
 * for documentation purposes. Can be re-run when dashboard features change.
 * 
 * Usage:
 *   npm run screenshots
 * 
 * Requirements:
 *   - Service must be running (starts automatically if not)
 *   - Puppeteer for headless browser automation
 *   - Sharp for image optimization
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const http = require('http');

const SCREENSHOTS_DIR = path.join(__dirname, '../docs/screenshots');
const DASHBOARD_URL = 'http://localhost:3000/dashboard';
const HEALTH_URL = 'http://localhost:3000/health';
const MAX_RETRIES = 30;
const RETRY_DELAY = 1000;

// Ensure screenshots directory exists
if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Check if service is running
 */
async function checkServiceRunning() {
    return new Promise((resolve) => {
        const req = http.get(HEALTH_URL, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

/**
 * Wait for service to be ready
 */
async function waitForService(retries = MAX_RETRIES) {
    console.log('Waiting for service to be ready...');
    for (let i = 0; i < retries; i++) {
        if (await checkServiceRunning()) {
            console.log('✓ Service is ready');
            return true;
        }
        process.stdout.write('.');
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
    console.log('\n✗ Service did not start in time');
    return false;
}

/**
 * Inject fake data into dashboard page
 */
async function injectFakeData(page, scenario) {
    const scenarios = {
        healthy: {
            status: {
                status: 'HEALTHY',
                version: '1.4.0',
                uptime: 86400, // 1 day
                sync: {
                    lastSyncTime: new Date(Date.now() - 300000).toISOString(), // 5 min ago
                    lastSyncStatus: 'success',
                    totalSyncs: 150,
                    successfulSyncs: 145,
                    failedSyncs: 5,
                    successRate: '96.67%'
                },
                servers: {
                    'Main Budget': { status: 'success', lastSync: new Date(Date.now() - 300000).toISOString(), lastSyncStatus: 'success' },
                    'Personal Budget': { status: 'success', lastSync: new Date(Date.now() - 600000).toISOString(), lastSyncStatus: 'success' },
                    'Family Budget': { status: 'success', lastSync: new Date(Date.now() - 900000).toISOString(), lastSyncStatus: 'success' }
                }
            },
            metrics: {
                overall: { totalSyncs: 50, successCount: 48, failureCount: 2, successRate: 0.96 },
                byServer: {
                    'Main Budget': { totalSyncs: 20, successCount: 19, failureCount: 1, successRate: 0.95, avgDuration: 5200, 
                        recentSyncs: Array.from({length: 10}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: i === 3 ? 'error' : 'success', 
                            duration: 4000 + Math.random() * 3000 
                        }))
                    },
                    'Personal Budget': { totalSyncs: 18, successCount: 18, failureCount: 0, successRate: 1.0, avgDuration: 3800,
                        recentSyncs: Array.from({length: 10}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: 'success', 
                            duration: 3000 + Math.random() * 2000 
                        }))
                    },
                    'Family Budget': { totalSyncs: 12, successCount: 11, failureCount: 1, successRate: 0.917, avgDuration: 6100,
                        recentSyncs: Array.from({length: 10}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: i === 7 ? 'error' : 'success', 
                            duration: 5000 + Math.random() * 3000 
                        }))
                    }
                },
                timeline: Array.from({length: 20}, (_, i) => ({
                    timestamp: new Date(Date.now() - i * 1800000).toISOString(),
                    server: ['Main Budget', 'Personal Budget', 'Family Budget'][i % 3],
                    status: (i === 5 || i === 12) ? 'error' : 'success',
                    duration: 3000 + Math.random() * 4000
                }))
            },
            history: Array.from({length: 10}, (_, i) => ({
                timestamp: new Date(Date.now() - i * 3600000).toISOString(),
                serverName: ['Main Budget', 'Personal Budget', 'Family Budget'][i % 3],
                status: (i === 2 || i === 7) ? 'error' : 'success',
                duration: 3000 + (i * 400), // Deterministic duration
                accountsProcessed: (i % 5) + 1, // Deterministic account count
                accountsFailed: (i === 2 || i === 7) ? 1 : 0
            })),
            logs: [
                { level: 'INFO', message: 'Starting sync for server: Main Budget', metadata: { server: 'Main Budget' } },
                { level: 'INFO', message: 'Successfully synced 3 accounts', metadata: { accountsProcessed: 3 } },
                { level: 'INFO', message: 'Sync completed successfully', metadata: { duration: 5234 } },
                { level: 'INFO', message: 'Starting sync for server: Personal Budget', metadata: { server: 'Personal Budget' } }
            ]
        },
        degraded: {
            status: {
                status: 'DEGRADED',
                version: '1.4.0',
                uptime: 172800, // 2 days
                sync: {
                    lastSyncTime: new Date(Date.now() - 1800000).toISOString(), // 30 min ago
                    lastSyncStatus: 'error',
                    totalSyncs: 200,
                    successfulSyncs: 170,
                    failedSyncs: 30,
                    successRate: '85.00%'
                },
                servers: {
                    'Main Budget': { status: 'success', lastSync: new Date(Date.now() - 1800000).toISOString(), lastSyncStatus: 'success' },
                    'Personal Budget': { status: 'error', lastSync: new Date(Date.now() - 3600000).toISOString(), lastSyncStatus: 'failure', error: 'Connection timeout after 3 retries' },
                    'Family Budget': { status: 'success', lastSync: new Date(Date.now() - 2400000).toISOString(), lastSyncStatus: 'partial' },
                    'Business Budget': { status: 'error', lastSync: new Date(Date.now() - 5400000).toISOString(), lastSyncStatus: 'failure', error: 'Rate limit exceeded' }
                }
            },
            metrics: {
                overall: { totalSyncs: 50, successCount: 40, failureCount: 10, successRate: 0.80 },
                byServer: {
                    'Main Budget': { totalSyncs: 15, successCount: 13, failureCount: 2, successRate: 0.867, avgDuration: 5500,
                        recentSyncs: Array.from({length: 10}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: (i === 2 || i === 6) ? 'error' : 'success', 
                            duration: 4000 + Math.random() * 4000 
                        }))
                    },
                    'Personal Budget': { totalSyncs: 15, successCount: 10, failureCount: 5, successRate: 0.667, avgDuration: 4200,
                        recentSyncs: Array.from({length: 10}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: (i === 1 || i === 3 || i === 5 || i === 7 || i === 9) ? 'error' : 'success', 
                            duration: 3000 + Math.random() * 3000 
                        }))
                    },
                    'Family Budget': { totalSyncs: 12, successCount: 10, failureCount: 2, successRate: 0.833, avgDuration: 6800,
                        recentSyncs: Array.from({length: 10}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: (i === 4 || i === 8) ? 'error' : 'success', 
                            duration: 5000 + Math.random() * 4000 
                        }))
                    },
                    'Business Budget': { totalSyncs: 8, successCount: 7, failureCount: 1, successRate: 0.875, avgDuration: 7200,
                        recentSyncs: Array.from({length: 8}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: i === 5 ? 'error' : 'success', 
                            duration: 6000 + Math.random() * 3000 
                        }))
                    }
                },
                timeline: Array.from({length: 20}, (_, i) => ({
                    timestamp: new Date(Date.now() - i * 1800000).toISOString(),
                    server: ['Main Budget', 'Personal Budget', 'Family Budget', 'Business Budget'][i % 4],
                    status: (i === 3 || i === 6 || i === 9 || i === 12 || i === 15 || i === 18) ? 'error' : 'success',
                    duration: 3000 + Math.random() * 5000
                }))
            },
            history: Array.from({length: 10}, (_, i) => ({
                timestamp: new Date(Date.now() - i * 3600000).toISOString(),
                serverName: ['Main Budget', 'Personal Budget', 'Family Budget', 'Business Budget'][i % 4],
                status: (i === 1 || i === 4 || i === 7) ? 'error' : 'success',
                duration: 3000 + (i * 500), // Deterministic duration
                accountsProcessed: (i === 1 || i === 4 || i === 7) ? 0 : (i % 5) + 1, // Deterministic account count
                accountsFailed: (i === 1 || i === 4 || i === 7) ? ((i % 3) + 1) : 0 // Deterministic failures
            })),
            logs: [
                { level: 'ERROR', message: 'Sync failed for server: Personal Budget', metadata: { server: 'Personal Budget', error: 'Connection timeout' } },
                { level: 'WARN', message: 'Retry attempt 2 of 3', metadata: { attempt: 2 } },
                { level: 'INFO', message: 'Starting sync for server: Main Budget', metadata: { server: 'Main Budget' } },
                { level: 'ERROR', message: 'Account sync failed', metadata: { accountId: 'acc_12345', error: 'Rate limit exceeded' } }
            ]
        },
        multiServer: {
            status: {
                status: 'HEALTHY',
                version: '1.4.0',
                uptime: 259200, // 3 days
                sync: {
                    lastSyncTime: new Date(Date.now() - 180000).toISOString(), // 3 min ago
                    lastSyncStatus: 'success',
                    totalSyncs: 500,
                    successfulSyncs: 485,
                    failedSyncs: 15,
                    successRate: '97.00%'
                },
                servers: {
                    'Main Budget': { status: 'success', lastSync: new Date(Date.now() - 180000).toISOString(), lastSyncStatus: 'success' },
                    'Personal Budget': { status: 'success', lastSync: new Date(Date.now() - 240000).toISOString(), lastSyncStatus: 'success' },
                    'Family Budget': { status: 'success', lastSync: new Date(Date.now() - 360000).toISOString(), lastSyncStatus: 'success' },
                    'Business Budget': { status: 'success', lastSync: new Date(Date.now() - 480000).toISOString(), lastSyncStatus: 'success' },
                    'Investments': { status: 'success', lastSync: new Date(Date.now() - 600000).toISOString(), lastSyncStatus: 'success' },
                    'Emergency Fund': { status: 'success', lastSync: new Date(Date.now() - 720000).toISOString(), lastSyncStatus: 'success' }
                }
            },
            serverEncryption: {
                servers: [
                    { name: 'Main Budget', encrypted: true },
                    { name: 'Personal Budget', encrypted: false },
                    { name: 'Family Budget', encrypted: true },
                    { name: 'Business Budget', encrypted: true },
                    { name: 'Investments', encrypted: false },
                    { name: 'Emergency Fund', encrypted: false }
                ]
            },
            metrics: {
                overall: { totalSyncs: 60, successCount: 58, failureCount: 2, successRate: 0.967 },
                byServer: {
                    'Main Budget': { totalSyncs: 12, successCount: 12, failureCount: 0, successRate: 1.0, avgDuration: 5200,
                        recentSyncs: Array.from({length: 10}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: 'success', 
                            duration: 4500 + Math.random() * 1500 
                        }))
                    },
                    'Personal Budget': { totalSyncs: 10, successCount: 10, failureCount: 0, successRate: 1.0, avgDuration: 3800,
                        recentSyncs: Array.from({length: 10}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: 'success', 
                            duration: 3200 + Math.random() * 1200 
                        }))
                    },
                    'Family Budget': { totalSyncs: 10, successCount: 10, failureCount: 0, successRate: 1.0, avgDuration: 6100,
                        recentSyncs: Array.from({length: 10}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: 'success', 
                            duration: 5500 + Math.random() * 1500 
                        }))
                    },
                    'Business Budget': { totalSyncs: 10, successCount: 9, failureCount: 1, successRate: 0.9, avgDuration: 7500,
                        recentSyncs: Array.from({length: 10}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: i === 5 ? 'error' : 'success', 
                            duration: 6800 + Math.random() * 2000 
                        }))
                    },
                    'Investments': { totalSyncs: 9, successCount: 9, failureCount: 0, successRate: 1.0, avgDuration: 4200,
                        recentSyncs: Array.from({length: 9}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: 'success', 
                            duration: 3800 + Math.random() * 1000 
                        }))
                    },
                    'Emergency Fund': { totalSyncs: 9, successCount: 8, failureCount: 1, successRate: 0.889, avgDuration: 3600,
                        recentSyncs: Array.from({length: 9}, (_, i) => ({ 
                            timestamp: new Date(Date.now() - i * 3600000).toISOString(), 
                            status: i === 7 ? 'error' : 'success', 
                            duration: 3200 + Math.random() * 1000 
                        }))
                    }
                },
                timeline: Array.from({length: 20}, (_, i) => ({
                    timestamp: new Date(Date.now() - i * 1800000).toISOString(),
                    server: ['Main Budget', 'Personal Budget', 'Family Budget', 'Business Budget', 'Investments', 'Emergency Fund'][i % 6],
                    status: (i === 8 || i === 16) ? 'error' : 'success',
                    duration: 3000 + Math.random() * 5000
                }))
            },
            history: Array.from({length: 10}, (_, i) => ({
                timestamp: new Date(Date.now() - i * 1800000).toISOString(),
                serverName: ['Main Budget', 'Personal Budget', 'Family Budget', 'Business Budget', 'Investments', 'Emergency Fund'][i % 6],
                status: (i === 3 || i === 8) ? 'error' : 'success',
                duration: 3000 + (i * 450), // Deterministic duration
                accountsProcessed: (i === 3 || i === 8) ? 0 : ((i % 6) + 2), // Deterministic account count
                accountsFailed: (i === 3 || i === 8) ? ((i % 2) + 1) : 0 // Deterministic failures
            })),
            logs: [
                { level: 'INFO', message: 'Starting sync for server: Main Budget', metadata: { server: 'Main Budget' } },
                { level: 'INFO', message: 'Successfully synced 4 accounts', metadata: { accountsProcessed: 4 } },
                { level: 'INFO', message: 'Starting sync for server: Personal Budget', metadata: { server: 'Personal Budget' } },
                { level: 'INFO', message: 'Successfully synced 3 accounts', metadata: { accountsProcessed: 3 } }
            ]
        }
    };

    const data = scenarios[scenario] || scenarios.healthy;

    // Inject data by overriding fetch responses
    await page.evaluateOnNewDocument((mockData) => {
        window.__mockData = mockData;
        
        const originalFetch = window.fetch;
        window.fetch = function(url, options) {
            // Mock API responses
            if (url.includes('/api/dashboard/status')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve(window.__mockData.status)
                });
            } else if (url.includes('/api/dashboard/servers')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve(window.__mockData.serverEncryption || { servers: [] })
                });
            } else if (url.includes('/api/dashboard/orphaned-servers')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ orphaned: [] })
                });
            } else if (url.includes('/api/dashboard/metrics')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve(window.__mockData.metrics)
                });
            } else if (url.includes('/api/dashboard/history')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve(window.__mockData.history)
                });
            }
            return originalFetch.apply(this, arguments);
        };

        // Mock WebSocket for logs
        window.WebSocket = function(url) {
            const ws = {
                onopen: null,
                onmessage: null,
                onerror: null,
                onclose: null,
                send: () => {},
                close: () => {}
            };
            
            setTimeout(() => {
                if (ws.onopen) ws.onopen({ type: 'open' });
                
                // Send mock logs
                window.__mockData.logs.forEach((log, i) => {
                    setTimeout(() => {
                        if (ws.onmessage) {
                            ws.onmessage({
                                data: JSON.stringify({
                                    timestamp: new Date().toISOString(),
                                    level: log.level,
                                    message: log.message,
                                    metadata: log.metadata || {}
                                })
                            });
                        }
                    }, i * 500);
                });
            }, 100);
            
            return ws;
        };
    }, data);
}

/**
 * Take screenshot of specific scenario
 */
async function takeScreenshot(browser, scenario, filename, description, options = {}) {
    console.log(`\n📸 Capturing: ${description}`);
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Inject fake data before navigation
    await injectFakeData(page, scenario);
    
    // Navigate to dashboard
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle0' });
    
    // Wait for initial render
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Switch to specific tab if requested
    if (options.tab) {
        await page.evaluate((tabName) => {
            const tabButton = Array.from(document.querySelectorAll('.tab'))
                .find(btn => btn.textContent.toLowerCase().includes(tabName.toLowerCase()));
            if (tabButton) tabButton.click();
        }, options.tab);
        
        // Wait for tab content to load
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Apply custom interactions if provided
    if (options.customActions) {
        await options.customActions(page);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Scroll to show all content
    await page.evaluate(() => window.scrollTo(0, 0));
    
    // Take screenshot
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({
        path: filepath,
        fullPage: options.fullPage !== false,
        type: 'png'
    });
    
    console.log(`   ✓ Saved: ${filename}`);
    
    await page.close();
    return filepath;
}

/**
 * Main execution
 */
async function main() {
    console.log('🎬 Dashboard Screenshot Generator');
    console.log('=================================\n');

    // Check if service is running
    const isRunning = await checkServiceRunning();
    
    if (!isRunning) {
        console.log('⚠️  Service not running. Please start the service first:');
        console.log('   npm start\n');
        console.log('Then run this script again.');
        process.exit(1);
    }

    // Wait for service to be fully ready
    if (!await waitForService()) {
        console.error('✗ Could not connect to service');
        process.exit(1);
    }

    console.log('\n🌐 Launching browser...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        // 1. Overview Tab - Healthy System
        await takeScreenshot(
            browser,
            'healthy',
            'dashboard-overview-healthy.png',
            'Overview Tab - Healthy System with 2-Column Layout',
            { tab: 'overview' }
        );

        // 2. Overview Tab - Degraded System
        await takeScreenshot(
            browser,
            'degraded',
            'dashboard-overview-degraded.png',
            'Overview Tab - Degraded System with Error States',
            { tab: 'overview' }
        );

        // 3. Overview Tab - Multi-Server with Status Badges
        await takeScreenshot(
            browser,
            'multiServer',
            'dashboard-overview-multi-server.png',
            'Overview Tab - 6 Servers with Encryption Badges',
            { tab: 'overview' }
        );

        // 4. Analytics Tab - Charts and Statistics
        await takeScreenshot(
            browser,
            'healthy',
            'dashboard-analytics.png',
            'Analytics Tab - All-Time Statistics and Charts',
            { tab: 'analytics' }
        );

        // 5. Analytics Tab - Degraded Performance
        await takeScreenshot(
            browser,
            'degraded',
            'dashboard-analytics-degraded.png',
            'Analytics Tab - Performance Issues Visualization',
            { tab: 'analytics' }
        );

        // 6. History Tab - Recent Syncs
        await takeScreenshot(
            browser,
            'healthy',
            'dashboard-history.png',
            'History Tab - Sync History with Filters',
            { tab: 'history' }
        );

        // 7. History Tab - With Errors
        await takeScreenshot(
            browser,
            'degraded',
            'dashboard-history-errors.png',
            'History Tab - Error Details and Filtering',
            { tab: 'history' }
        );

        // 8. Settings Tab - Date Format Preferences
        await takeScreenshot(
            browser,
            'healthy',
            'dashboard-settings.png',
            'Settings Tab - Preferences and Data Management',
            { 
                tab: 'settings',
                customActions: async (page) => {
                    // Scroll to date format section
                    await page.evaluate(() => {
                        const dateFormatCard = Array.from(document.querySelectorAll('.card'))
                            .find(card => card.textContent.includes('Date Format Preferences'));
                        if (dateFormatCard) {
                            dateFormatCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    });
                }
            }
        );

        // 9. Settings Tab - Orphaned Servers & Danger Zone
        await takeScreenshot(
            browser,
            'healthy',
            'dashboard-settings-danger-zone.png',
            'Settings Tab - Reset History and Orphaned Servers',
            { 
                tab: 'settings',
                customActions: async (page) => {
                    // Scroll to top to show danger zone
                    await page.evaluate(() => window.scrollTo(0, 0));
                }
            }
        );

        // 10. Full Dashboard - Overview (Hero Shot)
        await takeScreenshot(
            browser,
            'multiServer',
            'dashboard-hero.png',
            'Full Dashboard - Hero Shot with All Features',
            { tab: 'overview', fullPage: false }
        );

        console.log('\n✅ All screenshots generated successfully!');
        console.log(`📁 Screenshots saved to: ${SCREENSHOTS_DIR}\n`);
        console.log('Screenshots generated:');
        console.log('  • dashboard-overview-healthy.png - Clean 2-column layout');
        console.log('  • dashboard-overview-degraded.png - Error states');
        console.log('  • dashboard-overview-multi-server.png - 6 servers with badges');
        console.log('  • dashboard-analytics.png - Charts and statistics');
        console.log('  • dashboard-analytics-degraded.png - Performance issues');
        console.log('  • dashboard-history.png - Sync history table');
        console.log('  • dashboard-history-errors.png - Error details');
        console.log('  • dashboard-settings.png - Date formats and preferences');
        console.log('  • dashboard-settings-danger-zone.png - Data management');
        console.log('  • dashboard-hero.png - Hero shot for README');
        console.log('\n🎯 Next steps:');
        console.log('1. Review screenshots in docs/screenshots/');
        console.log('2. Update README.md with new screenshots');
        console.log('3. Update docs/ markdown files');
        console.log('4. Update Docker descriptions (docker/description/)');

    } catch (error) {
        console.error('\n✗ Error generating screenshots:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

// Run if called directly
if (require.main === module) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { main, takeScreenshot };
