# Notification System

The Notification System provides automated alerts and interactive commands to monitor and control your Actual-sync service. Get instant notifications for sync events via email and webhooks, or use the Telegram bot for real-time status updates and configuration changes.

## Table of Contents

- [Features](#features)
- [Configuration](#configuration)
- [Telegram Bot](#telegram-bot)
- [Email Notifications](#email-notifications)
- [Webhook Notifications](#webhook-notifications)
- [Notification Thresholds](#notification-thresholds)
- [Rate Limiting](#rate-limiting)
- [Use Cases](#use-cases)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

## Features

- **Interactive Telegram Bot**: Real-time commands for status, history, and configuration
- **Multiple Notification Channels**: Email, Slack, Discord, Telegram webhooks
- **Smart Thresholds**: Trigger notifications based on consecutive failures or failure rates
- **Rate Limiting**: Prevent notification spam with configurable intervals and limits
- **Rich Context**: Includes error details, correlation IDs, and sync statistics
- **Automatic Tracking**: Monitors sync results and tracks failure patterns
- **Configurable Notifications**: Choose to receive notifications for all syncs, only failures, or never
- **Graceful Degradation**: Continues operation even if notifications fail

## Configuration

Add the `notifications` section to your `config/config.json`:

```json
{
  "notifications": {
    "email": {
      "enabled": true,
      "host": "smtp.gmail.com",
      "port": 587,
      "secure": false,
      "auth": {
        "user": "your-email@gmail.com",
        "pass": "your-app-specific-password"
      },
      "from": "actual-sync@example.com",
      "to": ["admin@example.com", "team@example.com"]
    },
    "webhooks": {
      "slack": [
        {
          "name": "Main Channel",
          "url": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
        }
      ],
      "discord": [
        {
          "name": "Alerts Channel",
          "url": "https://discord.com/api/webhooks/YOUR/WEBHOOK"
        }
      ],
      "teams": [
        {
          "name": "DevOps Team",
          "url": "https://outlook.webhook.office.com/YOUR/WEBHOOK"
        }
      ],
      "telegram": [
        {
          "name": "Production Alerts",
          "botToken": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
          "chatId": "123456789"
        }
      ]
    },
    "thresholds": {
      "consecutiveFailures": 3,
      "failureRate": 0.5,
      "ratePeriodMinutes": 60
    },
    "rateLimit": {
      "minIntervalMinutes": 15,
      "maxPerHour": 4
    }
  }
}
```

### Configuration Schema

#### Email Settings

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `enabled` | boolean | No | `false` | Enable email notifications |
| `host` | string | No | `smtp.gmail.com` | SMTP server hostname |
| `port` | integer | No | `587` | SMTP server port |
| `secure` | boolean | No | `false` | Use TLS for SMTP |
| `auth.user` | string | Yes* | - | SMTP username |
| `auth.pass` | string | Yes* | - | SMTP password or app password |
| `from` | string | Yes* | - | From email address |
| `to` | array | Yes* | - | Recipient email addresses |

*Required when email is enabled

#### Webhook Settings

Each webhook type (Slack, Discord, Telegram) accepts an array of webhook configurations:

**Slack, Discord:**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | No | Descriptive name for logs |
| `url` | string | Yes | Webhook URL |

**Telegram (Legacy Webhooks - deprecated):**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | No | Descriptive name for logs |
| `botToken` | string | Yes | Bot token from @BotFather |
| `chatId` | string | Yes | Chat ID (user, group, or channel) |

**Note**: The legacy Telegram webhook configuration is deprecated. Use the new `telegram` object for interactive bot features.

#### Telegram Bot Settings

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `enabled` | boolean | No | `false` | Enable Telegram bot |
| `botToken` | string | Yes* | - | Bot token from @BotFather |
| `chatId` | string | Yes* | - | Chat ID (user, group, or channel) |
| `notifyOnSuccess` | string | No | `errors_only` | Notification mode: `always`, `errors_only`, or `never` |

*Required when Telegram bot is enabled

#### Threshold Settings

| Property | Type | Default | Range | Description |
|----------|------|---------|-------|-------------|
| `consecutiveFailures` | integer | `3` | 1-20 | Number of consecutive failures to trigger notification |
| `failureRate` | number | `0.5` | 0.0-1.0 | Failure rate threshold (50% = 0.5) |
| `ratePeriodMinutes` | integer | `60` | 5-1440 | Time window for failure rate calculation |

#### Rate Limit Settings

| Property | Type | Default | Range | Description |
|----------|------|---------|-------|-------------|
| `minIntervalMinutes` | integer | `15` | 1-1440 | Minimum minutes between notifications |
| `maxPerHour` | integer | `4` | 1-20 | Maximum notifications per hour |

## Telegram Bot

The Telegram Bot provides interactive commands for real-time monitoring and configuration of your Actual-sync service. Unlike simple webhook notifications, the bot responds to your commands and allows you to query status, view history, and change settings directly from Telegram.

### Setup

#### 1. Create a Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` command
3. Follow the prompts to choose a name and username
4. **BotFather** will give you a bot token (e.g., `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
5. Save this token - you'll need it for configuration

#### 2. Get Your Chat ID

**Method 1: Using @userinfobot**
1. Search for **@userinfobot** in Telegram
2. Start a chat and send any message
3. The bot will reply with your user ID

**Method 2: Using API**
1. Start a chat with your new bot
2. Send any message to the bot
3. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Look for `"chat":{"id":123456789}` in the JSON response

#### 3. Configure in config.json

```json
{
  "notifications": {
    "telegram": {
      "enabled": true,
      "botToken": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      "chatId": "123456789",
      "notifyOnSuccess": "errors_only"
    }
  }
}
```

### Available Commands

#### `/help`
Shows all available commands and current notification mode.

**Example:**
```
/help
```

**Response:**
```
🤖 Actual-sync Bot Commands

/help - Show available commands
/ping - Check if bot is responsive
/status - Get current sync status
/history - Show recent sync history
/stats - Show sync statistics
/servers - List configured servers
/notify - Change notification settings (always/errors/never)
/errors - Show recent errors

Current notification mode: errors_only
```

#### `/ping`
Tests bot responsiveness. Useful for verifying the bot is running and can communicate.

**Example:**
```
/ping
```

**Response:**
```
🏓 Pong! Bot is responsive.
```

#### `/status`
Shows current service health, sync statistics, and last sync time.

**Example:**
```
/status
```

**Response:**
```
✅ Service Status: HEALTHY

Uptime: 127 minutes
Total Syncs: 15
Successful: 14
Failed: 1
Success Rate: 93.3%

Last Sync: 12/6/2024, 4:30 PM
```

#### `/history [limit]`
Shows recent sync history. Optionally specify the number of records to show (default: 5).

**Examples:**
```
/history
/history 10
```

**Response:**
```
📜 Recent Syncs (last 5):

✅ My-Finances
   12/6/24, 4:30 PM
   Duration: 2156ms

✅ My-Finances
   12/6/24, 4:00 PM
   Duration: 1987ms

❌ My-Finances
   12/6/24, 3:30 PM
   Duration: 543ms
   Error: Connection timeout
```

#### `/stats`
Shows comprehensive sync statistics including averages and totals.

**Example:**
```
/stats
```

**Response:**
```
📊 Sync Statistics

Total Syncs: 25
Successful: 23
Failed: 2
Success Rate: 92.0%

Avg Duration: 2145ms
Total Accounts: 50
Failed Accounts: 2

Last Sync: 12/6/2024, 4:30 PM
```

#### `/servers`
Lists all configured servers and their sync schedules.

**Example:**
```
/servers
```

**Response:**
```
📋 Configured Servers (2):

🖥️ My-Finances
   URL: http://finance-actual-budget-main:5006
   Schedule: */30 * * * *

🖥️ Backup-Server
   URL: http://backup-actual:5006
   Schedule: 0 3 * * *
```

#### `/notify [mode]`
Changes notification preferences. Without arguments, shows current mode.

**Modes:**
- `always` - Get notified on every sync (success or failure)
- `errors` - Get notified only on failures (default)
- `never` - No sync notifications (commands still work)

**Examples:**
```
/notify
/notify always
/notify errors
/notify never
```

**Response (change mode):**
```
✅ Notification mode changed to: always

You will receive sync notifications.
```

**Response (view current):**
```
⚙️ Current notification mode: errors_only

Usage: /notify [always|errors|never]

• always - Notify on all syncs
• errors - Notify only on failures (default)
• never - No sync notifications (commands still work)
```

#### `/errors [limit]`
Shows recent errors with details. Optionally specify the number of errors to show (default: 5).

**Examples:**
```
/errors
/errors 10
```

**Response:**
```
❌ Recent Errors (last 3):

🖥️ My-Finances
   12/6/24, 3:30 PM
   Connection timeout
   Code: ETIMEDOUT

🖥️ Backup-Server
   12/5/24, 11:45 PM
   Invalid credentials
   Code: AUTH_ERROR
```

**Response (no errors):**
```
✅ No recent errors!
```

### Non-Command Messages

If you send a message that's not a recognized command, the bot will acknowledge it and suggest using `/help`:

**Example:**
```
hello
```

**Response:**
```
I received your message: "hello"

I don't understand that command. Type /help to see available commands.
```

### Notification Examples

#### Startup Notification
When the service starts, you'll receive:

```
🚀 Actual-sync Service Started

✅ Service is now running

Servers: My-Finances

Schedules:
  - My-Finances: */30 * * * *

Next sync: 12/6/24, 5:00 PM

Type /help to see available commands
```

#### Success Notification (when mode is `always`)
```
✅ Sync Successful

Server: My-Finances
Duration: 2156ms
Accounts Processed: 5
```

#### Failure Notification (when mode is `always` or `errors`)
```
❌ Sync Failed

Server: My-Finances
Duration: 543ms
Error: Connection timeout
Code: ETIMEDOUT
```

### Message Logging

All incoming Telegram messages are logged for auditing and troubleshooting:

```json
{
  "timestamp": "2024-12-06T16:30:00.000Z",
  "level": "INFO",
  "component": "TelegramBot",
  "message": "Telegram message received",
  "from": "John Doe",
  "username": "johndoe",
  "chatId": "123456789",
  "text": "/status"
}
```

### Security Considerations

1. **Chat ID Verification**: The bot only responds to messages from the configured `chatId`, ignoring messages from other users.

2. **Token Security**: Keep your bot token secret. Never commit it to version control. Consider using environment variables or Docker secrets.

3. **Private Bots**: By default, only you (the chat ID owner) can interact with the bot. For team use, consider:
   - Creating a group chat and adding the bot
   - Getting the group's chat ID
   - All group members can then use commands

4. **Command Authorization**: All commands are available to the configured chat. Implement additional authorization if needed.

### Troubleshooting

#### Bot not responding to commands

**Check bot is running:**
```bash
docker logs actual-sync | grep "Telegram bot started"
```

**Verify configuration:**
```json
{
  "telegram": {
    "enabled": true,  // Must be true
    "botToken": "...", // Valid bot token
    "chatId": "..."    // Your chat ID as string
  }
}
```

**Test with /ping:**
- If no response, check logs for errors
- Verify chat ID matches your Telegram user ID
- Restart the service: `docker-compose restart actual-sync`

#### Notifications not sent

**Check notification mode:**
```
/notify
```

If set to `never`, notifications are disabled. Change with:
```
/notify errors
```

**Check logs:**
```bash
docker logs actual-sync | grep "notifySync"
```

#### Wrong chat ID

**Symptoms:**
- Bot doesn't respond to your messages
- Logs show "Message from unauthorized chat"

**Fix:**
1. Get your correct chat ID using @userinfobot
2. Update `config.json` with the correct chat ID
3. Restart the service

### Best Practices

1. **Start with `errors_only`**: Reduces notification noise while staying informed of issues.

2. **Use `/status` regularly**: Quick health check without waiting for scheduled syncs.

3. **Monitor `/history`**: Track sync patterns and identify intermittent issues.

4. **Review `/errors`**: Investigate root causes of failures.

5. **Adjust notification mode**: Switch to `always` during troubleshooting, back to `errors` for normal operation.

6. **Keep bot token secure**: Use environment variables in production:
   ```bash
   TELEGRAM_BOT_TOKEN=your_token_here
   TELEGRAM_CHAT_ID=your_chat_id_here
   ```

7. **Test commands after updates**: Run `/ping` and `/status` after service restarts to verify bot functionality.

## Email Notifications

### Gmail Configuration

To use Gmail for email notifications:

1. **Enable 2-Factor Authentication** on your Google account
2. **Generate an App Password**:
   - Go to Google Account → Security → 2-Step Verification → App passwords
   - Generate a new app password for "Mail"
   - Use this password in the `auth.pass` field

3. **Configure in config.json**:
```json
{
  "notifications": {
    "email": {
      "enabled": true,
      "host": "smtp.gmail.com",
      "port": 587,
      "secure": false,
      "auth": {
        "user": "your-email@gmail.com",
        "pass": "your-16-char-app-password"
      },
      "from": "your-email@gmail.com",
      "to": ["admin@example.com"]
    }
  }
}
```

### Other Email Providers

**Office 365 / Outlook.com:**
```json
{
  "host": "smtp.office365.com",
  "port": 587,
  "secure": false
}
```

**SendGrid:**
```json
{
  "host": "smtp.sendgrid.net",
  "port": 587,
  "secure": false,
  "auth": {
    "user": "apikey",
    "pass": "your-sendgrid-api-key"
  }
}
```

**Amazon SES:**
```json
{
  "host": "email-smtp.us-east-1.amazonaws.com",
  "port": 587,
  "secure": false,
  "auth": {
    "user": "your-smtp-username",
    "pass": "your-smtp-password"
  }
}
```

### Email Content

Notification emails include:
- **Subject**: `[Actual Budget Sync] Error: [ServerName]`
- **Server name** and **timestamp**
- **Error message** and **error code**
- **Correlation ID** for tracking
- **Alert details**: Consecutive failures count and failure rate
- **Additional context**: Accounts processed, succeeded, failed, duration
- Both plain text and HTML formatted versions

## Webhook Notifications

### Slack Webhooks

1. **Create Incoming Webhook**:
   - Go to your Slack workspace settings
   - Navigate to Apps → Incoming Webhooks
   - Add Configuration → Choose channel → Copy webhook URL

2. **Configure**:
```json
{
  "webhooks": {
    "slack": [
      {
        "name": "Production Alerts",
        "url": "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX"
      }
    ]
  }
}
```

3. **Notification Format**:
   - Rich message with formatted blocks
   - Server name, timestamp, error details
   - Consecutive failures and failure rate
   - Color-coded severity indicators

### Discord Webhooks

1. **Create Webhook**:
   - Go to Server Settings → Integrations → Webhooks
   - Create Webhook → Choose channel → Copy webhook URL

2. **Configure**:
```json
{
  "webhooks": {
    "discord": [
      {
        "name": "Sync Alerts",
        "url": "https://discord.com/api/webhooks/123456789/abcdefghijklmnop"
      }
    ]
  }
}
```

3. **Notification Format**:
   - Embedded message with red color coding
   - Structured fields for easy reading
   - Timestamp and correlation ID

### Microsoft Teams Webhooks

1. **Create Incoming Webhook**:
   - Go to your Teams channel → Connectors
   - Configure "Incoming Webhook" → Name it → Copy URL

2. **Configure**:
```json
{
  "webhooks": {
    "teams": [
      {
        "name": "DevOps Alerts",
        "url": "https://outlook.webhook.office.com/webhookb2/xxx@yyy/IncomingWebhook/zzz"
      }
    ]
  }
}
```

3. **Notification Format**:
   - MessageCard format with color theme
   - Fact-based information display
   - Summary and detailed sections

### Telegram Bot Notifications

1. **Create Telegram Bot**:
   - Open Telegram and search for @BotFather
   - Send `/newbot` command
   - Follow instructions to create bot
   - Copy the bot token (format: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

2. **Get Chat ID**:
   
   **For Personal Messages:**
   - Start a chat with your bot
   - Send any message to the bot
   - Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Find your chat ID in the response (under `message.chat.id`)
   
   **For Group Chats:**
   - Add the bot to your group
   - Send a message in the group
   - Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Find the group chat ID (negative number like `-123456789`)
   
   **For Channels:**
   - Add the bot as admin to your channel
   - Use the channel username with @ (e.g., `@mychannel`)
   - Or use the numeric channel ID (starts with `-100`)

3. **Configure**:
```json
{
  "webhooks": {
    "telegram": [
      {
        "name": "Production Alerts",
        "botToken": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
        "chatId": "123456789"
      },
      {
        "name": "Team Group",
        "botToken": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
        "chatId": "-987654321"
      }
    ]
  }
}
```

4. **Notification Format**:
   - MarkdownV2 formatted message
   - Clean, readable text layout
   - Emoji indicators (🚨 for errors)
   - Server name, timestamp, error details
   - Consecutive failures and failure rate
   - Special characters automatically escaped

5. **Tips**:
   - One bot can send to multiple chats (personal, groups, channels)
   - Create separate bots for different environments
   - Test with `/start` command to ensure bot is working
   - Bot needs admin rights to post in channels

## Notification Thresholds

The system uses two threshold mechanisms to determine when to send notifications:

### 1. Consecutive Failures Threshold

Triggers notification after N consecutive sync failures for a server.

**Example**: With `consecutiveFailures: 3`:
```
Server1: ✓ ✗ ✗ ✗ → Notification sent (3 consecutive failures)
Server1: ✗ ✓ ✗ ✗ → No notification (success breaks the chain)
```

**Use case**: Detect persistent issues that affect every sync attempt.

### 2. Failure Rate Threshold

Triggers notification when failure rate exceeds threshold over a time period.

**Example**: With `failureRate: 0.5` and `ratePeriodMinutes: 60`:
```
Last hour: 6 syncs total, 4 failed → 66% failure rate → Notification sent
Last hour: 6 syncs total, 2 failed → 33% failure rate → No notification
```

**Use case**: Detect intermittent issues that don't fail every time but indicate a problem.

### Threshold Logic

A notification is sent if **either** threshold is exceeded:
- Consecutive failures ≥ threshold **OR**
- Failure rate ≥ threshold

This ensures both persistent and intermittent issues are caught.

## Rate Limiting

Rate limiting prevents notification spam while ensuring important alerts are delivered.

### Minimum Interval

Ensures at least N minutes between notifications, regardless of other conditions.

**Example**: With `minIntervalMinutes: 15`:
```
12:00 PM: Notification sent
12:10 PM: Threshold exceeded → No notification (only 10 min since last)
12:16 PM: Threshold exceeded → Notification sent (16 min since last)
```

### Maximum Per Hour

Caps total notifications sent within any 60-minute rolling window.

**Example**: With `maxPerHour: 4`:
```
12:00 PM: Notification 1 sent
12:20 PM: Notification 2 sent
12:40 PM: Notification 3 sent
12:50 PM: Notification 4 sent
12:55 PM: Threshold exceeded → No notification (4 already sent in last hour)
```

### Rate Limit Strategy

Both limits work together:
1. Check minimum interval first (fast check)
2. Check max per hour if interval passed
3. Send notification only if both allow

This prevents:
- **Notification storms** from rapid successive failures
- **Alert fatigue** from too many notifications
- **Missing critical issues** by allowing reasonable alert frequency

## Use Cases

### Production Monitoring

Monitor critical sync operations with immediate alerts:

```json
{
  "thresholds": {
    "consecutiveFailures": 2,
    "failureRate": 0.4,
    "ratePeriodMinutes": 30
  },
  "rateLimit": {
    "minIntervalMinutes": 10,
    "maxPerHour": 6
  }
}
```

- Lower thresholds for faster detection
- Higher rate limits for timely alerts
- Multiple channels (email + Slack)

### Development Environment

Less aggressive monitoring for dev/test systems:

```json
{
  "thresholds": {
    "consecutiveFailures": 5,
    "failureRate": 0.7,
    "ratePeriodMinutes": 120
  },
  "rateLimit": {
    "minIntervalMinutes": 30,
    "maxPerHour": 2
  }
}
```

- Higher thresholds to reduce noise
- Longer rate period for trend analysis
- Stricter rate limits to prevent spam

### Team Collaboration

Route notifications to appropriate teams:

```json
{
  "email": {
    "enabled": true,
    "to": ["on-call@example.com"]
  },
  "webhooks": {
    "slack": [
      {
        "name": "Ops Team",
        "url": "https://hooks.slack.com/services/ops-channel"
      }
    ],
    "teams": [
      {
        "name": "DevOps",
        "url": "https://outlook.webhook.office.com/devops"
      }
    ],
    "telegram": [
      {
        "name": "Mobile Alerts",
        "botToken": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
        "chatId": "-987654321"
      }
    ]
  }
}
```

### Silent Operation

Disable notifications for maintenance or testing:

```json
{
  "notifications": {
    "email": {
      "enabled": false
    },
    "webhooks": {
      "slack": [],
      "discord": [],
      "teams": [],
      "telegram": []
    }
  }
}
```

## Troubleshooting

### Email Not Sending

**Problem**: Notifications enabled but emails not received

**Solutions**:

1. **Check SMTP credentials**:
   - Verify username and password
   - For Gmail, use app-specific password
   - Check 2FA is enabled for app passwords

2. **Verify SMTP settings**:
   ```bash
   # Test SMTP connection
   telnet smtp.gmail.com 587
   ```

3. **Check logs**:
   ```bash
   # Look for email errors
   grep -i "email" logs/*.log
   ```

4. **Check spam folder**: Emails might be filtered

5. **Verify email addresses**: Check `from` and `to` addresses are valid

### Webhook Not Sending

**Problem**: Webhook configured but notifications not appearing

**Solutions**:

1. **Test webhook URL manually**:
   ```bash
   curl -X POST YOUR_WEBHOOK_URL \
     -H "Content-Type: application/json" \
     -d '{"text": "Test notification"}'
   ```

2. **Check webhook URL format**:
   - Slack: `https://hooks.slack.com/services/...`
   - Discord: `https://discord.com/api/webhooks/...`
   - Teams: `https://outlook.webhook.office.com/...`

3. **Verify webhook is active**: Recreate if deleted/expired

4. **Check channel permissions**: Webhook must have post permission

### No Notifications Despite Failures

**Problem**: Syncs failing but no notifications sent

**Solutions**:

1. **Check thresholds**: Failures might not exceed configured thresholds
   ```bash
   # View sync history to analyze failure patterns
   npm run history --server YourServer --days 1
   ```

2. **Check rate limiting**: Previous notifications might be blocking new ones

3. **Verify configuration loaded**:
   ```bash
   npm run validate-config
   ```

4. **Check service logs**:
   ```bash
   # Look for notification decisions
   grep "threshold\|rate limit" logs/*.log
   ```

### Too Many Notifications

**Problem**: Receiving excessive notifications

**Solutions**:

1. **Increase thresholds**:
   ```json
   {
     "thresholds": {
       "consecutiveFailures": 5,
       "failureRate": 0.7
     }
   }
   ```

2. **Increase rate limit intervals**:
   ```json
   {
     "rateLimit": {
       "minIntervalMinutes": 30,
       "maxPerHour": 2
     }
   }
   ```

3. **Fix underlying sync issues** rather than suppressing notifications

## Best Practices

### 1. Start Conservative

Begin with higher thresholds and stricter rate limits, then adjust based on experience:

```json
{
  "thresholds": {
    "consecutiveFailures": 5,
    "failureRate": 0.6
  },
  "rateLimit": {
    "minIntervalMinutes": 30,
    "maxPerHour": 2
  }
}
```

### 2. Use Multiple Channels

- **Email**: On-call teams, important alerts
- **Slack/Teams**: Real-time team collaboration
- **Discord**: Community or informal monitoring

### 3. Correlate with Sync History

Use correlation IDs to link notifications to detailed sync history:

```bash
# After receiving notification with correlation ID
npm run history | grep "correlation-id-from-email"
```

### 4. Test Notification Configuration

Before deploying, test your notification setup:

1. Set very low thresholds temporarily
2. Force a sync failure
3. Verify notifications arrive
4. Reset thresholds to production values

### 5. Monitor Notification Statistics

Periodically review notification frequency:
- Too many notifications → Increase thresholds or rate limits
- Too few notifications → Lower thresholds
- No notifications during known issues → Check configuration

### 6. Secure Credentials

- **Never commit** SMTP passwords or webhook URLs to version control
- Use **environment variables** for sensitive values
- **Rotate credentials** periodically
- Use **app-specific passwords** for email services

### 7. Document Your Configuration

Keep documentation of:
- Why specific thresholds were chosen
- Who receives notifications and how to update
- Webhook channel owners and renewal dates
- On-call rotation for email recipients

### 8. Regular Maintenance

- **Test email/webhooks** quarterly
- **Review thresholds** based on actual failure patterns
- **Update recipient lists** when team changes
- **Archive old notification logs** to save space

## Integration with Other Features

### Sync History Integration

Notification service tracks sync results independently but integrates with sync history:

- **Correlation IDs**: Link notifications to detailed history records
- **Query history**: Use sync history to analyze notification patterns
- **Failure trends**: Combine notification stats with historical data

### Health Check Integration

Notification service complements the health check endpoints:

- **Health checks**: Passive monitoring (query when needed)
- **Notifications**: Active monitoring (alerts pushed to you)
- **Combined**: Health checks for status, notifications for problems

### Structured Logging Integration

All notification activities are logged with:
- **Correlation IDs**: Track notification decisions
- **Debug logs**: Threshold checks, rate limit decisions
- **Error logs**: Notification failures, webhook errors

## Future Enhancements

Potential future improvements:

1. **Notification History**: Track sent notifications in database
2. **Escalation Rules**: Different channels for different severity
3. **Quiet Hours**: Suppress non-critical notifications during off-hours
4. **Custom Templates**: User-defined email/webhook message formats
5. **Aggregated Notifications**: Batch multiple failures into digest
6. **SMS Integration**: Twilio/SNS for critical alerts
7. **PagerDuty Integration**: Incident management system integration
8. **Notification Dashboard**: Web UI to view notification status
9. **Smart Thresholds**: ML-based adaptive threshold adjustment
10. **Notification Replay**: Manually trigger notification for testing

## Summary

The Error Notification System provides:

✅ **Multiple delivery channels** (Email, Slack, Discord, Telegram)
✅ **Smart thresholds** (consecutive failures and failure rates)  
✅ **Rate limiting** (prevent notification spam)
✅ **Rich context** (errors, stats, correlation IDs)
✅ **Flexible configuration** (adapt to your needs)
✅ **Production-ready** (34 comprehensive tests, graceful error handling)

Configure it once, and stay informed about sync issues that matter without being overwhelmed by noise.
