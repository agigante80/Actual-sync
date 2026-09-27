/**
 * Missing-payment detection engine (#258).
 *
 * `evaluate()` is pure: no I/O, no `@actual-app/api` import, no logging. It
 * takes a snapshot (rules, schedules, transactions, accounts, a clock and a
 * timezone) and returns what happened, so it is trivial to unit test with
 * fixed dates and easy to reason about independently of the sync loop that
 * calls it (`src/syncService.js`).
 *
 * Single source of truth: Actual's own Schedules. This module adds only what
 * a schedule lacks - a grace period, an early-payment allowance, and how long
 * a stale bank connection is tolerated before giving up rather than crying
 * wolf - never a cadence of its own (see `src/lib/vendor/actualSchedules.js`
 * for how a schedule's recurrence config becomes occurrence dates).
 *
 * ## Design notes / deviations from the literal #258 text
 *
 * - `evaluate()` returns `{ events, evaluations, warnings }`, not the literal
 *   `{ events, evaluations }`. `warnings` is additive: it exists only for
 *   #271 item 1 (see below), where a config problem is detected at
 *   evaluation time (the only time a schedule's cadence is known) but this
 *   function cannot log it, being pure. The caller (`syncService.js`) logs
 *   each entry at WARN and otherwise ignores the field.
 * - `evaluations[].occurrences[]` (#271 item 4) includes at least `date`,
 *   `deadline`, `state`, `receivedDate`, `receivedAmount`, as required.
 * - #271 item 1 (window overlap): #258 says W(o) and L(o) of consecutive
 *   occurrences never overlap, which is false for a schedule whose interval
 *   is shorter than `graceDays + earlyDays` (see the reproduction in #271).
 *   `config.json` carries no cadence, so the violation cannot be caught at
 *   config load; it is caught here, per schedule, once the real interval is
 *   known. A violating rule is not evaluated (its window math would be
 *   unsound); it produces one `cannotCheck` event with
 *   `reason: 'interval-violation'` and one entry in `warnings`, instead of
 *   silently double-counting a transaction or inverting a late window.
 * - #271 item 2 (end of L(o) with no next occurrence): resolved as "today"
 *   (the evaluation clock, as a calendar date in `timezone`). No transaction
 *   dated after today can exist regardless, so this never under- or
 *   over-extends the late window; it only stops `late` from being considered
 *   indefinitely for a schedule that has ended or was a one-off.
 * - Two-pass matching (on-time first, then late; earliest occurrence first
 *   in both passes) is exactly the #258 algorithm, and is what keeps W/L of
 *   non-violating schedules from double-counting one transaction.
 * - Amount tolerance for an `isbetween` schedule (a range, not a single
 *   amount) is out of scope for this ticket: `schedule.amount` is `null` for
 *   those, so the amount check is skipped and any account+payee match in
 *   window counts as `received`. This matches the common case (`is` /
 *   `isapprox`) exactly and never produces a false `wrongAmount`.
 */
'use strict';

const moment = require('moment-timezone');
const { parseRecurDate, getDateWithSkippedWeekend, getRecurringDescription } = require('./vendor/actualSchedules');
const { expandRules } = require('./scheduleAlertRules');

/** Hard cap on the look-back window, regardless of a schedule's own interval. */
const MAX_LOOKBACK_DAYS = 90;
/** How many recent occurrences `evaluations[].occurrences` carries at most. */
const MAX_OCCURRENCES = 6;
/** Actual's own tolerance for an "approximately" schedule amount. */
const APPROX_TOLERANCE_PCT = 7.5;

/**
 * Turn a rschedule-generated `Date` (local time, noon-anchored - see
 * `vendor/actualSchedules.js`) into a calendar-day moment in `timezone`. Only
 * the Y/M/D components are taken from the `Date`; a schedule's occurrence
 * date is a calendar date with no zone of its own, and all arithmetic on it
 * (deadlines, "today", staleness) must happen in one chosen zone regardless
 * of the machine's own local time.
 *
 * @param {Date} date
 * @param {string} timezone
 * @returns {moment.Moment}
 */
function toCalendarDay(date, timezone) {
  return moment.tz([date.getFullYear(), date.getMonth(), date.getDate()], timezone).startOf('day');
}

/**
 * Expand a schedule's `date` config (a `RecurConfig`, or a plain `YYYY-MM-DD`
 * string for a one-off schedule) into calendar-day moments in `timezone`,
 * within `[rangeStart, rangeEnd]` inclusive, ascending and deduplicated.
 *
 * @param {Object|string} dateConfig
 * @param {moment.Moment} rangeStart
 * @param {moment.Moment} rangeEnd
 * @param {string} timezone
 * @returns {moment.Moment[]}
 */
function expandOccurrences(dateConfig, rangeStart, rangeEnd, timezone) {
  if (typeof dateConfig === 'string') {
    const single = moment.tz(dateConfig, timezone).startOf('day');
    return single.isBetween(rangeStart, rangeEnd, 'day', '[]') ? [single] : [];
  }

  const parsed = parseRecurDate(dateConfig);
  const raw = parsed.schedule
    .occurrences({ start: rangeStart.clone().subtract(1, 'day').toDate(), end: rangeEnd.clone().add(1, 'day').toDate() })
    .toArray()
    .map((occ) => occ.date);

  const days = raw.map((d) => (dateConfig.skipWeekend ? getDateWithSkippedWeekend(d, dateConfig.weekendSolveMode) : d));
  const calendarDays = days.map((d) => toCalendarDay(d, timezone));

  const seen = new Set();
  const unique = [];
  for (const day of calendarDays.sort((a, b) => a.valueOf() - b.valueOf())) {
    const key = day.format('YYYY-MM-DD');
    if (seen.has(key)) continue;
    seen.add(key);
    if (day.isBetween(rangeStart, rangeEnd, 'day', '[]')) unique.push(day);
  }
  return unique;
}

/**
 * The shortest and longest gap, in days, between consecutive occurrences in
 * a wide reference window. Used to size the look-back window and to catch
 * the #271 item 1 window-overlap condition.
 *
 * @param {Object|string} dateConfig
 * @param {moment.Moment} today
 * @param {string} timezone
 * @returns {{ shortestIntervalDays: number|null, longestIntervalDays: number }}
 */
function computeIntervalStats(dateConfig, today, timezone) {
  const rangeStart = today.clone().subtract(MAX_LOOKBACK_DAYS, 'days');
  const rangeEnd = today.clone().add(MAX_LOOKBACK_DAYS, 'days');
  const days = expandOccurrences(dateConfig, rangeStart, rangeEnd, timezone);

  let shortest = null;
  let longest = 0;
  for (let i = 1; i < days.length; i++) {
    const diff = days[i].diff(days[i - 1], 'days');
    if (shortest === null || diff < shortest) shortest = diff;
    if (diff > longest) longest = diff;
  }
  return { shortestIntervalDays: shortest, longestIntervalDays: longest || 30 };
}

/**
 * Resolve the effective amount-tolerance percentage for a rule: the rule's
 * own `amountTolerancePct` if set, otherwise Actual's own schedule amount
 * mode ("approximately" -> 7.5%, an exact amount -> 0%).
 *
 * @param {Object} rule
 * @param {Object} schedule
 * @returns {number}
 */
function resolveTolerancePct(rule, schedule) {
  if (rule.amountTolerancePct != null) return rule.amountTolerancePct;
  return schedule.amountOp === 'isapprox' ? APPROX_TOLERANCE_PCT : 0;
}

/**
 * Whether `amount` (a transaction's signed integer cents) is within
 * `tolerancePct` of `expected` (the schedule's own signed integer cents).
 *
 * @param {number} amount
 * @param {number} expected
 * @param {number} tolerancePct
 * @returns {boolean}
 */
function amountWithinTolerance(amount, expected, tolerancePct) {
  const allowed = Math.abs(expected) * (tolerancePct / 100);
  return Math.abs(Math.abs(amount) - Math.abs(expected)) <= allowed;
}

/**
 * Whether a transaction can settle a schedule's occurrence at all: either
 * Actual's own link (`transaction.schedule === schedule.id`, always
 * authoritative regardless of amount), or an account+payee match (subject to
 * the amount-tolerance check the caller performs separately for `W(o)`).
 *
 * @param {Object} tx
 * @param {Object} schedule
 * @returns {{ eligible: boolean, linked: boolean }}
 */
function matches(tx, schedule) {
  if (tx.schedule && schedule.id && tx.schedule === schedule.id) return { eligible: true, linked: true };
  if (tx.account === schedule.account && schedule.payee && tx.payee === schedule.payee) {
    return { eligible: true, linked: false };
  }
  return { eligible: false, linked: false };
}

/**
 * Evaluate every rule against the current schedules/transactions/accounts
 * snapshot. See the module doc comment for the algorithm and its documented
 * deviations from the literal #258 text.
 *
 * @param {Object} args
 * @param {Object[]} args.rules - normalized rules, from `scheduleAlertRules.getRules`
 * @param {Array<Object>} args.schedules - `getSchedules()` output, optionally
 *   pre-hydrated with `payeeName`/`accountName` (schedules only carry ids)
 * @param {Array<Object>} args.transactions - posted transactions in the
 *   look-back window, each with at least `date`, `amount`, `account`,
 *   `payee`, `schedule`
 * @param {Array<{id:string,last_sync:?string}>} args.accounts
 * @param {Date|string} args.now
 * @param {string} args.timezone - IANA zone, e.g. `Europe/Madrid`
 * @returns {{ events: Object[], evaluations: Object[], warnings: Object[] }}
 */
function evaluate({ rules, schedules, transactions, accounts, now, timezone }) {
  const events = [];
  const evaluations = [];
  const warnings = [];

  const today = moment.tz(now, timezone).startOf('day');
  const accountsById = new Map((accounts || []).map((a) => [a.id, a]));
  const bindings = expandRules(rules || [], schedules || []);

  for (const binding of bindings) {
    if (binding.unmatched) {
      events.push({ event: 'ruleUnmatched', alertId: binding.id, scheduleId: null, occurrence: null, deadline: null });
      continue;
    }

    const schedule = binding.schedule;
    const dateConfig = schedule.date;
    const { shortestIntervalDays, longestIntervalDays } = computeIntervalStats(dateConfig, today, timezone);

    if (shortestIntervalDays !== null && binding.graceDays + binding.earlyDays >= shortestIntervalDays) {
      warnings.push({
        ruleId: binding.id,
        scheduleId: binding.scheduleId,
        message: `Rule "${binding.id}": graceDays (${binding.graceDays}) + earlyDays (${binding.earlyDays}) >= `
          + `the schedule's shortest interval between occurrences (${shortestIntervalDays} days); `
          + 'the on-time and late windows of consecutive occurrences would overlap, so this rule was skipped.'
      });
      events.push({
        event: 'cannotCheck',
        alertId: binding.id,
        scheduleId: binding.scheduleId,
        occurrence: null,
        deadline: null,
        reason: 'interval-violation'
      });
      evaluations.push({
        alertId: binding.id,
        scheduleId: binding.scheduleId,
        name: binding.scheduleName,
        cadenceText: typeof dateConfig === 'string' ? null : getRecurringDescription(dateConfig),
        account: schedule.accountName || schedule.account,
        payee: schedule.payeeName || schedule.payee,
        expectedAmount: schedule.amount != null ? schedule.amount : null,
        nextDate: null,
        deadline: null,
        state: 'cannotCheck',
        occurrences: []
      });
      continue;
    }

    const lookbackDays = Math.max(7, Math.min(MAX_LOOKBACK_DAYS, 2 * longestIntervalDays));
    const rangeStart = today.clone().subtract(lookbackDays, 'days');
    const rangeEnd = today.clone().add(longestIntervalDays, 'days');
    const occurrenceDays = expandOccurrences(dateConfig, rangeStart, rangeEnd, timezone);

    const tolerancePct = resolveTolerancePct(binding, schedule);
    const account = accountsById.get(schedule.account) || null;
    const lastSync = account && account.last_sync ? moment.tz(account.last_sync, timezone).startOf('day') : null;

    const candidateTx = (transactions || [])
      .filter((tx) => matches(tx, schedule).eligible)
      .map((tx) => ({ tx, date: moment.tz(tx.date, timezone).startOf('day'), used: false }))
      .sort((a, b) => a.date.valueOf() - b.date.valueOf());

    const occurrenceResults = occurrenceDays.map((day, index) => {
      const deadline = day.clone().add(binding.graceDays, 'days');
      const earlyStart = day.clone().subtract(binding.earlyDays, 'days');
      const next = occurrenceDays[index + 1] || null;
      const lateEnd = next
        ? next.clone().subtract(binding.earlyDays, 'days').subtract(1, 'day')
        : today.clone();
      const lateStart = deadline.clone().add(1, 'day');
      const hasLateWindow = !lateEnd.isBefore(lateStart, 'day');

      return { day, deadline, earlyStart, lateStart, lateEnd: hasLateWindow ? lateEnd : null };
    });

    // Pass 1: on-time (W(o)), earliest occurrence first.
    for (const occ of occurrenceResults) {
      const candidate = candidateTx.find(
        (c) => !c.used && !c.date.isBefore(occ.earlyStart, 'day') && !c.date.isAfter(occ.deadline, 'day')
      );
      if (candidate) {
        candidate.used = true;
        const { linked } = matches(candidate.tx, schedule);
        const amountOk = linked || schedule.amount == null || amountWithinTolerance(candidate.tx.amount, schedule.amount, tolerancePct);
        occ.receivedDate = candidate.date.format('YYYY-MM-DD');
        occ.receivedAmount = candidate.tx.amount;
        occ.state = amountOk ? 'received' : 'wrongAmount';
      }
    }

    // Pass 2: late (L(o)), earliest occurrence first, only for those still unresolved.
    for (const occ of occurrenceResults) {
      if (occ.state || !occ.lateEnd) continue;
      const candidate = candidateTx.find(
        (c) => !c.used && !c.date.isBefore(occ.lateStart, 'day') && !c.date.isAfter(occ.lateEnd, 'day')
      );
      if (candidate) {
        candidate.used = true;
        occ.receivedDate = candidate.date.format('YYYY-MM-DD');
        occ.receivedAmount = candidate.tx.amount;
        occ.state = 'late';
      }
    }

    // Fill remaining state: upcoming / missing / cannotCheck, and emit events.
    for (const occ of occurrenceResults) {
      if (occ.state) continue;
      if (occ.day.isAfter(today, 'day')) {
        occ.state = 'upcoming';
        continue;
      }
      if (!today.isAfter(occ.deadline, 'day')) {
        occ.state = 'upcoming';
        continue;
      }

      const stale = !lastSync || today.diff(lastSync, 'days') > binding.staleAfterDays;
      const lastSyncAfterDeadline = lastSync && lastSync.isAfter(occ.deadline, 'day');

      if (!lastSyncAfterDeadline || stale) {
        occ.state = 'cannotCheck';
        events.push({
          event: 'cannotCheck',
          alertId: binding.id,
          scheduleId: binding.scheduleId,
          occurrence: occ.day.format('YYYY-MM-DD'),
          deadline: occ.deadline.format('YYYY-MM-DD'),
          lastSync: lastSync ? lastSync.format('YYYY-MM-DD') : null,
          reason: stale ? 'stale' : 'not-synced'
        });
      } else {
        occ.state = 'missing';
        events.push({
          event: 'missing',
          alertId: binding.id,
          scheduleId: binding.scheduleId,
          occurrence: occ.day.format('YYYY-MM-DD'),
          deadline: occ.deadline.format('YYYY-MM-DD'),
          daysOverdue: today.diff(occ.deadline, 'days'),
          expectedAmount: schedule.amount != null ? schedule.amount : null
        });
      }
    }

    // wrongAmount events, one per occurrence found wrong in pass 1.
    for (const occ of occurrenceResults) {
      if (occ.state !== 'wrongAmount') continue;
      const expected = schedule.amount;
      events.push({
        event: 'wrongAmount',
        alertId: binding.id,
        scheduleId: binding.scheduleId,
        occurrence: occ.day.format('YYYY-MM-DD'),
        deadline: occ.deadline.format('YYYY-MM-DD'),
        expectedAmount: expected,
        receivedAmount: occ.receivedAmount,
        receivedDate: occ.receivedDate,
        difference: occ.receivedAmount - expected,
        difference_raw: occ.receivedAmount - expected
      });
    }

    const current = [...occurrenceResults].reverse().find((o) => !o.day.isAfter(today, 'day')) || occurrenceResults[0] || null;
    const upcoming = occurrenceResults.find((o) => o.day.isAfter(today, 'day'));

    evaluations.push({
      alertId: binding.id,
      scheduleId: binding.scheduleId,
      name: binding.scheduleName,
      cadenceText: typeof dateConfig === 'string' ? null : getRecurringDescription(dateConfig),
      account: schedule.accountName || schedule.account,
      payee: schedule.payeeName || schedule.payee,
      expectedAmount: schedule.amount != null ? schedule.amount : null,
      nextDate: upcoming ? upcoming.day.format('YYYY-MM-DD') : null,
      deadline: current ? current.deadline.format('YYYY-MM-DD') : null,
      state: current ? current.state : 'upcoming',
      occurrences: occurrenceResults.slice(-MAX_OCCURRENCES).map((o) => ({
        date: o.day.format('YYYY-MM-DD'),
        deadline: o.deadline.format('YYYY-MM-DD'),
        state: o.state,
        receivedDate: o.receivedDate || null,
        receivedAmount: o.receivedAmount != null ? o.receivedAmount : null
      }))
    });
  }

  return { events, evaluations, warnings };
}

module.exports = { evaluate, MAX_LOOKBACK_DAYS, MAX_OCCURRENCES };
