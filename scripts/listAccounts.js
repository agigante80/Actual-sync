#!/usr/bin/env node

/**
 * List all accounts from configured Actual Budget servers
 * Utility script to discover account IDs and verify connectivity
 */

const actual = require('@actual-app/api');
const fs = require('fs').promises;
const ConfigLoader = require('../src/lib/configLoader');
const { createLogger } = require('../src/lib/logger');

// Load environment variables
require('dotenv').config();

// Load configuration
let config;
let logger;
try {
    const configLoader = new ConfigLoader();
    config = configLoader.load();
    
    // Initialize logger
    logger = createLogger({
        level: config.logging.level,
        format: config.logging.format,
        logDir: config.logging.logDir
    });
} catch (error) {
    console.error('❌ Failed to load configuration:');
    console.error(error.message);
    console.error('\nPlease ensure config/config.json exists and is valid.');
    process.exit(1);
}

async function listAccountsForServer(server) {
    const { name, url, password, syncId, dataDir } = server;
    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📊 Server: ${name}`);
        console.log(`${'='.repeat(60)}`);
        
        // Ensure data directory exists
        logger.debug(`Checking data directory: ${dataDir}`, { server: name, dataDir });
        console.log(`Checking data directory: ${dataDir}`);
        try {
            await fs.mkdir(dataDir, { recursive: true });
            logger.debug('Data directory ready', { server: name, dataDir });
            console.log(`✅ Data directory ready`);
        } catch (mkdirError) {
            logger.error('Error creating data directory', { server: name, error: mkdirError.message });
            console.error(`❌ Error creating data directory:`, mkdirError);
            throw mkdirError;
        }

        logger.info(`Connecting to server`, { server: name, url });
        console.log(`Connecting to: ${url}`);
        await actual.init({
            serverURL: url,
            password: password,
            dataDir: dataDir,
        });
        logger.info('Connected to Actual server', { server: name });
        console.log('✅ Connected to Actual server');

        logger.info('Downloading budget file', { server: name, syncId });
        console.log('Downloading budget file...');
        await actual.downloadBudget(syncId);
        logger.info('Budget file loaded', { server: name });
        console.log('✅ Budget file loaded');
        
        logger.debug('Fetching accounts', { server: name });
        console.log('Fetching accounts...');
        const accounts = await actual.getAccounts();
        
        if (accounts && accounts.length > 0) {
            logger.info('Accounts retrieved successfully', { server: name, count: accounts.length });
            console.log(`\n✅ Found ${accounts.length} account(s):\n`);
            accounts.forEach((account, index) => {
                console.log(`  ${index + 1}. ${account.name}`);
                console.log(`     ID: ${account.id}`);
                console.log(`     Type: ${account.type || 'N/A'}`);
                console.log(`     Closed: ${account.closed ? 'Yes' : 'No'}`);
                console.log();
            });
        } else {
            logger.warn('No accounts found', { server: name });
            console.log('⚠️  No accounts found');
        }

    } catch (error) {
        logger.error('Failed to list accounts', { 
            server: name, 
            error: error.message,
            errorStack: error.stack 
        });
        console.error(`\n❌ Failed to list accounts for server "${name}":`, error.message);
        if (error.stack) {
            console.error('\nStack trace:', error.stack);
        }
    } finally {
        try {
            await actual.shutdown();
            logger.debug('Connection closed', { server: name });
            console.log('✅ Connection closed');
        } catch (shutdownError) {
            logger.error('Error during shutdown', { server: name, error: shutdownError.message });
            console.error('⚠️  Error during shutdown:', shutdownError);
        }
    }
}

async function main() {
    logger.info('Starting account discovery', { serverCount: config.servers.length });
    console.log('🔍 Actual-sync Account Discovery');
    console.log(`Configured servers: ${config.servers.length}\n`);
    
    for (const server of config.servers) {
        await listAccountsForServer(server);
    }
    
    logger.info('Account discovery complete');
    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ Account discovery complete');
    console.log(`${'='.repeat(60)}\n`);
}

main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
});