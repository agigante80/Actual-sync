/**
 * Tests for the vendored Actual Budget schedule helpers (#258).
 *
 * Two concerns: (1) the import allow-list stays enforced, so this file can
 * never grow a dependency on the rest of the codebase and remains a drop-in
 * replacement for whatever Actual eventually exports itself; (2) the ported
 * logic (occurrence expansion, weekend skipping, cadence wording) behaves the
 * way Actual's own schedule.ts does, since `scheduleAlerts.js` trusts it
 * completely for "what does this schedule's recurrence mean".
 */

const fs = require('fs');
const path = require('path');
const {
  parseDate,
  dayFromDate,
  getDateWithSkippedWeekend,
  parseRecurDate,
  getRecurringDescription
} = require('../lib/vendor/actualSchedules');

const VENDOR_FILE = path.join(__dirname, '..', 'lib', 'vendor', 'actualSchedules.js');

describe('import allow-list', () => {
  test('only requires @rschedule/* or date-fns', () => {
    const source = fs.readFileSync(VENDOR_FILE, 'utf8');
    const requireCalls = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    expect(requireCalls.length).toBeGreaterThan(0);
    for (const spec of requireCalls) {
      expect(spec === 'date-fns' || spec.startsWith('@rschedule/')).toBe(true);
    }
  });
});

describe('parseDate / dayFromDate', () => {
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

  test('dayFromDate formats back to yyyy-MM-dd', () => {
    expect(dayFromDate('2026-03-05')).toBe('2026-03-05');
  });
});

describe('getDateWithSkippedWeekend', () => {
  test('rolls a Saturday forward to Monday when solveMode is "after"', () => {
    const saturday = parseDate('2026-01-03'); // a Saturday
    const rolled = getDateWithSkippedWeekend(saturday, 'after');
    expect(rolled.getDay()).toBe(1);
  });

  test('rolls a Sunday back to Friday when solveMode is "before"', () => {
    const sunday = parseDate('2026-01-04'); // a Sunday
    const rolled = getDateWithSkippedWeekend(sunday, 'before');
    expect(rolled.getDay()).toBe(5);
  });

  test('leaves a weekday unchanged', () => {
    const tuesday = parseDate('2026-01-06');
    expect(getDateWithSkippedWeekend(tuesday, 'after')).toBe(tuesday);
  });

  test('throws on an unknown solve mode for a weekend date', () => {
    const saturday = parseDate('2026-01-03');
    expect(() => getDateWithSkippedWeekend(saturday, 'bogus')).toThrow('Unknown weekend solve mode');
  });
});

describe('parseRecurDate + occurrence expansion', () => {
  test('daily frequency yields one occurrence per day', () => {
    const { schedule } = parseRecurDate({ start: '2026-01-01', frequency: 'daily' });
    const occ = schedule.occurrences({ start: parseDate('2026-01-01'), end: parseDate('2026-01-05') }).toArray();
    expect(occ).toHaveLength(5);
  });

  test('weekly frequency with an interval skips weeks', () => {
    const { schedule } = parseRecurDate({ start: '2026-01-05', frequency: 'weekly', interval: 2 });
    const occ = schedule.occurrences({ start: parseDate('2026-01-01'), end: parseDate('2026-02-28') }).toArray();
    const days = occ.map((o) => dayFromDate(o.date));
    expect(days).toEqual(['2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16']);
  });

  test('monthly frequency with a day-of-month pattern', () => {
    const { schedule } = parseRecurDate({
      start: '2026-01-05',
      frequency: 'monthly',
      patterns: [{ type: 'day', value: 5 }]
    });
    const occ = schedule.occurrences({ start: parseDate('2026-01-01'), end: parseDate('2026-03-31') }).toArray();
    const days = occ.map((o) => dayFromDate(o.date));
    expect(days).toEqual(['2026-01-05', '2026-02-05', '2026-03-05']);
  });

  test('endMode after_n_occurrences stops after the configured count', () => {
    const { schedule } = parseRecurDate({ start: '2026-01-01', frequency: 'daily', endMode: 'after_n_occurrences', endOccurrences: 3 });
    const occ = schedule.occurrences({ start: parseDate('2026-01-01'), end: parseDate('2026-12-31') }).toArray();
    expect(occ).toHaveLength(3);
  });

  test('endMode on_date stops after the given end date', () => {
    const { schedule } = parseRecurDate({ start: '2026-01-01', frequency: 'daily', endMode: 'on_date', endDate: '2026-01-03' });
    const occ = schedule.occurrences({ start: parseDate('2026-01-01'), end: parseDate('2026-12-31') }).toArray();
    const days = occ.map((o) => dayFromDate(o.date));
    expect(days).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  test('an unsupported frequency throws', () => {
    expect(() => parseRecurDate({ start: '2026-01-01', frequency: 'fortnightly' })).toThrow('Invalid recurring schedule config');
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
