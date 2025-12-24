const actual = require('@actual-app/api');
const fs = require('fs').promises;
const schedule = require('node-schedule'); // Import the scheduler
const moment = require('moment-timezone');
const cronstrue = require('cronstrue');
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
 * Format next sync time in human-readable format
 * @param {Date} nextInvocation - Next scheduled invocation time
 * @returns {string} Human-readable format
 */
function formatNextSync(nextInvocation) {
    // Ensure nextInvocation is a Date object
    if (!nextInvocation) return 'not scheduled';
    const nextDate = nextInvocation instanceof Date ? nextInvocation : new Date(nextInvocation);
    
    const now = new Date();
    const diff = nextDate - now;
    
    // Convert to different time units
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    
    if (days > 1) {
        return `in ${days} days`;
    } else if (days === 1) {
        return `tomorrow at ${nextDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } else if (hours >= 1) {
        return `in ${hours}h ${minutes}m`;
    } else if (minutes > 1) {
        return `in ${minutes} minutes`;
    } else if (minutes === 1) {
        return `in 1 minute`;
    } else if (seconds > 10) {
        return `in ${seconds} seconds`;
    } else if (seconds > 0) {
        return `in ${seconds} seconds (${nextDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`;
    } else {
        // Show exact time if it's in the past or immediate
        return `at ${nextDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }
}

// Export formatNextSync so healthCheck service can use it
module.exports.formatNextSync = formatNextSync;

/**
 * Convert cron schedule to human-readable format
 * @param {string} cron - Cron expression (e.g., "0 5 * * 2")
 * @returns {string} Human-readable description
 */

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
let scheduledJobsRef = []; // Variable to store scheduled jobs (populated during run())
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
                chatId: config.notifications.telegram.chatId || config.notifications.telegram.chatIds?.[0],
                chatIds: config.notifications.telegram.chatIds,
                notifyOnSuccess: config.notifications.telegram.notifyOnSuccess || 'errors_only'
            },
            {
                syncHistory: syncHistory,
                healthCheck: null, // Will be set after healthCheck is created
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
    
    // Initialize health check service (after notification services)
    healthCheck = new HealthCheckService({
        port: config.healthCheck?.port || 3000,
        host: config.healthCheck?.host || '0.0.0.0',
        dashboardConfig: config.healthCheck?.dashboard || { enabled: true, auth: { type: 'none' } },
        prometheusService: prometheusService,
        syncHistory: syncHistory,
        notificationService: notificationService,
        telegramBot: telegramBot,
        syncBank: syncBank,
        getServers: () => config.servers,
        getSchedules: () => {
            // Return schedule info for each server
            const scheduleMap = {};
            scheduledJobsRef.forEach(sj => {
                sj.servers.forEach(server => {
                    const nextInvocation = sj.job.nextInvocation();
                    if (nextInvocation) {
                        scheduleMap[server.name] = formatNextSync(nextInvocation);
                    }
                });
            });
            return scheduleMap;
        },
        getCronSchedules: () => {
            // Return cron schedule information for dashboard
            return scheduledJobsRef.map(sj => ({
                cron: sj.schedule,
                cronHuman: cronstrue.toString(sj.schedule),
                servers: sj.servers.map(s => s.name),
                nextInvocation: sj.job.nextInvocation()?.toString()
            }));
        },
        loggerConfig: {
            level: config.logging.level,
            format: config.logging.format,
            logDir: config.logging.logDir
        }
    });
    
    // Update Telegram bot with healthCheck reference
    if (telegramBot) {
        telegramBot.services.healthCheck = healthCheck;
    }
    
    // Connect logger to WebSocket broadcasting
    logger.setBroadcastCallback((level, message, metadata) => {
        if (healthCheck && healthCheck.broadcastLog) {
            healthCheck.broadcastLog(level, message, metadata);
        }
    });
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

async function syncBank(server) {
    const { name, url, password, syncId, dataDir, encryptionPassword } = server;
    const syncIdLog = syncId ? syncId : "your_budget_name";
    const isEncrypted = !!encryptionPassword;
    
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
    const succeededAccounts = [];
    const failedAccounts = [];
    
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

        serverLogger.info(`Loading budget file`, { 
            syncId: syncIdLog,
            encrypted: !!encryptionPassword
        });
        
        // Download budget with encryption password if provided
        const downloadOptions = encryptionPassword ? { password: encryptionPassword } : undefined;
        
        // Download budget (single attempt - no retries)
        let downloadError;
        try {
            await actual.downloadBudget(syncId, downloadOptions);
            serverLogger.info('Budget file loaded successfully', {
                encrypted: !!encryptionPassword
            });
        } catch (error) {
            downloadError = error;
            serverLogger.debug('Download failed', {
                error: error?.reason || error?.message || String(error)
            });
        }
        
        // If download failed, enhance and throw error
        if (downloadError) {
            const enhancedError = enhanceActualApiError(downloadError, {
                phase: 'download',
                serverUrl: url,
                syncId,
                isEncrypted: !!encryptionPassword
            }, serverLogger);
            enhancedError.syncId = syncId;
            enhancedError.serverUrl = url;
            throw enhancedError;
        }

        serverLogger.debug('Fetching accounts...');
        const accounts = await actual.getAccounts();
        serverLogger.info('Accounts fetched successfully', { accountCount: accounts?.length || 0 });

        serverLogger.info('Starting file sync');
        try {
            await actual.sync();
            serverLogger.info('File sync completed');
        } catch (syncError) {
            throw enhanceActualApiError(syncError, {
                phase: 'sync',
                serverUrl: url,
                syncId,
                isEncrypted: isEncrypted
            }, serverLogger);
        }
            
        if (accounts && accounts.length > 0) {
            for (const account of accounts) {
                accountsProcessed++;
                const accountTimer = serverLogger.startTimer(`account-sync-${account.id}`);
                serverLogger.info(`Starting bank sync for account`, { 
                    accountId: account.id,
                    accountName: account.name 
                });
                try { //  Wrap runBankSync in try...catch
                    await actual.runBankSync({ accountId: account.id });
                    accountsSucceeded++;
                    succeededAccounts.push(account.name);
                    const accountDuration = accountTimer();
                    serverLogger.info('Bank sync completed for account', { 
                        accountId: account.id,
                        durationMs: accountDuration
                    });
                } catch (bankSyncError) { // catch bankSyncError
                    accountsFailed++;
                    const errorMsg = bankSyncError?.message || bankSyncError?.toString() || String(bankSyncError) || 'Unknown error';
                    failedAccounts.push({
                        name: account.name,
                        error: errorMsg
                    });
                    accountTimer();
                    serverLogger.error('Error syncing bank for account', {
                        accountId: account.id,
                        accountName: account.name,
                        error: errorMsg,
                        errorCode: bankSyncError?.code || 'UNKNOWN',
                        errorStack: bankSyncError?.stack || 'No stack trace available'
                    });
                }
            }
        } else {
            serverLogger.warn('No accounts found to sync');
        }

        serverLogger.info('Starting final file sync');
        try {
            await actual.sync();
            serverLogger.info('Final file sync completed');
        } catch (syncError) {
            throw enhanceActualApiError(syncError, {
                phase: 'sync',
                serverUrl: url,
                syncId,
                isEncrypted: isEncrypted
            }, serverLogger);
        }
        
        // Calculate sync duration and log performance
        let durationMs = endTimer({ 
            accountsProcessed: accountsSucceeded,
            accountsFailed 
        });
        
        // Fallback to manual calculation if performance tracking is disabled
        if (durationMs === undefined || isNaN(durationMs)) {
            durationMs = Date.now() - syncStartTime;
        }
        
        // Determine sync status based on account results
        const syncStatus = accountsFailed > 0 && accountsSucceeded === 0 ? 'failure' : 
                          accountsFailed > 0 ? 'partial' : 'success';
        const errorMessage = accountsFailed > 0 ? 
            `${accountsFailed} account(s) failed to sync: ${failedAccounts.map(a => a.error).join('; ')}` : 
            null;
        const errorCode = null; // No error code in success/partial case
        
        // Log detailed sync results
        serverLogger.info('Sync completed', {
            status: syncStatus,
            accountsProcessed,
            accountsSucceeded,
            accountsFailed,
            succeededAccounts: succeededAccounts.length > 0 ? succeededAccounts : undefined,
            failedAccounts: failedAccounts.length > 0 ? failedAccounts : undefined,
            encrypted: isEncrypted,
            durationMs
        });
        
        // Update health check with sync status
        // Note: Partial failures are treated as success for overall health, but error details are preserved
        if (healthCheck) {
            healthCheck.updateSyncStatus({ 
                status: syncStatus === 'partial' ? 'success' : syncStatus, 
                serverName: name,
                error: syncStatus === 'partial' ? `Partial sync: ${errorMessage}` : errorMessage
            });
        }
        
        // Record sync in history
        if (syncHistory) {
            syncHistory.recordSync({
                serverName: name,
                status: syncStatus,
                durationMs,
                accountsProcessed,
                accountsSucceeded,
                accountsFailed,
                errorMessage,
                correlationId
            });
        }
        
        // Record metrics in Prometheus
        // Note: Partial status recorded as success but with accountsFailed count for monitoring
        if (prometheusService) {
            prometheusService.recordSync({
                server: name,
                status: syncStatus === 'partial' ? 'success' : syncStatus,
                duration: durationMs,
                accountsProcessed: accountsSucceeded,
                accountsFailed: accountsFailed
            });
        }
        
        // Record sync result for notification tracking
        // Note: Partial failures treated as success to avoid alert fatigue, but tracked separately
        if (notificationService) {
            const isSuccess = syncStatus !== 'failure';
            notificationService.recordSyncResult(name, isSuccess, correlationId);
            if (syncStatus === 'partial') {
                serverLogger.warn('Partial sync completed with some account failures', {
                    serverName: name,
                    succeededCount: accountsSucceeded,
                    failedCount: accountsFailed,
                    failedAccounts: failedAccounts.map(a => `${a.name}: ${a.error}`)
                });
            }
            
            // Send unified sync notification to all channels
            try {
                await notificationService.notifySync({
                    status: syncStatus,
                    serverName: name,
                    duration: durationMs,
                    accountsProcessed: accountsSucceeded,
                    accountsFailed: accountsFailed,
                    succeededAccounts: succeededAccounts,
                    failedAccounts: failedAccounts,
                    error: errorMessage,
                    errorCode: errorCode,
                    correlationId,
                    context: {},
                    bypassThresholds: false
                });
            } catch (notifyError) {
                logger.error('Failed to send sync notification', { 
                    error: notifyError.message,
                    correlationId
                });
            }
        }
        
    } catch (error) {
        let durationMs = endTimer({ error: error.message || String(error) });
        
        // Fallback to manual calculation if performance tracking is disabled
        if (durationMs === undefined || isNaN(durationMs)) {
            durationMs = Date.now() - syncStartTime;
        }
        
        // Normalize error information
        // Check if message exists and is not empty, otherwise use toString
        let errorMessage = error?.message;
        
        // Log error structure for debugging
        serverLogger.debug('Error structure for debugging', {
            hasMessage: !!errorMessage,
            errorMessage: errorMessage,
            toString: error?.toString(),
            hasStack: !!error?.stack,
            stackFirstLine: error?.stack?.split('\n')[0],
            errorType: error?.constructor?.name
        });
        
        if (!errorMessage || errorMessage.trim() === '' || errorMessage === 'Error') {
            // Try to extract from stack trace first
            if (error?.stack) {
                const stackLines = error.stack.split('\n');
                const firstLine = stackLines[0];
                // Remove "Error: " prefix if present
                if (firstLine && firstLine.startsWith('Error: ')) {
                    errorMessage = firstLine.substring(7); // Remove "Error: "
                } else {
                    errorMessage = firstLine;
                }
                
                // If still just "Error", look for originalError
                if (errorMessage === 'Error' && error?.originalError) {
                    errorMessage = error.originalError.message || error.originalError.toString() || 'Unknown sync error';
                }
            }
            
            // Try toString as fallback
            if (!errorMessage || errorMessage === 'Error') {
                const errorString = error?.toString() || String(error);
                if (errorString && errorString !== '[object Object]' && errorString !== 'Error') {
                    errorMessage = errorString.replace(/^Error: /, '');
                } else {
                    errorMessage = 'Unknown sync error';
                }
            }
        }
        const errorCode = error?.code || error?.errorCode || 'UNKNOWN';
        const errorStack = error?.stack || 'No stack trace available';
        
        serverLogger.error(`Error syncing bank for server`, {
            error: errorMessage,
            errorCode: errorCode,
            errorStack: errorStack,
            accountsProcessed,
            accountsSucceeded,
            accountsFailed,
            encrypted: isEncrypted,
            phase: accountsProcessed === 0 ? 'initialization' : accountsSucceeded > 0 ? 'final-sync' : 'bank-sync'
        });
        
        // Update health check with failed sync
        if (healthCheck) {
            healthCheck.updateSyncStatus({ 
                status: 'failure', 
                serverName: name, 
                error: errorMessage 
            });
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
                errorMessage: errorMessage,
                errorCode: errorCode,
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
                errorCode: errorCode
            });
        }
        
        // Record failed sync result and send unified notification to all channels
        if (notificationService) {
            notificationService.recordSyncResult(name, false, correlationId);
            
            try {
                await notificationService.notifySync({
                    status: 'failure',
                    serverName: name,
                    duration: durationMs,
                    accountsProcessed: accountsSucceeded,
                    accountsFailed: accountsFailed,
                    succeededAccounts: succeededAccounts,
                    failedAccounts: failedAccounts,
                    error: errorMessage,
                    errorCode: errorCode,
                    correlationId,
                    context: {
                        accountsProcessed,
                        accountsSucceeded,
                        accountsFailed,
                        durationMs
                    },
                    bypassThresholds: false
                });
            } catch (notifyError) {
                const notifyErrorMessage = notifyError?.message || String(notifyError) || 'Unknown notification error';
                logger.error('Failed to send sync notification', {
                    error: notifyErrorMessage,
                    originalError: errorMessage,
                    correlationId
                });
            }
        }
    } finally {
        try {
            serverLogger.debug('Shutting down Actual API connection');
            await actual.shutdown();
            serverLogger.debug('Shutdown complete');
        } catch (shutdownError) {
            const shutdownErrorMessage = shutdownError?.message || String(shutdownError) || 'Unknown shutdown error';
            serverLogger.error('Error during shutdown', {
                error: shutdownErrorMessage
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
        
        // Update the reference for health check service by clearing and repopulating
        // (this maintains the same array reference that getCronSchedules closure captured)
        scheduledJobsRef.length = 0; // Clear the array
        scheduledJobsRef.push(...scheduledJobs); // Add all scheduled jobs

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
        
        // Start health check service (must be after scheduledJobsRef is populated)
        healthCheck.start().catch((error) => {
            logger.error('Failed to start health check service', { error: error.message });
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
        
        // Send startup notification to all configured channels
        if (notificationService) {
            try {
                const serverNames = servers.map(s => s.name).join(', ');
                const scheduleInfo = scheduledJobs.map(sj => 
                    `  • ${sj.servers.map(s => s.name).join(', ')}\n    ${cronstrue.toString(sj.schedule)} (${sj.schedule})`
                ).join('\n');
                const nextSync = scheduledJobs[0]?.job.nextInvocation();
                const nextSyncStr = nextSync ? nextSync.toLocaleString('en-US', { 
                    timeZone: 'Europe/Madrid',
                    dateStyle: 'short',
                    timeStyle: 'short'
                }) : 'N/A';
                
                // Send unified startup notification to all channels
                await notificationService.sendStartupNotification({
                    version: VERSION,
                    serverNames,
                    schedules: scheduleInfo,
                    nextSync: nextSyncStr
                });
                
                logger.info('Startup notifications sent to all channels');
                
            } catch (error) {
                logger.error('Failed to send startup notification', { error: error.message });
            }
        }
    }
}

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
    // Extract meaningful information from reason
    const reasonInfo = reason instanceof Error 
        ? { message: reason.message, code: reason.code, stack: reason.stack }
        : typeof reason === 'object' && reason !== null
        ? { ...reason, toString: String(reason) }
        : { value: reason, type: typeof reason };
    
    logger.error('Unhandled promise rejection - service will continue', {
        reason: reasonInfo,
        promiseString: promise ? promise.toString() : 'no promise info'
    });
});

run().catch((error) => {
    logger.error('Fatal error during service initialization', { error: error.message, stack: error.stack });
    process.exit(1);
});




