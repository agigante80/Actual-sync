const actual = require('@actual-app/api');
const fs = require('fs').promises;
const path = require('path');
const { BlockingScheduler } = require('node-schedule'); // Import the scheduler
const schedule = require('node-schedule'); // Import the scheduler
const moment = require('moment-timezone');
const ConfigLoader = require('./lib/configLoader');
const { createLogger } = require('./lib/logger');
const { HealthCheckService } = require('./services/healthCheck');
const { SyncHistoryService } = require('./services/syncHistory');
const { NotificationService } = require('./services/notificationService');
const { TelegramBotService } = require('./services/telegramBot');
const PrometheusService = require('./services/prometheusService');

// Get version
const VERSION = process.env.VERSION || (() => {
    try {
        return require('../package.json').version;
    } catch (error) {
        return 'unknown';
    }
})();

/**
 * Convert cron schedule to human-readable format
 * @param {string} cron - Cron expression (e.g., "0 5 * * 2")
 * @returns {string} Human-readable description
 */
function cronToHuman(cron) {
    const parts = cron.split(' ');
    if (parts.length !== 5) return cron;
    
    const [minute, hour, , , dayOfWeek] = parts;
    
    // Day names
    const days = {
        '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday',
        '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '7': 'Sunday'
    };
    
    let timeStr = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    
    if (dayOfWeek === '*') {
        return `Daily at ${timeStr}`;
    }
    
    const daysList = dayOfWeek.split(',').map(d => days[d.trim()]);
    if (daysList.length === 7) {
        return `Daily at ${timeStr}`;
    } else if (daysList.length === 5 && !daysList.includes('Saturday') && !daysList.includes('Sunday')) {
        return `Weekdays at ${timeStr}`;
    } else if (daysList.length === 1) {
        return `Every ${daysList[0]} at ${timeStr}`;
    } else {
        return `${daysList.join(', ')} at ${timeStr}`;
    }
}

// Load environment variables
require('dotenv').config();

// Load configuration from file
let config;
let logger;
let healthCheck;
let syncHistory;
let notificationService;
let telegramBot;
let prometheusService;
try {
    const configLoader = new ConfigLoader();
    config = configLoader.load();
    
    // Initialize logger with config
    logger = createLogger({
        level: config.logging.level,
        format: config.logging.format,
        logDir: config.logging.logDir,
        rotation: config.logging.rotation,
        syslog: config.logging.syslog,
        performance: config.logging.performance
    });
    
    logger.info('Configuration loaded successfully', { 
        serverCount: config.servers.length 
    });
    
    // Initialize sync history service
    syncHistory = new SyncHistoryService({
        dbPath: config.syncHistory?.dbPath,
        retentionDays: config.syncHistory?.retentionDays || 90,
        loggerConfig: {
            level: config.logging.level,
            format: config.logging.format,
            logDir: config.logging.logDir
        }
    });
    
    // Initialize Prometheus service if enabled
    if (config.prometheus?.enabled !== false) {
        prometheusService = new PrometheusService({
            syncHistory: syncHistory,
            includeDefaultMetrics: config.prometheus?.includeDefaultMetrics !== false,
            loggerConfig: {
                level: config.logging.level,
                format: config.logging.format,
                logDir: config.logging.logDir
            }
        });
        logger.info('Prometheus metrics service enabled');
    }
    
    // Initialize health check service
    healthCheck = new HealthCheckService({
        port: config.healthCheck?.port || 3000,
        host: config.healthCheck?.host || '0.0.0.0',
        dashboardConfig: config.healthCheck?.dashboard || { enabled: true, auth: { type: 'none' } },
        prometheusService: prometheusService,
        syncHistory: syncHistory,
        syncBank: syncBank,
        getServers: () => config.servers,
        loggerConfig: {
            level: config.logging.level,
            format: config.logging.format,
            logDir: config.logging.logDir
        }
    });
    
    // Connect logger to WebSocket broadcasting
    logger.setBroadcastCallback((level, message, metadata) => {
        if (healthCheck && healthCheck.broadcastLog) {
            healthCheck.broadcastLog(level, message, metadata);
        }
    });
    
    // Initialize notification service
    notificationService = new NotificationService(
        config.notifications || {},
        {
            level: config.logging.level,
            format: config.logging.format,
            logDir: config.logging.logDir
        }
    );
    
    // Initialize Telegram bot service if enabled
    if (config.notifications?.telegram?.enabled) {
        telegramBot = new TelegramBotService(
            {
                botToken: config.notifications.telegram.botToken,
                chatId: config.notifications.telegram.chatId,
                notifyOnSuccess: config.notifications.telegram.notifyOnSuccess || 'errors_only'
            },
            {
                syncHistory: syncHistory,
                healthCheck: healthCheck,
                getServerConfig: () => config.servers,
                syncBank: syncBank
            },
            {
                level: config.logging.level,
                format: config.logging.format,
                logDir: config.logging.logDir
            }
        );
        logger.info('Telegram bot service initialized');
    }
} catch (error) {
    // Fallback to console if logger not initialized
    console.error('❌ Failed to load configuration:');
    console.error(error.message);
    console.error('\nPlease ensure config/config.json exists and is valid.');
    console.error('See config/config.example.json for reference.');
    process.exit(1);
}

// Extract configuration values
const servers = config.servers;
const globalSyncConfig = config.sync;

// Helper function to get sync config for a server (server-specific overrides global)
function getSyncConfig(server) {
    return {
        maxRetries: server.sync?.maxRetries ?? globalSyncConfig.maxRetries,
        baseRetryDelayMs: server.sync?.baseRetryDelayMs ?? globalSyncConfig.baseRetryDelayMs,
        schedule: server.sync?.schedule ?? globalSyncConfig.schedule
    };
}

async function runWithRetries(fn, retries, baseRetryDelayMs) {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (error) {
            logger.error(`Attempt ${i + 1} failed`, { 
                attempt: i + 1, 
                error: error.message,
                errorCode: error.code,
                errorCategory: error.category
            });

            let retryDelay = 0;

            if (error.code === 'NORDIGEN_ERROR' && error.category === 'RATE_LIMIT_EXCEEDED') {
                retryDelay = baseRetryDelayMs * (2 ** i); // Exponential backoff for rate limits
                logger.warn(`Rate limit exceeded. Retrying in ${retryDelay / 1000} seconds...`, {
                    retryDelayMs: retryDelay,
                    attempt: i + 1
                });
            } else if (error.message === 'network-failure' || error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
                // Retry for network failures, ECONNRESET, or DNS issues
                retryDelay = baseRetryDelayMs * (2 ** i); // Exponential backoff for network issues
                logger.warn(`Network failure. Retrying in ${retryDelay / 1000} seconds...`, {
                    retryDelayMs: retryDelay,
                    attempt: i + 1,
                    errorCode: error.code
                });
            } else {
                logger.error('Not a retryable error, not retrying', { errorCode: error.code });
                throw error; // Re-throw other errors
            }
            if (i === retries) {
                logger.error('Max retries reached. Bank sync failed.', { maxRetries: retries });
                throw error; // Re-throw after max retries
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

async function syncBank(server) {
    const { name, url, password, syncId, dataDir } = server;
    const syncIdLog = syncId ? syncId : "your_budget_name";
    
    // Get sync configuration for this server (server-specific or global)
    const syncConfig = getSyncConfig(server);
    
    // Create server-specific logger with per-server log level if configured
    const serverLogger = server.logging ? logger.child({
        server: name,
        ...(server.logging.level && { level: server.logging.level }),
        ...(server.logging.format && { format: server.logging.format })
    }) : logger.child({ server: name });
    
    // Override logger level if server-specific level is set
    if (server.logging?.level) {
        serverLogger.level = server.logging.level;
    }
    
    // Create correlation ID for this sync operation
    const correlationId = serverLogger.generateCorrelationId();
    serverLogger.setCorrelationId(correlationId);
    
    // Start performance timer
    const endTimer = serverLogger.startTimer(`sync-${name}`);
    
    // Track sync start time and account stats
    const syncStartTime = Date.now();
    let accountsProcessed = 0;
    let accountsSucceeded = 0;
    let accountsFailed = 0;
    
    try {
        serverLogger.info(`Starting sync for server: ${name}`, { 
            url, 
            dataDir,
            maxRetries: syncConfig.maxRetries,
            baseRetryDelayMs: syncConfig.baseRetryDelayMs,
            schedule: syncConfig.schedule
        });
        
        serverLogger.debug(`Checking if data directory exists: ${dataDir}`, { dataDir });
        await fs.mkdir(dataDir, { recursive: true });
        serverLogger.debug('Data directory ready', { dataDir });

        serverLogger.info(`Connecting to Actual server`, { url });
        await actual.init({
            serverURL: url,
            password: password,
            dataDir: dataDir,
        });
        serverLogger.info('Connected to Actual server');

        serverLogger.info(`Loading budget file`, { syncId: syncIdLog });
        await runWithRetries(
            async () => await actual.downloadBudget(syncId),
            syncConfig.maxRetries,
            syncConfig.baseRetryDelayMs
        );
        serverLogger.info('Budget file loaded successfully');

        serverLogger.debug('Fetching accounts...');
        const accounts = await actual.getAccounts();
        serverLogger.info('Accounts fetched successfully', { accountCount: accounts?.length || 0 });

        serverLogger.info('Starting file sync');
        await runWithRetries(
            async () => await actual.sync(),
            syncConfig.maxRetries,
            syncConfig.baseRetryDelayMs
        ); // Add this before runBankSync
        serverLogger.info('File sync completed');
            
        const succeededAccounts = [];
        const failedAccounts = [];
        
        if (accounts && accounts.length > 0) {
            for (const account of accounts) {
                accountsProcessed++;
                const accountTimer = serverLogger.startTimer(`account-sync-${account.id}`);
                serverLogger.info(`Starting bank sync for account`, { 
                    accountId: account.id,
                    accountName: account.name 
                });
                try { //  Wrap runBankSync in try...catch
                    await runWithRetries(
                        async () => await actual.runBankSync({ accountId: account.id }),
                        syncConfig.maxRetries,
                        syncConfig.baseRetryDelayMs
                    );
                    accountsSucceeded++;
                    succeededAccounts.push(account.name);
                    const accountDuration = accountTimer();
                    serverLogger.info('Bank sync completed for account', { 
                        accountId: account.id,
                        durationMs: accountDuration
                    });
                } catch (bankSyncError) { // catch bankSyncError
                    accountsFailed++;
                    failedAccounts.push({
                        name: account.name,
                        error: bankSyncError.message
                    });
                    accountTimer();
                    serverLogger.error('Error syncing bank for account', {
                        accountId: account.id,
                        error: bankSyncError.message,
                        errorCode: bankSyncError.code
                    });
                }
            }
        } else {
            serverLogger.warn('No accounts found to sync');
        }

        serverLogger.info('Starting final file sync');
        await runWithRetries(
            async () => await actual.sync(),
            syncConfig.maxRetries,
            syncConfig.baseRetryDelayMs
        );
        serverLogger.info('Final file sync completed');
        
        // Calculate sync duration and log performance
        const durationMs = endTimer({ 
            accountsProcessed: accountsSucceeded,
            accountsFailed 
        });
        
        // Update health check with successful sync
        if (healthCheck) {
            healthCheck.updateSyncStatus({ status: 'success', serverName: name });
        }
        
        // Record sync in history
        if (syncHistory) {
            syncHistory.recordSync({
                serverName: name,
                status: 'success',
                durationMs,
                accountsProcessed,
                accountsSucceeded,
                accountsFailed,
                correlationId
            });
        }
        
        // Record metrics in Prometheus
        if (prometheusService) {
            prometheusService.recordSync({
                server: name,
                status: 'success',
                duration: durationMs,
                accountsProcessed: accountsSucceeded,
                accountsFailed: accountsFailed
            });
        }
        
        // Record successful sync result for notification tracking
        if (notificationService) {
            notificationService.recordSyncResult(name, true, correlationId);
        }
        
        // Send Telegram bot notification for successful sync
        if (telegramBot) {
            try {
                await telegramBot.notifySync({
                    status: 'success',
                    serverName: name,
                    duration: durationMs,
                    accountsProcessed: accountsSucceeded,
                    accountsFailed: accountsFailed,
                    succeededAccounts: succeededAccounts,
                    failedAccounts: failedAccounts
                });
            } catch (botError) {
                logger.error('Failed to send Telegram bot notification', { error: botError.message });
            }
        }
        
    } catch (error) {
        const durationMs = endTimer({ error: error.message });
        serverLogger.error(`Error syncing bank for server`, {
            error: error.message,
            errorCode: error.code,
            errorStack: error.stack
        });
        
        // Update health check with failed sync
        if (healthCheck) {
            healthCheck.updateSyncStatus({ status: 'failure', serverName: name, error });
        }
        
        // Record failed sync in history
        if (syncHistory) {
            syncHistory.recordSync({
                serverName: name,
                status: 'failure',
                durationMs,
                accountsProcessed,
                accountsSucceeded,
                accountsFailed,
                errorMessage: error.message,
                errorCode: error.code,
                correlationId
            });
        }
        
        // Record metrics in Prometheus
        if (prometheusService) {
            prometheusService.recordSync({
                server: name,
                status: 'error',
                duration: durationMs,
                accountsProcessed: accountsSucceeded,
                accountsFailed: accountsFailed,
                errorCode: error.code || 'UNKNOWN_ERROR'
            });
        }
        
        // Record failed sync result and send notification if thresholds exceeded
        if (notificationService) {
            notificationService.recordSyncResult(name, false, correlationId);
            
            try {
                await notificationService.notifyError({
                    serverName: name,
                    errorMessage: error.message,
                    errorCode: error.code,
                    timestamp: new Date().toISOString(),
                    correlationId,
                    context: {
                        accountsProcessed,
                        accountsSucceeded,
                        accountsFailed,
                        durationMs
                    }
                });
            } catch (notifyError) {
                logger.error('Failed to send error notification', {
                    error: notifyError.message,
                    originalError: error.message
                });
            }
        }
        
        // Send Telegram bot notification for failed sync
        if (telegramBot) {
            try {
                await telegramBot.notifySync({
                    status: 'error',
                    serverName: name,
                    duration: durationMs,
                    error: error.message,
                    errorCode: error.code
                });
            } catch (botError) {
                logger.error('Failed to send Telegram bot notification', { error: botError.message });
            }
        }
    } finally {
        try {
            serverLogger.debug('Shutting down Actual API connection');
            await actual.shutdown();
            serverLogger.debug('Shutdown complete');
        } catch (shutdownError) {
            serverLogger.error('Error during shutdown', {
                error: shutdownError.message
            });
        }
        serverLogger.clearCorrelationId();
    }
}

async function syncAllBanks() {
    for (const server of servers) {
        await syncBank(server);
    }
}

// Check for the force run argument and optional server filter
async function run() {
    const forceRun = process.argv.includes('--force-run');
    const serverFlag = process.argv.indexOf('--server');
    const serverName = serverFlag !== -1 ? process.argv[serverFlag + 1] : null;

    if (forceRun) {
        if (serverName) {
            // Sync specific server only
            const server = servers.find(s => s.name === serverName);
            if (!server) {
                logger.error('Server not found', { 
                    requestedServer: serverName,
                    availableServers: servers.map(s => s.name)
                });
                console.error(`\n❌ Error: Server "${serverName}" not found in configuration.`);
                console.error(`\nAvailable servers: ${servers.map(s => s.name).join(', ')}\n`);
                process.exit(1);
            }
            logger.info('Force running bank sync for specific server', { 
                forceRun: true, 
                server: serverName 
            });
            await syncBank(server);
            logger.info('Forced bank sync complete for server', { server: serverName });
        } else {
            // Sync all servers
            logger.info('Force running bank sync for all servers', { forceRun: true });
            await syncAllBanks();
            logger.info('Forced bank sync complete');
        }
    } else {
        // Group servers by their effective schedule
        const scheduleGroups = new Map();
        for (const server of servers) {
            const syncConfig = getSyncConfig(server);
            const scheduleStr = syncConfig.schedule;
            if (!scheduleGroups.has(scheduleStr)) {
                scheduleGroups.set(scheduleStr, []);
            }
            scheduleGroups.get(scheduleStr).push(server);
        }

        // Create one job per unique schedule
        const scheduledJobs = [];
        for (const [scheduleStr, serversWithSchedule] of scheduleGroups) {
            logger.info('Scheduling sync job', { 
                schedule: scheduleStr, 
                servers: serversWithSchedule.map(s => s.name) 
            });
            
            const job = schedule.scheduleJob(scheduleStr, async () => {
                logger.info('Scheduled sync starting', { 
                    schedule: scheduleStr,
                    servers: serversWithSchedule.map(s => s.name)
                });
                for (const server of serversWithSchedule) {
                    await syncBank(server);
                }
                logger.info('Scheduled sync completed', { schedule: scheduleStr });
            });
            
            scheduledJobs.push({ schedule: scheduleStr, job, servers: serversWithSchedule });
        }

        const now = moment().tz('Europe/Madrid');
        logger.info('Sync service initialized', {
            timezone: 'Europe/Madrid',
            currentTime: now.format(),
            scheduleCount: scheduledJobs.length,
            schedules: scheduledJobs.map(sj => ({
                schedule: sj.schedule,
                servers: sj.servers.map(s => s.name),
                nextInvocation: sj.job.nextInvocation()?.toString()
            }))
        });

        logger.info('Service started - periodic bank sync scheduled', { 
            forceRun: false
        });
        
        // Start Telegram bot if enabled
        if (telegramBot) {
            try {
                telegramBot.start();
                logger.info('Telegram bot started and polling for commands');
            } catch (error) {
                logger.error('Failed to start Telegram bot', { error: error.message });
            }
        }
        
        // Send startup notification via Telegram
        if (notificationService && config.notifications?.telegram?.enabled) {
            try {
                const serverNames = servers.map(s => s.name).join(', ');
                const scheduleInfo = scheduledJobs.map(sj => 
                    `  • ${sj.servers.map(s => s.name).join(', ')}\n    ${cronToHuman(sj.schedule)} (${sj.schedule})`
                ).join('\n');
                const nextSync = scheduledJobs[0]?.job.nextInvocation();
                const nextSyncStr = nextSync ? nextSync.toLocaleString('en-US', { 
                    timeZone: 'Europe/Madrid',
                    dateStyle: 'short',
                    timeStyle: 'short'
                }) : 'N/A';
                
                await notificationService.sendTelegramMessage(
                    `🚀 Actual-sync Service Started\n\n` +
                    `✅ Service is now running\n` +
                    `📦 Version: ${VERSION}\n\n` +
                    `Servers: ${serverNames}\n\n` +
                    `Schedules:\n${scheduleInfo}\n\n` +
                    `Next sync: ${nextSyncStr}\n\n` +
                    `Type /help to see available commands`
                );
                logger.info('Startup notification sent via Telegram');
            } catch (error) {
                logger.error('Failed to send startup notification', { error: error.message });
            }
        }
    }
}

// Start health check service
healthCheck.start().catch((error) => {
    logger.error('Failed to start health check service', { error: error.message });
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully...');
    try {
        if (telegramBot) {
            telegramBot.stop();
        }
        await healthCheck.stop();
        syncHistory.close();
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', { error: error.message });
        process.exit(1);
    }
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down gracefully...');
    try {
        if (telegramBot) {
            telegramBot.stop();
        }
        await healthCheck.stop();
        syncHistory.close();
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', { error: error.message });
        process.exit(1);
    }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception - service will continue', {
        error: error.message,
        stack: error.stack
    });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection - service will continue', {
        reason: reason,
        promise: promise
    });
});

run();




