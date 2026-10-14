/** POST /api/dashboard/payment-preview/:server (#262): preview, test send, rate limit. */
const { destinationKey } = require('../lib/scheduleAlertDelivery');
const { basicHeader, createHarness } = require('./helpers/paymentRulesHarness');

const h = createHarness();
const { call } = h;
const URL_ = (s = 'Main') => `/api/dashboard/payment-preview/${s}`;
const RULE = { id: 'moto', schedule: 'Rent - Moto', graceDays: 5 };
const SLACK = { url: 'https://hooks.slack.test/secret-token', name: 'ops' };
const SNAPSHOT = [{
  id: 's1', name: 'Rent - Moto', cadenceText: 'Every month on the 1st', amount: -85000, amountMin: null, amountMax: null,
  amountOp: 'is', account: 'Checking', payee: 'Landlord', nextDate: '2026-11-01', completed: false
}];
const rowCount = (table) => h.state.history.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

afterEach(async () => { await h.cleanup(); jest.restoreAllMocks(); });

describe('preview without send (#262)', () => {
  test('renders with the stored schedule, lists the sample keys and sends nothing', async () => {
    await h.boot();
    h.state.history.replaceScheduleSnapshot('Main', SNAPSHOT, '2026-10-14T07:00:00.000Z');
    const res = await call('POST', URL_(), { body: { rule: RULE, event: 'missing' } });
    expect(res.status).toBe(200);
    expect(res.json.sent).toBe(false);
    expect(res.json.results).toEqual([]);
    expect(res.json.text).toMatch(/Rent - Moto/);
    expect(res.json.text).toMatch(/Landlord/);
    expect(res.json.sampleKeys).toEqual(['deadline', 'days_overdue']);
    expect(h.state.sender.calls).toHaveLength(0);
  });

  test('with no matching schedule every schedule variable is a sample', async () => {
    await h.boot();
    const res = await call('POST', URL_(), { body: { rule: RULE, event: 'missing' } });
    expect(res.json.text).toMatch(/Sample payment/);
    expect(res.json.sampleKeys).toEqual(expect.arrayContaining(['name', 'payee', 'account']));
  });

  test('a prefix rule previews against the first match in name order', async () => {
    await h.boot();
    h.state.history.replaceScheduleSnapshot('Main', [
      { ...SNAPSHOT[0], id: 's2', name: 'Rent - B' }, { ...SNAPSHOT[0], id: 's1', name: 'Rent - A' }
    ], '2026-10-14T07:00:00.000Z');
    const res = await call('POST', URL_(), { body: { rule: { id: 'rents', schedulePrefix: 'Rent' }, event: 'missing' } });
    expect(res.json.text).toMatch(/Rent - A/);
  });

  test.each(['missing', 'wrongAmount', 'resolved', 'cannotCheck', 'ruleUnmatched', 'muteEnded'])('event %s renders', async (event) => {
    await h.boot();
    const res = await call('POST', URL_(), { body: { rule: RULE, event } });
    expect(res.status).toBe(200);
    expect(typeof res.json.text).toBe('string');
  });

  test('writes no ledger, status or audit row', async () => {
    await h.boot();
    await call('POST', URL_(), { body: { rule: RULE, event: 'missing', send: true } });
    expect(rowCount('schedule_alerts')).toBe(0);
    expect(rowCount('payment_alert_status')).toBe(0);
    expect(rowCount('config_audit')).toBe(0);
    expect(rowCount('payment_alert_rule')).toBe(0);
  });
});

describe('preview with send (#262)', () => {
  const config = { telegram: { enabled: true }, webhooks: { slack: [SLACK], discord: [{ url: 'https://d.test/secret-token' }] } };

  test('one message per destination; the response never carries a URL or token', async () => {
    await h.boot({ config });
    const res = await call('POST', URL_(), { body: { rule: RULE, event: 'missing', send: true } });
    expect(res.status).toBe(200);
    expect(res.json.sent).toBe(true);
    expect(h.state.sender.calls.map((c) => Object.keys(c))).toEqual([['telegram'], ['slack'], ['discord']]);
    expect(res.json.results).toEqual([
      { channel: 'telegram', target: 'telegram', ok: true },
      { channel: 'slack', target: 'ops', ok: true },
      { channel: 'discord', target: destinationKey('discord', { url: 'https://d.test/secret-token' }), ok: true }
    ]);
    expect(res.text).not.toMatch(/secret-token|hooks\.slack|d\.test/);
  });

  test('partial failure is 200 with sent true and a closed error code', async () => {
    await h.boot({ config });
    h.state.sender.result = (o) => (o.slack ? { slack: { success: false } } : Object.fromEntries(Object.keys(o).map((k) => [k, { success: true }])));
    const res = await call('POST', URL_(), { body: { rule: RULE, event: 'missing', send: true } });
    expect(res.status).toBe(200);
    expect(res.json.sent).toBe(true);
    expect(res.json.results.find((r) => r.channel === 'slack')).toEqual({ channel: 'slack', target: 'ops', ok: false, error: 'send_failed' });
  });

  test('all destinations failing is 502 send_failed with the results, no exception text', async () => {
    await h.boot({ config });
    h.state.sender.result = () => { throw new Error('boom https://hooks.slack.test/secret-token'); };
    const res = await call('POST', URL_(), { body: { rule: RULE, event: 'missing', send: true } });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('send_failed');
    expect(res.json.sent).toBe(false);
    expect(res.json.results.every((r) => r.ok === false && r.error === 'send_threw')).toBe(true);
    expect(res.text).not.toMatch(/boom|secret-token/);
  });

  test('zero destinations is 400 no_configured_destination and sends nothing', async () => {
    await h.boot({ config: {} });
    const res = await call('POST', URL_(), { body: { rule: RULE, event: 'missing', send: true } });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'no_configured_destination' });
  });

  test('the 6th validated test send in a minute is 429 and sends nothing; previews and 4xx do not count', async () => {
    await h.boot({ config: { telegram: { enabled: true } } });
    const send = () => call('POST', URL_(), { body: { rule: RULE, event: 'missing', send: true } });
    // none of these count
    for (let i = 0; i < 6; i += 1) await call('POST', URL_(), { body: { rule: RULE, event: 'missing' } });
    for (let i = 0; i < 6; i += 1) await call('POST', URL_(), { body: { rule: { id: 'x' }, event: 'missing', send: true } });
    for (let i = 0; i < 5; i += 1) expect((await send()).status).toBe(200);
    expect(h.state.sender.calls).toHaveLength(5);
    const sixth = await send();
    expect(sixth.status).toBe(429);
    expect(sixth.json).toEqual({ error: 'test_send_rate_limited' });
    expect(h.state.sender.calls).toHaveLength(5);
    // a plain preview is still allowed
    expect((await call('POST', URL_(), { body: { rule: RULE, event: 'missing' } })).status).toBe(200);
  });

  test('the window slides: a send older than a minute stops counting', async () => {
    await h.boot({ config: { telegram: { enabled: true } } });
    const realNow = Date.now;
    let t = realNow();
    jest.spyOn(Date, 'now').mockImplementation(() => t);
    try {
      const send = () => call('POST', URL_(), { body: { rule: RULE, event: 'missing', send: true } });
      for (let i = 0; i < 5; i += 1) await send();
      expect((await send()).status).toBe(429);
      t += 61 * 1000;
      expect((await send()).status).toBe(200);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('preview validation and gates (#262)', () => {
  test('body errors', async () => {
    await h.boot();
    expect((await call('POST', URL_(), { body: { rule: RULE, event: 'bogus' } })).json).toEqual({ error: 'invalid_event' });
    expect((await call('POST', URL_(), { body: { event: 'missing' } })).json).toEqual({ error: 'invalid_body' });
    expect((await call('POST', URL_(), { body: { rule: RULE } })).json).toEqual({ error: 'invalid_body' });
    expect((await call('POST', URL_(), { body: { rule: RULE, event: 'missing', send: 'yes' } })).json).toEqual({ error: 'invalid_body' });
    expect((await call('POST', URL_(), { body: { rule: RULE, event: 5 } })).json).toEqual({ error: 'invalid_body' });
    expect((await call('POST', URL_(), { body: '[]' })).json).toEqual({ error: 'invalid_body' });
  });

  test('the posted rule is validated like a save', async () => {
    await h.boot();
    const bad = await call('POST', URL_(), { body: { rule: { id: 'a' }, event: 'missing' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('invalid_rule');
    const enabled = await call('POST', URL_(), { body: { rule: { ...RULE, enabled: false }, event: 'missing' } });
    expect(enabled.json.details.map((d) => d.path)).toContain('/enabled');
    const tpl = await call('POST', URL_(), { body: { rule: { ...RULE, templates: { missing: '{{nope}}' } }, event: 'missing' } });
    expect(tpl.json).toMatchObject({ error: 'invalid_template', token: 'nope' });
    expect(h.state.sender.calls).toHaveLength(0);
  });

  test('server_not_found first, then alerts_not_configured', async () => {
    await h.boot({ servers: [{ name: 'Main' }] });
    expect((await call('POST', URL_('Nope'), { body: {} })).json).toEqual({ error: 'server_not_found' });
    expect((await call('POST', URL_(), { body: { rule: RULE, event: 'missing' } })).json).toEqual({ error: 'alerts_not_configured' });
  });

  test('401 for no, wrong credentials; 403 off-origin and writes disabled; 415 and 413', async () => {
    await h.boot();
    const body = { rule: RULE, event: 'missing' };
    expect((await call('POST', URL_(), { body, auth: null })).status).toBe(401);
    expect((await call('POST', URL_(), { body, auth: basicHeader('wrong') })).status).toBe(401);
    expect((await call('POST', URL_(), { body, headers: { Origin: 'https://evil.example' } })).json).toEqual({ error: 'origin_rejected' });
    expect((await call('POST', URL_(), { body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await call('POST', URL_(), { body: JSON.stringify({ rule: 'x'.repeat(17 * 1024) }) })).status).toBe(413);
    await h.cleanup();
    await h.boot({ dashboard: { allowConfigWrites: false } });
    expect((await call('POST', URL_(), { body })).json).toEqual({ error: 'config_writes_disabled', reason: 'disabled' });
  });

  test('an unexpected failure gives a fixed 500 body', async () => {
    await h.boot();
    jest.spyOn(h.state.history, 'getScheduleSnapshot').mockImplementation(() => { throw new Error('disk I/O secret-path'); });
    const res = await call('POST', URL_(), { body: { rule: RULE, event: 'missing' } });
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'Failed to preview payment rule' });
    expect(res.text).not.toContain('secret-path');
  });
});
