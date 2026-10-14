/**
 * Sync History Service
 * 
 * Tracks and persists sync operation history in SQLite database.
 * Provides query interface for historical analysis and reporting.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const moment = require('moment-timezone');
const { createLogger } = require('../lib/logger');
const { muteEndsAt } = require('../lib/scheduleAlertRules');

const REDACTED = '[redacted]';

// Field denylist for config_audit.changes_json (#259): case-insensitive
// SUBSTRING of the key name with `_` and `-` removed (so `api_key`, `X-Api-Key`
// and `apiKey` all hit `apikey`), at every nesting level. `reason` is the
// free-text mute reason of #261, which can name a person. Over-redaction is
// deliberate: a false positive hides a harmless value, a false negative stores
// a secret. Exported for the test.
const CONFIG_AUDIT_REDACT_SUBSTRINGS = [
  'password', 'passwd', 'secret', 'token', 'apikey', 'authorization', 'webhook', 'reason'
];
const CONFIG_AUDIT_MAX_BYTES = 8 * 1024;
const NOTIFICATION_CHANNEL_NAMES = ['slack', 'discord', 'ntfy', 'webhook'];
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]*@/i;

const normalizeKey = (key) => String(key).toLowerCase().replace(/[_-]/g, '');

/**
 * Should the value under `key` be hidden? `context` holds the ancestor key
 * names (dotted keys count as paths: `notifications.email.auth.pass` is `pass` under
 * `email` and `auth`). The real SMTP credentials live at notifications.email.auth.
 */
function isSensitiveKey(key, context) {
  const segments = String(key).split('.');
  const leaf = normalizeKey(segments[segments.length - 1]);
  const full = normalizeKey(key);
  if (CONFIG_AUDIT_REDACT_SUBSTRINGS.some(sub => full.includes(sub))) return true;
  const ancestors = context.concat(segments.slice(0, -1)).map(normalizeKey);
  if ((leaf === 'user' || leaf === 'pass') && ancestors.some(a => a.includes('smtp') || a.includes('email') || a === 'auth')) return true;
  if (leaf === 'url' && ancestors.some(a => NOTIFICATION_CHANNEL_NAMES.some(n => a.includes(n)))) return true;
  return false;
}

function redactValue(value, context) {
  if (typeof value === 'string') {
    return URL_WITH_CREDENTIALS.test(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactValue(item, context));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSensitiveKey(key, context)
        ? REDACTED
        : redactValue(inner, context.concat(key));
    }
    return out;
  }
  return value;
}

/**
 * changes -> the changes_json text: redacted, then capped at 8 KB. Over the
 * cap (or not serialisable) it becomes { _truncated: true, fields: [names] }.
 */
function serializeAuditChanges(changes) {
  const source = changes && typeof changes === 'object' ? changes : {};
  const fieldNames = () => Object.keys(source).slice(0, 50).map(name => name.slice(0, 64));
  try {
    const text = JSON.stringify(redactValue(source, []));
    if (Buffer.byteLength(text) <= CONFIG_AUDIT_MAX_BYTES) return text;
  } catch { /* fall through to the marker */ }
  return JSON.stringify({ _truncated: true, fields: fieldNames() });
}

class SyncHistoryService {
  /**
   * @param {Object} options - Sync history service options
   * @param {string} options.dbPath - Path to SQLite database file
   * @param {number} options.retentionDays - Number of days to retain history (default: 90)
   * @param {Object} options.loggerConfig - Logger configuration
   */
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(process.cwd(), 'data', 'sync-history.db');
    this.retentionDays = options.retentionDays || 90;
    // Injectable clock (#263): the e2e fixtures seed history at fixed dates and
    // need the day-window queries to agree. Must return a fresh Date each call,
    // since the cutoff code mutates it.
    this.now = options.now || (() => new Date());
    this.logger = createLogger(options.loggerConfig || {});
    this.db = null;
    
    this.initialize();
  }

  /**
   * Initialize database and create tables if needed
   */
  initialize() {
    try {
      // Ensure data directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        this.logger.info('Created data directory for sync history', { dbDir });
      }

      // Open database
      this.db = new Database(this.dbPath);
      this.logger.info('Sync history database opened', { dbPath: this.dbPath });

      // Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');

      // Create tables
      this.createTables();

      // Apply schema migrations for databases created before newer columns existed
      this.migrateSchema();

      // Clean up old records
      this.cleanup();

      this.logger.info('Sync history service initialized', {
        retentionDays: this.retentionDays
      });
    } catch (error) {
      this.logger.error('Failed to initialize sync history database', {
        error: error.message,
        dbPath: this.dbPath
      });
      throw error;
    }
  }

  /**
   * Create database tables
   */
  createTables() {
    const createSyncHistoryTable = `
      CREATE TABLE IF NOT EXISTS sync_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        server_name TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        accounts_processed INTEGER,
        accounts_succeeded INTEGER,
        accounts_failed INTEGER,
        accounts_skipped INTEGER,
        error_message TEXT,
        error_code TEXT,
        correlation_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // Current-state snapshot of each server's accounts and whether they can
    // bank-sync, so the dashboard can show syncable/manual/closed without a live
    // Actual connection. Refreshed (replaced per server) on every sync. (#99)
    const createAccountMetadataTable = `
      CREATE TABLE IF NOT EXISTS account_metadata (
        server_name TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_name TEXT,
        classification TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_name, account_id)
      )
    `;

    // Missing-payment alert de-duplication ledger (#258). One row per
    // successfully delivered event *destination*, keyed by (server, alert,
    // schedule, occurrence, event, channel); `deliver()`
    // (src/lib/scheduleAlertDelivery.js) reads it before sending and writes
    // it only after a successful send, so a failed send is retried on the
    // next sync instead of being lost.
    //
    // `channel` (#295 review, H5) identifies the individual destination a
    // row was recorded for (e.g. `slack:https://hooks.example/a`, or just
    // `telegram` for a single-destination channel), so one dead destination
    // no longer forces every other, already-succeeding destination to resend
    // on the next sync (see scheduleAlertDelivery.js's `dueDestinations`).
    // It is nullable so a lookup that does not care which destination
    // recorded an event (e.g. `deriveResolvedEvents`, which only asks "was
    // `missing` ever recorded for this occurrence, on any channel") can omit
    // it and match any row.
    const createScheduleAlertsTable = `
      CREATE TABLE IF NOT EXISTS schedule_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server TEXT NOT NULL,
        alert_id TEXT NOT NULL,
        schedule_id TEXT,
        occurrence_date TEXT,
        event TEXT NOT NULL,
        delivery TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        channel TEXT
      )
    `;

    // Missing-payment alert snapshot (#260): what the #258 evaluation last
    // said about every watched schedule, so the dashboard can show it without
    // a connection to Actual. Replaced per server on every successful
    // evaluation (replacePaymentSnapshot). `expected_amount` is integer cents
    // (NULL for a range or an absent amount); an `isbetween` range is stored
    // normalised in expected_min/expected_max. `occurrences_json` is the
    // evaluation's occurrences[] unchanged. No last_alert_at: that is joined
    // from the schedule_alerts ledger at request time (getLastSentAlerts).
    const createPaymentAlertStatusTable = `
      CREATE TABLE IF NOT EXISTS payment_alert_status (
        server TEXT NOT NULL,
        alert_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        name TEXT,
        cadence_text TEXT,
        account TEXT,
        payee TEXT,
        expected_amount INTEGER,
        expected_min INTEGER,
        expected_max INTEGER,
        next_date TEXT,
        deadline TEXT,
        state TEXT NOT NULL,
        occurrences_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (server, alert_id, schedule_id)
      )
    `;

    // One row per server describing the latest evaluation attempt. `evaluated_at`
    // is the latest attempt; `last_success_at` the latest success (kept when a
    // later run fails, NULL until the first success). (#260)
    const createPaymentAlertRunTable = `
      CREATE TABLE IF NOT EXISTS payment_alert_run (
        server TEXT PRIMARY KEY,
        evaluated_at TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error_code TEXT,
        rules_errored INTEGER NOT NULL DEFAULT 0,
        last_success_at TEXT
      )
    `;

    // Configuration change audit (#259). Append-only: the history resets leave
    // it alone and add a history_reset row; only cleanup() purges it, by age.
    // changes_json is redacted and capped before it is stored.
    const createConfigAuditTable = `
      CREATE TABLE IF NOT EXISTS config_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        server TEXT,
        remote_addr TEXT,
        action TEXT NOT NULL,
        target TEXT,
        changes_json TEXT NOT NULL
      )
    `;

    // Dashboard override of one alert rule (#261): switched off and/or muted
    // until a date, keyed at rule level (a schedulePrefix rule shares one
    // alert_id). A row at the default state (enabled, no mute) is never stored.
    // `muted_from` is an ISO instant, `muted_until` a YYYY-MM-DD date. There is
    // no IP column; the remote address lives only in config_audit.
    const createPaymentAlertOverrideTable = `
      CREATE TABLE IF NOT EXISTS payment_alert_override (
        server TEXT NOT NULL,
        alert_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        muted_from TEXT,
        muted_until TEXT,
        reason TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (server, alert_id)
      )
    `;

    const createIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_timestamp ON sync_history(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_server_name ON sync_history(server_name)',
      'CREATE INDEX IF NOT EXISTS idx_status ON sync_history(status)',
      'CREATE INDEX IF NOT EXISTS idx_correlation_id ON sync_history(correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_account_meta_server ON account_metadata(server_name)',
      'CREATE INDEX IF NOT EXISTS idx_schedule_alerts_lookup ON schedule_alerts(server, alert_id, schedule_id, occurrence_date, event)',
      'CREATE INDEX IF NOT EXISTS idx_schedule_alerts_recorded_at ON schedule_alerts(recorded_at)',
      'CREATE INDEX IF NOT EXISTS idx_config_audit_at ON config_audit(at)'
    ];

    this.db.exec(createSyncHistoryTable);
    this.db.exec(createAccountMetadataTable);
    this.db.exec(createScheduleAlertsTable);
    this.db.exec(createPaymentAlertStatusTable);
    this.db.exec(createPaymentAlertRunTable);
    this.db.exec(createConfigAuditTable);
    this.db.exec(createPaymentAlertOverrideTable);
    this.logger.debug('Created sync_history, account_metadata, schedule_alerts and payment snapshot tables');

    createIndexes.forEach(idx => {
      this.db.exec(idx);
    });
    this.logger.debug('Created indexes');
  }

  /**
   * Apply additive schema migrations to existing databases.
   *
   * `CREATE TABLE IF NOT EXISTS` only defines columns for brand-new databases;
   * a database created by an older version keeps its original column set. Each
   * migration is guarded by a PRAGMA check so it is idempotent and safe to run
   * on every startup. Adding a column preserves existing rows (new column reads
   * as NULL for them).
   */
  migrateSchema() {
    const columns = this.db.prepare('PRAGMA table_info(sync_history)').all();
    const hasColumn = (name) => columns.some(col => col.name === name);

    if (!hasColumn('accounts_skipped')) {
      this.db.exec('ALTER TABLE sync_history ADD COLUMN accounts_skipped INTEGER');
      this.logger.info('Migrated sync_history: added accounts_skipped column');
    }

    // #295 review, H5: schedule_alerts.channel, added to an existing
    // database created before per-destination ledger keying existed.
    // Existing rows read as NULL for it: a row written back when there was
    // only ever one implicit "destination" per event. `findLatestScheduleAlert`
    // (#295 review round 2, M9) treats such a row as a match for ANY specific
    // destination key, not just "any destination" lookups that omit `channel`
    // entirely - otherwise every pre-upgrade "sent" row would become invisible
    // to the new per-destination lookups the moment a real `channel` value is
    // queried, and every already-delivered alert would resend once per
    // destination on the first post-upgrade sync.
    const scheduleAlertsColumns = this.db.prepare('PRAGMA table_info(schedule_alerts)').all();
    if (!scheduleAlertsColumns.some((col) => col.name === 'channel')) {
      this.db.exec('ALTER TABLE schedule_alerts ADD COLUMN channel TEXT');
      this.logger.info('Migrated schedule_alerts: added channel column');
    }

    // NOTE: account_metadata and schedule_alerts are created via CREATE TABLE
    // IF NOT EXISTS in createTables() (so a missing table is added to
    // existing DBs). If a NEW COLUMN is ever added to either, add an ALTER
    // guard here too, since CREATE TABLE IF NOT EXISTS will not add columns
    // to an existing table. (#99, #258)
  }

  /**
   * Look up the most recent `schedule_alerts` ledger row for one
   * `(server, alertId, scheduleId, occurrenceDate, event)` key.
   * `scheduleAlertDelivery.deliver()`'s de-duplication and reminder logic.
   *
   * @param {Object} key
   * @param {string} key.server
   * @param {string} key.alertId
   * @param {?string} key.scheduleId
   * @param {?string} key.occurrenceDate
   * @param {string} key.event
   * @param {string} [key.channel] - #295 review, H5: when given, a row
   *   recorded for this exact destination matches, and so does a legacy row
   *   recorded before per-destination keying existed (`channel IS NULL` AND
   *   `delivery = 'sent'`, #295 review round 2, M9; #297 F7 limited the
   *   wildcard to delivered rows so a NULL-channel muted/skip row can never
   *   suppress a real destination - otherwise upgrading an existing database
   *   made every previously-delivered alert resend once per destination,
   *   since no old row could ever match a specific destination key again).
   *   When `channel` is omitted entirely, any row for the event matches
   *   regardless of which destination recorded it (used by
   *   `deriveResolvedEvents`, which only needs to know an event was ever
   *   recorded at all, not on which channel).
   * @param {string} [key.delivery] - #261: only rows with this `delivery`
   *   (`deriveResolvedEvents` counts `sent` rows only, so a `muted` row never
   *   makes a destination look told). Omitted: any delivery.
   * @returns {Promise<{recordedAt:string, delivery:string}|null>}
   */
  async findLatestScheduleAlert({ server, alertId, scheduleId, occurrenceDate, event, channel, delivery }) {
    try {
      const filterChannel = channel !== undefined;
      const filterDelivery = delivery !== undefined;
      const row = this.db.prepare(`
        SELECT recorded_at AS recordedAt, delivery FROM schedule_alerts
        WHERE server = ? AND alert_id = ?
          AND schedule_id IS ? AND occurrence_date IS ? AND event = ?
          ${filterChannel ? "AND (channel IS ? OR (channel IS NULL AND delivery = 'sent'))" : ''}
          ${filterDelivery ? 'AND delivery = ?' : ''}
        ORDER BY recorded_at DESC, id DESC
        LIMIT 1
      `).get(...[server, alertId, scheduleId ?? null, occurrenceDate ?? null, event, ...(filterChannel ? [channel] : []), ...(filterDelivery ? [delivery] : [])]);
      return row || null;
    } catch (error) {
      this.logger.error('Failed to read schedule_alerts ledger', { error: error.message, server, alertId, event });
      throw error;
    }
  }

  /**
   * Occurrence dates that have a `missing` row for one schedule on or after
   * `sinceDate` (#326). The caller (deriveResolvedEvents) closes them with a
   * `resolved` when the schedule is marked completed; whether a destination
   * already got that `resolved` is decided per destination later, as usual.
   *
   * @param {Object} key
   * @param {string} key.server
   * @param {string} key.alertId
   * @param {string} key.scheduleId
   * @param {string} key.sinceDate - `YYYY-MM-DD`, inclusive lower bound on occurrence_date
   * @returns {Promise<string[]>}
   */
  async listMissingScheduleAlertOccurrences({ server, alertId, scheduleId, sinceDate }) {
    try {
      return this.db.prepare(`
        SELECT DISTINCT occurrence_date AS occurrenceDate FROM schedule_alerts
        WHERE server = ? AND alert_id = ? AND schedule_id = ? AND event = 'missing'
          AND occurrence_date IS NOT NULL AND occurrence_date >= ?
        ORDER BY occurrence_date
      `).all(server, alertId, scheduleId, sinceDate).map((r) => r.occurrenceDate);
    } catch (error) {
      this.logger.error('Failed to read schedule_alerts missing rows', { error: error.message, server, alertId });
      throw error;
    }
  }

  /**
   * Remembered skip decisions for one server (#297 F1): every `skipped` row,
   * as `{scheduleId, occurrenceDate}`. `evaluate()` takes these back in as
   * `skips` so an occurrence inferred as skipped stays skipped after a later
   * payment advances the schedule's `next_date`.
   *
   * @param {Object} key
   * @param {string} key.server
   * @returns {Promise<Array<{scheduleId:string, occurrenceDate:string}>>}
   */
  async listScheduleAlertSkips({ server }) {
    try {
      return this.db.prepare(`
        SELECT DISTINCT schedule_id AS scheduleId, occurrence_date AS occurrenceDate
        FROM schedule_alerts
        WHERE server = ? AND event = 'skipped' AND schedule_id IS NOT NULL AND occurrence_date IS NOT NULL
      `).all(server);
    } catch (error) {
      this.logger.error('Failed to read schedule_alerts skips', { error: error.message, server });
      throw error;
    }
  }

  /**
   * Record a delivered (or muted/disabled, for #261) schedule alert event.
   *
   * @param {Object} record
   * @param {string} record.server
   * @param {string} record.alertId
   * @param {?string} record.scheduleId
   * @param {?string} record.occurrenceDate
   * @param {string} record.event
   * @param {'sent'|'muted'|'disabled'|'inferred'} record.delivery
   * @param {?string} [record.channel] - #295 review, H5: the destination
   *   this row was recorded for (see `findLatestScheduleAlert`); `null`/
   *   omitted for a record with no single destination (e.g. legacy rows).
   * @returns {Promise<number>} inserted row id
   */
  async recordScheduleAlert({ server, alertId, scheduleId, occurrenceDate, event, delivery, channel }) {
    try {
      const result = this.db.prepare(`
        INSERT INTO schedule_alerts (server, alert_id, schedule_id, occurrence_date, event, delivery, recorded_at, channel)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(server, alertId, scheduleId ?? null, occurrenceDate ?? null, event, delivery, this.now().toISOString(), channel ?? null);
      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error('Failed to record schedule alert', { error: error.message, server, alertId, event });
      throw error;
    }
  }

  /**
   * Record a sync operation
   * @param {Object} record - Sync operation record
   * @param {string} record.serverName - Server name
   * @param {string} record.status - 'success' or 'failure'
   * @param {number} record.durationMs - Duration in milliseconds
   * @param {number} record.accountsProcessed - Number of accounts processed
   * @param {number} record.accountsSucceeded - Number of accounts succeeded
   * @param {number} record.accountsFailed - Number of accounts failed
   * @param {number} record.accountsSkipped - Number of accounts skipped (manual/closed)
   * @param {string} record.errorMessage - Error message if failed
   * @param {string} record.errorCode - Error code if failed
   * @param {string} record.correlationId - Correlation ID for tracking
   * @returns {number} - Inserted record ID
   */
  recordSync(record) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO sync_history (
          timestamp,
          server_name,
          status,
          duration_ms,
          accounts_processed,
          accounts_succeeded,
          accounts_failed,
          accounts_skipped,
          error_message,
          error_code,
          correlation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        this.now().toISOString(),
        record.serverName,
        record.status,
        record.durationMs || null,
        record.accountsProcessed || 0,
        record.accountsSucceeded || 0,
        record.accountsFailed || 0,
        record.accountsSkipped || 0,
        record.errorMessage || null,
        record.errorCode || null,
        record.correlationId || null
      );

      this.logger.debug('Sync operation recorded', {
        id: result.lastInsertRowid,
        serverName: record.serverName,
        status: record.status
      });

      return result.lastInsertRowid;
    } catch (error) {
      this.logger.error('Failed to record sync operation', {
        error: error.message,
        serverName: record.serverName
      });
      throw error;
    }
  }

  /**
   * Replace the stored account snapshot for a server with the current set.
   * Deletes the server's previous rows and inserts the new ones in one
   * transaction, so a removed/renamed account never lingers. (#99)
   * @param {string} serverName
   * @param {Array<{id:string,name:string,classification:string}>} accounts
   *   classification is 'syncable' | 'manual' | 'closed'
   * @returns {number} number of accounts stored
   */
  replaceAccountMetadata(serverName, accounts = []) {
    try {
      const del = this.db.prepare('DELETE FROM account_metadata WHERE server_name = ?');
      // OR REPLACE so a duplicate account id within one batch self-heals (last
      // wins) instead of throwing a PRIMARY KEY error that rolls back the whole
      // snapshot. (#99)
      const ins = this.db.prepare(`
        INSERT OR REPLACE INTO account_metadata (server_name, account_id, account_name, classification, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const now = this.now().toISOString();
      const replace = this.db.transaction((rows) => {
        del.run(serverName);
        for (const a of rows) {
          ins.run(serverName, a.id, a.name ?? null, a.classification, now);
        }
      });
      replace(accounts);
      this.logger.debug('Account metadata persisted', { serverName, count: accounts.length });
      return accounts.length;
    } catch (error) {
      this.logger.error('Failed to persist account metadata', {
        error: error.message,
        serverName
      });
      throw error;
    }
  }

  /**
   * Replace a server's payment alert snapshot with the latest #258 evaluation,
   * in ONE transaction (#260): upsert every evaluation, delete the server's
   * rows whose (alertId, scheduleId) pair is in neither `evaluations` nor
   * `runInfo.erroredPairs`, then upsert the run row as a success. Rows of
   * disabled or muted rules are kept because #258 still evaluates them. A
   * rule that threw (an errored pair) keeps its previous row. A successful
   * run with zero evaluations replaces the set (all rows go, errored pairs
   * excepted).
   * @param {string} serverName
   * @param {Array<Object>} evaluations - evaluate().evaluations
   * @param {{erroredPairs?: Array<{alertId:string, scheduleId:string}>}} [runInfo]
   * @returns {number} number of evaluations stored
   */
  replacePaymentSnapshot(serverName, evaluations = [], runInfo = {}) {
    try {
      const erroredPairs = runInfo.erroredPairs || [];
      const pairKey = (alertId, scheduleId) => JSON.stringify([alertId, scheduleId]);
      const keep = new Set(erroredPairs.map((p) => pairKey(p.alertId, p.scheduleId)));
      for (const e of evaluations) keep.add(pairKey(e.alertId, e.scheduleId));
      const now = this.now().toISOString();

      const upsert = this.db.prepare(`
        INSERT OR REPLACE INTO payment_alert_status (
          server, alert_id, schedule_id, name, cadence_text, account, payee,
          expected_amount, expected_min, expected_max, next_date, deadline,
          state, occurrences_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const listPairs = this.db.prepare('SELECT alert_id, schedule_id FROM payment_alert_status WHERE server = ?');
      const delRow = this.db.prepare('DELETE FROM payment_alert_status WHERE server = ? AND alert_id = ? AND schedule_id = ?');
      const upsertRun = this.db.prepare(`
        INSERT INTO payment_alert_run (server, evaluated_at, ok, error_code, rules_errored, last_success_at)
        VALUES (?, ?, 1, NULL, ?, ?)
        ON CONFLICT(server) DO UPDATE SET
          evaluated_at = excluded.evaluated_at, ok = 1, error_code = NULL,
          rules_errored = excluded.rules_errored, last_success_at = excluded.last_success_at
      `);

      const replace = this.db.transaction(() => {
        for (const e of evaluations) {
          const amount = e.expectedAmount;
          let cents = null;
          let min = null;
          let max = null;
          if (typeof amount === 'number') {
            cents = amount;
          } else if (amount && typeof amount === 'object') {
            min = Math.min(amount.num1, amount.num2);
            max = Math.max(amount.num1, amount.num2);
          }
          upsert.run(
            serverName, e.alertId, e.scheduleId, e.name ?? null, e.cadenceText ?? null,
            e.account ?? null, e.payee ?? null, cents, min, max, e.nextDate ?? null,
            e.deadline ?? null, e.state, JSON.stringify(e.occurrences || []), now
          );
        }
        for (const row of listPairs.all(serverName)) {
          if (!keep.has(pairKey(row.alert_id, row.schedule_id))) {
            delRow.run(serverName, row.alert_id, row.schedule_id);
          }
        }
        upsertRun.run(serverName, now, erroredPairs.length, now);
      });
      replace();
      this.logger.debug('Payment snapshot persisted', { serverName, count: evaluations.length });
      return evaluations.length;
    } catch (error) {
      this.logger.error('Failed to persist payment snapshot', { error: error.message, serverName });
      throw error;
    }
  }

  /**
   * Record a failed evaluation (#260): upserts only the run row (ok = 0, the
   * error code, evaluated_at). Item rows, rules_errored and last_success_at
   * are untouched, so the dashboard keeps the last good snapshot.
   * @param {string} serverName
   * @param {string} errorCode - one of the closed list in scheduleAlertsStep
   */
  recordPaymentRunFailure(serverName, errorCode) {
    try {
      this.db.prepare(`
        INSERT INTO payment_alert_run (server, evaluated_at, ok, error_code, rules_errored, last_success_at)
        VALUES (?, ?, 0, ?, 0, NULL)
        ON CONFLICT(server) DO UPDATE SET
          evaluated_at = excluded.evaluated_at, ok = 0, error_code = excluded.error_code
      `).run(serverName, this.now().toISOString(), errorCode);
    } catch (error) {
      this.logger.error('Failed to record payment run failure', { error: error.message, serverName });
      throw error;
    }
  }

  /**
   * Delete both payment snapshot tables' rows for a server in one transaction
   * (#260), used when the server's scheduleAlerts block is removed.
   * @param {string} serverName
   */
  deletePaymentSnapshot(serverName) {
    try {
      const delItems = this.db.prepare('DELETE FROM payment_alert_status WHERE server = ?');
      const delRun = this.db.prepare('DELETE FROM payment_alert_run WHERE server = ?');
      this.db.transaction((s) => {
        delItems.run(s);
        delRun.run(s);
      })(serverName);
    } catch (error) {
      this.logger.error('Failed to delete payment snapshot', { error: error.message, serverName });
      throw error;
    }
  }

  /**
   * Read a server's stored payment snapshot (#260).
   * @param {string} serverName
   * @returns {{items: Array<Object>, run: Object|null}} `run` is null before
   *   the first evaluation. `expectedAmount` is cents, null, or
   *   `{num1, num2}` (min, max) for a range.
   */
  getPaymentSnapshot(serverName) {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM payment_alert_status WHERE server = ? ORDER BY alert_id, schedule_id
      `).all(serverName);
      const items = rows.map((r) => ({
        alertId: r.alert_id,
        scheduleId: r.schedule_id,
        name: r.name,
        cadenceText: r.cadence_text,
        account: r.account,
        payee: r.payee,
        expectedAmount: r.expected_min != null
          ? { num1: r.expected_min, num2: r.expected_max }
          : r.expected_amount,
        nextDate: r.next_date,
        deadline: r.deadline,
        state: r.state,
        occurrences: JSON.parse(r.occurrences_json)
      }));
      const runRow = this.db.prepare('SELECT * FROM payment_alert_run WHERE server = ?').get(serverName);
      const run = runRow ? {
        at: runRow.evaluated_at,
        ok: runRow.ok === 1,
        errorCode: runRow.error_code,
        lastSuccessAt: runRow.last_success_at,
        rulesErrored: runRow.rules_errored
      } : null;
      return { items, run };
    } catch (error) {
      this.logger.error('Failed to read payment snapshot', { error: error.message, serverName });
      throw error;
    }
  }

  /**
   * Latest DELIVERED alert per (alertId, scheduleId) for a server (#260),
   * computed at request time from the schedule_alerts ledger because the
   * snapshot is saved before the ledger is written for the same sync. Includes
   * "resolved" notices; null once the last alert is older than the ledger
   * retention. `inferred` rows (#297 skips) are not alerts.
   * @param {string} serverName
   * @returns {Map<string, string>} key is JSON `[alertId, scheduleId]`, value an ISO time
   */
  getLastSentAlerts(serverName) {
    try {
      const rows = this.db.prepare(`
        SELECT alert_id, schedule_id, MAX(recorded_at) AS last_sent_at
        FROM schedule_alerts
        WHERE server = ? AND delivery = 'sent'
        GROUP BY alert_id, schedule_id
      `).all(serverName);
      return new Map(rows.map((r) => [JSON.stringify([r.alert_id, r.schedule_id]), r.last_sent_at]));
    } catch (error) {
      this.logger.error('Failed to read last sent alerts', { error: error.message, serverName });
      throw error;
    }
  }

  /**
   * Get the stored account snapshots for every server, grouped by server.
   * @returns {Array<{server:string, accounts:Array}>}
   */
  getAllAccountMetadata() {
    try {
      const rows = this.db.prepare(`
        SELECT server_name AS server, account_id AS id, account_name AS name, classification, updated_at AS updatedAt
        FROM account_metadata ORDER BY server_name, COALESCE(account_name, account_id)
      `).all();
      const byServer = new Map();
      for (const r of rows) {
        if (!byServer.has(r.server)) byServer.set(r.server, []);
        byServer.get(r.server).push({ id: r.id, name: r.name, classification: r.classification, updatedAt: r.updatedAt });
      }
      return [...byServer.entries()].map(([server, accounts]) => ({ server, accounts }));
    } catch (error) {
      this.logger.error('Failed to read all account metadata', { error: error.message });
      throw error;
    }
  }

  /**
   * Get sync history with filters
   * @param {Object} filters - Query filters
   * @param {string} filters.serverName - Filter by server name
   * @param {string} filters.status - Filter by status
   * @param {number} filters.days - Number of days to look back
   * @param {number} filters.limit - Maximum number of records to return
   * @param {number} filters.offset - Offset for pagination
   * @returns {Array} - Array of sync records
   */
  getHistory(filters = {}) {
    try {
      let query = 'SELECT * FROM sync_history WHERE 1=1';
      const params = [];

      if (filters.serverName) {
        query += ' AND server_name = ?';
        params.push(filters.serverName);
      }

      if (filters.status) {
        query += ' AND status = ?';
        params.push(filters.status);
      }

      if (filters.days) {
        const cutoffDate = this.now();
        cutoffDate.setDate(cutoffDate.getDate() - filters.days);
        query += ' AND timestamp >= ?';
        params.push(cutoffDate.toISOString());
      }

      query += ' ORDER BY timestamp DESC';

      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
      }

      if (filters.offset) {
        query += ' OFFSET ?';
        params.push(filters.offset);
      }

      const stmt = this.db.prepare(query);
      const records = stmt.all(...params);

      this.logger.debug('Retrieved sync history', {
        count: records.length,
        filters
      });

      return records;
    } catch (error) {
      this.logger.error('Failed to retrieve sync history', {
        error: error.message,
        filters
      });
      throw error;
    }
  }

  /**
   * Get sync statistics
   * @param {Object} filters - Query filters
   * @param {string} filters.serverName - Filter by server name
   * @param {number} filters.days - Number of days to analyze
   * @returns {Object} - Statistics object
   */
  getStatistics(filters = {}) {
    try {
      let query = `
        SELECT 
          COUNT(*) as total_syncs,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_syncs,
          SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) as failed_syncs,
          AVG(duration_ms) as avg_duration_ms,
          MIN(duration_ms) as min_duration_ms,
          MAX(duration_ms) as max_duration_ms,
          SUM(accounts_processed) as total_accounts_processed,
          MIN(timestamp) as earliest_sync,
          MAX(timestamp) as latest_sync
        FROM sync_history
        WHERE 1=1
      `;
      const params = [];

      if (filters.serverName) {
        query += ' AND server_name = ?';
        params.push(filters.serverName);
      }

      if (filters.days) {
        const cutoffDate = this.now();
        cutoffDate.setDate(cutoffDate.getDate() - filters.days);
        query += ' AND timestamp >= ?';
        params.push(cutoffDate.toISOString());
      }

      const stmt = this.db.prepare(query);
      const stats = stmt.get(...params);

      // Calculate success rate
      if (stats.total_syncs > 0) {
        stats.success_rate = ((stats.successful_syncs / stats.total_syncs) * 100).toFixed(2) + '%';
      } else {
        stats.success_rate = 'N/A';
      }

      this.logger.debug('Retrieved sync statistics', {
        totalSyncs: stats.total_syncs,
        filters
      });

      return stats;
    } catch (error) {
      this.logger.error('Failed to retrieve sync statistics', {
        error: error.message,
        filters
      });
      throw error;
    }
  }

  /**
   * Get statistics per server
   * @param {number} days - Number of days to analyze
   * @returns {Array} - Array of per-server statistics
   */
  getStatisticsByServer(days = null) {
    try {
      let query = `
        SELECT 
          server_name,
          COUNT(*) as total_syncs,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_syncs,
          SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) as failed_syncs,
          AVG(duration_ms) as avg_duration_ms,
          MAX(timestamp) as last_sync
        FROM sync_history
        WHERE 1=1
      `;
      const params = [];

      if (days) {
        const cutoffDate = this.now();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        query += ' AND timestamp >= ?';
        params.push(cutoffDate.toISOString());
      }

      query += ' GROUP BY server_name ORDER BY server_name';

      const stmt = this.db.prepare(query);
      const stats = stmt.all(...params);

      // Calculate success rate for each server
      stats.forEach(stat => {
        if (stat.total_syncs > 0) {
          stat.success_rate = ((stat.successful_syncs / stat.total_syncs) * 100).toFixed(2) + '%';
        } else {
          stat.success_rate = 'N/A';
        }
      });

      this.logger.debug('Retrieved per-server statistics', {
        serverCount: stats.length,
        days
      });

      return stats;
    } catch (error) {
      this.logger.error('Failed to retrieve per-server statistics', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get recent errors
   * @param {number} limit - Maximum number of errors to return
   * @returns {Array} - Array of error records
   */
  getRecentErrors(limit = 10) {
    try {
      const stmt = this.db.prepare(`
        SELECT *
        FROM sync_history
        WHERE status = 'failure'
        ORDER BY timestamp DESC
        LIMIT ?
      `);

      const errors = stmt.all(limit);

      this.logger.debug('Retrieved recent errors', {
        count: errors.length,
        limit
      });

      return errors;
    } catch (error) {
      this.logger.error('Failed to retrieve recent errors', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get last sync for a server
   * @param {string} serverName - Server name
   * @returns {Object|null} - Last sync record or null
   */
  getLastSync(serverName) {
    try {
      const stmt = this.db.prepare(`
        SELECT *
        FROM sync_history
        WHERE server_name = ?
        ORDER BY timestamp DESC
        LIMIT 1
      `);

      const record = stmt.get(serverName);

      this.logger.debug('Retrieved last sync', {
        serverName,
        found: !!record
      });

      return record || null;
    } catch (error) {
      this.logger.error('Failed to retrieve last sync', {
        error: error.message,
        serverName
      });
      throw error;
    }
  }

  /**
   * Get all unique server names from sync history with metadata
   * @returns {Array} - Array of {server_name, sync_count, last_sync}
   */
  getAllServerNames() {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          server_name,
          COUNT(*) as sync_count,
          MAX(timestamp) as last_sync
        FROM sync_history
        GROUP BY server_name
        ORDER BY server_name
      `);

      const servers = stmt.all();

      this.logger.debug('Retrieved all server names from history', {
        count: servers.length
      });

      return servers;
    } catch (error) {
      this.logger.error('Failed to retrieve server names', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get recent syncs for dashboard display
   * @param {number} limit - Maximum number of records to return
   * @returns {Array} - Array of sync records formatted for dashboard
   */
  getRecentSyncs(limit = 50) {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          id,
          timestamp,
          server_name as serverName,
          status,
          duration_ms as duration,
          accounts_processed as accountsProcessed,
          accounts_succeeded as accountsSucceeded,
          accounts_failed as accountsFailed,
          accounts_skipped as accountsSkipped,
          error_message as errorMessage,
          error_code as errorCode,
          correlation_id as correlationId
        FROM sync_history
        ORDER BY timestamp DESC
        LIMIT ?
      `);

      const records = stmt.all(limit);

      this.logger.debug('Retrieved recent syncs for dashboard', {
        count: records.length,
        limit
      });

      return records;
    } catch (error) {
      this.logger.error('Failed to retrieve recent syncs', {
        error: error.message,
        limit
      });
      throw error;
    }
  }

  /**
   * Clean up old records based on retention policy
   * @returns {number} - Number of records deleted
   */
  cleanup() {
    try {
      const cutoffDate = this.now();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

      const stmt = this.db.prepare(`
        DELETE FROM sync_history
        WHERE timestamp < ?
      `);

      const result = stmt.run(cutoffDate.toISOString());

      if (result.changes > 0) {
        this.logger.info('Cleaned up old sync history records', {
          deletedRecords: result.changes,
          retentionDays: this.retentionDays,
          cutoffDate: cutoffDate.toISOString()
        });
      }

      // schedule_alerts (#258) is purged at max(retentionDays, 120) days, on
      // its own recorded_at column, independently of sync_history's own
      // retentionDays. 120 is longer than the 90-day evaluation look-back
      // cap, so the ledger never forgets an occurrence that could still be
      // re-evaluated (which would otherwise re-send a "missing" alert).
      const scheduleAlertsRetentionDays = Math.max(this.retentionDays, 120);
      const scheduleAlertsCutoff = this.now();
      scheduleAlertsCutoff.setDate(scheduleAlertsCutoff.getDate() - scheduleAlertsRetentionDays);
      // #261: a mute can outlast that window (up to 365 days), so the muted
      // rows of an alert whose override still has muted_until set are kept for
      // the summary; they are purged normally once the mute fields are cleared.
      // Stale mutes are expired first (UTC: cleanup has no configured zone).
      this.expireStaleMutes({ timezone: 'UTC' });
      const scheduleAlertsResult = this.db.prepare(`
        DELETE FROM schedule_alerts
        WHERE recorded_at < ?
          AND NOT (delivery = 'muted' AND EXISTS (
            SELECT 1 FROM payment_alert_override o
            WHERE o.server = schedule_alerts.server
              AND o.alert_id = schedule_alerts.alert_id
              AND o.muted_until IS NOT NULL))
      `).run(scheduleAlertsCutoff.toISOString());

      if (scheduleAlertsResult.changes > 0) {
        this.logger.info('Cleaned up old schedule alert ledger rows', {
          deletedRecords: scheduleAlertsResult.changes,
          retentionDays: scheduleAlertsRetentionDays,
          cutoffDate: scheduleAlertsCutoff.toISOString()
        });
      }

      // config_audit (#259) is purged by age at retentionDays, like sync_history.
      const auditResult = this.db.prepare('DELETE FROM config_audit WHERE at < ?')
        .run(cutoffDate.toISOString());
      if (auditResult.changes > 0) {
        this.logger.info('Cleaned up old configuration audit rows', {
          deletedRecords: auditResult.changes,
          retentionDays: this.retentionDays
        });
      }

      // Vacuum database to reclaim space
      this.db.exec('VACUUM');

      return result.changes;
    } catch (error) {
      this.logger.error('Failed to clean up old records', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * True when any table resetServerHistory clears has a row for this name.
   * sync_history ages out after 90 days but the other tables do not, so a
   * retired server can still be known without any history rows. (#259)
   * @param {string} serverName
   * @returns {boolean}
   */
  hasServerData(serverName) {
    const row = this.db.prepare(`
      SELECT EXISTS (SELECT 1 FROM sync_history WHERE server_name = @s)
          OR EXISTS (SELECT 1 FROM account_metadata WHERE server_name = @s)
          OR EXISTS (SELECT 1 FROM schedule_alerts WHERE server = @s)
          OR EXISTS (SELECT 1 FROM payment_alert_status WHERE server = @s)
          OR EXISTS (SELECT 1 FROM payment_alert_run WHERE server = @s)
          OR EXISTS (SELECT 1 FROM payment_alert_override WHERE server = @s) AS known
    `).get({ s: serverName });
    return row.known === 1;
  }

  /**
   * Reset sync history for a specific server
   * @param {string} serverName - Name of the server
   * @param {{remoteAddr?: string}} [options] - recorded on the history_reset audit row (#259)
   */
  async resetServerHistory(serverName, { remoteAddr } = {}) {
    try {
      // Clear sync history, the dashboard account snapshot and the schedule
      // alert ledger atomically, so a reset never leaves orphaned account
      // badges, half-cleared state, or a ledger that still blocks a "missing"
      // alert this reset was meant to let re-fire. (#99, #258)
      const delHistory = this.db.prepare('DELETE FROM sync_history WHERE server_name = ?');
      const delMeta = this.db.prepare('DELETE FROM account_metadata WHERE server_name = ?');
      const delScheduleAlerts = this.db.prepare('DELETE FROM schedule_alerts WHERE server = ?');
      const delPaymentItems = this.db.prepare('DELETE FROM payment_alert_status WHERE server = ?');
      const delOverrides = this.db.prepare('DELETE FROM payment_alert_override WHERE server = ?');
      const delPaymentRun = this.db.prepare('DELETE FROM payment_alert_run WHERE server = ?');
      // config_audit is deliberately NOT deleted (#259): a reset must not erase
      // the record of earlier configuration changes. It appends one
      // history_reset row, in this transaction, with the deleted counts.
      const reset = this.db.transaction((s) => {
        const r = delHistory.run(s);
        const deleted = {
          sync_history: r.changes,
          account_metadata: delMeta.run(s).changes,
          schedule_alerts: delScheduleAlerts.run(s).changes,
          payment_alert_status: delPaymentItems.run(s).changes,
          payment_alert_run: delPaymentRun.run(s).changes,
          payment_alert_override: delOverrides.run(s).changes
        };
        this.insertConfigAudit({
          server: s, remoteAddr, action: 'history_reset', target: null, changes: { deleted }
        });
        return r;
      });
      const result = reset(serverName);

      this.logger.info('Sync history reset for server', {
        serverName,
        deletedRows: result.changes
      });

      return { success: true, deletedRows: result.changes };
    } catch (error) {
      this.logger.error('Failed to reset server history', {
        serverName,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Reset all sync history
   * @param {{remoteAddr?: string}} [options] - recorded on the history_reset audit row (#259)
   */
  async resetAllHistory({ remoteAddr } = {}) {
    try {
      // Clear all sync history, all account snapshots and the whole schedule
      // alert ledger atomically. (#99, #258)
      const delHistory = this.db.prepare('DELETE FROM sync_history');
      const delMeta = this.db.prepare('DELETE FROM account_metadata');
      const delScheduleAlerts = this.db.prepare('DELETE FROM schedule_alerts');
      const delPaymentItems = this.db.prepare('DELETE FROM payment_alert_status');
      const delPaymentRun = this.db.prepare('DELETE FROM payment_alert_run');
      const delOverrides = this.db.prepare('DELETE FROM payment_alert_override');
      // config_audit is kept and gets one history_reset row (see resetServerHistory).
      const reset = this.db.transaction(() => {
        const r = delHistory.run();
        const deleted = {
          sync_history: r.changes,
          account_metadata: delMeta.run().changes,
          schedule_alerts: delScheduleAlerts.run().changes,
          payment_alert_status: delPaymentItems.run().changes,
          payment_alert_run: delPaymentRun.run().changes,
          payment_alert_override: delOverrides.run().changes
        };
        this.insertConfigAudit({
          server: null, remoteAddr, action: 'history_reset', target: null, changes: { deleted }
        });
        return r;
      });
      const result = reset();

      this.logger.info('All sync history reset', {
        deletedRows: result.changes
      });

      return { success: true, deletedRows: result.changes };
    } catch (error) {
      this.logger.error('Failed to reset all history', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Insert one config_audit row (no logging). Redacts and caps `changes`.
   * Used by recordConfigChange() and, inside their transactions, by the resets.
   */
  insertConfigAudit({ server, remoteAddr, action, target, changes }) {
    return this.db.prepare(`
      INSERT INTO config_audit (at, server, remote_addr, action, target, changes_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      this.now().toISOString(),
      server ?? null,
      remoteAddr ?? null,
      action,
      target ?? null,
      serializeAuditChanges(changes)
    );
  }

  /**
   * Record one configuration change (#259). Called by the config routes after a
   * successful write only. `changes` is { field: [before, after] } with changed
   * fields only; secrets are redacted and the row is capped at 8 KB.
   * Never logs values: INFO carries the action and target.
   * @param {{server?: string, remoteAddr?: string, action: string, target?: string, changes?: Object}} entry
   * @returns {number} the new row id
   */
  recordConfigChange({ server, remoteAddr, action, target, changes } = {}) {
    if (typeof action !== 'string' || action === '') {
      throw new Error('recordConfigChange requires an action');
    }
    const result = this.insertConfigAudit({ server, remoteAddr, action, target, changes });
    this.logger.info('Configuration change recorded', { action, target: target ?? null });
    return Number(result.lastInsertRowid);
  }

  /**
   * Configuration changes, newest first. Throws on a database error.
   * @param {{limit?: number}} [options]
   * @returns {Array<{at: string, server: ?string, remote_addr: ?string, action: string, target: ?string, changes: Object}>}
   */
  getConfigAudit({ limit = 50 } = {}) {
    const rows = this.db.prepare(`
      SELECT at, server, remote_addr, action, target, changes_json
      FROM config_audit
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
    return rows.map(row => {
      let changes = {};
      try {
        changes = JSON.parse(row.changes_json);
      } catch { /* a corrupt row still lists, with no changes */ }
      return {
        at: row.at,
        server: row.server,
        remote_addr: row.remote_addr,
        action: row.action,
        target: row.target,
        changes
      };
    });
  }

  // ---- Payment alert overrides (#261) -------------------------------------

  _overrideFromRow(row) {
    return row ? {
      server: row.server,
      alertId: row.alert_id,
      enabled: row.enabled === 1,
      mutedFrom: row.muted_from,
      mutedUntil: row.muted_until,
      reason: row.reason,
      updatedAt: row.updated_at
    } : null;
  }

  /**
   * @param {string} server
   * @param {string} alertId
   * @returns {?{server:string, alertId:string, enabled:boolean, mutedFrom:?string, mutedUntil:?string, reason:?string, updatedAt:string}}
   */
  getOverride(server, alertId) {
    return this._overrideFromRow(this.db.prepare(
      'SELECT * FROM payment_alert_override WHERE server = ? AND alert_id = ?'
    ).get(server, alertId));
  }

  /**
   * Replace the override of one rule. A state with the rule enabled and no
   * mute is the default, so the row is deleted instead of stored. Returns the
   * stored override, or null when it was normalised away.
   */
  setOverride({ server, alertId, enabled = true, mutedFrom = null, mutedUntil = null, reason = null }) {
    if (enabled !== false && !mutedUntil) {
      this.deleteOverride(server, alertId);
      return null;
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO payment_alert_override
        (server, alert_id, enabled, muted_from, muted_until, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      server, alertId, enabled === false ? 0 : 1,
      mutedUntil ? mutedFrom : null, mutedUntil || null, mutedUntil ? reason : null,
      this.now().toISOString()
    );
    return this.getOverride(server, alertId);
  }

  /** @returns {boolean} true when a row was removed */
  deleteOverride(server, alertId) {
    return this.db.prepare(
      'DELETE FROM payment_alert_override WHERE server = ? AND alert_id = ?'
    ).run(server, alertId).changes > 0;
  }

  /** Every override (of one server when given), ordered by server then alert id. */
  listOverrides(server) {
    const rows = server === undefined
      ? this.db.prepare('SELECT * FROM payment_alert_override ORDER BY server, alert_id').all()
      : this.db.prepare('SELECT * FROM payment_alert_override WHERE server = ? ORDER BY server, alert_id').all(server);
    return rows.map(row => this._overrideFromRow(row));
  }

  /**
   * The `muted` ledger rows of one alert, optionally within [since, until).
   * @param {{server:string, alertId:string, since?:string, until?:Date}} q
   * @returns {Array<{scheduleId:?string, occurrenceDate:?string, event:string, channel:?string, recordedAt:string}>}
   */
  listMutedRows({ server, alertId, since, until }) {
    const clauses = ["server = ?", "alert_id = ?", "delivery = 'muted'"];
    const args = [server, alertId];
    if (since) { clauses.push('recorded_at >= ?'); args.push(since); }
    if (until) { clauses.push('recorded_at < ?'); args.push(until.toISOString()); }
    return this.db.prepare(`
      SELECT schedule_id AS scheduleId, occurrence_date AS occurrenceDate, event, channel, recorded_at AS recordedAt
      FROM schedule_alerts WHERE ${clauses.join(' AND ')} ORDER BY id
    `).all(...args);
  }

  /** Delete the alert's `muted` rows (since a time when given). @returns {number} */
  deleteMutedRows({ server, alertId, since }) {
    return since
      ? this.db.prepare("DELETE FROM schedule_alerts WHERE server = ? AND alert_id = ? AND delivery = 'muted' AND recorded_at >= ?").run(server, alertId, since).changes
      : this.db.prepare("DELETE FROM schedule_alerts WHERE server = ? AND alert_id = ? AND delivery = 'muted'").run(server, alertId).changes;
  }

  /**
   * Apply one operator change to an override, its held-back muted rows and its
   * audit row in a single transaction (#261), so a failing audit insert leaves
   * nothing changed (same pattern as resetServerHistory).
   * @param {Object} change
   * @param {string} change.server
   * @param {string} change.alertId
   * @param {?Object} change.override - the override to store, or null to delete it
   * @param {boolean} [change.dropMutedRows] - delete the alert's muted rows
   * @param {string} [change.mutedSince] - limit that delete to rows since this time
   * @param {string} [change.remoteAddr]
   * @param {(stored: ?Object) => Object} change.auditChanges - the audit `changes`, from the stored override
   * @returns {?Object} the stored override (null when deleted or normalised away)
   */
  applyOverrideChange({ server, alertId, override, dropMutedRows = false, mutedSince, remoteAddr, auditChanges }) {
    const apply = this.db.transaction(() => {
      if (dropMutedRows) this.deleteMutedRows({ server, alertId, since: mutedSince });
      let stored = null;
      if (override) stored = this.setOverride(override);
      else this.deleteOverride(server, alertId);
      const changes = auditChanges(stored);
      if (changes && Object.keys(changes).length > 0) {
        this.insertConfigAudit({ server, remoteAddr, action: 'payment_alert_state', target: alertId, changes });
      }
      return stored;
    });
    const stored = apply();
    this.logger.info('Configuration change recorded', { action: 'payment_alert_state', target: alertId });
    return stored;
  }

  /** Delete the muted rows of one destination key. @returns {number} */
  deleteMutedRow({ server, alertId, scheduleId, occurrenceDate, event, channel }) {
    return this.db.prepare(`
      DELETE FROM schedule_alerts
      WHERE server = ? AND alert_id = ? AND schedule_id IS ? AND occurrence_date IS ?
        AND event = ? AND channel IS ? AND delivery = 'muted'
    `).run(server, alertId, scheduleId ?? null, occurrenceDate ?? null, event, channel ?? null).changes;
  }

  /**
   * Expire mutes whose summary never went out (#261): at the end of the
   * `mutedUntil` day plus 7 days, clear the reason, the mute fields and the
   * alert's muted rows, with a WARN, so a failing or deferred summary cannot
   * keep the free-text reason forever. Covers every override of the server
   * (all servers when none is given): enabled, switched off, config-locked or
   * orphaned. The reason is never logged.
   *
   * @param {{server?:string, timezone?:string, now?:Date}} [options]
   * @returns {Array<{server:string, alertId:string}>} the expired overrides
   */
  expireStaleMutes({ server, timezone = 'UTC', now } = {}) {
    const at = (now || this.now()).getTime();
    const expired = [];
    const run = this.db.transaction(() => {
      for (const o of this.listOverrides(server)) {
        if (!o.mutedUntil) continue;
        const expiry = moment(muteEndsAt(o.mutedUntil, timezone)).tz(timezone).add(7, 'days');
        if (at < expiry.valueOf()) continue;
        this.deleteMutedRows({ server: o.server, alertId: o.alertId });
        this.setOverride({ server: o.server, alertId: o.alertId, enabled: o.enabled });
        expired.push({ server: o.server, alertId: o.alertId });
        this.logger.warn('Mute expired without a summary; reason and muted rows cleared', {
          server: o.server, alertId: o.alertId, mutedUntil: o.mutedUntil
        });
      }
    });
    run();
    return expired;
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      try {
        this.db.close();
        this.logger.info('Sync history database closed');
        this.db = null;
      } catch (error) {
        this.logger.error('Error closing sync history database', {
          error: error.message
        });
        throw error;
      }
    }
  }

}

module.exports = { SyncHistoryService, CONFIG_AUDIT_REDACT_SUBSTRINGS };
