/**
 * The one validator for a `scheduleAlerts.alerts[]` entry (#262).
 *
 * Shared by startup (`configLoader.validateScheduleAlerts`), the dashboard
 * rule routes and the preview, and by the sync step and the rule list (which
 * re-check stored dashboard rules), so a rule can never be valid in one place
 * and invalid in another for a reason other than the mode it was asked in.
 *
 * Modes:
 * - default (startup): templates are compiled against the rule's own resolved
 *   channels, and a channel restriction that resolves to nothing is an error.
 *   The JSON schema has already been applied to the whole config, so
 *   `skipSchema: true` skips it here.
 * - `dashboard: true`: also runs the schema check on this one entry, rejects
 *   `enabled`, requires `id`, and fails with `no_configured_destination` when
 *   the rule's channels resolve to zero destinations (a rule that could never
 *   send anything).
 * - `schemaOnly: true`: the schema check and a template compile only, with no
 *   channel resolution. Templates are compiled against every mode the rule's
 *   own `channels` (or every channel) could use. This is the mode of the sync
 *   step and of the rule list, so the list shows exactly what the sync will
 *   skip.
 */
'use strict';

const fs = require('fs');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { resolveSchemaPath } = require('./configBootstrap');
const {
  DEFAULT_TEMPLATES, VARIABLES, ALL_CHANNELS, CHANNEL_TO_MODES, resolveChannels
} = require('./scheduleAlertDelivery');
const { compileTemplateSet, TemplateValidationError } = require('./templateRenderer');

let schemaCheck = null;

/** Lazily compiled AJV check on `$defs/scheduleAlert` of config.schema.json. */
function getSchemaCheck() {
  if (!schemaCheck) {
    const schema = JSON.parse(fs.readFileSync(resolveSchemaPath(), 'utf8'));
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
    addFormats(ajv);
    schemaCheck = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/scheduleAlert' });
  }
  return schemaCheck;
}

const NOISE = new Set(['if', 'then', 'else', 'allOf', 'anyOf', 'oneOf', 'not']);

function formatAjvErrors(raw) {
  const out = [];
  const seen = new Set();
  const push = (path, message) => {
    const key = `${path}\n${message}`;
    if (!seen.has(key)) { seen.add(key); out.push({ path, message }); }
  };
  const oneOfFailed = (raw || []).some((err) => err.keyword === 'oneOf');
  for (const err of raw || []) {
    if (NOISE.has(err.keyword)) continue;
    if (err.keyword === 'additionalProperties') {
      push(`${err.instancePath}/${err.params.additionalProperty}`, 'is not a known field');
    } else if (err.keyword === 'required') {
      // The oneOf branches each report their own missing key; one sentence
      // below replaces them.
      if (oneOfFailed && err.instancePath === ''
        && (err.params.missingProperty === 'schedule' || err.params.missingProperty === 'schedulePrefix')) continue;
      push(`${err.instancePath}/${err.params.missingProperty}`, 'is required');
    } else {
      push(err.instancePath, err.message);
    }
  }
  if (oneOfFailed) push('', 'exactly one of schedule or schedulePrefix is required');
  return out;
}

/**
 * @param {Object} rule - one raw `scheduleAlerts.alerts[]` entry
 * @param {Object} [opts]
 * @param {Object} [opts.block] - the server's `scheduleAlerts` block (for its templates)
 * @param {Object} [opts.notificationsConfig] - `config.notifications`
 * @param {boolean} [opts.dashboard]
 * @param {boolean} [opts.schemaOnly]
 * @param {boolean} [opts.skipSchema] - startup: the whole config was already schema-checked
 * @returns {{valid: boolean, code: ?string, errors: Array<{path:string,message:string}>,
 *   template: ?{template:string,token:string,line:number,reason:string,message:string},
 *   channelsRestricted: ?string[]}}
 *   `code` is `invalid_rule`, `invalid_template` or `no_configured_destination`.
 */
function validateScheduleAlert(rule, opts = {}) {
  const { block, notificationsConfig, dashboard = false, schemaOnly = false, skipSchema = false } = opts;
  const fail = (code, extra = {}) => ({
    valid: false, code, errors: [], template: null, channelsRestricted: null, ...extra
  });

  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return fail('invalid_rule', { errors: [{ path: '', message: 'must be an object' }] });
  }

  if (!skipSchema) {
    const check = getSchemaCheck();
    const errors = check(rule) ? [] : formatAjvErrors(check.errors);
    if (dashboard) {
      if ('enabled' in rule) {
        errors.push({ path: '/enabled', message: 'is not allowed in a dashboard rule; use the enable switch' });
      }
      if (rule.id === undefined) errors.push({ path: '/id', message: 'is required' });
    }
    if (errors.length) return fail('invalid_rule', { errors });
  }

  const templates = {
    ...DEFAULT_TEMPLATES,
    ...((block && block.templates) || {}),
    ...(rule.templates || {})
  };
  const sender = { config: notificationsConfig || {} };
  const resolved = schemaOnly ? null : resolveChannels(rule, sender);
  // A dashboard rule is re-checked at every sync in schemaOnly mode, against
  // the rule's requested channels (or all of them), not only the configured
  // ones. Saving and previewing compile against that same set, so a rule the
  // API accepts is never dropped at the next sync (#262 review F1). Config
  // rules keep the startup behaviour: only the channels that resolve.
  const requested = rule.channels && rule.channels.length ? rule.channels : ALL_CHANNELS;
  const channels = schemaOnly || dashboard ? requested : resolved;
  const modes = channels.flatMap((channel) => CHANNEL_TO_MODES[channel] || []);
  try {
    compileTemplateSet({ templates, variables: VARIABLES, channels: modes });
  } catch (error) {
    if (!(error instanceof TemplateValidationError)) throw error;
    return fail('invalid_template', {
      template: {
        template: error.key, token: error.token, line: error.line, reason: error.reason, message: error.message
      }
    });
  }

  if (!schemaOnly && rule.channels && rule.channels.length && resolved.length === 0) {
    return fail('no_configured_destination', { channelsRestricted: rule.channels });
  }
  if (dashboard && !schemaOnly && resolved.length === 0) {
    return fail('no_configured_destination');
  }
  return { valid: true, code: null, errors: [], template: null, channelsRestricted: null };
}

module.exports = { validateScheduleAlert };
