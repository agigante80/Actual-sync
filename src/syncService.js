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
function cronToHuman(cron) {
    const parts = cron.split(' ');
    if (parts.length !== 5) return cron;
    
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    
    // Day names
    const days = {
        '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday',
        '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '7': 'Sunday'
    };
    
    // Handle minute intervals (e.g., */15, */30)
    if (minute.startsWith('*/')) {
        const interval = minute.substring(2);
        if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
            return `Every ${interval} minutes`;
        }
    }
    
    // Handle hourly patterns (e.g., 0 * * * *)
    if (minute.match(/^\d+$/) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
        return `Every hour at minute ${minute}`;
    }
    
    // Handle hour intervals (e.g., 0 */6 * * *)
    if (hour.startsWith('*/')) {
        const interval = hour.substring(2);
        return `Every ${interval} hours at minute ${minute}`;
    }
    
    let timeStr = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    
    if (dayOfWeek === '*' && dayOfMonth === '*') {
        return `Daily at ${timeStr}`;
    }
    
    // Handle specific days of week
    if (dayOfWeek !== '*') {
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
    
    // Handle specific day of month
    if (dayOfMonth !== '*') {
        return `Monthly on day ${dayOfMonth} at ${timeStr}`;
    }
    
    return `Daily at ${timeStr}`;
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
    
    // Initialize health check service
    healthCheck = new HealthCheckService({
        port: config.healthCheck?.port || 3000,
        host: config.healthCheck?.host || '0.0.0.0',
        dashboardConfig: config.healthCheck?.dashboard || { enabled: true, auth: { type: 'none' } },
        prometheusService: prometheusService,
        syncHistory: syncHistory,
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
                cronHuman: cronToHuman(sj.schedule),
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
            // Normalize error to ensure we have a message
            const errorMessage = error?.message || error?.toString() || String(error) || 'Unknown error';
            const errorCode = error?.code || 'UNKNOWN';
            const errorCategory = error?.category;
            
            logger.error(`Attempt ${i + 1} failed`, { 
                attempt: i + 1, 
                error: errorMessage,
                errorCode: errorCode,
                errorCategory: errorCategory
            });

            let retryDelay = 0;

            if (errorCode === 'NORDIGEN_ERROR' && errorCategory === 'RATE_LIMIT_EXCEEDED') {
                retryDelay = baseRetryDelayMs * (2 ** i); // Exponential backoff for rate limits
                logger.warn(`Rate limit exceeded. Retrying in ${retryDelay / 1000} seconds...`, {
                    retryDelayMs: retryDelay,
                    attempt: i + 1
                });
            } else if (errorMessage === 'network-failure' || errorCode === 'ECONNRESET' || errorCode === 'ENOTFOUND') {
                // Retry for network failures, ECONNRESET, or DNS issues
                retryDelay = baseRetryDelayMs * (2 ** i); // Exponential backoff for network issues
                logger.warn(`Network failure. Retrying in ${retryDelay / 1000} seconds...`, {
                    retryDelayMs: retryDelay,
                    attempt: i + 1,
                    errorCode: errorCode
                });
            } else {
                logger.error('Not a retryable error, not retrying', { 
                    errorCode: errorCode,
                    errorMessage: errorMessage 
                });
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
    const { name, url, password, syncId, dataDir, encryptionPassword } = server;
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

        serverLogger.info(`Loading budget file`, { 
            syncId: syncIdLog,
            encrypted: !!encryptionPassword
        });
        
        // Download budget with encryption password if provided
        const downloadOptions = encryptionPassword ? { password: encryptionPassword } : undefined;
        try {
            await runWithRetries(
                async () => await actual.downloadBudget(syncId, downloadOptions),
                syncConfig.maxRetries,
                syncConfig.baseRetryDelayMs
            );
            serverLogger.info('Budget file loaded successfully', {
                encrypted: !!encryptionPassword
            });
        } catch (downloadError) {
            // Enhance error message with more context
            const originalError = downloadError?.message || downloadError?.toString() || 'Unknown error';
            const errorDetails = [];
            
            if (originalError.includes('Could not get remote files')) {
                errorDetails.push('Failed to retrieve budget files from server.');
                errorDetails.push(`Verify that Sync ID "${syncId}" exists on server "${url}".`);
                errorDetails.push('Check that file sync is enabled in your Actual Budget server settings.');
                if (!encryptionPassword) {
                    errorDetails.push('If this budget uses encryption, provide the encryptionPassword in config.');
                }
            } else if (originalError.includes('network-failure')) {
                errorDetails.push('Network connection to Actual Budget server failed.');
                errorDetails.push(`Check that server is accessible at: ${url}`);
            } else if (originalError.includes('decrypt-failure') || originalError.includes('Invalid password')) {
                errorDetails.push('Failed to decrypt budget file.');
                errorDetails.push('Verify the encryptionPassword is correct for this budget.');
            } else if (originalError.includes('unauthorized')) {
                errorDetails.push('Authentication failed.');
                errorDetails.push('Verify the server password is correct.');
            }
            
            const enhancedMessage = errorDetails.length > 0 
                ? `${originalError}\n\nTroubleshooting:\n- ${errorDetails.join('\n- ')}`
                : originalError;
            
            const enhancedError = new Error(enhancedMessage);
            enhancedError.originalError = downloadError;
            enhancedError.syncId = syncId;
            enhancedError.serverUrl = url;
            throw enhancedError;
        }

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
        await runWithRetries(
            async () => await actual.sync(),
            syncConfig.maxRetries,
            syncConfig.baseRetryDelayMs
        );
        serverLogger.info('Final file sync completed');
        
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
        }
        
        // Send Telegram bot notification
        if (telegramBot) {
            try {
                await telegramBot.notifySync({
                    status: syncStatus,
                    serverName: name,
                    duration: durationMs,
                    accountsProcessed: accountsSucceeded,
                    accountsFailed: accountsFailed,
                    succeededAccounts: succeededAccounts,
                    failedAccounts: failedAccounts,
                    errorMessage: errorMessage
                });
            } catch (botError) {
                logger.error('Failed to send Telegram bot notification', { error: botError.message });
            }
        }
        
    } catch (error) {
        let durationMs = endTimer({ error: error.message || String(error) });
        
        // Fallback to manual calculation if performance tracking is disabled
        if (durationMs === undefined || isNaN(durationMs)) {
            durationMs = Date.now() - syncStartTime;
        }
        
        // Normalize error information
        const errorMessage = error?.message || error?.toString() || String(error) || 'Unknown sync error';
        const errorCode = error?.code || 'UNKNOWN';
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
        
        // Record failed sync result and send notification if thresholds exceeded
        if (notificationService) {
            notificationService.recordSyncResult(name, false, correlationId);
            
            try {
                await notificationService.notifyError({
                    serverName: name,
                    errorMessage: errorMessage,
                    errorCode: errorCode,
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
                const notifyErrorMessage = notifyError?.message || String(notifyError) || 'Unknown notification error';
                logger.error('Failed to send error notification', {
                    error: notifyErrorMessage,
                    originalError: errorMessage
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
                    error: errorMessage,
                    errorCode: errorCode
                });
            } catch (botError) {
                const botErrorMessage = botError?.message || String(botError) || 'Unknown bot error';
                logger.error('Failed to send Telegram bot notification', { error: botErrorMessage });
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

run().catch((error) => {
    logger.error('Fatal error during service initialization', { error: error.message, stack: error.stack });
    process.exit(1);
});




