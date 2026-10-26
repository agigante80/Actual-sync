/**
 * validateScheduleAlert (#262): the shared rule validator.
 */
const { validateScheduleAlert } = require('../lib/scheduleAlertValidation');

const TELEGRAM = { telegram: { enabled: true, botToken: '1:AAAA', chatId: '1' } };

describe('validateScheduleAlert', () => {
  const dash = (rule, extra = {}) => validateScheduleAlert(rule, {
    notificationsConfig: TELEGRAM, dashboard: true, ...extra
  });

  it('accepts a minimal dashboard rule', () => {
    expect(dash({ id: 'rent', schedule: 'Rent' })).toMatchObject({ valid: true, code: null });
  });

  it('reports schema errors with a JSON pointer path', () => {
    const r = dash({ id: 'rent', schedule: 'Rent', graceDays: 99, bogus: 1 });
    expect(r.code).toBe('invalid_rule');
    expect(r.errors).toEqual(expect.arrayContaining([
      { path: '/graceDays', message: 'must be <= 60' },
      { path: '/bogus', message: 'is not a known field' }
    ]));
  });

  it('collapses the schedule / schedulePrefix oneOf into one message', () => {
    for (const rule of [{ id: 'a' }, { id: 'a', schedule: 'x', schedulePrefix: 'y' }]) {
      expect(dash(rule).errors).toEqual([
        { path: '', message: 'exactly one of schedule or schedulePrefix is required' }
      ]);
    }
  });

  it('dashboard mode rejects enabled and requires id; config mode does not', () => {
    expect(dash({ id: 'a', schedule: 'x', enabled: false }).errors.map(e => e.path)).toEqual(['/enabled']);
    expect(dash({ schedule: 'x' }).errors).toEqual([{ path: '/id', message: 'is required' }]);
    const cfg = validateScheduleAlert({ schedule: 'x', enabled: false }, { notificationsConfig: TELEGRAM });
    expect(cfg.valid).toBe(true);
  });

  it('rejects an invalid template with key, token, line and reason', () => {
    const r = dash({ id: 'a', schedule: 'x', templates: { missing: 'ok\n{{nope}}' } });
    expect(r.code).toBe('invalid_template');
    expect(r.template).toMatchObject({ template: 'missing', token: 'nope', line: 2, reason: 'unknown_variable' });
  });

  it('merges block templates under the rule templates', () => {
    const block = { templates: { missing: '{{nope}}' } };
    expect(dash({ id: 'a', schedule: 'x' }, { block }).code).toBe('invalid_template');
    expect(dash({ id: 'a', schedule: 'x', templates: { missing: 'fine' } }, { block }).valid).toBe(true);
  });

  it('config mode compiles only against the rule\'s resolved channels (a Telegram-only markup char needs a Telegram destination)', () => {
    const rule = { id: 'a', schedule: 'x', templates: { missing: 'a & b' } };
    expect(dash(rule).code).toBe('invalid_template');
    const slack = { webhooks: { slack: [{ url: 'https://hooks.slack.test/x' }] } };
    expect(validateScheduleAlert(rule, { notificationsConfig: slack, skipSchema: true }).valid).toBe(true);
    // #262 review F1: a dashboard save compiles against every requested
    // channel, because the sync checks dashboard rules that way and would
    // otherwise drop a rule the save accepted.
    expect(validateScheduleAlert(rule, { notificationsConfig: slack, dashboard: true }).code).toBe('invalid_template');
  });

  it('dashboard mode fails with no_configured_destination when nothing resolves', () => {
    expect(dash({ id: 'a', schedule: 'x' }, { notificationsConfig: {} }).code).toBe('no_configured_destination');
    expect(dash({ id: 'a', schedule: 'x', channels: ['slack'] }).code).toBe('no_configured_destination');
  });

  it('config mode without a restriction does not require a destination', () => {
    expect(validateScheduleAlert({ schedule: 'x' }, { notificationsConfig: {} }).valid).toBe(true);
    const r = validateScheduleAlert({ schedule: 'x', channels: ['slack'] }, { notificationsConfig: TELEGRAM });
    expect(r).toMatchObject({ code: 'no_configured_destination', channelsRestricted: ['slack'] });
  });

  it('schemaOnly skips channel resolution but still compiles templates', () => {
    expect(validateScheduleAlert({ id: 'a', schedule: 'x' }, { dashboard: true, schemaOnly: true }).valid).toBe(true);
    const bad = validateScheduleAlert({ id: 'a', schedule: 'x', templates: { missing: '{{nope}}' } },
      { dashboard: true, schemaOnly: true });
    expect(bad.code).toBe('invalid_template');
    expect(validateScheduleAlert({ id: 'a', schedule: 'x', graceDays: -1 }, { dashboard: true, schemaOnly: true }).code)
      .toBe('invalid_rule');
  });

  it('rejects a non-object', () => {
    expect(dash(null).code).toBe('invalid_rule');
    expect(dash([]).code).toBe('invalid_rule');
  });
});
