/**
 * Message Formatter
 * 
 * Creates unified message content for all notification channels.
 * Each channel receives the same information, just formatted for its platform.
 */

class MessageFormatter {
  /**
   * Format sync success/failure notification
   * @param {Object} result - Sync result
   * @param {string} result.status - 'success', 'failure', or 'partial'
   * @param {string} result.serverName - Server name
   * @param {number} result.duration - Duration in ms
   * @param {number} result.accountsProcessed - Successful account count
   * @param {number} result.accountsFailed - Failed account count
   * @param {Array} result.succeededAccounts - Successful account names
   * @param {Array} result.failedAccounts - Failed accounts with errors
   * @param {string} result.error - Error message (for failures)
   * @param {string} result.errorCode - Error code (for failures)
   * @returns {Object} Formatted messages for all channels
   */
  static formatSyncNotification(result) {
    const isSuccess = result.status === 'success' || result.status === 'partial';
    const hasIssues = result.accountsFailed > 0;
    
    // Determine status emoji and text
    let emoji, statusText;
    if (isSuccess) {
      if (hasIssues) {
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
    
    // Format duration
    const duration = result.duration >= 1000 
      ? `${(result.duration / 1000).toFixed(1)}s`
      : `${result.duration}ms`;
    
    // Build common content structure
    const content = {
      emoji,
      statusText,
      serverName: result.serverName,
      duration,
      durationMs: result.duration || 0,
      isSuccess,
      hasIssues,
      error: result.error,
      errorCode: result.errorCode,
      accountsProcessed: result.accountsProcessed || 0,
      accountsFailed: result.accountsFailed || 0,
      totalAccounts: (result.accountsProcessed || 0) + (result.accountsFailed || 0),
      succeededAccounts: result.succeededAccounts || [],
      failedAccounts: result.failedAccounts || [],
      skippedAccounts: result.skippedAccounts || []
    };

    const text = this._formatPlainText(content);
    const status = isSuccess ? (hasIssues ? 'partial' : 'success') : 'failure';

    return {
      text,
      html: this._formatHtml(content),
      slack: this._formatSlack(content),
      discord: this._formatDiscord(content),
      // Generic webhook JSON payload (#111) and ntfy fields (#112)
      generic: {
        event: 'sync',
        status,
        server: content.serverName,
        durationMs: content.durationMs,
        message: `Sync ${content.statusText}`,
        accounts: {
          synced: content.succeededAccounts.length,
          failed: content.failedAccounts.length,
          skipped: content.skippedAccounts.length
        },
        succeededAccounts: content.succeededAccounts,
        failedAccounts: content.failedAccounts,
        skippedAccounts: content.skippedAccounts,
        timestamp: new Date().toISOString()
      },
      ntfy: {
        // No emoji in the title: HTTP headers are Latin-1 only, so an emoji would
        // be rejected by Node's http layer. ntfy renders the status emoji from the
        // ASCII Tags shortcodes below. (sendNtfy also sanitizes the header.)
        title: `Sync ${content.statusText}: ${content.serverName}`,
        message: text,
        // A partial sync has failures, so treat it as failure-priority for ntfy.
        level: (isSuccess && !hasIssues) ? 'success' : 'failure',
        tags: [isSuccess ? (hasIssues ? 'warning' : 'white_check_mark') : 'x']
      }
    };
  }
  
  /**
   * Format error notification
   * @param {Object} error - Error details
   * @param {string} error.serverName - Server name
   * @param {string} error.errorMessage - Error message
   * @param {string} error.errorCode - Error code
   * @param {string} error.timestamp - Timestamp
   * @param {string} error.correlationId - Correlation ID
   * @param {Object} error.context - Additional context
   * @param {Object} error.thresholds - Threshold information
   * @param {number} error.consecutiveFailures - Consecutive failure count
   * @returns {Object} Formatted messages for all channels
   */
  static formatErrorNotification(error) {
    const isTest = error.serverName?.includes('🧪') || error.errorCode === 'TEST_NOTIFICATION';
    
    const content = {
      isTest,
      title: isTest ? '🧪 Test Notification' : '🚨 Sync Error',
      serverName: error.serverName,
      timestamp: error.timestamp,
      errorMessage: error.errorMessage,
      errorCode: error.errorCode,
      correlationId: error.correlationId,
      context: error.context || {},
      consecutiveFailures: error.consecutiveFailures,
      thresholds: error.thresholds
    };
    
    const text = this._formatErrorPlainText(content);
    return {
      text,
      html: this._formatErrorHtml(content),
      slack: this._formatErrorSlack(content),
      discord: this._formatErrorDiscord(content),
      generic: {
        event: 'error',
        server: content.serverName,
        message: content.errorMessage,
        errorCode: content.errorCode,
        correlationId: content.correlationId,
        timestamp: content.timestamp || new Date().toISOString()
      },
      ntfy: {
        // Emoji-free title (Latin-1 header); status conveyed via Tags.
        title: `${content.isTest ? 'Test Notification' : 'Sync Error'}: ${content.serverName}`,
        message: text,
        level: content.isTest ? 'info' : 'failure',
        tags: [content.isTest ? 'test_tube' : 'rotating_light']
      }
    };
  }
  
  /**
   * Format startup notification
   * @param {Object} info - Startup information
   * @param {string} info.version - Service version
   * @param {string} info.serverNames - Comma-separated server names
   * @param {string} info.schedules - Schedule information
   * @param {string} info.nextSync - Next sync time
   * @returns {Object} Formatted messages for all channels
   */
  static formatStartupNotification(info) {
    const content = {
      title: '🚀 Service Started',
      version: info.version,
      serverNames: info.serverNames,
      schedules: info.schedules,
      nextSync: info.nextSync
    };
    
    const text = this._formatStartupPlainText(content);
    return {
      text,
      html: this._formatStartupHtml(content),
      slack: this._formatStartupSlack(content),
      discord: this._formatStartupDiscord(content),
      generic: {
        event: 'startup',
        message: 'Service Started',
        version: content.version,
        servers: content.serverNames,
        nextSync: content.nextSync,
        timestamp: new Date().toISOString()
      },
      ntfy: {
        title: 'Service Started',
        message: text,
        level: 'info',
        tags: ['rocket']
      }
    };
  }
  
  // ========== SYNC NOTIFICATION FORMATTERS ==========

  // Truncate a per-account error to keep notifications compact (shared across channels). (#108)
  static _truncateError(error) {
    if (!error) return '';
    return error.length > 80 ? error.substring(0, 77) + '...' : error;
  }

  // Render a failed-account line "• name: error" (error omitted when absent). (#108)
  static _failedAccountLine(account) {
    const err = this._truncateError(account.error);
    return err ? `• ${account.name}: ${err}` : `• ${account.name}`;
  }

  // Join account lines, capping the result at maxChars so it cannot exceed a
  // platform field/section limit (Discord field = 1024, Slack section = 3000).
  // When it would overflow, keep as many whole lines as fit and append
  // "…and N more", so a large failure batch still delivers instead of being
  // rejected by the platform with HTTP 400. (#108)
  static _joinCapped(lines, maxChars) {
    if (lines.length === 0) return '';
    const kept = [];
    let used = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const sep = kept.length ? 1 : 0;
      if (used + sep + line.length > maxChars) {
        let remaining = lines.length - kept.length;
        let suffix = `…and ${remaining} more`;
        while (kept.length && used + 1 + suffix.length > maxChars) {
          const popped = kept.pop();
          used -= popped.length + (kept.length ? 1 : 0);
          remaining = lines.length - kept.length;
          suffix = `…and ${remaining} more`;
        }
        kept.push(suffix);
        return kept.join('\n');
      }
      kept.push(line);
      used += sep + line.length;
    }
    return kept.join('\n');
  }

  static _formatPlainText(content) {
    let text = `${content.emoji} Sync ${content.statusText}\n\n`;
    text += `Server: ${content.serverName}\n`;
    text += `Duration: ${content.duration}\n`;

    // Server-level error (e.g. connection/auth) shown regardless of account data.
    if (!content.isSuccess && content.error) {
      text += `Error: ${content.error}\n`;
      if (content.errorCode) {
        text += `Code: ${content.errorCode}\n`;
      }
    }

    // Account breakdown — shown on both success and failure, suppressed entirely
    // when no accounts were reached (server-level failure). (#100)
    const synced = content.succeededAccounts.length;
    const failed = content.failedAccounts.length;
    const skipped = content.skippedAccounts.length;
    if (synced || failed || skipped) {
      text += `\nAccounts: ${synced} synced, ${failed} failed, ${skipped} skipped\n`;

      if (synced > 0) {
        text += `\n✅ Synced:\n`;
        content.succeededAccounts.forEach(name => {
          text += `  • ${name}\n`;
        });
      }

      if (failed > 0) {
        text += `\n❌ Failed:\n`;
        content.failedAccounts.forEach(account => {
          text += `  • ${account.name}\n`;
          if (account.error) {
            text += `    ${this._truncateError(account.error)}\n`;
          }
        });
      }

      if (skipped > 0) {
        text += `\n⏭️ Skipped (not bank-linked / closed): ${skipped}\n`;
        content.skippedAccounts.forEach(account => {
          text += `  • ${account.name} (${account.reason})\n`;
        });
      }
    }

    return text;
  }
  
  static _formatHtml(content) {
    const bgColor = content.isSuccess ? (content.hasIssues ? '#ffc107' : '#28a745') : '#dc3545';
    
    let html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: ${bgColor}; color: white; padding: 15px; border-radius: 5px 5px 0 0; }
    .content { background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
    .field { margin: 10px 0; }
    .label { font-weight: bold; color: #495057; }
    .value { color: #212529; }
    .account-list { list-style: none; padding-left: 0; }
    .account-item { padding: 5px 0; }
    .error-detail { color: #6c757d; font-size: 0.9em; margin-left: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>${content.emoji} Sync ${content.statusText}</h2>
    </div>
    <div class="content">
      <div class="field">
        <span class="label">Server:</span>
        <span class="value">${content.serverName}</span>
      </div>
      <div class="field">
        <span class="label">Duration:</span>
        <span class="value">${content.duration}</span>
      </div>`;
    
    if (!content.isSuccess && content.error) {
      html += `
      <div class="field">
        <span class="label">Error:</span>
        <span class="value">${content.error}</span>
      </div>`;
      if (content.errorCode) {
        html += `
      <div class="field">
        <span class="label">Code:</span>
        <span class="value">${content.errorCode}</span>
      </div>`;
      }
    }

    // Account breakdown on both paths; suppressed when no accounts were reached. (#100)
    {
      const synced = content.succeededAccounts.length;
      const failed = content.failedAccounts.length;
      const skipped = content.skippedAccounts.length;
      if (synced || failed || skipped) {
        html += `
      <div class="field">
        <span class="label">Accounts:</span>
        <span class="value">${synced} synced, ${failed} failed, ${skipped} skipped</span>
      </div>`;
      }

      if (synced > 0) {
        html += `
      <div class="field">
        <span class="label">✅ Synced Accounts:</span>
        <ul class="account-list">`;
        content.succeededAccounts.forEach(name => {
          html += `<li class="account-item">• ${name}</li>`;
        });
        html += `</ul>
      </div>`;
      }

      if (failed > 0) {
        html += `
      <div class="field">
        <span class="label">❌ Failed Accounts:</span>
        <ul class="account-list">`;
        content.failedAccounts.forEach(account => {
          html += `<li class="account-item">• ${account.name}`;
          if (account.error) {
            html += `<div class="error-detail">${account.error}</div>`;
          }
          html += `</li>`;
        });
        html += `</ul>
      </div>`;
      }

      if (skipped > 0) {
        html += `
      <div class="field">
        <span class="label">⏭️ Skipped (not bank-linked / closed):</span>
        <ul class="account-list">`;
        content.skippedAccounts.forEach(account => {
          html += `<li class="account-item">• ${account.name} (${account.reason})</li>`;
        });
        html += `</ul>
      </div>`;
      }
    }

    html += `
    </div>
  </div>
</body>
</html>`;

    return html;
  }
  
  static _formatSlack(content) {
    const payload = {
      text: `*${content.emoji} Sync ${content.statusText}*`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `${content.emoji} Sync ${content.statusText}`
          }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Server:*\n${content.serverName}` },
            { type: 'mrkdwn', text: `*Duration:*\n${content.duration}` }
          ]
        }
      ]
    };
    
    // Server-level error first (failure path).
    if (!content.isSuccess && content.error) {
      payload.blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Error:*\n${content.error}${content.errorCode ? `\n*Code:* ${content.errorCode}` : ''}`
        }
      });
    }

    // Account breakdown on both paths; suppressed when no accounts were reached. (#100)
    const synced = content.succeededAccounts.length;
    const failed = content.failedAccounts.length;
    const skipped = content.skippedAccounts.length;
    if (synced || failed || skipped) {
      payload.blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Accounts:* ${synced} synced, ${failed} failed, ${skipped} skipped` }
      });
      let accountsText = '';
      if (synced > 0) {
        accountsText += `*✅ Synced:*\n${this._joinCapped(content.succeededAccounts.map(n => `• ${n}`), 900)}`;
      }
      if (failed > 0) {
        if (accountsText) accountsText += '\n\n';
        accountsText += `*❌ Failed:*\n${this._joinCapped(content.failedAccounts.map(a => this._failedAccountLine(a)), 900)}`;
      }
      if (skipped > 0) {
        if (accountsText) accountsText += '\n\n';
        accountsText += `*⏭️ Skipped (not bank-linked / closed):*\n${this._joinCapped(content.skippedAccounts.map(a => `• ${a.name} (${a.reason})`), 900)}`;
      }
      if (accountsText) {
        payload.blocks.push({ type: 'section', text: { type: 'mrkdwn', text: accountsText } });
      }
    }
    
    return payload;
  }
  
  static _formatDiscord(content) {
    const color = content.isSuccess ? (content.hasIssues ? 15844367 : 5025616) : 15158332; // Warning, Green, Red
    
    const fields = [
      { name: 'Server', value: content.serverName, inline: true },
      { name: 'Duration', value: content.duration, inline: true }
    ];
    
    if (!content.isSuccess && content.error) {
      fields.push({ name: 'Error', value: content.error });
      if (content.errorCode) {
        fields.push({ name: 'Code', value: content.errorCode, inline: true });
      }
    }

    // Account breakdown on both paths; suppressed when no accounts were reached. (#100)
    const synced = content.succeededAccounts.length;
    const failed = content.failedAccounts.length;
    const skipped = content.skippedAccounts.length;
    if (synced || failed || skipped) {
      fields.push({ name: 'Accounts', value: `${synced} synced, ${failed} failed, ${skipped} skipped` });
      if (synced > 0) {
        fields.push({ name: '✅ Synced Accounts', value: this._joinCapped(content.succeededAccounts.map(n => `• ${n}`), 1000) });
      }
      if (failed > 0) {
        fields.push({ name: '❌ Failed Accounts', value: this._joinCapped(content.failedAccounts.map(a => this._failedAccountLine(a)), 1000) });
      }
      if (skipped > 0) {
        fields.push({ name: '⏭️ Skipped (not bank-linked / closed)', value: this._joinCapped(content.skippedAccounts.map(a => `• ${a.name} (${a.reason})`), 1000) });
      }
    }
    
    return {
      embeds: [{
        title: `${content.emoji} Sync ${content.statusText}`,
        color,
        fields,
        timestamp: new Date().toISOString()
      }]
    };
  }
  
  // ========== ERROR NOTIFICATION FORMATTERS ==========
  
  static _formatErrorPlainText(content) {
    let text = `${content.title}\n\n`;
    text += `Server: ${content.serverName}\n`;
    text += `Time: ${content.timestamp}\n`;
    text += `Error: ${content.errorMessage}\n`;
    if (content.errorCode) {
      text += `Code: ${content.errorCode}\n`;
    }
    if (content.correlationId) {
      text += `Correlation ID: ${content.correlationId}\n`;
    }
    
    if (content.thresholds) {
      text += `\nAlert Triggered:\n`;
      text += `- Consecutive Failures: ${content.consecutiveFailures}\n`;
      text += `- Failure Rate: ${(content.thresholds.failureRate * 100).toFixed(1)}%\n`;
      if (content.thresholds.consecutiveExceeded) {
        text += `- ⚠️ Exceeded consecutive failure threshold\n`;
      }
      if (content.thresholds.rateExceeded) {
        text += `- ⚠️ Exceeded failure rate threshold\n`;
      }
    }
    
    if (Object.keys(content.context).length > 0) {
      text += `\nAdditional Context:\n`;
      Object.entries(content.context).forEach(([k, v]) => {
        text += `  ${k}: ${v}\n`;
      });
    }
    
    return text;
  }
  
  static _formatErrorHtml(content) {
    const bgColor = content.isTest ? '#0078D4' : '#dc3545';
    
    let html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: ${bgColor}; color: white; padding: 15px; border-radius: 5px 5px 0 0; }
    .content { background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
    .field { margin: 10px 0; }
    .label { font-weight: bold; color: #495057; }
    .value { color: #212529; white-space: pre-wrap; }
    .alert { background: #fff3cd; border: 1px solid #ffc107; padding: 10px; margin: 15px 0; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>${content.title}</h2>
    </div>
    <div class="content">
      <div class="field">
        <span class="label">Server:</span>
        <span class="value">${content.serverName}</span>
      </div>
      <div class="field">
        <span class="label">Time:</span>
        <span class="value">${content.timestamp}</span>
      </div>
      <div class="field">
        <span class="label">Error:</span>
        <span class="value">${content.errorMessage}</span>
      </div>`;
    
    if (content.errorCode) {
      html += `
      <div class="field">
        <span class="label">Code:</span>
        <span class="value">${content.errorCode}</span>
      </div>`;
    }
    
    if (content.correlationId) {
      html += `
      <div class="field">
        <span class="label">Correlation ID:</span>
        <span class="value">${content.correlationId}</span>
      </div>`;
    }
    
    if (content.thresholds) {
      html += `
      <div class="alert">
        <strong>Alert Triggered:</strong>
        <ul>
          <li>Consecutive Failures: ${content.consecutiveFailures}</li>
          <li>Failure Rate: ${(content.thresholds.failureRate * 100).toFixed(1)}%</li>`;
      if (content.thresholds.consecutiveExceeded) {
        html += `<li>⚠️ Exceeded consecutive failure threshold</li>`;
      }
      if (content.thresholds.rateExceeded) {
        html += `<li>⚠️ Exceeded failure rate threshold</li>`;
      }
      html += `
        </ul>
      </div>`;
    }
    
    if (Object.keys(content.context).length > 0) {
      html += `
      <div class="field">
        <span class="label">Additional Context:</span>
        <ul>`;
      Object.entries(content.context).forEach(([k, v]) => {
        html += `<li>${k}: ${v}</li>`;
      });
      html += `
        </ul>
      </div>`;
    }
    
    html += `
    </div>
  </div>
</body>
</html>`;
    
    return html;
  }
  
  static _formatErrorSlack(content) {
    const payload = {
      text: `*${content.title}*`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: content.title
          }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Server:*\n${content.serverName}` },
            { type: 'mrkdwn', text: `*Time:*\n${content.timestamp}` }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Error:*\n${content.errorMessage}`
          }
        }
      ]
    };
    
    if (content.errorCode || content.correlationId) {
      const fields = [];
      if (content.errorCode) {
        fields.push({ type: 'mrkdwn', text: `*Code:*\n${content.errorCode}` });
      }
      if (content.correlationId) {
        fields.push({ type: 'mrkdwn', text: `*Correlation ID:*\n\`${content.correlationId}\`` });
      }
      payload.blocks.push({
        type: 'section',
        fields
      });
    }
    
    if (content.thresholds) {
      let alertText = `*Alert Triggered:*\n• Failure Rate: ${(content.thresholds.failureRate * 100).toFixed(1)}%\n`;
      if (content.thresholds.consecutiveExceeded) {
        alertText += '• ⚠️ Exceeded consecutive failure threshold\n';
      }
      if (content.thresholds.rateExceeded) {
        alertText += '• ⚠️ Exceeded failure rate threshold';
      }
      payload.blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: alertText
        }
      });
    }
    
    return payload;
  }
  
  static _formatErrorDiscord(content) {
    const color = content.isTest ? 3447003 : 15158332; // Blue for test, Red for error
    
    const fields = [
      { name: 'Server', value: content.serverName, inline: true },
      { name: 'Time', value: content.timestamp, inline: true },
      { name: 'Error', value: content.errorMessage }
    ];
    
    if (content.errorCode) {
      fields.push({ name: 'Code', value: content.errorCode, inline: true });
    }
    
    if (content.correlationId) {
      fields.push({ name: 'Correlation ID', value: `\`${content.correlationId}\``, inline: true });
    }
    
    if (content.thresholds) {
      let alertValue = `Consecutive Failures: ${content.consecutiveFailures}\nFailure Rate: ${(content.thresholds.failureRate * 100).toFixed(1)}%`;
      if (content.thresholds.consecutiveExceeded || content.thresholds.rateExceeded) {
        alertValue += '\n\n';
        if (content.thresholds.consecutiveExceeded) {
          alertValue += '⚠️ Exceeded consecutive failure threshold\n';
        }
        if (content.thresholds.rateExceeded) {
          alertValue += '⚠️ Exceeded failure rate threshold';
        }
      }
      fields.push({ name: 'Alert Status', value: alertValue });
    }
    
    return {
      embeds: [{
        title: content.title,
        color,
        fields,
        timestamp: new Date().toISOString()
      }]
    };
  }
  
  // ========== STARTUP NOTIFICATION FORMATTERS ==========
  
  static _formatStartupPlainText(content) {
    let text = `${content.title}\n\n`;
    text += `✅ Service is now running\n`;
    text += `📦 Version: ${content.version}\n\n`;
    text += `Servers: ${content.serverNames}\n\n`;
    text += `Schedules:\n${content.schedules}\n\n`;
    text += `Next sync: ${content.nextSync}`;
    return text;
  }
  
  static _formatStartupHtml(content) {
    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #28a745; color: white; padding: 15px; border-radius: 5px 5px 0 0; }
    .content { background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
    pre { background: #e9ecef; padding: 10px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>${content.title}</h2>
    </div>
    <div class="content">
      <p>✅ <strong>Service is now running</strong></p>
      <p>📦 <strong>Version:</strong> ${content.version}</p>
      <p><strong>Servers:</strong> ${content.serverNames}</p>
      <h3>Schedules:</h3>
      <pre>${content.schedules}</pre>
      <p><strong>Next sync:</strong> ${content.nextSync}</p>
    </div>
  </div>
</body>
</html>`;
  }
  
  static _formatStartupSlack(content) {
    return {
      text: `*${content.title}*`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: content.title
          }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Status:*\n✅ Service is now running` },
            { type: 'mrkdwn', text: `*Version:*\n${content.version}` },
            { type: 'mrkdwn', text: `*Servers:*\n${content.serverNames}` },
            { type: 'mrkdwn', text: `*Next Sync:*\n${content.nextSync}` }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Schedules:*\n\`\`\`\n${content.schedules}\n\`\`\``
          }
        }
      ]
    };
  }
  
  static _formatStartupDiscord(content) {
    return {
      embeds: [{
        title: content.title,
        color: 5025616, // Green
        fields: [
          { name: 'Status', value: '✅ Service is now running', inline: true },
          { name: 'Version', value: content.version, inline: true },
          { name: 'Servers', value: content.serverNames },
          { name: 'Schedules', value: `\`\`\`\n${content.schedules}\n\`\`\`` },
          { name: 'Next Sync', value: content.nextSync }
        ],
        timestamp: new Date().toISOString()
      }]
    };
  }
}

module.exports = { MessageFormatter };
