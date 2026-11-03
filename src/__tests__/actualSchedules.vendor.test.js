/**
 * Tests for the vendored Actual Budget cadence wording (#258, trimmed in #298).
 *
 * Two concerns: (1) the import allow-list stays enforced, so this file can
 * never grow a dependency on the rest of the codebase and remains a drop-in
 * replacement for whatever Actual eventually exports itself; (2) the ported
 * wording matches Actual's own schedule.ts. Occurrence dates are no longer
 * expanded here: they come from Actual's `getScheduleDates` (#298).
 */

const fs = require('fs');
const path = require('path');
const { parseDate, getRecurringDescription } = require('../lib/vendor/actualSchedules');

const VENDOR_FILE = path.join(__dirname, '..', 'lib', 'vendor', 'actualSchedules.js');

describe('import allow-list', () => {
  test('only requires date-fns', () => {
    const source = fs.readFileSync(VENDOR_FILE, 'utf8');
    const requireCalls = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    expect(requireCalls).toEqual(['date-fns']);
  });
});

describe('parseDate', () => {
  test('parses a full YYYY-MM-DD string anchored at noon', () => {
    const d = parseDate('2026-03-05');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(5);
    expect(d.getHours()).toBe(12);
  });

  test('parses a YYYY-MM string as the first of the month', () => {
    const d = parseDate('2026-03');
    expect(d.getDate()).toBe(1);
    expect(d.getMonth()).toBe(2);
  });
});

describe('getRecurringDescription', () => {
  test('daily, interval 1', () => {
    expect(getRecurringDescription({ start: '2026-01-01', frequency: 'daily' })).toBe('Every day');
  });

  test('daily, interval > 1', () => {
    expect(getRecurringDescription({ start: '2026-01-01', frequency: 'daily', interval: 3 })).toBe('Every 3 days');
  });

  test('weekly, interval 1, names the weekday', () => {
    // 2026-01-05 is a Monday.
    expect(getRecurringDescription({ start: '2026-01-05', frequency: 'weekly' })).toBe('Every week on Monday');
  });

  test('weekly, interval > 1', () => {
    expect(getRecurringDescription({ start: '2026-01-05', frequency: 'weekly', interval: 2 })).toBe('Every 2 weeks on Monday');
  });

  test('monthly with no patterns falls back to the start day-of-month ordinal', () => {
    expect(getRecurringDescription({ start: '2026-01-05', frequency: 'monthly' })).toBe('Every month on the 5th');
  });

  test('monthly with a day pattern', () => {
    expect(getRecurringDescription({
      start: '2026-01-05', frequency: 'monthly', patterns: [{ type: 'day', value: 5 }]
    })).toBe('Every month on the 5th');
  });

  test('monthly with a last-day pattern', () => {
    expect(getRecurringDescription({
      start: '2026-01-31', frequency: 'monthly', patterns: [{ type: 'day', value: -1 }]
    })).toBe('Every month on the last day');
  });

  test('yearly, interval 1', () => {
    expect(getRecurringDescription({ start: '2026-03-05', frequency: 'yearly' })).toBe('Every year on Mar 5th');
  });

  test('appends the "until <date>" suffix for endMode on_date', () => {
    const desc = getRecurringDescription(
      { start: '2026-01-01', frequency: 'daily', endMode: 'on_date', endDate: '2026-06-01' },
      'd MMM yyyy'
    );
    expect(desc).toBe('Every day, until 1 Jun 2026');
  });

  test('appends the weekend-skip suffix when skipWeekend is set', () => {
    const desc = getRecurringDescription({ start: '2026-01-01', frequency: 'daily', skipWeekend: true, weekendSolveMode: 'after' });
    expect(desc).toBe('Every day (after weekend)');
  });

  test('an unsupported frequency returns the error string, not a throw', () => {
    expect(getRecurringDescription({ start: '2026-01-01', frequency: 'fortnightly' })).toBe('Recurring error');
  });
});
