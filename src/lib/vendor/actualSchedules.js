/**
 * Vendored schedule helpers from Actual Budget (#258).
 *
 * Actual Budget (https://github.com/actualbudget/actual) is MIT-licensed.
 * These functions are not exported by `@actual-app/api`, so `getSchedules()`
 * gives us the raw recurrence config but nothing that expands it into
 * occurrence dates or renders Actual's own cadence wording. This file ports
 * the minimum needed for that, kept import-clean (only `@rschedule/*` and
 * `date-fns`, see `actualSchedules.vendor.test.js`) so it can be dropped once
 * Actual exports these helpers itself (tracking issue to be filed upstream;
 * link it here once opened).
 *
 * Provenance:
 * - Upstream repository: https://github.com/actualbudget/actual
 * - Vendored from npm package @actual-app/core@26.9.0
 * - Upstream commit (tag v26.9.0): 59fe126f637d858c061e1eeedbef5436c8f2225a
 * - Ported from:
 *   - packages/loot-core/src/shared/schedules.ts
 *     -> `recurConfigToRSchedule`, `getDateWithSkippedWeekend`
 *   - packages/loot-core/src/server/rules/rule-utils.ts
 *     -> `parseRecurDate` (simplified: throws a plain Error instead of
 *        Actual's internal RuleError, which this project does not use)
 *   - packages/loot-core/src/server/util/rschedule.ts
 *     -> the `RSchedule` wrapper class and its `@rschedule/*` setup
 *   - packages/desktop-client/src/util/schedule.ts
 *     -> `getRecurringDescription` (Actual's own cadence wording, e.g.
 *        "Every month on the 5th"). Actual's `t()` (i18next) is replaced by
 *        an identity function (`t = (s) => s`, ignoring interpolation
 *        objects) since this project has no i18n layer; the "{{token}}"
 *        placeholders are still substituted so the English strings match
 *        Actual's own `schedule.test.ts` fixtures exactly. `monthUtils.format`
 *        calls are ported to plain `date-fns` (`monthUtils.format(date, fmt,
 *        locale)` is itself a thin wrapper over `date-fns.format`).
 *
 * License: MIT (see https://github.com/actualbudget/actual/blob/master/LICENSE.txt)
 */

'use strict';

// Import allow-list enforced by actualSchedules.vendor.test.js: this file may
// only import from `@rschedule/*` and `date-fns`, so it stays a drop-in
// replacement for whatever Actual eventually exports, and never grows a
// dependency on the rest of this codebase.
require('@rschedule/standard-date-adapter/setup');
const { Schedule: OriginalSchedule } = require('@rschedule/core/generators');
const d = require('date-fns');

/** Wrapper class, exactly as Actual defines it (constructor behavior when bundled). */
class RSchedule extends OriginalSchedule {}

/**
 * Parse a plain `YYYY-MM-DD` / `YYYY-MM` / `YYYY` string into a local Date
 * anchored at 12:00, exactly like Actual's `monthUtils.parseDate`. Anchoring
 * at noon keeps date arithmetic clear of any DST transition, which can shift
 * a midnight-anchored date by an hour into the previous or next day.
 *
 * @param {string} value
 * @returns {Date}
 */
function parseDate(value) {
  if (value instanceof Date) return value;
  const [year, month, day] = String(value).split('-');
  if (day != null) {
    return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), 12);
  } else if (month != null) {
    return new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1, 12);
  }
  return new Date(parseInt(year, 10), 0, 1, 12);
}

/**
 * Format a Date/`YYYY-MM-DD` value as `yyyy-MM-dd`, matching
 * `monthUtils.dayFromDate`.
 * @param {Date|string} value
 * @returns {string}
 */
function dayFromDate(value) {
  return d.format(value instanceof Date ? value : parseDate(value), 'yyyy-MM-dd');
}

/**
 * Convert Actual's `RecurConfig` (a schedule's `date` field, when recurring)
 * into the `@rschedule` rule option(s) it represents. Ported unchanged from
 * `packages/loot-core/src/shared/schedules.ts`.
 *
 * @param {Object} config
 * @returns {Object[]} one or more rschedule `IRuleOptions`
 */
function recurConfigToRSchedule(config) {
  const base = {
    start: parseDate(config.start),
    frequency: config.frequency.toUpperCase(),
    byHourOfDay: [12]
  };

  if (config.interval) {
    base.interval = config.interval;
  }

  switch (config.endMode) {
    case 'after_n_occurrences':
      base.count = config.endOccurrences;
      break;
    case 'on_date':
      base.end = parseDate(config.endDate);
      break;
    default:
      break;
  }

  const abbrevDay = (name) => name.slice(0, 2).toUpperCase();

  switch (config.frequency) {
    case 'daily':
      return [base];
    case 'weekly':
      return [base];
    case 'monthly':
      if (config.patterns && config.patterns.length > 0) {
        const days = config.patterns.filter((p) => p.type === 'day');
        const dayNames = config.patterns.filter((p) => p.type !== 'day');

        return [
          days.length > 0 && { ...base, byDayOfMonth: days.map((p) => p.value) },
          dayNames.length > 0 && {
            ...base,
            byDayOfWeek: dayNames.map((p) => [abbrevDay(p.type), p.value])
          }
        ].filter(Boolean);
      }
      return [base];
    case 'yearly':
      return [base];
    default:
      throw new Error('Invalid recurring date config');
  }
}

/**
 * Move a weekend date to the nearest weekday, exactly as Actual's own
 * "avoid weekends" schedule option does. Ported unchanged from
 * `packages/loot-core/src/shared/schedules.ts`.
 *
 * @param {Date} date
 * @param {'after'|'before'} solveMode
 * @returns {Date}
 */
function getDateWithSkippedWeekend(date, solveMode) {
  if (d.isWeekend(date)) {
    if (solveMode === 'after') {
      return d.nextMonday(date);
    } else if (solveMode === 'before') {
      return d.previousFriday(date);
    }
    throw new Error('Unknown weekend solve mode, this should not happen!');
  }
  return date;
}

/**
 * Build an `RSchedule` instance for a schedule's recurring `date` config, the
 * same object shape Actual's rule engine works with. Simplified from
 * `packages/loot-core/src/server/rules/rule-utils.ts`: Actual wraps parse
 * failures in its internal `RuleError`, which this project has no equivalent
 * of or use for, so a plain `Error` is thrown instead.
 *
 * @param {Object} desc - a schedule's recurring `date` config
 * @returns {{ type: 'recur', schedule: RSchedule }}
 */
function parseRecurDate(desc) {
  try {
    const rules = recurConfigToRSchedule(desc);
    return {
      type: 'recur',
      schedule: new RSchedule({
        rrules: rules,
        data: {
          skipWeekend: desc.skipWeekend,
          weekendSolve: desc.weekendSolveMode
        }
      })
    };
  } catch (e) {
    throw new Error(`Invalid recurring schedule config: ${e.message}`);
  }
}

/** Identity "translation" function: this project has no i18n layer (#258). */
function t(str) {
  return str;
}

function makeNumberSuffix(num, locale) {
  return d.format(new Date(2020, 0, num, 12), 'do', locale ? { locale } : undefined);
}

function prettyDayName(day) {
  const days = {
    SU: 'Sunday',
    MO: 'Monday',
    TU: 'Tuesday',
    WE: 'Wednesday',
    TH: 'Thursday',
    FR: 'Friday',
    SA: 'Saturday'
  };
  return days[day];
}

/**
 * Actual's own cadence wording for a schedule, e.g. "Every month on the
 * 5th". Ported from `packages/desktop-client/src/util/schedule.ts`, with
 * `i18next`'s `t()` replaced by the identity `t()` above (see the module
 * doc comment) and `monthUtils.format` replaced by plain `date-fns.format`.
 *
 * @param {Object} config - a schedule's recurring `date` config
 * @param {string} dateFormat - a date-fns format string, e.g. 'd MMM yyyy'
 * @param {Object} [locale] - a date-fns Locale object
 * @returns {string}
 */
function getRecurringDescription(config, dateFormat, locale) {
  const interval = config.interval || 1;
  const opts = locale ? { locale } : undefined;

  let endModeSuffix = '';
  switch (config.endMode) {
    case 'after_n_occurrences':
      endModeSuffix = config.endOccurrences === 1 ? t('once') : t(`${config.endOccurrences} times`);
      break;
    case 'on_date':
      endModeSuffix = t(`until ${d.format(parseDate(config.endDate), dateFormat, opts)}`);
      break;
    default:
      break;
  }

  const weekendSolveModeString = config.weekendSolveMode
    ? config.weekendSolveMode === 'after'
      ? t('(after weekend)')
      : t('(before weekend)')
    : '';
  const weekendSolveSuffix = config.skipWeekend ? weekendSolveModeString : '';

  let suffix = '';
  if (endModeSuffix) suffix += `, ${endModeSuffix}`;
  if (weekendSolveSuffix) suffix += ` ${weekendSolveSuffix}`;

  let desc = null;

  switch (config.frequency) {
    case 'daily':
      desc = interval !== 1 ? t(`Every ${interval} days`) : t('Every day');
      break;
    case 'weekly':
      desc = interval !== 1
        ? t(`Every ${interval} weeks on ${d.format(parseDate(config.start), 'EEEE', opts)}`)
        : t(`Every week on ${d.format(parseDate(config.start), 'EEEE', opts)}`);
      break;
    case 'monthly':
      if (config.patterns && config.patterns.length > 0) {
        let patterns = [...config.patterns]
          .sort((p1, p2) => {
            const typeOrder = (p1.type === 'day' ? 1 : 0) - (p2.type === 'day' ? 1 : 0);
            const valOrder = p1.value - p2.value;
            return typeOrder === 0 ? valOrder : typeOrder;
          })
          .filter((p) => p.value !== -1);
        patterns = patterns.concat(config.patterns.filter((p) => p.value === -1));

        const strs = [];
        const uniqueDays = new Set(patterns.map((p) => p.type));
        const isSameDay = uniqueDays.size === 1 && !uniqueDays.has('day');

        for (const pattern of patterns) {
          if (pattern.type === 'day') {
            strs.push(pattern.value === -1 ? t('last day') : makeNumberSuffix(pattern.value, locale));
          } else {
            const dayName = isSameDay ? '' : ' ' + prettyDayName(pattern.type);
            strs.push(
              pattern.value === -1
                ? t('last') + dayName
                : makeNumberSuffix(pattern.value, locale) + dayName
            );
          }
        }

        let range = '';
        if (strs.length > 2) {
          range += strs.slice(0, strs.length - 1).join(', ');
          range += `, ${t('and')} `;
          range += strs[strs.length - 1];
        } else {
          range += strs.join(` ${t('and')} `);
        }
        if (isSameDay) range += ' ' + prettyDayName(patterns[0].type);

        desc = interval !== 1
          ? t(`Every ${interval} months on the ${range}`)
          : t(`Every month on the ${range}`);
      } else {
        const dateFormatted = d.format(parseDate(config.start), 'do', opts);
        desc = interval !== 1
          ? t(`Every ${interval} months on the ${dateFormatted}`)
          : t(`Every month on the ${dateFormatted}`);
      }
      break;
    case 'yearly': {
      const dateFormatted = d.format(parseDate(config.start), 'LLL do', opts);
      desc = interval !== 1
        ? t(`Every ${interval} years on ${dateFormatted}`)
        : t(`Every year on ${dateFormatted}`);
      break;
    }
    default:
      return t('Recurring error');
  }

  return `${desc}${suffix}`.trim();
}

module.exports = {
  RSchedule,
  parseDate,
  dayFromDate,
  recurConfigToRSchedule,
  getDateWithSkippedWeekend,
  parseRecurDate,
  getRecurringDescription
};
