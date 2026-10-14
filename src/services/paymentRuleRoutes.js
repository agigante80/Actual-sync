/**
 * Dashboard routes for payment alert rules, the schedule snapshot and the
 * message preview (#262). Registered by HealthCheckService; every handler
 * takes the service as `svc` so the clock, logger, stores and auth chain stay
 * the service's own.
 *
 * Lookups are by `Array.find` / `Map`, never by object index, so `__proto__`
 * and `constructor` are plain unknown names. No response carries exception
 * text: errors are logged and answered with a fixed message.
 */
'use strict';

const { getRules, mergeRules, normalizeRule, DEFAULT_GRACE_DAYS, DEFAULT_EARLY_DAYS } = require('../lib/scheduleAlertRules');
const { validateScheduleAlert } = require('../lib/scheduleAlertValidation');
const {
  DEFAULT_TEMPLATES, VARIABLES, resolveChannels, buildPreviewContext, previewRule, PREVIEW_EVENTS
} = require('../lib/scheduleAlertDelivery');
const { TemplateValidationError } = require('../lib/templateRenderer');

const MAX_DASHBOARD_RULES = 200;
const ALERT_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const TEST_SEND_LIMIT = 5;
const TEST_SEND_WINDOW_MS = 60 * 1000;

/**
 * The rules that actually run for a server: config rules plus dashboard rules
 * that no config rule supersedes. No block means nothing runs.
 * @returns {Object[]} merged entries (see mergeRules)
 */
function activeRules(svc, server) {
  const block = server.scheduleAlerts;
  if (!block) return [];
  const rows = svc.syncHistory.listRules(server.name);
  return mergeRules(getRules(block), rows, block).filter((rule) => !rule.superseded);
}

/** Stable JSON: keys sorted at every level, so key order never reads as a change. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `{field: [before, after]}` for the fields that differ between two definitions. */
function diffDefinitions(before, after) {
  const changes = {};
  const fields = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const field of fields) {
    const was = before && field in before ? before[field] : null;
    const is = after && field in after ? after[field] : null;
    if (canonical(was) !== canonical(is)) changes[field] = [was, is];
  }
  return changes;
}

function notificationsConfig(svc) {
  return (svc.notificationService && svc.notificationService.config) || {};
}

/** Answer a failed validation with the closed 400 body for its code. */
function sendInvalid(res, result) {
  if (result.code === 'invalid_template') {
    const { template, token, line, reason } = result.template;
    return res.status(400).json({ error: 'invalid_template', template, token, line, reason });
  }
  if (result.code === 'invalid_rule') {
    return res.status(400).json({ error: 'invalid_rule', details: result.errors });
  }
  return res.status(400).json({ error: result.code });
}

function publicRule(entry, validation) {
  return {
    id: entry.id,
    source: entry.source,
    superseded: entry.superseded,
    invalid: !validation.valid,
    errors: validation.errors,
    definition: entry.definition,
    updatedAt: entry.updatedAt
  };
}

/**
 * Validate a rule the way the sync treats it: a dashboard rule in the
 * schema-only mode the sync filter uses, a config rule the way startup checks
 * it (resolved channels only), so the list never flags a config rule the sync
 * evaluates (#262 review F1b).
 */
function listingValidation(svc, entry, server) {
  const dashboard = entry.source === 'dashboard';
  const result = validateScheduleAlert(entry.definition, {
    block: server.scheduleAlerts || undefined,
    notificationsConfig: notificationsConfig(svc),
    dashboard,
    schemaOnly: dashboard,
    skipSchema: !dashboard
  });
  const errors = result.errors.slice();
  if (result.template) errors.push({ path: `/templates/${result.template.template}`, message: result.template.message });
  return { valid: result.valid, errors };
}

function registerPaymentRuleRoutes(svc) {
  const sendTimes = [];

  const findServer = (req, res) => {
    const servers = svc.getServers ? (svc.getServers() || []) : [];
    const server = servers.find((s) => s.name === req.params.server);
    if (!server) {
      res.status(404).json({ error: 'server_not_found' });
      return null;
    }
    return server;
  };
  const noHistory = (res) => res.status(503).json({ error: 'Sync history not available' });
  const validAlertId = (id) => ALERT_ID_PATTERN.test(id) && id !== '__proto__' && id !== 'constructor';

  // Schedules the editor can pick, plus the server constants the validator uses.
  svc.app.get('/api/dashboard/payment-schedules/:server', svc.dashboardAuth(), (req, res) => {
    if (!svc.syncHistory) return noHistory(res);
    try {
      const server = findServer(req, res);
      if (!server) return undefined;
      const block = server.scheduleAlerts || null;
      const snapshot = svc.syncHistory.getScheduleSnapshot(server.name);
      return res.json({
        configured: Boolean(block),
        capturedAt: block ? snapshot.capturedAt : null,
        schedules: block ? snapshot.schedules : [],
        defaults: {
          graceDays: DEFAULT_GRACE_DAYS,
          earlyDays: DEFAULT_EARLY_DAYS,
          templates: DEFAULT_TEMPLATES,
          blockTemplates: (block && block.templates) || {},
          variables: Object.fromEntries(PREVIEW_EVENTS.map((event) => [event, VARIABLES]))
        }
      });
    } catch (error) {
      svc.logger.error('Failed to get payment schedules', { error: error.message });
      return res.status(500).json({ error: 'Failed to retrieve payment rules' });
    }
  });

  svc.app.get('/api/dashboard/payment-rules/:server', svc.dashboardAuth(), (req, res) => {
    if (!svc.syncHistory) return noHistory(res);
    try {
      const server = findServer(req, res);
      if (!server) return undefined;
      const block = server.scheduleAlerts || null;
      const rows = svc.syncHistory.listRules(server.name);
      const entries = block
        ? mergeRules(getRules(block), rows, block)
        : mergeRules([], rows, {}).map((entry) => ({ ...entry, superseded: false }));
      return res.json({
        configured: Boolean(block),
        rules: entries.map((entry) => publicRule(entry, listingValidation(svc, entry, server)))
      });
    } catch (error) {
      svc.logger.error('Failed to list payment rules', { error: error.message });
      return res.status(500).json({ error: 'Failed to retrieve payment rules' });
    }
  });

  const createdEntry = (server, row) => {
    const rule = normalizeRule(row.definition, server.scheduleAlerts);
    return { ...rule, source: 'dashboard', superseded: false, definition: row.definition, updatedAt: row.updatedAt };
  };

  svc.configRouter.post('/api/dashboard/payment-rules/:server', ...svc.configWrite(), (req, res) => {
    if (!svc.syncHistory) return noHistory(res);
    try {
      const server = findServer(req, res);
      if (!server) return undefined;
      const block = server.scheduleAlerts;
      if (!block) return res.status(409).json({ error: 'alerts_not_configured' });

      const definition = req.body;
      const result = validateScheduleAlert(definition, {
        block, notificationsConfig: notificationsConfig(svc), dashboard: true
      });
      if (!result.valid) return sendInvalid(res, result);

      const id = definition.id;
      if (getRules(block).some((rule) => rule.id === id)) return res.status(409).json({ error: 'id_in_config' });

      const outcome = svc.syncHistory.runInTransaction(() => {
        if (svc.syncHistory.getRule(server.name, id)) return { error: 'duplicate_id' };
        if (svc.syncHistory.countRules(server.name) >= MAX_DASHBOARD_RULES) return { error: 'too_many_rules' };
        const row = svc.syncHistory.insertRule(server.name, id, definition);
        svc.syncHistory.recordConfigChange({
          server: server.name,
          remoteAddr: req.ip,
          action: 'payment_alert_rule_create',
          target: id,
          changes: diffDefinitions(null, definition)
        });
        return { row };
      });
      if (outcome.error) return res.status(409).json({ error: outcome.error });
      const entry = createdEntry(server, outcome.row);
      return res.status(201).json({ rule: publicRule(entry, { valid: true, errors: [] }) });
    } catch (error) {
      svc.logger.error('Failed to save payment rule', { error: error.message });
      return res.status(500).json({ error: 'Failed to save payment rule' });
    }
  });

  svc.configRouter.put('/api/dashboard/payment-rules/:server/:alertId', ...svc.configWrite(), (req, res) => {
    if (!svc.syncHistory) return noHistory(res);
    try {
      const server = findServer(req, res);
      if (!server) return undefined;
      const alertId = req.params.alertId;
      if (!validAlertId(alertId)) return res.status(404).json({ error: 'rule_not_found' });
      const block = server.scheduleAlerts;
      if (!block) return res.status(409).json({ error: 'alerts_not_configured' });
      if (getRules(block).some((rule) => rule.id === alertId)) return res.status(409).json({ error: 'managed_in_config' });
      const stored = svc.syncHistory.getRule(server.name, alertId);
      if (!stored) return res.status(404).json({ error: 'rule_not_found' });

      const definition = req.body;
      if (definition && typeof definition === 'object' && !Array.isArray(definition)
        && definition.id !== undefined && definition.id !== alertId) {
        return res.status(400).json({ error: 'id_mismatch' });
      }
      const result = validateScheduleAlert(definition, {
        block, notificationsConfig: notificationsConfig(svc), dashboard: true
      });
      if (!result.valid) return sendInvalid(res, result);

      let row = stored;
      if (canonical(stored.definition) !== canonical(definition)) {
        row = svc.syncHistory.runInTransaction(() => {
          const updated = svc.syncHistory.updateRule(server.name, alertId, definition);
          svc.syncHistory.recordConfigChange({
            server: server.name,
            remoteAddr: req.ip,
            action: 'payment_alert_rule_update',
            target: alertId,
            changes: diffDefinitions(stored.definition, definition)
          });
          return updated;
        });
      }
      return res.json({ rule: publicRule(createdEntry(server, row), { valid: true, errors: [] }) });
    } catch (error) {
      svc.logger.error('Failed to save payment rule', { error: error.message });
      return res.status(500).json({ error: 'Failed to save payment rule' });
    }
  });

  svc.configRouter.delete('/api/dashboard/payment-rules/:server/:alertId', ...svc.configWrite(), (req, res) => {
    if (!svc.syncHistory) return noHistory(res);
    try {
      const server = findServer(req, res);
      if (!server) return undefined;
      const alertId = req.params.alertId;
      if (!validAlertId(alertId)) return res.status(404).json({ error: 'rule_not_found' });
      const stored = svc.syncHistory.getRule(server.name, alertId);
      const inConfig = getRules(server.scheduleAlerts).some((rule) => rule.id === alertId);
      if (!stored) {
        return inConfig
          ? res.status(409).json({ error: 'managed_in_config' })
          : res.status(404).json({ error: 'rule_not_found' });
      }

      svc.syncHistory.runInTransaction(() => {
        const changes = diffDefinitions(stored.definition, null);
        if (!inConfig) {
          // The config rule, when there is one, keeps its own override and status.
          const override = svc.syncHistory.getOverride(server.name, alertId);
          if (override) {
            if (override.mutedUntil) {
              svc.syncHistory.deleteMutedRows({ server: server.name, alertId, since: override.mutedFrom || undefined });
            }
            svc.syncHistory.deleteOverride(server.name, alertId);
            changes.override = {
              enabled: [override.enabled, null], mutedUntil: [override.mutedUntil, null], reason: '[redacted]'
            };
          }
          svc.syncHistory.deletePaymentStatusForAlert(server.name, alertId);
        }
        svc.syncHistory.deleteRule(server.name, alertId);
        svc.syncHistory.recordConfigChange({
          server: server.name, remoteAddr: req.ip, action: 'payment_alert_rule_delete', target: alertId, changes
        });
      });
      return res.json({ deleted: true });
    } catch (error) {
      svc.logger.error('Failed to delete payment rule', { error: error.message });
      return res.status(500).json({ error: 'Failed to save payment rule' });
    }
  });

  // Preview and test-send. Nothing here writes a ledger or status row.
  svc.configRouter.post('/api/dashboard/payment-preview/:server', ...svc.configWrite(), async (req, res) => {
    if (!svc.syncHistory) return noHistory(res);
    try {
      const server = findServer(req, res);
      if (!server) return undefined;
      const block = server.scheduleAlerts;
      if (!block) return res.status(409).json({ error: 'alerts_not_configured' });

      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)
        || body.rule === undefined || body.event === undefined
        || typeof body.event !== 'string'
        || (body.send !== undefined && typeof body.send !== 'boolean')) {
        return res.status(400).json({ error: 'invalid_body' });
      }
      if (!PREVIEW_EVENTS.includes(body.event)) return res.status(400).json({ error: 'invalid_event' });

      const result = validateScheduleAlert(body.rule, {
        block, notificationsConfig: notificationsConfig(svc), dashboard: true
      });
      if (!result.valid) return sendInvalid(res, result);

      const send = body.send === true;
      if (send) {
        const now = Date.now();
        while (sendTimes.length && now - sendTimes[0] >= TEST_SEND_WINDOW_MS) sendTimes.shift();
        if (sendTimes.length >= TEST_SEND_LIMIT) return res.status(429).json({ error: 'test_send_rate_limited' });
        sendTimes.push(now);
      }

      const rule = normalizeRule(body.rule, block);
      const snapshot = svc.syncHistory.getScheduleSnapshot(server.name).schedules;
      const schedule = (rule.schedulePrefix
        ? snapshot.find((s) => typeof s.name === 'string' && s.name.startsWith(rule.schedulePrefix))
        : snapshot.find((s) => s.name === rule.schedule)) || null;
      const { context, sampleKeys } = buildPreviewContext({
        eventName: body.event, rule, schedule, server: server.name, timezone: svc.getTimezone(), now: svc.now()
      });
      const sender = svc.notificationService;
      const preview = await previewRule({ eventName: body.event, context, rule, sender, send });

      const sent = preview.results.some((r) => r.ok);
      if (send && !sent) {
        return res.status(502).json({ error: 'send_failed', text: preview.text, sampleKeys, sent: false, results: preview.results });
      }
      return res.json({ text: preview.text, sampleKeys, sent, results: preview.results });
    } catch (error) {
      if (error instanceof TemplateValidationError) {
        return res.status(400).json({
          error: 'invalid_template', template: error.key, token: error.token, line: error.line, reason: error.reason
        });
      }
      svc.logger.error('Failed to preview payment rule', { error: error.message });
      return res.status(500).json({ error: 'Failed to preview payment rule' });
    }
  });
}

/** Names from ALL_CHANNELS that currently have a destination (capabilities.channels). */
function configuredChannels(svc) {
  return resolveChannels({}, { config: notificationsConfig(svc) });
}

module.exports = { registerPaymentRuleRoutes, activeRules, configuredChannels };
