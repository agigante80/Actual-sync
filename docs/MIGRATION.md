# Configuration Migration Guide

## Upgrading to 1.11.0

**Read this before upgrading if you use notifications.** Three changes alter behaviour for existing configs. Two can make a channel go *silent*, and one can make a channel start *talking*.

### 1. `notifyOnSuccess` now actually works — and `never` silences failures too

`notifications.telegram.notifyOnSuccess` has existed in the schema for a long time but **gated nothing**: every channel notified on every sync regardless of what you set. From 1.11.0 it is enforced, and it now exists on every channel — with one exception, legacy `webhooks.telegram` entries, covered in §3 below.

The trap is the name. `notifyOnSuccess: "never"` reads like *"never notify me on success"* — but it means **"turn this channel off entirely, failures included"**.

| If you meant | Use |
|---|---|
| Stop telling me about *successful* syncs | **`errors_only`** |
| Turn this channel off completely | `never` |

**Action:** if any config of yours sets `notifyOnSuccess: "never"` and you actually wanted quiet successes, change it to `errors_only` before upgrading. On startup the service logs a `WARN` naming every channel it has muted, so check your logs after the first boot:

```
[WARN] Channels muted by notifyOnSuccess: "never" — these will NOT notify on failures either
```

This also applies to a mode set with the Telegram `/notify` command. Before 1.11.0 that command changed nothing on the dispatch path, so a value typed months ago as a no-op now takes effect. An explicit `notifications.telegram.notifyOnSuccess` in your config overrides a stored `/notify` value on restart; if config is silent, the stored value applies.

### 2. Enabled email now requires a sender and at least one recipient

`notifications.email.enabled: true` combined with a missing `from`, a missing `to`, or an empty `to: []` previously validated fine — and then silently delivered nothing. That is now **rejected at startup**:

```
Configuration is invalid — it does not match the schema:
  - /notifications/email/to: must NOT have fewer than 1 items
```

**Action:** either fill in `from` and `to`, or set `enabled: false`. A disabled email block with an empty `to` is still perfectly valid, so placeholder stubs are unaffected.

If you need to boot before you can fix the config, `CONFIG_STRICT=false` downgrades schema failures to warnings. Use it to get running, not as a permanent setting — the channel still cannot deliver.

### 3. Legacy `webhooks.telegram` entries now actually deliver

A `notifications.webhooks.telegram` entry has never sent a message — the code path that would read it was unreachable. It works now.

Consequence: an entry has **no `enabled` flag — its presence is its enablement**. If you have a legacy entry *and* `notifications.telegram.enabled: false`, you were receiving nothing and will now start receiving messages.

**Action:** if you want that channel to stay off, either **remove the entry**, or set it on the top-level block:

```json
"notifications": {
  "telegram": { "enabled": false, "notifyOnSuccess": "never" },
  "webhooks": { "telegram": [ { "name": "legacy", "botToken": "…", "chatId": "…" } ] }
}
```

> **Do not** put `notifyOnSuccess` on the legacy entry itself. Legacy `webhooks.telegram` items are the one exception to "every channel supports it" — the schema has no such key there, and because an unknown key is only an advisory warning the service still starts and silently ignores it. The channel would keep sending.

### Also worth knowing

- **Delivery reporting is honest now.** The log line `Sync notification sent` only appears when at least one channel actually delivered; a total failure logs `Sync notification failed on every channel` at WARN. If you have monitoring that greps for the old line, it will now correctly go quiet when your alerting is broken.
- **Undelivered notifications no longer consume the rate-limit budget.** A broken transport is therefore retried on every scheduled sync instead of being rate-limited away. See [Rate Limiting](NOTIFICATIONS.md#rate-limiting).
- **A dead Telegram bot token is logged once**, not every two seconds.

Full reference: [docs/NOTIFICATIONS.md](NOTIFICATIONS.md#notification-mode-notifyonsuccess).

---

## Overview

As of December 2025, Actual-sync has moved from hardcoded server configuration to external configuration files. This provides better flexibility and security.

---

## What Changed

### Before (Hardcoded Configuration)

Server configuration was embedded in `sync_all_banks.js`:

```javascript
const servers = [
    {
        name: 'Main',
        url: process.env.SERVICE_MAIN_URL || 'http://actual-main:5006',
        password: process.env.SERVICE_MAIN_PASSWORD || 'hunter2',
        // ...
    }
];
```

### After (External Configuration)

Server configuration is now in `config.json`:

```json
{
  "servers": [
    {
      "name": "Main",
      "url": "http://actual-main:5006",
      "password": "your_password",
      "syncId": "your_sync_id",
      "dataDir": "/app/dataDir_Main_temp"
    }
  ],
  "sync": {
    "maxRetries": 5,
    "baseRetryDelayMs": 3000,
    "schedule": "03 03 */2 * *"
  }
}
```

---

## Migration Steps

### Step 1: Install Dependencies

Update to the latest version and install new dependencies:

```bash
cd /path/to/Actual-sync
npm install
```

### Step 2: Create config.json

Copy the example configuration:

```bash
cp config/config.example.json config/config.json
```

### Step 3: Migrate Your Settings

If you were using environment variables, migrate them to `config.json`:

**Environment Variables → config.json Mapping:**

| Environment Variable | config.json Path |
|---------------------|------------------|
| `SERVICE_MAIN_URL` | `servers[0].url` |
| `SERVICE_MAIN_PASSWORD` | `servers[0].password` |
| `SERVICE_MAIN_SYNC_ID` | `servers[0].syncId` |
| `SERVICE_MAIN_DIR` | `servers[0].dataDir` |
| `SERVICE_ALEJANDRO_URL` | `servers[1].url` |
| `SERVICE_ALEJANDRO_PASSWORD` | `servers[1].password` |
| `SERVICE_ALEJANDRO_SYNC_ID` | `servers[1].syncId` |
| `SERVICE_ALEJANDRO_DIR` | `servers[1].dataDir` |

**Example Migration:**

If your `.env` file had:
```env
SERVICE_MAIN_URL=https://budget.example.com
SERVICE_MAIN_PASSWORD=mySecurePassword123
SERVICE_MAIN_SYNC_ID=abc-def-ghi-123
SERVICE_MAIN_DIR=/data/main
```

Your `config.json` should have:
```json
{
  "servers": [
    {
      "name": "Main",
      "url": "https://budget.example.com",
      "password": "mySecurePassword123",
      "syncId": "abc-def-ghi-123",
      "dataDir": "/data/main"
    }
  ]
}
```

### Step 4: Configure Multiple Servers

To add more servers, add entries to the `servers` array:

```json
{
  "servers": [
    {
      "name": "Personal",
      "url": "https://personal.example.com",
      "password": "password1",
      "syncId": "sync-id-1",
      "dataDir": "/data/personal"
    },
    {
      "name": "Business",
      "url": "https://business.example.com",
      "password": "password2",
      "syncId": "sync-id-2",
      "dataDir": "/data/business"
    }
  ]
}
```

### Step 5: Adjust Sync Settings (Optional)

Customize retry behavior and schedule:

```json
{
  "sync": {
    "maxRetries": 5,              // Number of retry attempts (0-10)
    "baseRetryDelayMs": 3000,     // Base delay for exponential backoff (milliseconds)
    "schedule": "0 2 * * *"       // Cron: Run at 2 AM daily
  }
}
```

**Common Cron Schedules:**
- Every day at 2 AM: `0 2 * * *`
- Every 6 hours: `0 */6 * * *`
- Every other day at 3:03 AM: `03 03 */2 * *` (default)
- Every hour: `0 * * * *`

### Step 6: Secure Your Configuration

**Important Security Steps:**

1. Set appropriate file permissions:
   ```bash
   chmod 600 config.json
   ```

2. Verify `config.json` is in `.gitignore`:
   ```bash
   grep "config.json" .gitignore
   ```

3. Never commit `config.json` to version control

### Step 7: Validate Configuration

Test your configuration before running:

```bash
npm run validate-config
```

Or just start the service (it validates on startup):
```bash
npm start
```

### Step 8: Test Sync

Run a manual sync to verify everything works:

```bash
npm run sync
```

---

## Troubleshooting

### "Configuration file not found"

**Error:**
```
❌ Failed to load configuration:
Configuration file not found: ./config.json
```

**Solution:**
Create `config/config.json` from the example:
```bash
cp config/config.example.json config/config.json
```
Then edit with your settings.

---

### "Invalid JSON in configuration file"

**Error:**
```
❌ Failed to load configuration:
Invalid JSON in configuration file: Unexpected token...
```

**Solution:**
- Check for missing commas between properties
- Check for trailing commas (not allowed in JSON)
- Validate JSON syntax: https://jsonlint.com/
- Use a JSON validator:
  ```bash
  node -e "JSON.parse(require('fs').readFileSync('config/config.json', 'utf8'))"
  ```

---

### "Configuration validation failed"

**Error:**
```
❌ Failed to load configuration:
Configuration validation failed:
  - /servers/0/password: must be string
```

**Solution:**
Fix the specific field mentioned in the error. Common issues:
- Missing required fields (name, url, password, syncId, dataDir)
- Wrong data types (e.g., number instead of string)
- Invalid URLs (must start with http:// or https://)

---

### Warning: "Using unencrypted HTTP connection"

**Warning:**
```
⚠️  Warning: Server "Main" uses unencrypted HTTP connection.
   Consider using HTTPS for production: http://example.com
```

**Solution:**
This is a warning, not an error. Consider using HTTPS in production:
```json
{
  "url": "https://example.com"  // Use HTTPS instead of HTTP
}
```

For local/internal servers (localhost, 127.0.0.1), HTTP is acceptable.

---

### Warning: "Weak password"

**Warning:**
```
⚠️  Warning: Server "Main" has a weak password (< 8 characters).
   Consider using a stronger password for security.
```

**Solution:**
Use a longer, more secure password (16+ characters recommended):
```json
{
  "password": "aVeryLongAndSecurePassword123!@#"
}
```

---

## Backward Compatibility

### Environment Variables Still Work

The `.env` file is still loaded, but it's no longer used for server configuration. You can remove the old environment variables:

```bash
# These are no longer needed:
# SERVICE_MAIN_URL
# SERVICE_MAIN_PASSWORD
# SERVICE_MAIN_SYNC_ID
# SERVICE_MAIN_DIR
# SERVICE_ALEJANDRO_URL
# SERVICE_ALEJANDRO_PASSWORD
# SERVICE_ALEJANDRO_SYNC_ID
# SERVICE_ALEJANDRO_DIR
```

### Rolling Back

If you need to roll back to the old version:

1. Check out the previous version:
   ```bash
   git checkout <previous-commit>
   ```

2. Reinstall dependencies:
   ```bash
   npm install
   ```

Your `.env` file will work again with the old version.

---

## Configuration Reference

### Complete Example

```json
{
  "$schema": "./config.schema.json",
  "servers": [
    {
      "name": "Production",
      "url": "https://budget.example.com",
      "password": "SecurePassword123!",
      "syncId": "abc-123-def-456",
      "dataDir": "/var/lib/actual-sync/production"
    },
    {
      "name": "Testing",
      "url": "http://localhost:5006",
      "password": "TestPassword",
      "syncId": "test-sync-id",
      "dataDir": "/tmp/actual-sync-test"
    }
  ],
  "sync": {
    "maxRetries": 5,
    "baseRetryDelayMs": 3000,
    "schedule": "0 2 * * *"
  },
  "logging": {
    "level": "info"
  }
}
```

### Field Descriptions

**servers** (required, array):
- **name** (required, string): Human-readable server name
- **url** (required, string): Actual Budget server URL
- **password** (required, string): Server password
- **syncId** (required, string): Budget sync ID from Actual settings
- **dataDir** (required, string): Local directory for budget cache

**sync** (optional, object):
- **maxRetries** (optional, integer, default: 5): Max retry attempts (0-10)
- **baseRetryDelayMs** (optional, integer, default: 3000): Base retry delay in ms
- **schedule** (optional, string, default: "03 03 */2 * *"): Cron expression

**logging** (optional, object):
- **level** (optional, string, default: "info"): Log level (debug/info/warn/error)

---

## Getting Help

If you encounter issues during migration:

1. Check the [troubleshooting section](#troubleshooting)
2. Validate your JSON syntax
3. Review the example configuration: `config.example.json`
4. Check the schema: `config.schema.json`
5. Open an issue with your error message (remove sensitive data!)

---

**Migration completed?** You're all set — your budgets now sync from `config.json`.
