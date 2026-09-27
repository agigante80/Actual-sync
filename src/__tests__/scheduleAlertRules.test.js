/**
 * Tests for the schedule alert rule loader (#258).
 *
 * `getRules`/`expandRules`/`checkUniqueIds` are pure data transforms; no
 * mocking is needed, only plain config objects and schedule arrays.
 */

const {
  slugify,
  deriveRuleId,
  getRules,
  checkUniqueIds,
  expandRules,
  DEFAULT_GRACE_DAYS,
  DEFAULT_EARLY_DAYS,
  DEFAULT_STALE_AFTER_DAYS
} = require('../lib/scheduleAlertRules');

describe('slugify', () => {
  test('lowercases and hyphenates', () => {
    expect(slugify('Rent - Apartment')).toBe('rent-apartment');
  });

  test('strips leading/trailing separators', () => {
    expect(slugify('  Salary!!  ')).toBe('salary');
  });

  test('falls back to "alert" for an empty/undefined value', () => {
    expect(slugify('')).toBe('alert');
    expect(slugify(undefined)).toBe('alert');
  });

  test('truncates to 64 characters, matching the config schema pattern', () => {
    const long = 'a'.repeat(100);
    const slug = slugify(long);
    expect(slug.length).toBe(64);
    expect(slug).toMatch(/^[a-z0-9-]{1,64}$/);
  });
});

describe('deriveRuleId', () => {
  test('uses the explicit id when given', () => {
    expect(deriveRuleId({ id: 'rent', schedule: 'Rent - Apartment' })).toBe('rent');
  });

  test('slugifies schedule when no id is given', () => {
    expect(deriveRuleId({ schedule: 'Rent - Apartment' })).toBe('rent-apartment');
  });

  test('slugifies schedulePrefix when no id or schedule is given', () => {
    expect(deriveRuleId({ schedulePrefix: 'Utilities' })).toBe('utilities');
  });
});

describe('getRules', () => {
  test('returns [] for a missing or malformed scheduleAlerts block', () => {
    expect(getRules(undefined)).toEqual([]);
    expect(getRules(null)).toEqual([]);
    expect(getRules({})).toEqual([]);
    expect(getRules({ alerts: 'not-an-array' })).toEqual([]);
  });

  test('applies built-in defaults when the block and alert set nothing', () => {
    const rules = getRules({ alerts: [{ id: 'rent', schedule: 'Rent' }] });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      id: 'rent',
      schedule: 'Rent',
      schedulePrefix: null,
      graceDays: DEFAULT_GRACE_DAYS,
      earlyDays: DEFAULT_EARLY_DAYS,
      period: 'occurrence',
      remindEveryDays: 0,
      staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
      dateFormat: 'D MMM YYYY',
      locale: 'en',
      digest: false
    });
    expect(rules[0].channels).toBeUndefined();
    expect(rules[0].amountTolerancePct).toBeUndefined();
  });

  test('an alert-level setting overrides its own field only', () => {
    const rules = getRules({
      staleAfterDays: 10,
      digest: true,
      alerts: [{ id: 'rent', schedule: 'Rent', graceDays: 6, earlyDays: 5, amountTolerancePct: 0, remindEveryDays: 2, channels: ['telegram'] }]
    });
    expect(rules[0]).toMatchObject({
      graceDays: 6,
      earlyDays: 5,
      amountTolerancePct: 0,
      remindEveryDays: 2,
      channels: ['telegram'],
      staleAfterDays: 10,
      digest: true
    });
  });

  test('merges block-level and alert-level templates, alert wins on a shared key', () => {
    const rules = getRules({
      templates: { missing: 'block missing', resolved: 'block resolved' },
      alerts: [{ id: 'rent', schedule: 'Rent', templates: { missing: 'alert missing' } }]
    });
    expect(rules[0].templates).toEqual({ missing: 'alert missing', resolved: 'block resolved' });
  });

  test('one rule per alerts[] entry, each independently normalized', () => {
    const rules = getRules({
      alerts: [
        { id: 'rent', schedule: 'Rent' },
        { id: 'salary', schedule: 'Salary', earlyDays: 5 }
      ]
    });
    expect(rules.map((r) => r.id)).toEqual(['rent', 'salary']);
    expect(rules[1].earlyDays).toBe(5);
    expect(rules[0].earlyDays).toBe(DEFAULT_EARLY_DAYS);
  });
});

describe('checkUniqueIds', () => {
  test('does not throw when every id in a server is unique', () => {
    expect(() => checkUniqueIds([
      { name: 'Main', scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent' }, { id: 'salary', schedule: 'Salary' }] } }
    ])).not.toThrow();
  });

  test('does not throw for servers without a scheduleAlerts block', () => {
    expect(() => checkUniqueIds([{ name: 'Main' }, { name: 'Other', scheduleAlerts: undefined }])).not.toThrow();
  });

  test('throws naming both colliding indices and the server on an explicit-id collision', () => {
    expect(() => checkUniqueIds([
      { name: 'Main', scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'A' }, { id: 'rent', schedule: 'B' }] } }
    ])).toThrow('scheduleAlerts.alerts: duplicate id "rent" at alerts[0] and alerts[1] (server "Main")');
  });

  test('throws on a derived-id collision (two schedules that slugify the same)', () => {
    expect(() => checkUniqueIds([
      { name: 'Main', scheduleAlerts: { alerts: [{ schedule: 'Rent!' }, { schedule: 'Rent?' }] } }
    ])).toThrow(/duplicate id "rent"/);
  });

  test('checks each server independently (same id in two servers is fine)', () => {
    expect(() => checkUniqueIds([
      { name: 'Main', scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent' }] } },
      { name: 'Other', scheduleAlerts: { alerts: [{ id: 'rent', schedule: 'Rent' }] } }
    ])).not.toThrow();
  });
});

describe('expandRules', () => {
  const schedules = [
    { id: 's1', name: 'Rent - Apartment' },
    { id: 's2', name: 'Utilities - Gas' },
    { id: 's3', name: 'Utilities - Electric' }
  ];

  test('a schedule rule with an exact name match expands to one binding', () => {
    const rules = getRules({ alerts: [{ id: 'rent', schedule: 'Rent - Apartment' }] });
    const bindings = expandRules(rules, schedules);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ id: 'rent', scheduleId: 's1', scheduleName: 'Rent - Apartment', unmatched: false });
  });

  test('a schedulePrefix rule expands to one binding per matching schedule, sharing the alert id', () => {
    const rules = getRules({ alerts: [{ id: 'utilities', schedulePrefix: 'Utilities' }] });
    const bindings = expandRules(rules, schedules);
    expect(bindings).toHaveLength(2);
    expect(bindings.map((b) => b.scheduleId).sort()).toEqual(['s2', 's3']);
    expect(bindings.every((b) => b.id === 'utilities')).toBe(true);
    expect(bindings.every((b) => b.unmatched === false)).toBe(true);
  });

  test('a rule matching no schedule expands to one unmatched binding', () => {
    const rules = getRules({ alerts: [{ id: 'ghost', schedule: 'Does Not Exist' }] });
    const bindings = expandRules(rules, schedules);
    expect(bindings).toEqual([expect.objectContaining({ id: 'ghost', scheduleId: null, scheduleName: null, schedule: null, unmatched: true })]);
  });

  test('an empty schedules array yields unmatched bindings for every rule', () => {
    const rules = getRules({ alerts: [{ id: 'rent', schedule: 'Rent - Apartment' }] });
    expect(expandRules(rules, [])).toEqual([expect.objectContaining({ unmatched: true })]);
  });

  // #295 review, H4: a completed schedule must not produce a binding (it
  // would otherwise still be evaluated and reported "missing" forever).
  //
  // #295 review round 2, M2 reverses H4's original choice of outcome here:
  // a name match against only a completed schedule is NOT the same as a
  // name mismatch, so it now produces no binding at all (and no
  // `ruleUnmatched`) rather than one `unmatched: true` binding - see the
  // rationale comment in `expandRules` for why the daily `ruleUnmatched` was
  // wrong for a paid one-off or a completed recurring schedule.
  test('a completed schedule is excluded, so a schedule rule matching only a completed one produces no binding and is not unmatched', () => {
    const rules = getRules({ alerts: [{ id: 'rent', schedule: 'Rent - Apartment' }] });
    const completedSchedules = [{ id: 's1', name: 'Rent - Apartment', completed: true }];
    expect(expandRules(rules, completedSchedules)).toEqual([]);
  });

  test('a rule matching no schedule by name at all is still unmatched (name mismatch, not completion)', () => {
    const rules = getRules({ alerts: [{ id: 'ghost', schedule: 'Does Not Exist' }] });
    const completedSchedules = [{ id: 's1', name: 'Rent - Apartment', completed: true }];
    expect(expandRules(rules, completedSchedules)).toEqual([expect.objectContaining({ id: 'ghost', unmatched: true, scheduleId: null })]);
  });

  test('a schedulePrefix rule skips a completed schedule but still expands the active ones', () => {
    const rules = getRules({ alerts: [{ id: 'utilities', schedulePrefix: 'Utilities' }] });
    const mixed = [
      { id: 's2', name: 'Utilities - Gas', completed: false },
      { id: 's3', name: 'Utilities - Electric', completed: true }
    ];
    const bindings = expandRules(rules, mixed);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ scheduleId: 's2', unmatched: false });
  });

  test('a schedulePrefix rule matching only completed schedules produces no binding and is not unmatched (#295 review round 2, M2)', () => {
    const rules = getRules({ alerts: [{ id: 'utilities', schedulePrefix: 'Utilities' }] });
    const allCompleted = [
      { id: 's2', name: 'Utilities - Gas', completed: true },
      { id: 's3', name: 'Utilities - Electric', completed: true }
    ];
    expect(expandRules(rules, allCompleted)).toEqual([]);
  });
});
