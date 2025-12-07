/**
 * Telegram Bot Service
 * 
 * Handles interactive Telegram bot commands for monitoring and control
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../lib/logger');

class TelegramBotService {
  /**
   * Create a TelegramBotService instance
   * @param {Object} config - Telegram bot configuration
   * @param {string} config.botToken - Telegram bot token
   * @param {string} config.chatId - Telegram chat ID
   * @param {string} config.notifyOnSuccess - Notify on successful syncs ('always', 'never', 'errors_only')
   * @param {Object} services - Service dependencies
   * @param {Object} services.syncHistory - Sync history service
   * @param {Object} services.healthCheck - Health check service
   * @param {Function} services.getServerConfig - Function to get server configuration
   * @param {Object} loggerConfig - Logger configuration
   */
  constructor(config = {}, services = {}, loggerConfig = {}) {
    this.config = {
      botToken: config.botToken || process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: config.chatId || process.env.TELEGRAM_CHAT_ID || '',
      notifyOnSuccess: config.notifyOnSuccess || 'errors_only', // 'always', 'never', 'errors_only'
      pollInterval: config.pollInterval || 2000, // Poll every 2 seconds
      ...config
    };

    this.services = services;
    this.logger = createLogger({
      component: 'TelegramBot',
      ...loggerConfig
    });

    this.lastUpdateId = 0;
    this.polling = false;
    this.pollTimeout = null;
    this.commands = this.initializeCommands();
    this.preferencesFile = path.join(process.cwd(), 'data', 'telegram-preferences.json');
    
    // Load saved preferences
    this.loadPreferences();
  }

  /**
   * Initialize bot commands
   */
  initializeCommands() {
    return {
      '/help': {
        description: 'Show available commands',
        handler: this.handleHelp.bind(this)
      },
      '/ping': {
        description: 'Check if bot is responsive',
        handler: this.handlePing.bind(this)
      },
      '/status': {
        description: 'Get current sync status',
        handler: this.handleStatus.bind(this)
      },
      '/history': {
        description: 'Show recent sync history',
        handler: this.handleHistory.bind(this)
      },
      '/stats': {
        description: 'Show sync statistics',
        handler: this.handleStats.bind(this)
      },
      '/servers': {
        description: 'List configured servers',
        handler: this.handleServers.bind(this)
      },
      '/notify': {
        description: 'Change notification settings (always/errors/never)',
        handler: this.handleNotify.bind(this)
      },
      '/errors': {
        description: 'Show recent errors',
        handler: this.handleErrors.bind(this)
      }
    };
  }

  /**
   * Load preferences from file
   */
  loadPreferences() {
    try {
      if (fs.existsSync(this.preferencesFile)) {
        const data = fs.readFileSync(this.preferencesFile, 'utf8');
        const preferences = JSON.parse(data);
        
        // Apply saved notification mode if it exists
        if (preferences.notifyOnSuccess) {
          this.config.notifyOnSuccess = preferences.notifyOnSuccess;
          this.logger.info('Loaded notification preferences', {
            notifyOnSuccess: this.config.notifyOnSuccess
          });
        }
      }
    } catch (error) {
      this.logger.error('Failed to load preferences', {
        error: error.message
      });
    }
  }

  /**
   * Save preferences to file
   */
  savePreferences() {
    try {
      const preferences = {
        notifyOnSuccess: this.config.notifyOnSuccess,
        lastUpdated: new Date().toISOString()
      };
      
      // Ensure data directory exists
      const dataDir = path.dirname(this.preferencesFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      fs.writeFileSync(this.preferencesFile, JSON.stringify(preferences, null, 2));
      
      this.logger.info('Saved notification preferences', {
        notifyOnSuccess: this.config.notifyOnSuccess
      });
    } catch (error) {
      this.logger.error('Failed to save preferences', {
        error: error.message
      });
    }
  }

  /**
   * Start polling for updates
   */
  start() {
    if (this.polling) {
      this.logger.warn('Telegram bot already polling');
      return;
    }

    if (!this.config.botToken || !this.config.chatId) {
      this.logger.error('Telegram bot token or chat ID not configured');
      return;
    }

    this.polling = true;
    this.logger.info('Telegram bot started', {
      chatId: this.config.chatId,
      notifyOnSuccess: this.config.notifyOnSuccess
    });

    this.poll();
  }

  /**
   * Stop polling for updates
   */
  stop() {
    this.polling = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    this.logger.info('Telegram bot stopped');
  }

  /**
   * Poll for updates
   */
  async poll() {
    if (!this.polling) return;

    try {
      const updates = await this.getUpdates();
      
      for (const update of updates) {
        if (update.update_id > this.lastUpdateId) {
          this.lastUpdateId = update.update_id;
          await this.processUpdate(update);
        }
      }
    } catch (error) {
      this.logger.error('Error polling for updates', {
        error: error.message
      });
    }

    // Schedule next poll
    this.pollTimeout = setTimeout(() => this.poll(), this.config.pollInterval);
  }

  /**
   * Get updates from Telegram
   */
  async getUpdates() {
    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/getUpdates`;
      const params = new URLSearchParams({
        offset: this.lastUpdateId + 1,
        timeout: 30,
        allowed_updates: JSON.stringify(['message'])
      });

      const response = await this.makeRequest(`${url}?${params.toString()}`);
      return response.result || [];
    } catch (error) {
      this.logger.error('Failed to get updates', { error: error.message });
      return [];
    }
  }

  /**
   * Process an update
   */
  async processUpdate(update) {
    if (!update.message || !update.message.text) {
      return;
    }

    const message = update.message;
    const text = message.text.trim();
    const from = message.from;

    // Log all incoming messages
    this.logger.info('Telegram message received', {
      from: `${from.first_name} ${from.last_name || ''}`.trim(),
      username: from.username,
      chatId: message.chat.id,
      text: text
    });

    // Check if it's from the configured chat
    if (message.chat.id.toString() !== this.config.chatId.toString()) {
      this.logger.warn('Message from unauthorized chat', {
        chatId: message.chat.id,
        configuredChatId: this.config.chatId
      });
      return;
    }

    // Check if it's a command
    const command = text.split(' ')[0].toLowerCase();
    if (this.commands[command]) {
      try {
        const args = text.split(' ').slice(1);
        await this.commands[command].handler(args);
      } catch (error) {
        this.logger.error('Error handling command', {
          command,
          error: error.message
        });
        await this.sendMessage(`❌ Error executing command: ${error.message}`);
      }
    } else {
      // Not a recognized command
      this.logger.info('Non-command message received', { text });
      await this.sendMessage(
        `I received your message: "${text}"\n\n` +
        `I don't understand that command. Type /help to see available commands.`
      );
    }
  }

  /**
   * Handle /help command
   */
  async handleHelp(args) {
    const commandList = Object.entries(this.commands)
      .map(([cmd, info]) => `${cmd} - ${info.description}`)
      .join('\n');

    await this.sendMessage(
      `🤖 Actual-sync Bot Commands\n\n` +
      `${commandList}\n\n` +
      `Current notification mode: ${this.config.notifyOnSuccess}`
    );
  }

  /**
   * Handle /ping command
   */
  async handlePing(args) {
    await this.sendMessage('🏓 Pong! Bot is responsive.');
  }

  /**
   * Handle /status command
   */
  async handleStatus(args) {
    try {
      const healthCheck = this.services.healthCheck;
      if (!healthCheck) {
        await this.sendMessage('❌ Health check service not available');
        return;
      }

      const status = healthCheck.getStatus();
      
      // Calculate uptime
      const startTime = new Date(status.startTime);
      const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
      const uptimeMinutes = Math.floor(uptime / 60);
      
      // Calculate success rate
      const totalSyncs = status.syncCount || 0;
      const successCount = status.successCount || 0;
      const failureCount = status.failureCount || 0;
      const successRate = totalSyncs > 0 
        ? ((successCount / totalSyncs) * 100).toFixed(1) + '%'
        : 'N/A';
      
      // Determine status emoji
      const statusEmoji = failureCount === 0 && totalSyncs > 0 ? '✅' :
                          failureCount > successCount ? '❌' :
                          failureCount > 0 ? '⚠️' :
                          totalSyncs === 0 ? '⏳' : '✅';

      let message = `${statusEmoji} Service Status\n\n`;
      message += `Uptime: ${uptimeMinutes} minutes\n`;
      message += `Total Syncs: ${totalSyncs}\n`;
      message += `Successful: ${successCount}\n`;
      message += `Failed: ${failureCount}\n`;
      message += `Success Rate: ${successRate}\n`;

      if (status.lastSyncTime) {
        const lastSync = new Date(status.lastSyncTime);
        message += `\nLast Sync: ${lastSync.toLocaleString('en-US', { 
          timeZone: 'Europe/Madrid' 
        })}`;
        message += `\nStatus: ${status.lastSyncStatus}`;
      } else {
        message += `\nNo syncs yet`;
      }

      await this.sendMessage(message);
    } catch (error) {
      await this.sendMessage(`❌ Error getting status: ${error.message}`);
    }
  }

  /**
   * Handle /history command
   */
  async handleHistory(args) {
    try {
      const syncHistory = this.services.syncHistory;
      if (!syncHistory) {
        await this.sendMessage('❌ Sync history service not available');
        return;
      }

      const limit = parseInt(args[0]) || 5;
      const history = syncHistory.getHistory({ limit });

      if (history.length === 0) {
        await this.sendMessage('📜 No sync history available yet');
        return;
      }

      let message = `📜 Recent Syncs (last ${limit}):\n\n`;
      for (const record of history) {
        const emoji = record.status === 'success' ? '✅' : '❌';
        const time = new Date(record.timestamp).toLocaleString('en-US', {
          timeZone: 'Europe/Madrid',
          dateStyle: 'short',
          timeStyle: 'short'
        });
        message += `${emoji} ${record.server_name}\n`;
        message += `   ${time}\n`;
        message += `   Duration: ${record.duration_ms}ms\n`;
        if (record.status === 'failure' || record.status === 'error') {
          message += `   Error: ${record.error_message || 'Unknown error'}\n`;
        }
        message += '\n';
      }

      await this.sendMessage(message);
    } catch (error) {
      await this.sendMessage(`❌ Error getting history: ${error.message}`);
    }
  }

  /**
   * Handle /stats command
   */
  async handleStats(args) {
    try {
      const syncHistory = this.services.syncHistory;
      if (!syncHistory) {
        await this.sendMessage('❌ Sync history service not available');
        return;
      }

      const stats = syncHistory.getStatistics();

      let message = `📊 Sync Statistics\n\n`;
      message += `Total Syncs: ${stats.total_syncs || 0}\n`;
      message += `Successful: ${stats.successful_syncs || 0}\n`;
      message += `Failed: ${stats.failed_syncs || 0}\n`;
      message += `Success Rate: ${stats.success_rate || 'N/A'}\n\n`;
      message += `Avg Duration: ${Math.round(stats.avg_duration_ms || 0)}ms\n`;
      message += `Total Accounts: ${stats.total_accounts_processed || 0}\n`;

      if (stats.latest_sync) {
        const lastSync = new Date(stats.latest_sync);
        message += `\nLast Sync: ${lastSync.toLocaleString('en-US', { 
          timeZone: 'Europe/Madrid' 
        })}`;
      }

      await this.sendMessage(message);
    } catch (error) {
      await this.sendMessage(`❌ Error getting statistics: ${error.message}`);
    }
  }

  /**
   * Handle /servers command
   */
  async handleServers(args) {
    try {
      const getServerConfig = this.services.getServerConfig;
      if (!getServerConfig) {
        await this.sendMessage('❌ Server configuration not available');
        return;
      }

      const servers = getServerConfig();
      if (!servers || servers.length === 0) {
        await this.sendMessage('📋 No servers configured');
        return;
      }

      let message = `📋 Configured Servers (${servers.length}):\n\n`;
      for (const server of servers) {
        message += `🖥️ ${server.name}\n`;
        message += `   URL: ${server.url}\n`;
        if (server.sync && server.sync.schedule) {
          message += `   Schedule: ${server.sync.schedule}\n`;
        }
        message += '\n';
      }

      await this.sendMessage(message);
    } catch (error) {
      await this.sendMessage(`❌ Error getting servers: ${error.message}`);
    }
  }

  /**
   * Handle /notify command
   */
  async handleNotify(args) {
    const mode = args[0]?.toLowerCase();
    const validModes = ['always', 'errors', 'never'];

    if (!mode || !validModes.includes(mode)) {
      await this.sendMessage(
        `⚙️ Current notification mode: ${this.config.notifyOnSuccess}\n\n` +
        `Usage: /notify [always|errors|never]\n\n` +
        `• always - Notify on all syncs\n` +
        `• errors - Notify only on failures (default)\n` +
        `• never - No sync notifications (commands still work)`
      );
      return;
    }

    const modeMap = {
      'always': 'always',
      'errors': 'errors_only',
      'never': 'never'
    };

    this.config.notifyOnSuccess = modeMap[mode];
    this.logger.info('Notification mode changed', {
      mode: this.config.notifyOnSuccess
    });
    
    // Save preferences to persist across restarts
    this.savePreferences();

    await this.sendMessage(
      `✅ Notification mode changed to: ${this.config.notifyOnSuccess}\n\n` +
      `You will ${mode === 'never' ? 'not receive' : 'receive'} sync notifications.\n` +
      `This setting will be remembered across restarts.`
    );
  }

  /**
   * Handle /errors command
   */
  async handleErrors(args) {
    try {
      const syncHistory = this.services.syncHistory;
      if (!syncHistory) {
        await this.sendMessage('❌ Sync history service not available');
        return;
      }

      const limit = parseInt(args[0]) || 5;
      const errors = syncHistory.getRecentErrors(limit);

      if (errors.length === 0) {
        await this.sendMessage('✅ No recent errors!');
        return;
      }

      let message = `❌ Recent Errors (last ${limit}):\n\n`;
      for (const error of errors) {
        const time = new Date(error.timestamp).toLocaleString('en-US', {
          timeZone: 'Europe/Madrid',
          dateStyle: 'short',
          timeStyle: 'short'
        });
        message += `🖥️ ${error.server_name}\n`;
        message += `   ${time}\n`;
        message += `   ${error.error_message}\n`;
        if (error.error_code) {
          message += `   Code: ${error.error_code}\n`;
        }
        message += '\n';
      }

      await this.sendMessage(message);
    } catch (error) {
      await this.sendMessage(`❌ Error getting errors: ${error.message}`);
    }
  }

  /**
   * Send a message to Telegram
   */
  async sendMessage(text, options = {}) {
    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
      const payload = {
        chat_id: this.config.chatId,
        text: text,
        disable_web_page_preview: true,
        ...options
      };

      await this.makeRequest(url, 'POST', payload);
      this.logger.debug('Telegram message sent', { textLength: text.length });
      return true;
    } catch (error) {
      this.logger.error('Failed to send Telegram message', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Make HTTP request
   */
  makeRequest(url, method = 'GET', payload = null) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const body = payload ? JSON.stringify(payload) : null;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Actual-sync-Bot/1.0'
        }
      };

      if (body) {
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  /**
   * Send sync notification if configured
   */
  async notifySync(result) {
    if (this.config.notifyOnSuccess === 'never') {
      return;
    }

    if (this.config.notifyOnSuccess === 'errors_only' && result.status === 'success' && !result.accountsFailed) {
      return;
    }

    // Determine status based on results
    let emoji, statusText;
    if (result.status === 'success') {
      if (result.accountsFailed > 0) {
        emoji = '⚠️';
        statusText = 'Completed with Issues';
      } else {
        emoji = '✅';
        statusText = 'Successful';
      }
    } else {
      emoji = '❌';
      statusText = 'Failed';
    }

    let message = `${emoji} Sync ${statusText}\n\n`;
    message += `Server: ${result.serverName}\n`;
    
    // Format duration (convert to seconds if > 1000ms)
    const duration = result.duration >= 1000 
      ? `${(result.duration / 1000).toFixed(1)}s`
      : `${result.duration}ms`;
    message += `Duration: ${duration}\n`;

    if (result.status === 'success') {
      const totalAccounts = (result.accountsProcessed || 0) + (result.accountsFailed || 0);
      message += `Result: ${result.accountsProcessed || 0}/${totalAccounts} synced`;
      
      if (result.accountsFailed > 0) {
        message += `, ${result.accountsFailed} failed ❌`;
      }
      message += `\n`;

      // Show successful accounts
      if (result.succeededAccounts && result.succeededAccounts.length > 0) {
        message += `\n✅ Synced:\n`;
        for (const accountName of result.succeededAccounts) {
          message += `  • ${accountName}\n`;
        }
      }

      // Show failed accounts with errors
      if (result.failedAccounts && result.failedAccounts.length > 0) {
        message += `\n❌ Failed:\n`;
        for (const account of result.failedAccounts) {
          message += `  • ${account.name}\n`;
          if (account.error) {
            // Truncate long error messages
            const errorMsg = account.error.length > 80 
              ? account.error.substring(0, 77) + '...'
              : account.error;
            message += `    ${errorMsg}\n`;
          }
        }
      }
    } else {
      message += `Error: ${result.error}\n`;
      if (result.errorCode) {
        message += `Code: ${result.errorCode}\n`;
      }
    }

    await this.sendMessage(message);
  }

  /**
   * Get current notification mode
   */
  getNotificationMode() {
    return this.config.notifyOnSuccess;
  }
}

module.exports = { TelegramBotService };
