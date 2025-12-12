#!/usr/bin/env node
/**
 * View Sync History
 * 
 * Command-line tool to query and display sync history from the database.
 * 
 * Usage:
 *   npm run history                              # Show recent history
 *   npm run history -- --server Main             # Filter by server
 *   npm run history -- --days 7                  # Last 7 days
 *   npm run history -- --status failure          # Show only failures
 *   npm run history -- --stats                   # Show statistics
 *   npm run history -- --stats --server Main     # Stats for specific server
 *   npm run history -- --errors                  # Show recent errors
 */

const { SyncHistoryService } = require('../src/services/syncHistory');
const ConfigLoader = require('../src/lib/configLoader');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  server: null,
  days: null,
  status: null,
  limit: 20,
  stats: false,
  errors: false,
  perServer: false
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--server':
      options.server = args[++i];
      break;
    case '--days':
      options.days = parseInt(args[++i]);
      break;
    case '--status':
      options.status = args[++i];
      break;
    case '--limit':
      options.limit = parseInt(args[++i]);
      break;
    case '--stats':
      options.stats = true;
      break;
    case '--errors':
      options.errors = true;
      break;
    case '--per-server':
      options.perServer = true;
      break;
    case '--help':
    case '-h':
      showHelp();
      process.exit(0);
  }
}

function showHelp() {
  console.log(`
Sync History Viewer

Usage: npm run history -- [options]

Options:
  --server <name>      Filter by server name
  --days <number>      Number of days to look back
  --status <status>    Filter by status (success or failure)
  --limit <number>     Maximum number of records to show (default: 20)
  --stats              Show statistics instead of history
  --per-server         Show per-server statistics
  --errors             Show recent errors only
  --help, -h           Show this help message

Examples:
  npm run history                              # Show recent history
  npm run history -- --server Main             # Filter by server
  npm run history -- --days 7                  # Last 7 days
  npm run history -- --status failure          # Show only failures
  npm run history -- --stats                   # Show overall statistics
  npm run history -- --stats --server Main     # Stats for specific server
  npm run history -- --per-server              # Stats per server
  npm run history -- --errors                  # Show recent errors
  `);
}

function formatDuration(ms) {
  if (!ms) return 'N/A';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

function displayHistory(records) {
  if (records.length === 0) {
    console.log('No history records found matching the criteria.');
    return;
  }

  console.log(`\nSync History (${records.length} records):\n`);
  console.log('─'.repeat(120));
  console.log(
    'Timestamp'.padEnd(25) +
    'Server'.padEnd(20) +
    'Status'.padEnd(12) +
    'Duration'.padEnd(12) +
    'Accounts'.padEnd(20) +
    'Error'
  );
  console.log('─'.repeat(120));

  records.forEach(record => {
    const timestamp = formatTimestamp(record.timestamp);
    const server = record.server_name;
    const status = record.status === 'success' ? '✓ success' : '✗ failure';
    const duration = formatDuration(record.duration_ms);
    const accounts = `${record.accounts_succeeded}/${record.accounts_processed}`;
    const error = record.error_message ? record.error_message.substring(0, 40) : '';

    console.log(
      timestamp.padEnd(25) +
      server.padEnd(20) +
      status.padEnd(12) +
      duration.padEnd(12) +
      accounts.padEnd(20) +
      error
    );
  });

  console.log('─'.repeat(120));
  console.log();
}

function displayStatistics(stats) {
  console.log('\nSync Statistics:\n');
  console.log('─'.repeat(60));
  
  console.log(`Total Syncs:         ${stats.total_syncs || 0}`);
  console.log(`Successful Syncs:    ${stats.successful_syncs || 0}`);
  console.log(`Failed Syncs:        ${stats.failed_syncs || 0}`);
  console.log(`Success Rate:        ${stats.success_rate || 'N/A'}`);
  console.log();
  
  if (stats.avg_duration_ms) {
    console.log(`Average Duration:    ${formatDuration(stats.avg_duration_ms)}`);
    console.log(`Min Duration:        ${formatDuration(stats.min_duration_ms)}`);
    console.log(`Max Duration:        ${formatDuration(stats.max_duration_ms)}`);
    console.log();
  }
  
  console.log(`Total Accounts:      ${stats.total_accounts_processed || 0}`);
  
  if (stats.earliest_sync) {
    console.log();
    console.log(`Earliest Sync:       ${formatTimestamp(stats.earliest_sync)}`);
    console.log(`Latest Sync:         ${formatTimestamp(stats.latest_sync)}`);
  }
  
  console.log('─'.repeat(60));
  console.log();
}

function displayPerServerStats(statsArray) {
  if (statsArray.length === 0) {
    console.log('No statistics available.');
    return;
  }

  console.log('\nPer-Server Statistics:\n');
  console.log('─'.repeat(100));
  console.log(
    'Server'.padEnd(20) +
    'Total'.padEnd(10) +
    'Success'.padEnd(10) +
    'Failed'.padEnd(10) +
    'Rate'.padEnd(12) +
    'Avg Duration'.padEnd(15) +
    'Last Sync'
  );
  console.log('─'.repeat(100));

  statsArray.forEach(stat => {
    const server = stat.server_name;
    const total = stat.total_syncs.toString();
    const success = stat.successful_syncs.toString();
    const failed = stat.failed_syncs.toString();
    const rate = stat.success_rate;
    const avgDuration = formatDuration(stat.avg_duration_ms);
    const lastSync = formatTimestamp(stat.last_sync);

    console.log(
      server.padEnd(20) +
      total.padEnd(10) +
      success.padEnd(10) +
      failed.padEnd(10) +
      rate.padEnd(12) +
      avgDuration.padEnd(15) +
      lastSync
    );
  });

  console.log('─'.repeat(100));
  console.log();
}

function displayErrors(errors) {
  if (errors.length === 0) {
    console.log('No recent errors found.');
    return;
  }

  console.log(`\nRecent Errors (${errors.length}):\n`);
  
  errors.forEach((error, index) => {
    console.log('─'.repeat(80));
    console.log(`Error #${index + 1}`);
    console.log(`Timestamp:    ${formatTimestamp(error.timestamp)}`);
    console.log(`Server:       ${error.server_name}`);
    console.log(`Duration:     ${formatDuration(error.duration_ms)}`);
    console.log(`Accounts:     ${error.accounts_processed} processed, ${error.accounts_failed} failed`);
    if (error.error_code) {
      console.log(`Error Code:   ${error.error_code}`);
    }
    console.log(`Message:      ${error.error_message || 'N/A'}`);
    if (error.correlation_id) {
      console.log(`Correlation:  ${error.correlation_id}`);
    }
  });
  
  console.log('─'.repeat(80));
  console.log();
}

async function main() {
  try {
    // Load configuration
    const configLoader = new ConfigLoader();
    const config = configLoader.load();

    // Initialize sync history service
    const syncHistory = new SyncHistoryService({
      dbPath: config.syncHistory?.dbPath,
      retentionDays: config.syncHistory?.retentionDays || 90,
      loggerConfig: {
        level: 'ERROR',
        format: config.logging.format,
        logDir: config.logging.logDir
      }
    });

    // Execute requested operation
    if (options.errors) {
      // Show recent errors
      const errors = syncHistory.getRecentErrors(options.limit);
      displayErrors(errors);
    } else if (options.stats) {
      // Show statistics
      const stats = syncHistory.getStatistics({
        serverName: options.server,
        days: options.days
      });
      displayStatistics(stats);
    } else if (options.perServer) {
      // Show per-server statistics
      const stats = syncHistory.getStatisticsByServer(options.days);
      displayPerServerStats(stats);
    } else {
      // Show history
      const history = syncHistory.getHistory({
        serverName: options.server,
        status: options.status,
        days: options.days,
        limit: options.limit
      });
      displayHistory(history);
    }

    // Close database
    syncHistory.close();

  } catch (error) {
    console.error('Error accessing sync history:');
    console.error(error.message);
    process.exit(1);
  }
}

main();
