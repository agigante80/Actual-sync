/**
 * Payment rule routes (#262): GET payment-schedules, GET/POST/PUT/DELETE
 * payment-rules and the capabilities channels. Preview has its own file.
 */
const fs = require('fs');
const { DEFAULT_TEMPLATES, VARIABLES } = require('../lib/scheduleAlertDelivery');
const { validateScheduleAlert } = require('../lib/scheduleAlertValidation');
const { NOW, basicHeader, makeSender, createHarness } = require('./helpers/paymentRulesHarness');

const h = createHarness();
const { call } = h;
const schedulesUrl = (s = 'Main') => `/api/dashboard/payment-schedules/${s}`;
const rulesUrl = (s = 'Main', id) => `/api/dashboard/payment-rules/${s}${id ? `/${id}` : ''}`;
const audit = () => h.state.history.getConfigAudit().filter((a) => a.action.startsWith('payment_alert_rule_'));
const RENT = { id: 'moto', schedule: 'Rent - Moto', graceDays: 5 };

afterEach(async () => {
  await h.cleanup();
  jest.restoreAllMocks();
});

describe('GET /api/dashboard/payment-schedules/:server (#262)', () => {
  test('returns the snapshot and the exact defaults', async () => {
    await h.boot({ servers: [{ name: 'Main', scheduleAlerts: { alerts: [], templates: { missing: 'X {{name}}' } } }] });
    h.state.history.replaceScheduleSnapshot('Main', [{
      id: 's1', name: 'Rent - Moto', cadenceText: 'Every month', amount: -5000, amountMin: null, amountMax: null,
      amountOp: 'is', account: 'Main', payee: 'Landlord', nextDate: '2026-11-01', completed: false
    }], '2026-10-14T07:00:00.000Z');
    const res = await call('GET', schedulesUrl());
    expect(res.status).toBe(200);
    expect(res.json.configured).toBe(true);
    expect(res.json.capturedAt).toBe('2026-10-14T07:00:00.000Z');
    expect(res.json.schedules).toEqual([{
      id: 's1', name: 'Rent - Moto', cadenceText: 'Every month', amount: -5000, amountMin: null, amountMax: null,
      amountOp: 'is', account: 'Main', payee: 'Landlord', nextDate: '2026-11-01', completed: false
    }]);
    const events = ['missing', 'wrongAmount', 'resolved', 'cannotCheck', 'ruleUnmatched', 'muteEnded'];
    expect(res.json.defaults).toEqual({
      graceDays: 3,
      earlyDays: 2,
      templates: DEFAULT_TEMPLATES,
      blockTemplates: { missing: 'X {{name}}' },
      variables: Object.fromEntries(events.map((e) => [e, VARIABLES]))
    });
    expect(Object.keys(res.json.defaults.templates).sort()).toEqual([...events].sort());
  });

  test('before any capture capturedAt is null; without a block it is not configured but defaults stay', async () => {
    await h.boot({ servers: [{ name: 'Main', scheduleAlerts: { alerts: [] } }, { name: 'Plain' }] });
    const empty = await call('GET', schedulesUrl());
    expect(empty.json).toMatchObject({ configured: true, capturedAt: null, schedules: [] });
    const plain = await call('GET', schedulesUrl('Plain'));
    expect(plain.json).toMatchObject({ configured: false, capturedAt: null, schedules: [] });
    expect(plain.json.defaults.blockTemplates).toEqual({});
    expect(plain.json.defaults.graceDays).toBe(3);
  });

  test('401 without credentials; 404 for an unknown server and for __proto__', async () => {
    await h.boot();
    expect((await call('GET', schedulesUrl(), { auth: null })).status).toBe(401);
    expect((await call('GET', schedulesUrl('Nope'))).json).toEqual({ error: 'server_not_found' });
    expect((await call('GET', schedulesUrl('__proto__'))).status).toBe(404);
    expect((await call('GET', schedulesUrl('constructor'))).status).toBe(404);
  });

  test('a storage failure gives the fixed 500 body without the exception text', async () => {
    await h.boot();
    jest.spyOn(h.state.history, 'getScheduleSnapshot').mockImplementation(() => { throw new Error('disk I/O secret-path'); });
    const res = await call('GET', schedulesUrl());
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'Failed to retrieve payment rules' });
    expect(res.text).not.toContain('secret-path');
    expect(h.state.errors).toHaveLength(1);
  });

  test('503 without sync history', async () => {
    await h.boot();
    h.state.svc.syncHistory = undefined;
    expect((await call('GET', schedulesUrl())).status).toBe(503);
  });
});

describe('GET /api/dashboard/payment-rules/:server (#262)', () => {
  test('lists config rules, dashboard rules and a superseded row with their source', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    h.state.history.insertRule('Main', 'cfg-rent', { id: 'cfg-rent', schedule: 'Shadow' });
    const res = await call('GET', rulesUrl());
    expect(res.status).toBe(200);
    expect(res.json.configured).toBe(true);
    expect(res.json.rules.map((r) => [r.id, r.source, r.superseded, r.invalid])).toEqual([
      ['cfg-rent', 'config', false, false], ['cfg-rent', 'dashboard', true, false], ['moto', 'dashboard', false, false]
    ]);
    expect(res.json.rules[2]).toEqual({
      id: 'moto', source: 'dashboard', superseded: false, invalid: false, errors: [],
      definition: RENT, updatedAt: NOW.toISOString()
    });
    expect(res.json.rules[0].definition).toEqual({ id: 'cfg-rent', schedule: 'Rent' });
    expect(res.json.rules[0].updatedAt).toBeNull();
  });

  test('a stored rule that no longer validates is listed invalid with its errors', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'bad', { id: 'bad', schedule: 'X', graceDays: -4 });
    h.state.history.insertRule('Main', 'tpl', { id: 'tpl', schedule: 'X', templates: { missing: '{{nope}}' } });
    const { rules } = (await call('GET', rulesUrl())).json;
    const bad = rules.find((r) => r.id === 'bad');
    expect(bad.invalid).toBe(true);
    expect(bad.errors[0].path).toBe('/graceDays');
    const tpl = rules.find((r) => r.id === 'tpl');
    expect(tpl.invalid).toBe(true);
    expect(tpl.errors[0].path).toBe('/templates/missing');
  });

  test('invalid agrees with the validator mode the sync uses, not the stricter save mode', async () => {
    // slack is requested but not configured: save mode rejects, the sync mode (and so the list) accepts it.
    await h.boot({ config: { telegram: { enabled: true } } });
    const definition = { id: 'slacky', schedule: 'X', channels: ['slack'] };
    h.state.history.insertRule('Main', 'slacky', definition);
    const block = h.state.servers[0].scheduleAlerts;
    const syncMode = validateScheduleAlert(definition, { block, notificationsConfig: h.state.sender.config, dashboard: true, schemaOnly: true });
    const saveMode = validateScheduleAlert(definition, { block, notificationsConfig: h.state.sender.config, dashboard: true });
    expect(syncMode.valid).toBe(true);
    expect(saveMode.valid).toBe(false);
    const listed = (await call('GET', rulesUrl())).json.rules.find((r) => r.id === 'slacky');
    expect(listed.invalid).toBe(!syncMode.valid);
  });

  test('F1b: a config rule startup accepts is listed valid, even with markup only Telegram rejects', async () => {
    const slackOnly = { webhooks: { slack: [{ name: 's', url: 'https://hooks.slack.com/x' }] } };
    await h.boot({
      config: slackOnly,
      servers: [{ name: 'Main', scheduleAlerts: { alerts: [{ id: 'cfg', schedule: 'X', templates: { missing: '<div>{{name}}</div>' } }] } }]
    });
    const listed = (await call('GET', rulesUrl())).json.rules.find((r) => r.id === 'cfg');
    expect(listed.invalid).toBe(false);
  });

  test('without a block: configured false and the stored rows, dormant', async () => {
    await h.boot({ servers: [{ name: 'Main' }] });
    h.state.history.insertRule('Main', 'moto', RENT);
    const res = await call('GET', rulesUrl());
    expect(res.json.configured).toBe(false);
    expect(res.json.rules.map((r) => [r.id, r.source, r.superseded])).toEqual([['moto', 'dashboard', false]]);
  });

  test('listRules throwing gives the fixed 500 body', async () => {
    await h.boot();
    jest.spyOn(h.state.history, 'listRules').mockImplementation(() => { throw new Error('disk I/O secret-path'); });
    const res = await call('GET', rulesUrl());
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'Failed to retrieve payment rules' });
    expect(res.text).not.toContain('secret-path');
  });

  test('401 and server_not_found', async () => {
    await h.boot();
    expect((await call('GET', rulesUrl(), { auth: null })).status).toBe(401);
    expect((await call('GET', rulesUrl('Nope'))).json).toEqual({ error: 'server_not_found' });
  });
});

describe('POST /api/dashboard/payment-rules/:server (#262)', () => {
  test('creates the rule with an audit row of [null, value] fields and the next sync sees it', async () => {
    await h.boot();
    const res = await call('POST', rulesUrl(), { body: RENT });
    expect(res.status).toBe(201);
    expect(res.json.rule).toMatchObject({ id: 'moto', source: 'dashboard', superseded: false, invalid: false, definition: RENT });
    expect(h.state.history.getRule('Main', 'moto').definition).toEqual(RENT);
    const rows = audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'payment_alert_rule_create', target: 'moto', server: 'Main' });
    expect(rows[0].changes).toEqual({ id: [null, 'moto'], schedule: [null, 'Rent - Moto'], graceDays: [null, 5] });
    const { activeRules } = require('../services/paymentRuleRoutes');
    expect(activeRules(h.state.svc, h.state.servers[0]).map((r) => r.id)).toEqual(['cfg-rent', 'moto']);
  });

  test.each([
    ['no id', { schedule: 'X' }, '/id'],
    ['neither schedule nor prefix', { id: 'a' }, ''],
    ['enabled present', { id: 'a', schedule: 'X', enabled: false }, '/enabled'],
    ['bad graceDays', { id: 'a', schedule: 'X', graceDays: 'soon' }, '/graceDays']
  ])('400 invalid_rule: %s', async (name, body, path) => {
    await h.boot();
    const res = await call('POST', rulesUrl(), { body });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_rule');
    expect(res.json.details.map((d) => d.path)).toContain(path);
    expect(h.state.history.countRules('Main')).toBe(0);
    expect(audit()).toHaveLength(0);
  });

  test('F1: a template the sync would reject is refused at save time, so a 201 rule is never dropped', async () => {
    const slackOnly = { webhooks: { slack: [{ name: 's', url: 'https://hooks.slack.com/x' }] } };
    await h.boot({ config: slackOnly });
    const body = { id: 'div', schedule: 'X', templates: { missing: '<div>{{name}}</div>' } };
    const res = await call('POST', rulesUrl(), { body });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_template');
    const block = h.state.servers[0].scheduleAlerts;
    const syncMode = validateScheduleAlert(body, { block, notificationsConfig: h.state.sender.config, dashboard: true, schemaOnly: true });
    expect(syncMode.valid).toBe(false);
    expect(h.state.history.countRules('Main')).toBe(0);
  });

  test('a non-object body is invalid_rule', async () => {
    await h.boot();
    const res = await call('POST', rulesUrl(), { body: '[1,2]' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_rule');
  });

  test('400 invalid_template carries the template, token, line and reason', async () => {
    await h.boot();
    const res = await call('POST', rulesUrl(), { body: { id: 'a', schedule: 'X', templates: { missing: 'a\n{{nope}}' } } });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: 'invalid_template', template: 'missing', token: 'nope', line: 2 });
    expect(typeof res.json.reason).toBe('string');
  });

  test('400 no_configured_destination when nothing resolves', async () => {
    await h.boot({ config: {} });
    const res = await call('POST', rulesUrl(), { body: RENT });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'no_configured_destination' });
    const restricted = await call('POST', rulesUrl(), { body: { ...RENT, channels: ['slack'] } });
    expect(restricted.json.error).toBe('no_configured_destination');
  });

  test('409 alerts_not_configured without a block, after server_not_found', async () => {
    await h.boot({ servers: [{ name: 'Main' }] });
    expect((await call('POST', rulesUrl(), { body: RENT })).json).toEqual({ error: 'alerts_not_configured' });
    expect((await call('POST', rulesUrl('Nope'), { body: RENT })).json).toEqual({ error: 'server_not_found' });
    // a body that would also be invalid answers with the earlier check
    expect((await call('POST', rulesUrl(), { body: {} })).json.error).toBe('alerts_not_configured');
  });

  test('POST order: validation (400) before id_in_config before duplicate_id before too_many_rules', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'cfg-rent', { id: 'cfg-rent', schedule: 'Shadow' });
    // an invalid body for a config id: 400 wins
    expect((await call('POST', rulesUrl(), { body: { id: 'cfg-rent' } })).status).toBe(400);
    // id both in config and stored: id_in_config wins over duplicate_id
    const inConfig = await call('POST', rulesUrl(), { body: { id: 'cfg-rent', schedule: 'X' } });
    expect(inConfig).toMatchObject({ status: 409 });
    expect(inConfig.json).toEqual({ error: 'id_in_config' });
    h.state.history.insertRule('Main', 'moto', RENT);
    const dup = await call('POST', rulesUrl(), { body: RENT });
    expect(dup.json).toEqual({ error: 'duplicate_id' });
    // full table and a duplicate id: duplicate_id wins over too_many_rules
    for (let i = 0; i < 198; i += 1) h.state.history.insertRule('Main', `r${i}`, { id: `r${i}`, schedule: 'X' });
    expect(h.state.history.countRules('Main')).toBe(200);
    expect((await call('POST', rulesUrl(), { body: RENT })).json).toEqual({ error: 'duplicate_id' });
    const full = await call('POST', rulesUrl(), { body: { id: 'one-more', schedule: 'X' } });
    expect(full.status).toBe(409);
    expect(full.json).toEqual({ error: 'too_many_rules' });
    expect(h.state.history.countRules('Main')).toBe(200);
    expect(audit()).toHaveLength(0);
  });

  test('the rule and its audit row commit together: a failing audit write leaves no rule', async () => {
    await h.boot();
    jest.spyOn(h.state.history, 'recordConfigChange').mockImplementation(() => { throw new Error('audit secret-path'); });
    const res = await call('POST', rulesUrl(), { body: RENT });
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'Failed to save payment rule' });
    expect(res.text).not.toContain('secret-path');
    expect(h.state.history.getRule('Main', 'moto')).toBeNull();
  });

  test('transport errors: invalid_json, 413, 415, and origin / writes-disabled gates', async () => {
    await h.boot();
    expect((await call('POST', rulesUrl(), { body: '{"id":' })).json).toEqual({ error: 'invalid_json' });
    const big = await call('POST', rulesUrl(), { body: JSON.stringify({ id: 'a', schedule: 'x'.repeat(17 * 1024) }) });
    expect(big.status).toBe(413);
    expect(big.json).toEqual({ error: 'payload_too_large' });
    const text = await call('POST', rulesUrl(), { body: JSON.stringify(RENT), headers: { 'Content-Type': 'text/plain' } });
    expect(text.status).toBe(415);
    expect(text.json).toEqual({ error: 'invalid_content_type' });
    const origin = await call('POST', rulesUrl(), { body: RENT, headers: { Origin: 'https://evil.example' } });
    expect(origin.status).toBe(403);
    expect(origin.json).toEqual({ error: 'origin_rejected' });
    expect((await call('POST', rulesUrl(), { body: RENT, auth: null })).status).toBe(401);
    expect((await call('POST', rulesUrl(), { body: RENT, auth: basicHeader('wrong') })).status).toBe(401);
  });

  test('403 config_writes_disabled when writes are off', async () => {
    await h.boot({ dashboard: { allowConfigWrites: false } });
    const res = await call('POST', rulesUrl(), { body: RENT });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'config_writes_disabled', reason: 'disabled' });
  });

  test('invalid_body_encoding for an unsupported charset', async () => {
    await h.boot();
    const res = await call('POST', rulesUrl(), {
      body: JSON.stringify(RENT), headers: { 'Content-Type': 'application/json; charset=latin1' }
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'invalid_body_encoding' });
  });

  test('writing never touches config.json or the Actual dependency', async () => {
    const syncBank = jest.fn(() => { throw new Error('Actual must not be used'); });
    await h.boot();
    h.state.svc.syncBank = syncBank;
    const writes = [
      jest.spyOn(fs, 'writeFileSync'), jest.spyOn(fs, 'renameSync'), jest.spyOn(fs.promises, 'writeFile'), jest.spyOn(fs, 'writeFile')
    ];
    await call('POST', rulesUrl(), { body: RENT });
    await call('PUT', rulesUrl('Main', 'moto'), { body: { ...RENT, graceDays: 6 } });
    await call('DELETE', rulesUrl('Main', 'moto'));
    writes.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    expect(syncBank).not.toHaveBeenCalled();
    expect(audit().map((a) => a.action)).toEqual([
      'payment_alert_rule_delete', 'payment_alert_rule_update', 'payment_alert_rule_create'
    ]);
  });
});

describe('PUT /api/dashboard/payment-rules/:server/:alertId (#262)', () => {
  test('updates, audits only the changed fields, and bumps updated_at', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    const res = await call('PUT', rulesUrl('Main', 'moto'), { body: { id: 'moto', schedule: 'Rent - Moto', graceDays: 7, earlyDays: 1 } });
    expect(res.status).toBe(200);
    expect(res.json.rule.definition).toEqual({ id: 'moto', schedule: 'Rent - Moto', graceDays: 7, earlyDays: 1 });
    const [row] = audit();
    expect(row.action).toBe('payment_alert_rule_update');
    expect(row.changes).toEqual({ graceDays: [5, 7], earlyDays: [null, 1] });
  });

  test('an identical definition (any key order) is a no-op: no audit row, same updated_at', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    h.state.svc.now = () => new Date('2026-10-20T00:00:00.000Z');
    h.state.history.now = () => new Date('2026-10-20T00:00:00.000Z');
    const res = await call('PUT', rulesUrl('Main', 'moto'), { body: { graceDays: 5, schedule: 'Rent - Moto', id: 'moto' } });
    expect(res.status).toBe(200);
    expect(res.json.rule.updatedAt).toBe(NOW.toISOString());
    expect(h.state.history.getRule('Main', 'moto').updatedAt).toBe(NOW.toISOString());
    expect(audit()).toHaveLength(0);
  });

  test('error table: managed_in_config, id_mismatch, rule_not_found, bad ids, no block', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    expect((await call('PUT', rulesUrl('Main', 'cfg-rent'), { body: { id: 'cfg-rent', schedule: 'X' } })).json)
      .toEqual({ error: 'managed_in_config' });
    expect((await call('PUT', rulesUrl('Main', 'moto'), { body: { ...RENT, id: 'other' } })).json).toEqual({ error: 'id_mismatch' });
    expect((await call('PUT', rulesUrl('Main', 'ghost'), { body: { id: 'ghost', schedule: 'X' } })).json).toEqual({ error: 'rule_not_found' });
    for (const bad of ['constructor', 'UPPER', 'a_b', 'x'.repeat(65)]) {
      expect((await call('PUT', rulesUrl('Main', bad), { body: RENT })).json).toEqual({ error: 'rule_not_found' });
    }
    expect((await call('PUT', '/api/dashboard/payment-rules/Main/__proto__', { body: RENT })).json).toEqual({ error: 'rule_not_found' });
    expect((await call('PUT', rulesUrl('Nope', 'moto'), { body: RENT })).json).toEqual({ error: 'server_not_found' });
    const invalid = await call('PUT', rulesUrl('Main', 'moto'), { body: { id: 'moto' } });
    expect(invalid.json.error).toBe('invalid_rule');
    const missingId = await call('PUT', rulesUrl('Main', 'moto'), { body: { schedule: 'X' } });
    expect(missingId.json.details.map((d) => d.path)).toContain('/id');
    expect(audit()).toHaveLength(0);
    expect(h.state.history.getRule('Main', 'moto').definition).toEqual(RENT);
  });

  test('409 alerts_not_configured when the block is gone', async () => {
    await h.boot({ servers: [{ name: 'Main' }] });
    h.state.history.insertRule('Main', 'moto', RENT);
    expect((await call('PUT', rulesUrl('Main', 'moto'), { body: RENT })).json).toEqual({ error: 'alerts_not_configured' });
  });

  test('a rule of another server is not found', async () => {
    await h.boot({ servers: [{ name: 'Main', scheduleAlerts: { alerts: [] } }, { name: 'Other', scheduleAlerts: { alerts: [] } }] });
    h.state.history.insertRule('Other', 'moto', RENT);
    expect((await call('PUT', rulesUrl('Main', 'moto'), { body: RENT })).json).toEqual({ error: 'rule_not_found' });
  });

  test('a failing write gives the fixed 500 body and keeps the old definition', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    jest.spyOn(h.state.history, 'recordConfigChange').mockImplementation(() => { throw new Error('boom secret-path'); });
    const res = await call('PUT', rulesUrl('Main', 'moto'), { body: { ...RENT, graceDays: 9 } });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('secret-path');
    expect(h.state.history.getRule('Main', 'moto').definition).toEqual(RENT);
  });
});

describe('DELETE /api/dashboard/payment-rules/:server/:alertId (#262)', () => {
  const seedState = (history, id) => {
    history.setOverride({ server: 'Main', alertId: id, enabled: false, mutedFrom: '2026-10-01T00:00:00.000Z', mutedUntil: '2026-10-30', reason: 'vacant secret' });
    history.replacePaymentSnapshot('Main', [{
      alertId: id, scheduleId: 's1', name: 'N', cadenceText: null, account: null, payee: null, expectedAmount: 1,
      nextDate: null, deadline: null, state: 'ok', occurrences: []
    }]);
  };

  test('removes the rule, its override, its status rows and writes one audit row with the redacted override', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    seedState(h.state.history, 'moto');
    const res = await call('DELETE', rulesUrl('Main', 'moto'));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ deleted: true });
    expect(h.state.history.getRule('Main', 'moto')).toBeNull();
    expect(h.state.history.getOverride('Main', 'moto')).toBeNull();
    expect(h.state.history.getPaymentSnapshot('Main').items).toEqual([]);
    const [row] = audit();
    expect(row.action).toBe('payment_alert_rule_delete');
    expect(row.changes.schedule).toEqual(['Rent - Moto', null]);
    expect(row.changes.override).toEqual({ enabled: [false, null], mutedUntil: ['2026-10-30', null], reason: '[redacted]' });
    expect(JSON.stringify(row)).not.toContain('vacant secret');
  });

  test('deletes the muted ledger rows of the rule since muted_from', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    seedState(h.state.history, 'moto');
    const spy = jest.spyOn(h.state.history, 'deleteMutedRows');
    await call('DELETE', rulesUrl('Main', 'moto'));
    expect(spy).toHaveBeenCalledWith({ server: 'Main', alertId: 'moto', since: '2026-10-01T00:00:00.000Z' });
  });

  test('a superseded row is deleted alone: the config rule keeps its override and status', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'cfg-rent', { id: 'cfg-rent', schedule: 'Shadow' });
    seedState(h.state.history, 'cfg-rent');
    const res = await call('DELETE', rulesUrl('Main', 'cfg-rent'));
    expect(res.status).toBe(200);
    expect(h.state.history.getRule('Main', 'cfg-rent')).toBeNull();
    expect(h.state.history.getOverride('Main', 'cfg-rent')).not.toBeNull();
    expect(h.state.history.getPaymentSnapshot('Main').items).toHaveLength(1);
    expect(audit()[0].changes.override).toBeUndefined();
    const overrides = await call('GET', '/api/dashboard/payment-overrides');
    expect(overrides.json.overrides.map((o) => [o.alertId, o.orphaned])).toEqual([['cfg-rent', false]]);
  });

  test('a config id without a dashboard row is managed_in_config; an unknown id is rule_not_found', async () => {
    await h.boot();
    expect((await call('DELETE', rulesUrl('Main', 'cfg-rent'))).json).toEqual({ error: 'managed_in_config' });
    expect((await call('DELETE', rulesUrl('Main', 'ghost'))).json).toEqual({ error: 'rule_not_found' });
    expect((await call('DELETE', rulesUrl('Main', 'constructor'))).json).toEqual({ error: 'rule_not_found' });
    expect((await call('DELETE', rulesUrl('Nope', 'moto'))).json).toEqual({ error: 'server_not_found' });
    expect(audit()).toHaveLength(0);
  });

  test('is allowed without a block (cleanup of dormant rows) and accepts no body', async () => {
    await h.boot({ servers: [{ name: 'Main' }] });
    h.state.history.insertRule('Main', 'moto', RENT);
    const res = await call('DELETE', rulesUrl('Main', 'moto'));
    expect(res.status).toBe(200);
    expect(h.state.history.getRule('Main', 'moto')).toBeNull();
  });

  test('a failing audit write rolls the deletion back', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    seedState(h.state.history, 'moto');
    jest.spyOn(h.state.history, 'recordConfigChange').mockImplementation(() => { throw new Error('boom'); });
    const res = await call('DELETE', rulesUrl('Main', 'moto'));
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'Failed to save payment rule' });
    expect(h.state.history.getRule('Main', 'moto')).not.toBeNull();
    expect(h.state.history.getOverride('Main', 'moto')).not.toBeNull();
    expect(h.state.history.getPaymentSnapshot('Main').items).toHaveLength(1);
  });
});

describe('history reset and dashboard rules (#262 review L1)', () => {
  const reset = (server) => call('POST', '/api/dashboard/reset-history', { body: { server } });

  test('a configured server keeps its rules on reset', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    expect((await reset('Main')).status).toBe(200);
    expect(h.state.history.countRules('Main')).toBe(1);
  });

  test('a removed server with rules but no sync rows is listed as orphaned (round 2 L1)', async () => {
    await h.boot();
    h.state.history.insertRule('Old', 'moto', RENT);
    const res = await call('GET', '/api/dashboard/orphaned-servers');
    expect(res.status).toBe(200);
    expect(res.json.orphaned).toEqual([{ server_name: 'Old', sync_count: 0, last_sync: null }]);
  });

  test('reset all deletes rules of removed servers only, counted in the audit (#372)', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    h.state.history.insertRule('Old', 'moto', RENT);
    expect((await reset('all')).status).toBe(200);
    expect(h.state.history.countRules('Main')).toBe(1);
    expect(h.state.history.countRules('Old')).toBe(0);
    const row = h.state.history.getConfigAudit().find((a) => a.action === 'history_reset');
    expect(row.changes.deleted.payment_alert_rule).toBe(1);
  });

  test('a server removed from the config loses its rules on reset, counted in the audit', async () => {
    await h.boot();
    h.state.history.insertRule('Old', 'moto', RENT);
    expect((await reset('Old')).status).toBe(200);
    expect(h.state.history.countRules('Old')).toBe(0);
    const row = h.state.history.getConfigAudit().find((a) => a.action === 'history_reset');
    expect(row.changes.deleted.payment_alert_rule).toBe(1);
  });
});

describe('merged rule set for the #261 routes (#262)', () => {
  test('a dashboard rule id is accepted by the state route; the override is not orphaned', async () => {
    await h.boot();
    h.state.history.insertRule('Main', 'moto', RENT);
    const put = await call('PUT', '/api/dashboard/payments/Main/moto/state', { body: { enabled: false } });
    expect(put.status).toBe(200);
    const overrides = await call('GET', '/api/dashboard/payment-overrides');
    expect(overrides.json.overrides.map((o) => [o.alertId, o.orphaned])).toEqual([['moto', false]]);
  });

  test('a stored rule on a server without a block is not an active rule', async () => {
    await h.boot({ servers: [{ name: 'Main' }] });
    h.state.history.insertRule('Main', 'moto', RENT);
    const put = await call('PUT', '/api/dashboard/payments/Main/moto/state', { body: { enabled: false } });
    expect(put.json).toEqual({ error: 'alert_not_found' });
  });
});

describe('GET /api/dashboard/capabilities channels (#262)', () => {
  test('lists the ALL_CHANNELS names that have a destination', async () => {
    await h.boot({
      sender: makeSender({ telegram: { enabled: true }, ntfy: { enabled: true, url: 'https://n.test/t' }, webhooks: { slack: [{ url: 'https://s.test/x' }] } })
    });
    const res = await call('GET', '/api/dashboard/capabilities');
    expect(res.json).toEqual({ configWrites: true, reason: null, channels: ['telegram', 'slack', 'ntfy'] });
  });

  test('no notification service gives an empty list', async () => {
    await h.boot();
    h.state.svc.notificationService = undefined;
    expect((await call('GET', '/api/dashboard/capabilities')).json.channels).toEqual([]);
  });
});

describe('route table in docs/HEALTH_CHECK.md (#262)', () => {
  const PATH_PREFIXES = ['/api/dashboard/payment-schedules', '/api/dashboard/payment-rules', '/api/dashboard/payment-preview'];

  function documentedRoutes() {
    const doc = fs.readFileSync(require('path').join(__dirname, '../../docs/HEALTH_CHECK.md'), 'utf8');
    return doc.split('\n')
      .map((line) => /^\|\s*(GET|POST|PUT|DELETE)\s*\|\s*`([^`]+)`\s*\|/.exec(line))
      .filter((m) => m && PATH_PREFIXES.some((p) => m[2].startsWith(p)))
      .map((m) => `${m[1]} ${m[2]}`)
      .sort();
  }

  function mountedRoutes(svc) {
    const found = [];
    const visit = (stack) => {
      for (const layer of stack) {
        if (layer.route) {
          for (const method of Object.keys(layer.route.methods)) {
            if (PATH_PREFIXES.some((p) => layer.route.path.startsWith(p))) {
              found.push(`${method.toUpperCase()} ${layer.route.path}`);
            }
          }
        } else if (layer.handle && Array.isArray(layer.handle.stack)) {
          visit(layer.handle.stack);
        }
      }
    };
    visit(svc.app.router.stack);
    return found.sort();
  }

  test('the six documented routes are exactly the routes mounted, including the nested config router', async () => {
    await h.boot();
    const documented = documentedRoutes();
    expect(documented).toHaveLength(6);
    expect(mountedRoutes(h.state.svc)).toEqual(documented);
  });
});
