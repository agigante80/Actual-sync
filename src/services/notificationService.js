/**
 * Notification Service
 * 
 * Handles error notifications via email and webhooks (Slack, Discord, Teams)
 * with rate limiting and configurable thresholds.
 */

const nodemailer = require('nodemailer');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { createLogger } = require('../lib/logger');

class NotificationService {
  /**
   * Create a NotificationService instance
   * @param {Object} config - Notification configuration
   * @param {Object} config.email - Email configuration
   * @param {boolean} config.email.enabled - Enable email notifications
   * @param {string} config.email.host - SMTP host
   * @param {number} config.email.port - SMTP port
   * @param {boolean} config.email.secure - Use TLS
   * @param {Object} config.email.auth - SMTP authentication
   * @param {string} config.email.from - From address
   * @param {string[]} config.email.to - Recipient addresses
   * @param {Object} config.webhooks - Webhook configuration
   * @param {Object[]} config.webhooks.slack - Slack webhooks
   * @param {Object[]} config.webhooks.discord - Discord webhooks
   * @param {Object[]} config.webhooks.teams - Teams webhooks
   * @param {Object} config.thresholds - Notification thresholds
   * @param {number} config.thresholds.consecutiveFailures - Failures before notification
   * @param {number} config.thresholds.failureRate - Failure rate (0-1) over period
   * @param {number} config.thresholds.ratePeriodMinutes - Period for rate calculation
   * @param {Object} config.rateLimit - Rate limiting
   * @param {number} config.rateLimit.minIntervalMinutes - Min time between notifications
   * @param {number} config.rateLimit.maxPerHour - Max notifications per hour
   * @param {Object} loggerConfig - Logger configuration
   */
  constructor(config = {}, loggerConfig = {}) {
    this.config = {
      email: {
        enabled: false,
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
          user: '',
          pass: ''
        },
        from: '',
        to: [],
        ...config.email
      },
      telegram: {
        enabled: false,
        botToken: '',
        chatId: '',
        ...config.telegram
      },
      webhooks: {
        slack: [],
        discord: [],
        teams: [],
        telegram: [],
        ...config.webhooks
      },
      thresholds: {
        consecutiveFailures: 3,
        failureRate: 0.5,
        ratePeriodMinutes: 60,
        ...config.thresholds
      },
      rateLimit: {
        minIntervalMinutes: 15,
        maxPerHour: 4,
        ...config.rateLimit
      }
    };

    this.logger = createLogger({
      component: 'NotificationService',
      ...loggerConfig
    });

    // Track notification state
    this.lastNotificationTime = null;
    this.notificationHistory = [];
    this.consecutiveFailures = {};
    this.recentSyncs = {};

    // Initialize email transporter if enabled
    this.emailTransporter = null;
    if (this.config.email.enabled) {
      this.initializeEmailTransporter();
    }
  }

  /**
   * Initialize nodemailer transporter
   */
  initializeEmailTransporter() {
    try {
      this.emailTransporter = nodemailer.createTransport({
        host: this.config.email.host,
        port: this.config.email.port,
        secure: this.config.email.secure,
        auth: this.config.email.auth
      });

      this.logger.info('Email transporter initialized', {
        host: this.config.email.host,
        port: this.config.email.port
      });
    } catch (error) {
      this.logger.error('Failed to initialize email transporter', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Record a sync result for threshold tracking
   * @param {string} serverName - Server name
   * @param {boolean} success - Whether sync succeeded
   * @param {string} correlationId - Correlation ID
   */
  recordSyncResult(serverName, success, correlationId = null) {
    const timestamp = Date.now();

    // Initialize tracking for this server if needed
    if (!this.recentSyncs[serverName]) {
      this.recentSyncs[serverName] = [];
    }
    if (!this.consecutiveFailures[serverName]) {
      this.consecutiveFailures[serverName] = 0;
    }

    // Add to recent syncs
    this.recentSyncs[serverName].push({
      timestamp,
      success,
      correlationId
    });

    // Clean old syncs outside rate period
    const cutoff = timestamp - (this.config.thresholds.ratePeriodMinutes * 60 * 1000);
    this.recentSyncs[serverName] = this.recentSyncs[serverName].filter(
      sync => sync.timestamp > cutoff
    );

    // Update consecutive failures counter
    if (success) {
      this.consecutiveFailures[serverName] = 0;
    } else {
      this.consecutiveFailures[serverName]++;
    }

    this.logger.debug('Recorded sync result', {
      serverName,
      success,
      consecutiveFailures: this.consecutiveFailures[serverName],
      recentSyncsCount: this.recentSyncs[serverName].length,
      correlationId
    });
  }

  /**
   * Check if notification thresholds are exceeded
   * @param {string} serverName - Server name
   * @returns {Object} Threshold status
   */
  checkThresholds(serverName) {
    const consecutiveCount = this.consecutiveFailures[serverName] || 0;
    const consecutiveExceeded = 
      consecutiveCount >= this.config.thresholds.consecutiveFailures;

    let rateExceeded = false;
    let failureRate = 0;

    if (this.recentSyncs[serverName] && this.recentSyncs[serverName].length > 0) {
      const failures = this.recentSyncs[serverName].filter(s => !s.success).length;
      const total = this.recentSyncs[serverName].length;
      failureRate = failures / total;
      rateExceeded = failureRate >= this.config.thresholds.failureRate;
    }

    return {
      consecutiveExceeded,
      consecutiveCount,
      rateExceeded,
      failureRate,
      shouldNotify: consecutiveExceeded || rateExceeded
    };
  }

  /**
   * Check if rate limit allows sending notification
   * @returns {boolean} True if notification allowed
   */
  checkRateLimit() {
    const now = Date.now();
    const minInterval = this.config.rateLimit.minIntervalMinutes * 60 * 1000;
    const oneHour = 60 * 60 * 1000;

    // Check minimum interval
    if (this.lastNotificationTime && (now - this.lastNotificationTime) < minInterval) {
      this.logger.debug('Rate limit: minimum interval not met', {
        timeSinceLastMs: now - this.lastNotificationTime,
        minIntervalMs: minInterval
      });
      return false;
    }

    // Check max per hour
    const recentNotifications = this.notificationHistory.filter(
      time => (now - time) < oneHour
    );

    if (recentNotifications.length >= this.config.rateLimit.maxPerHour) {
      this.logger.debug('Rate limit: max per hour exceeded', {
        count: recentNotifications.length,
        max: this.config.rateLimit.maxPerHour
      });
      return false;
    }

    return true;
  }

  /**
   * Update rate limit tracking after sending notification
   */
  updateRateLimitTracking() {
    const now = Date.now();
    this.lastNotificationTime = now;
    this.notificationHistory.push(now);

    // Clean old history (keep last 2 hours)
    const twoHours = 2 * 60 * 60 * 1000;
    this.notificationHistory = this.notificationHistory.filter(
      time => (now - time) < twoHours
    );
  }

  /**
   * Send error notification
   * @param {Object} error - Error details
   * @param {string} error.serverName - Server name
   * @param {string} error.errorMessage - Error message
   * @param {string} error.errorCode - Error code
   * @param {string} error.timestamp - Timestamp
   * @param {string} error.correlationId - Correlation ID
   * @param {Object} error.context - Additional context
   * @returns {Promise<Object>} Notification result
   */
  async notifyError(error) {
    const { serverName, errorMessage, errorCode, timestamp, correlationId, context = {} } = error;

    // Check thresholds
    const thresholds = this.checkThresholds(serverName);
    if (!thresholds.shouldNotify) {
      this.logger.debug('Thresholds not exceeded, skipping notification', {
        serverName,
        thresholds,
        correlationId
      });
      return {
        sent: false,
        reason: 'thresholds_not_exceeded',
        thresholds
      };
    }

    // Check rate limit
    if (!this.checkRateLimit()) {
      this.logger.warn('Rate limit exceeded, skipping notification', {
        serverName,
        correlationId
      });
      return {
        sent: false,
        reason: 'rate_limit_exceeded'
      };
    }

    // Prepare notification content
    const notification = {
      serverName,
      errorMessage,
      errorCode,
      timestamp: timestamp || new Date().toISOString(),
      correlationId,
      context,
      thresholds,
      consecutiveFailures: this.consecutiveFailures[serverName]
    };

    // Send via all configured channels
    const results = {
      email: null,
      slack: [],
      discord: [],
      teams: [],
      telegram: []
    };

    try {
      // Send email
      if (this.config.email.enabled && this.emailTransporter) {
        results.email = await this.sendEmail(notification);
      }

      // Send webhooks
      results.slack = await this.sendSlackWebhooks(notification);
      results.discord = await this.sendDiscordWebhooks(notification);
      results.teams = await this.sendTeamsWebhooks(notification);
      results.telegram = await this.sendTelegramWebhooks(notification);

      // Update rate limiting
      this.updateRateLimitTracking();

      this.logger.info('Error notification sent', {
        serverName,
        correlationId,
        email: !!results.email,
        webhooks: {
          slack: results.slack.length,
          discord: results.discord.length,
          teams: results.teams.length,
          telegram: results.telegram.length
        }
      });

      return {
        sent: true,
        results,
        thresholds
      };
    } catch (err) {
      this.logger.error('Failed to send notification', {
        error: err.message,
        stack: err.stack,
        serverName,
        correlationId
      });
      throw err;
    }
  }

  /**
   * Send email notification
   * @param {Object} notification - Notification details
   * @returns {Promise<Object>} Send result
   */
  async sendEmail(notification) {
    if (!this.emailTransporter || this.config.email.to.length === 0) {
      return null;
    }

    const subject = `[Actual Budget Sync] Error: ${notification.serverName}`;
    const text = this.formatEmailText(notification);
    const html = this.formatEmailHtml(notification);

    try {
      const info = await this.emailTransporter.sendMail({
        from: this.config.email.from,
        to: this.config.email.to.join(', '),
        subject,
        text,
        html
      });

      this.logger.debug('Email sent', {
        messageId: info.messageId,
        recipients: this.config.email.to.length
      });

      return {
        success: true,
        messageId: info.messageId
      };
    } catch (error) {
      this.logger.error('Failed to send email', {
        error: error.message,
        stack: error.stack
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Format email text content
   * @param {Object} notification - Notification details
   * @returns {string} Formatted text
   */
  formatEmailText(notification) {
    return `
Actual Budget Sync Error

Server: ${notification.serverName}
Time: ${notification.timestamp}
Error: ${notification.errorMessage}
${notification.errorCode ? `Code: ${notification.errorCode}` : ''}
${notification.correlationId ? `Correlation ID: ${notification.correlationId}` : ''}

Alert Triggered:
- Consecutive Failures: ${notification.consecutiveFailures}
- Failure Rate: ${(notification.thresholds.failureRate * 100).toFixed(1)}%
${notification.thresholds.consecutiveExceeded ? '- Exceeded consecutive failure threshold' : ''}
${notification.thresholds.rateExceeded ? '- Exceeded failure rate threshold' : ''}

${notification.context && Object.keys(notification.context).length > 0 ? 
  'Additional Context:\n' + Object.entries(notification.context).map(([k, v]) => `  ${k}: ${v}`).join('\n') : ''}

Please investigate and resolve the issue.
`.trim();
  }

  /**
   * Format email HTML content
   * @param {Object} notification - Notification details
   * @returns {string} Formatted HTML
   */
  formatEmailHtml(notification) {
    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #dc3545; color: white; padding: 15px; border-radius: 5px 5px 0 0; }
    .content { background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
    .field { margin: 10px 0; }
    .label { font-weight: bold; color: #495057; }
    .value { color: #212529; }
    .alert { background: #fff3cd; border: 1px solid #ffc107; padding: 10px; margin: 15px 0; border-radius: 4px; }
    .footer { padding: 15px; text-align: center; color: #6c757d; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>🚨 Actual Budget Sync Error</h2>
    </div>
    <div class="content">
      <div class="field">
        <span class="label">Server:</span>
        <span class="value">${notification.serverName}</span>
      </div>
      <div class="field">
        <span class="label">Time:</span>
        <span class="value">${notification.timestamp}</span>
      </div>
      <div class="field">
        <span class="label">Error:</span>
        <span class="value">${notification.errorMessage}</span>
      </div>
      ${notification.errorCode ? `
      <div class="field">
        <span class="label">Code:</span>
        <span class="value">${notification.errorCode}</span>
      </div>
      ` : ''}
      ${notification.correlationId ? `
      <div class="field">
        <span class="label">Correlation ID:</span>
        <span class="value">${notification.correlationId}</span>
      </div>
      ` : ''}
      
      <div class="alert">
        <strong>Alert Triggered:</strong>
        <ul>
          <li>Consecutive Failures: ${notification.consecutiveFailures}</li>
          <li>Failure Rate: ${(notification.thresholds.failureRate * 100).toFixed(1)}%</li>
          ${notification.thresholds.consecutiveExceeded ? '<li>⚠️ Exceeded consecutive failure threshold</li>' : ''}
          ${notification.thresholds.rateExceeded ? '<li>⚠️ Exceeded failure rate threshold</li>' : ''}
        </ul>
      </div>

      ${notification.context && Object.keys(notification.context).length > 0 ? `
      <div class="field">
        <span class="label">Additional Context:</span>
        <ul>
          ${Object.entries(notification.context).map(([k, v]) => `<li>${k}: ${v}</li>`).join('')}
        </ul>
      </div>
      ` : ''}
    </div>
    <div class="footer">
      Please investigate and resolve the issue.
    </div>
  </div>
</body>
</html>
`.trim();
  }

  /**
   * Send Slack webhook notifications
   * @param {Object} notification - Notification details
   * @returns {Promise<Array>} Send results
   */
  async sendSlackWebhooks(notification) {
    if (!this.config.webhooks.slack || this.config.webhooks.slack.length === 0) {
      return [];
    }

    const payload = {
      text: `🚨 *Actual Budget Sync Error*`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🚨 Actual Budget Sync Error'
          }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Server:*\n${notification.serverName}` },
            { type: 'mrkdwn', text: `*Time:*\n${notification.timestamp}` },
            { type: 'mrkdwn', text: `*Error:*\n${notification.errorMessage}` },
            { type: 'mrkdwn', text: `*Consecutive Failures:*\n${notification.consecutiveFailures}` }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Alert Triggered:*\n• Failure Rate: ${(notification.thresholds.failureRate * 100).toFixed(1)}%\n${notification.thresholds.consecutiveExceeded ? '• ⚠️ Exceeded consecutive failure threshold\n' : ''}${notification.thresholds.rateExceeded ? '• ⚠️ Exceeded failure rate threshold' : ''}`
          }
        }
      ]
    };

    if (notification.correlationId) {
      payload.blocks[1].fields.push({
        type: 'mrkdwn',
        text: `*Correlation ID:*\n\`${notification.correlationId}\``
      });
    }

    const results = [];
    for (const webhook of this.config.webhooks.slack) {
      try {
        const result = await this.sendWebhook(webhook.url, payload);
        results.push({ webhook: webhook.name || webhook.url, success: true, result });
      } catch (error) {
        this.logger.error('Failed to send Slack webhook', {
          webhook: webhook.name || webhook.url,
          error: error.message
        });
        results.push({ webhook: webhook.name || webhook.url, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Send Discord webhook notifications
   * @param {Object} notification - Notification details
   * @returns {Promise<Array>} Send results
   */
  async sendDiscordWebhooks(notification) {
    if (!this.config.webhooks.discord || this.config.webhooks.discord.length === 0) {
      return [];
    }

    const payload = {
      embeds: [{
        title: '🚨 Actual Budget Sync Error',
        color: 15158332, // Red
        fields: [
          { name: 'Server', value: notification.serverName, inline: true },
          { name: 'Time', value: notification.timestamp, inline: true },
          { name: 'Error', value: notification.errorMessage },
          { name: 'Consecutive Failures', value: notification.consecutiveFailures.toString(), inline: true },
          { name: 'Failure Rate', value: `${(notification.thresholds.failureRate * 100).toFixed(1)}%`, inline: true },
          {
            name: 'Alert Status',
            value: [
              notification.thresholds.consecutiveExceeded ? '⚠️ Exceeded consecutive failure threshold' : '',
              notification.thresholds.rateExceeded ? '⚠️ Exceeded failure rate threshold' : ''
            ].filter(Boolean).join('\n') || 'Threshold exceeded'
          }
        ],
        timestamp: notification.timestamp
      }]
    };

    if (notification.correlationId) {
      payload.embeds[0].fields.push({
        name: 'Correlation ID',
        value: `\`${notification.correlationId}\``,
        inline: false
      });
    }

    const results = [];
    for (const webhook of this.config.webhooks.discord) {
      try {
        const result = await this.sendWebhook(webhook.url, payload);
        results.push({ webhook: webhook.name || webhook.url, success: true, result });
      } catch (error) {
        this.logger.error('Failed to send Discord webhook', {
          webhook: webhook.name || webhook.url,
          error: error.message
        });
        results.push({ webhook: webhook.name || webhook.url, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Send Microsoft Teams webhook notifications
   * @param {Object} notification - Notification details
   * @returns {Promise<Array>} Send results
   */
  async sendTeamsWebhooks(notification) {
    if (!this.config.webhooks.teams || this.config.webhooks.teams.length === 0) {
      return [];
    }

    const payload = {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: 'Actual Budget Sync Error',
      themeColor: 'DC3545',
      title: '🚨 Actual Budget Sync Error',
      sections: [{
        facts: [
          { name: 'Server', value: notification.serverName },
          { name: 'Time', value: notification.timestamp },
          { name: 'Error', value: notification.errorMessage },
          { name: 'Consecutive Failures', value: notification.consecutiveFailures.toString() },
          { name: 'Failure Rate', value: `${(notification.thresholds.failureRate * 100).toFixed(1)}%` }
        ]
      }]
    };

    if (notification.correlationId) {
      payload.sections[0].facts.push({
        name: 'Correlation ID',
        value: notification.correlationId
      });
    }

    if (notification.thresholds.consecutiveExceeded || notification.thresholds.rateExceeded) {
      payload.sections.push({
        text: [
          notification.thresholds.consecutiveExceeded ? '⚠️ Exceeded consecutive failure threshold' : '',
          notification.thresholds.rateExceeded ? '⚠️ Exceeded failure rate threshold' : ''
        ].filter(Boolean).join('\n\n')
      });
    }

    const results = [];
    for (const webhook of this.config.webhooks.teams) {
      try {
        const result = await this.sendWebhook(webhook.url, payload);
        results.push({ webhook: webhook.name || webhook.url, success: true, result });
      } catch (error) {
        this.logger.error('Failed to send Teams webhook', {
          webhook: webhook.name || webhook.url,
          error: error.message
        });
        results.push({ webhook: webhook.name || webhook.url, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Send Telegram bot notifications
   * @param {Object} notification - Notification details
   * @returns {Promise<Array>} Send results
   */
  async sendTelegramWebhooks(notification) {
    if (!this.config.webhooks.telegram || this.config.webhooks.telegram.length === 0) {
      return [];
    }

    // Format message with Telegram MarkdownV2 escaping
    const escapeMarkdown = (text) => {
      return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
    };

    const message = `
🚨 *Actual Budget Sync Error*

*Server:* ${escapeMarkdown(notification.serverName)}
*Time:* ${escapeMarkdown(notification.timestamp)}
*Error:* ${escapeMarkdown(notification.errorMessage)}
${notification.errorCode ? `*Code:* \`${escapeMarkdown(notification.errorCode)}\`` : ''}
${notification.correlationId ? `*Correlation ID:* \`${escapeMarkdown(notification.correlationId)}\`` : ''}

*Alert Triggered:*
• Consecutive Failures: ${notification.consecutiveFailures}
• Failure Rate: ${(notification.thresholds.failureRate * 100).toFixed(1)}%
${notification.thresholds.consecutiveExceeded ? '• ⚠️ Exceeded consecutive failure threshold' : ''}
${notification.thresholds.rateExceeded ? '• ⚠️ Exceeded failure rate threshold' : ''}
`.trim();

    const results = [];
    for (const bot of this.config.webhooks.telegram) {
      try {
        const url = `https://api.telegram.org/bot${bot.botToken}/sendMessage`;
        const payload = {
          chat_id: bot.chatId,
          text: message,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true
        };

        const result = await this.sendWebhook(url, payload);
        results.push({ webhook: bot.name || bot.chatId, success: true, result });
      } catch (error) {
        this.logger.error('Failed to send Telegram message', {
          webhook: bot.name || bot.chatId,
          error: error.message
        });
        results.push({ webhook: bot.name || bot.chatId, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Send HTTP webhook
   * @param {string} url - Webhook URL
   * @param {Object} payload - JSON payload
   * @returns {Promise<Object>} Response
   */
  sendWebhook(url, payload) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const protocol = urlObj.protocol === 'https:' ? https : http;
      const body = JSON.stringify(payload);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = protocol.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: data });
          } else {
            reject(new Error(`Webhook failed with status ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Get notification statistics
   * @returns {Object} Statistics
   */
  getStats() {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const recentCount = this.notificationHistory.filter(t => (now - t) < oneHour).length;

    return {
      lastNotificationTime: this.lastNotificationTime ? new Date(this.lastNotificationTime).toISOString() : null,
      notificationsSentLastHour: recentCount,
      rateLimitRemaining: Math.max(0, this.config.rateLimit.maxPerHour - recentCount),
      consecutiveFailuresByServer: { ...this.consecutiveFailures },
      recentSyncsByServer: Object.fromEntries(
        Object.entries(this.recentSyncs).map(([server, syncs]) => [
          server,
          {
            total: syncs.length,
            failures: syncs.filter(s => !s.success).length,
            successes: syncs.filter(s => s.success).length
          }
        ])
      )
    };
  }

  /**
   * Send a simple Telegram message (for startup notifications, etc.)
   * @param {string} message - Message text
   * @param {Object} options - Additional options (parse_mode, etc.)
   * @returns {Promise<boolean>} Success status
   */
  async sendTelegramMessage(message, options = {}) {
    // Check if telegram is configured
    const telegram = this.config.telegram || this.config.webhooks?.telegram?.[0];
    if (!telegram || !telegram.enabled) {
      this.logger.debug('Telegram not configured or not enabled');
      return false;
    }

    try {
      const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;
      const payload = {
        chat_id: telegram.chatId,
        text: message,
        disable_web_page_preview: true,
        ...options
      };

      await this.sendWebhook(url, payload);
      this.logger.debug('Telegram message sent successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to send Telegram message', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Reset tracking state (mainly for testing)
   */
  reset() {
    this.lastNotificationTime = null;
    this.notificationHistory = [];
    this.consecutiveFailures = {};
    this.recentSyncs = {};
  }
}

module.exports = { NotificationService };
