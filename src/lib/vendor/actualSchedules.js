/**
 * Vendored cadence wording from Actual Budget (#258, trimmed in #298).
 *
 * Actual Budget (https://github.com/actualbudget/actual) is MIT-licensed.
 * `@actual-app/api` 26.11.0 added `getScheduleDates` (actualbudget/actual#9020),
 * so occurrence dates now come from Actual itself and the recurrence expansion
 * that used to live here (`recurConfigToRSchedule`, `getDateWithSkippedWeekend`,
 * `parseRecurDate`, the `RSchedule` wrapper and its `@rschedule/*` setup) is
 * gone. What is left renders Actual's own cadence wording, which the api does
 * not export. It stays import-clean (only `date-fns`, see
 * `actualSchedules.vendor.test.js`) so it can be dropped once Actual exports it.
 *
 * Provenance:
 * - Upstream repository: https://github.com/actualbudget/actual
 * - Vendored from npm package @actual-app/core@26.9.0
 * - Upstream commit (tag v26.9.0): 59fe126f637d858c061e1eeedbef5436c8f2225a
 * - Ported from:
 *   - packages/desktop-client/src/util/schedule.ts
 *     -> `getRecurringDescription` (Actual's own cadence wording, e.g.
 *        "Every month on the 5th"). Actual's `t()` (i18next) is replaced by
 *        an identity function (`t = (s) => s`, ignoring interpolation
 *        objects) since this project has no i18n layer; the "{{token}}"
 *        placeholders are still substituted so the English strings match
 *        Actual's own `schedule.test.ts` fixtures exactly. `monthUtils.format`
 *        calls are ported to plain `date-fns` (`monthUtils.format(date, fmt,
 *        locale)` is itself a thin wrapper over `date-fns.format`).
 *   - `monthUtils.parseDate` -> `parseDate`
 *
 * License: MIT (see https://github.com/actualbudget/actual/blob/master/LICENSE.txt)
 */

'use strict';

// Import allow-list enforced by actualSchedules.vendor.test.js: this file may
// only import `date-fns`, so it stays a drop-in replacement for whatever
// Actual eventually exports, and never grows a dependency on the rest of this
// codebase.
const d = require('date-fns');

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
  parseDate,
  getRecurringDescription
};
