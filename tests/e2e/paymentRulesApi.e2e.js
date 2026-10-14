/**
 * The payment rule API against the fixture server (#262): the seeders #268 uses
 * (scheduleSnapshot, dashboardRule), the list and the create / preview round
 * trip over real HTTP with basic auth. No browser is involved.
 */
const { startFixtureServer } = require('./fixtures');

const AUTH = `Basic ${Buffer.from('fixture-user:fixture-pass').toString('base64')}`;

async function api(fixture, method, path, body) {
  const res = await fetch(`${fixture.url}${path}`, {
    method,
    headers: { Authorization: AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json() };
}

describe('payment rule API on the fixture server (#262)', () => {
  let fixture;
  beforeEach(async () => { fixture = await startFixtureServer('payment-rules-editor'); });
  afterEach(async () => { await fixture.close(); });

  test('the seeded snapshot and rule are served', async () => {
    const schedules = await api(fixture, 'GET', '/api/dashboard/payment-schedules/Main');
    expect(schedules.status).toBe(200);
    expect(schedules.json.schedules.map((s) => s.name)).toEqual(['Gym', 'Rent - Flat']);
    expect(schedules.json.defaults.graceDays).toBe(3);
    const rules = await api(fixture, 'GET', '/api/dashboard/payment-rules/Main');
    expect(rules.json.rules.map((r) => [r.id, r.source])).toEqual([['cfg-rent', 'config'], ['gym', 'dashboard']]);
  });

  test('create, then preview and test-send the new rule', async () => {
    const rule = { id: 'flat-late', schedule: 'Rent - Flat', graceDays: 6 };
    const created = await api(fixture, 'POST', '/api/dashboard/payment-rules/Main', rule);
    expect(created.status).toBe(201);
    const preview = await api(fixture, 'POST', '/api/dashboard/payment-preview/Main', { rule, event: 'missing', send: true });
    expect(preview.status).toBe(200);
    expect(preview.json.sent).toBe(true);
    expect(fixture.sentNotifications.filter((n) => n.channel === 'templated')).toHaveLength(1);
    expect((await api(fixture, 'GET', '/api/dashboard/capabilities')).json.channels).toEqual(['discord']);
  });
});
