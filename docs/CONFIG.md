# Configuration System

## Quick Start

1. **Copy the example configuration:**
   ```bash
   cp config/config.example.json config/config.json
   ```

2. **Edit with your settings:**
   ```bash
   nano config/config.json  # or your preferred editor
   ```

3. **Validate configuration:**
   ```bash
   npm run validate-config
   ```

4. **Run the service:**
   ```bash
   npm start
   ```

---

## Configuration File Structure

### Complete Example

```json
{
  "$schema": "../config/config.schema.json",
  "servers": [
    {
      "name": "Production",
      "url": "https://budget.example.com",
      "password": "SecurePassword123!",
      "syncId": "abc-123-def-456",
      "dataDir": "/var/lib/actual-sync/production",
      "encryptionPassword": "MyBudgetEncryptionKey"
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

---

## Configuration Reference

### servers (required)

Array of Actual Budget server configurations. At least one server is required.

**Properties:**

- **name** (required, string): Human-readable name for the server
  - Must be unique across all servers
  - Used in logs for identification
  - Example: `"Production"`, `"Personal"`, `"Business"`

- **url** (required, string): Actual Budget server URL
  - Must start with `http://` or `https://`
  - HTTPS recommended for production
  - Example: `"https://budget.example.com"`

- **password** (required, string): Server password
  - Minimum 8 characters recommended
  - Avoid default passwords like "hunter2"
  - Use a password manager for secure passwords

- **syncId** (required, string): Budget sync ID
  - Found in Actual Budget → Advanced Settings
  - Unique identifier for your budget file
  - Example: `"abc-123-def-456-789"`

- **dataDir** (required, string): Local directory for budget cache
  - Must be writable by the service user
  - Each server should have a unique directory
  - Example: `"/var/lib/actual-sync/main"`

- **encryptionPassword** (optional, string): Budget file encryption password
  - Only required if your budget uses end-to-end encryption (E2EE)
  - This is **separate** from the server password
  - Found in Actual Budget → Settings → Encryption
  - Leave empty/omitted for unencrypted budgets
  - Example: `"MySecretBudgetPassword123!"`
  - ⚠️ **Security Note**: Store securely, never commit to version control

- **sync** (optional, object): Per-server sync configuration overrides
  - Overrides global `sync` settings for this specific server
  - All properties are optional
  - See [Per-Server Sync Configuration](#per-server-sync-configuration) below

---

### sync (optional)

Global synchronization behavior configuration. These settings apply to all servers unless overridden at the server level.

**Properties:**

- **maxRetries** (optional, integer, default: 5)
  - Maximum number of retry attempts for failed operations
  - Range: 0-10
  - Higher values = more resilience, longer failure detection
  - Can be overridden per server
  - Example: `5`

- **baseRetryDelayMs** (optional, integer, default: 3000)
  - Base delay in milliseconds for exponential backoff
  - Minimum: 1000ms (1 second)
  - Delay doubles with each retry attempt
  - Can be overridden per server
  - Example: `3000` (3 seconds)

- **schedule** (optional, string, default: "03 03 */2 * *")
  - Cron expression for sync schedule
  - Format: `minute hour day month dayOfWeek`
  - Can be overridden per server
  - See [Cron Examples](#cron-examples) below

---

### logging (optional)

Logging configuration.

**Properties:**

- **level** (optional, string, default: "info")
  - Log verbosity level
  - Options: `"debug"`, `"info"`, `"warn"`, `"error"`
  - Example: `"info"`

---

## Cron Examples

| Schedule | Cron Expression | Description |
|----------|----------------|-------------|
| Every day at 2 AM | `0 2 * * *` | Once daily |
| Every 6 hours | `0 */6 * * *` | Four times daily |
| Every hour | `0 * * * *` | 24 times daily |
| Every other day at 3:03 AM | `03 03 */2 * *` | Default schedule |
| Every Monday at 9 AM | `0 9 * * 1` | Weekly |
| Every 30 minutes | `*/30 * * * *` | 48 times daily |
| Twice daily (6 AM and 6 PM) | `0 6,18 * * *` | Morning and evening |

**Cron Format:** `minute (0-59) hour (0-23) day (1-31) month (1-12) dayOfWeek (0-6, Sunday=0)`

---

## Per-Server Sync Configuration

You can override global sync settings for specific servers by adding a `sync` object to the server configuration. This allows different synchronization strategies for different servers.

### Example Configuration

```json
{
  "servers": [
    {
      "name": "Critical-Production",
      "url": "https://budget.example.com",
      "password": "password",
      "syncId": "prod-sync-id",
      "dataDir": "/var/lib/actual-sync/prod",
      "sync": {
        "schedule": "*/30 * * * *",
        "maxRetries": 8
      }
    },
    {
      "name": "Testing",
      "url": "http://localhost:5006",
      "password": "password",
      "syncId": "test-sync-id",
      "dataDir": "/tmp/actual-sync-test",
      "sync": {
        "maxRetries": 2,
        "baseRetryDelayMs": 1000
      }
    },
    {
      "name": "Personal",
      "url": "https://personal.example.com",
      "password": "password",
      "syncId": "personal-sync-id",
      "dataDir": "/var/lib/actual-sync/personal"
    }
  ],
  "sync": {
    "maxRetries": 5,
    "baseRetryDelayMs": 3000,
    "schedule": "0 3 * * *"
  }
}
```

In this example:
- **Critical-Production**: Syncs every 30 minutes with 8 retries (more aggressive)
- **Testing**: Uses global schedule but fewer retries (2) and faster retry delay (1s)
- **Personal**: Uses all global defaults (daily at 3 AM, 5 retries, 3s delay)

### Use Cases

**Frequent Syncing for Critical Servers:**
```json
{
  "name": "Production",
  "sync": {
    "schedule": "*/15 * * * *"
  }
}
```

**Fewer Retries for Unreliable Connections:**
```json
{
  "name": "Flaky-Server",
  "sync": {
    "maxRetries": 2,
    "baseRetryDelayMs": 1000
  }
}
```

**Off-Hours Syncing for Low-Priority Servers:**
```json
{
  "name": "Archive",
  "sync": {
    "schedule": "0 4 * * 0"
  }
}
```

**Aggressive Retry for Important Servers:**
```json
{
  "name": "Business-Critical",
  "sync": {
    "maxRetries": 10,
    "baseRetryDelayMs": 5000
  }
}
```

### Configuration Merging

The system merges per-server and global settings using these rules:

1. If a property is specified in `server.sync`, it takes precedence
2. If a property is not specified in `server.sync`, the global `sync` value is used
3. You can override any combination of properties (one, two, or all three)
4. Zero values (e.g., `maxRetries: 0`) are treated as explicit values, not fallbacks

**Example:**
```json
{
  "servers": [
    {
      "name": "Server1",
      "sync": {
        "schedule": "0 2 * * *"
      }
    }
  ],
  "sync": {
    "maxRetries": 5,
    "baseRetryDelayMs": 3000,
    "schedule": "0 3 * * *"
  }
}
```

Server1 will use:
- `maxRetries`: 5 (from global)
- `baseRetryDelayMs`: 3000 (from global)
- `schedule`: "0 2 * * *" (from server override)

### Scheduling Behavior

When servers have different schedules, the service creates separate cron jobs for each unique schedule. Servers with the same schedule are grouped together and synced in sequence.

**Example:**
- Servers with schedule `"0 2 * * *"` → one cron job at 2 AM
- Servers with schedule `"0 4 * * *"` → separate cron job at 4 AM
- Servers with schedule `"*/30 * * * *"` → separate cron job every 30 minutes

This ensures efficient scheduling with minimal overhead.

---

## Validation

The configuration system performs multiple validation checks:

### Syntax Validation

- Valid JSON format
- No trailing commas
- Proper quotation marks

### Schema Validation

- All required fields present
- Correct data types
- Valid URL formats
- Valid cron expressions

### Business Logic Validation

- At least one server configured
- Unique server names
- No duplicate configurations
- Reasonable retry settings

### Security Warnings

The system warns about:
- HTTP connections (non-localhost)
- Weak passwords (<8 characters)
- Default/example passwords
- Common security issues

---

## Security Best Practices

### 1. Protect config.json

```bash
chmod 600 config.json  # Owner read/write only
```

### 2. Never Commit config.json

The file is in `.gitignore` - verify:
```bash
grep config.json .gitignore
```

### 3. Use Strong Passwords

- Minimum 16 characters
- Mix of letters, numbers, symbols
- Unique per server
- Use a password manager

### 4. Use HTTPS in Production

```json
{
  "url": "https://budget.example.com"  // ✅ HTTPS
}
```

Not:
```json
{
  "url": "http://budget.example.com"  // ❌ HTTP
}
```

---

## Troubleshooting

### Configuration file not found

**Error:**
```
❌ Failed to load configuration:
Configuration file not found: ./config.json
```

**Solution:**
```bash
cp config/config.example.json config/config.json
```

---

### Invalid JSON

**Error:**
```
Invalid JSON in configuration file: Unexpected token...
```

**Solutions:**
- Check for missing/trailing commas
- Validate at https://jsonlint.com/
- Use `node -e "JSON.parse(require('fs').readFileSync('config.json'))"`

---

### Schema Validation Failed

**Error:**
```
Configuration validation failed:
  - /servers/0/password: must be string
```

**Solution:**
Fix the specific field mentioned. Common issues:
- Missing quotes around strings
- Wrong data type
- Missing required fields

---

### Duplicate Server Names

**Error:**
```
Duplicate server names found: Main
Each server must have a unique name.
```

**Solution:**
Rename one of the servers:
```json
{
  "servers": [
    { "name": "Main-Production", ... },
    { "name": "Main-Testing", ... }
  ]
}
```

---

## Migration from Environment Variables

If upgrading from the old `.env` approach, see [MIGRATION.md](./MIGRATION.md) for detailed instructions.

**Quick Migration:**

1. Create config.json from example
2. Copy values from .env to config.json
3. Test configuration
4. Remove old environment variables from .env

---

## Advanced Usage

### Multiple Environments

Create different config files for different environments:

```bash
config.production.json
config.staging.json
config.development.json
```

Specify config file:
```javascript
const loader = new ConfigLoader('./config.production.json');
```

### Programmatic Access

```javascript
const ConfigLoader = require('./src/lib/configLoader');

const loader = new ConfigLoader();
const config = loader.load();

// Get all servers
const servers = loader.getServers();

// Get specific server
const prodServer = loader.getServer('Production');

// Access configuration
console.log('Schedule:', config.sync.schedule);
console.log('Max retries:', config.sync.maxRetries);
```

---

## Encrypted Budgets (E2EE)

Actual Budget supports end-to-end encryption (E2EE) for budget files. If your budget is encrypted, you need to provide the encryption password.

### How to Configure

1. **Check if your budget is encrypted:**
   - Open Actual Budget web interface
   - Go to Settings → Encryption
   - If encryption is enabled, you'll see "Budget is encrypted"

2. **Add encryption password to config:**

```json
{
  "servers": [
    {
      "name": "Encrypted Budget",
      "url": "https://actual.example.com",
      "password": "server-password-here",
      "syncId": "your-sync-id",
      "dataDir": "/app/data/encrypted",
      "encryptionPassword": "your-budget-encryption-password"
    }
  ]
}
```

### Important Notes

- **Server Password ≠ Encryption Password**:
  - `password`: Authenticates to the Actual Budget server
  - `encryptionPassword`: Decrypts the budget file itself

- **Security Best Practices**:
  - Never commit encryption passwords to version control
  - Use environment variables or secrets management
  - Keep encryption passwords separate from server passwords
  - Regularly rotate encryption passwords

- **Troubleshooting**:
  - If sync fails with "decryption error", verify encryption password
  - Unencrypted budgets don't need `encryptionPassword` field
  - Empty string is treated as no encryption (budget must be unencrypted)

### Example with Docker

```yaml
services:
  actual-sync:
    image: actual-sync:latest
    volumes:
      - ./config:/app/config:ro
    environment:
      - BUDGET_ENCRYPTION_PASSWORD=${BUDGET_ENCRYPTION_PASSWORD}
```

Then reference in config:
```json
{
  "servers": [{
    "encryptionPassword": "${BUDGET_ENCRYPTION_PASSWORD}"
  }]
}
```

**Note**: Environment variable substitution requires additional tooling (not built-in).

---

## Schema Reference

The configuration is validated against `config.schema.json` using JSON Schema Draft 7.

View the full schema:
```bash
cat config.schema.json
```

Validate manually:
```bash
npm install -g ajv-cli
ajv validate -s config.schema.json -d config.json
```

---

## Support

- **Documentation:** See [/docs/README.md](./docs/README.md)
- **Migration Guide:** [MIGRATION.md](./MIGRATION.md)
- **Architecture:** [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **Security:** [docs/SECURITY_AND_PRIVACY.md](./docs/SECURITY_AND_PRIVACY.md)

---

**Last Updated:** December 4, 2025
