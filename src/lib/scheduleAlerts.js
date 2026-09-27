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
 * - Amount tolerance for an `isbetween` schedule (a range, `schedule.amount`
 *   is `{num1, num2}`, not a single number) is a plain range check against
 *   `min(num1,num2)..max(num1,num2)` (#295 review, M10 - corrected from an
 *   earlier, incorrect claim here that `schedule.amount` was `null` for
 *   these and the amount check skipped; it is not `null`, and
 *   `Math.abs({num1,num2})` is `NaN`, which made every `isbetween` payment
 *   `wrongAmount` regardless of its actual amount).
 * - `getRecurringDescription`'s `dateFormat` argument is `date-fns` tokens,
 *   not the `moment` tokens `scheduleAlerts.dateFormat` (config) uses; the
 *   two token sets disagree (`D`/`YYYY` moment vs `d`/`yyyy` date-fns), and
 *   `date-fns` v2+ throws on an ambiguous token instead of guessing. Reusing
 *   the operator's own `dateFormat` here would trade one crash (the missing
 *   argument this fixes, #295 review H2) for another under some configured
 *   formats, so `CADENCE_DATE_FORMAT` below is a fixed, always-valid
 *   `date-fns` format used only for a schedule's own cadence wording (e.g.
 *   "Every month, until 5 Oct 2026"), independent of the operator's
 *   templated-message date format.
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
/** Fixed `date-fns` format for a schedule's own cadence wording (#295 review, H2). */
const CADENCE_DATE_FORMAT = 'd MMM yyyy';
/**
 * Actual links a transaction to a schedule within +/-2 calendar days of the
 * occurrence regardless of the rule's own `earlyDays` (#295 review, M12): with
 * `earlyDays: 0`, a linked payment paid 2 days early was wrongly excluded from
 * the on-time window and reported `missing` even though Actual itself already
 * considers it settled. The on-time window's early boundary is widened to
 * `max(earlyDays, LINKED_EARLY_WINDOW_DAYS)` for a *linked* candidate only; an
 * unlinked (account+payee) candidate still uses the rule's own `earlyDays`.
 */
const LINKED_EARLY_WINDOW_DAYS = 2;

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
  // Fewer than two occurrences within +/-MAX_LOOKBACK_DAYS means the true
  // interval cannot be measured (a one-off schedule, or a yearly/long-interval
  // schedule with at most one occurrence in range). The old `longest || 30`
  // fallback guessed 30 days regardless, which under-sized the evaluation
  // window below for anything with a real interval longer than that: a
  // yearly schedule with `graceDays: 60` could never produce `missing`, since
  // the look-back/look-ahead window was sized off the wrong 30-day guess
  // instead of the schedule's real once-a-year cadence (#295 review, M13).
  // MAX_LOOKBACK_DAYS is never a worse choice here: it is already the hard
  // cap every other window in this module respects, so falling back to it
  // cannot make the window narrower than a correctly-measured `longest`
  // would have.
  return { shortestIntervalDays: shortest, longestIntervalDays: longest || MAX_LOOKBACK_DAYS };
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
 * Whether `amount` (a transaction's signed integer cents) satisfies a
 * schedule's expected amount, for every `amountOp` Actual supports: `is` /
 * `isapprox` compare to a single `schedule.amount` within `tolerancePct`
 * (`amountWithinTolerance`); `isbetween` compares to the inclusive range
 * `schedule.amount` carries as `{num1, num2}` (#295 review, M10 - the range
 * is not sorted by which bound is the min in Actual's own data, so both
 * orderings are handled). `schedule.amount == null` (should not happen for a
 * real schedule, kept defensively) matches unconditionally.
 *
 * @param {number} amount
 * @param {Object} schedule
 * @param {number} tolerancePct
 * @returns {boolean}
 */
function amountMatchesSchedule(amount, schedule, tolerancePct) {
  if (schedule.amount == null) return true;
  if (schedule.amountOp === 'isbetween' && typeof schedule.amount === 'object') {
    const { num1, num2 } = schedule.amount;
    const lo = Math.min(num1, num2);
    const hi = Math.max(num1, num2);
    return amount >= lo && amount <= hi;
  }
  return amountWithinTolerance(amount, schedule.amount, tolerancePct);
}

/**
 * Whether a transaction can settle a schedule's occurrence at all: either
 * Actual's own link (`transaction.schedule === schedule.id`, always
 * authoritative regardless of amount), or an account+payee match (subject to
 * the amount-tolerance check the caller performs separately for `W(o)`).
 *
 * A transaction already linked to a *different* schedule (`tx.schedule` set,
 * but not to this `schedule.id`) is never eligible here even when the
 * account+payee also match: Actual's own link is authoritative in both
 * directions, so a payment it already assigned to schedule A must not also
 * be claimed by schedule B's account+payee matching. Without this, two
 * schedules sharing an account+payee (a common real setup, e.g. two rent
 * schedules to the same landlord/account) could both count the same
 * transaction, silently masking a real `missing` on one of them (#295
 * review, M11 - this replaces a per-binding-only `used` flag, which cannot
 * see a transaction already claimed by a *different* binding's own
 * candidate list).
 *
 * @param {Object} tx
 * @param {Object} schedule
 * @returns {{ eligible: boolean, linked: boolean }}
 */
function matches(tx, schedule) {
  if (tx.schedule) {
    const linked = !!schedule.id && tx.schedule === schedule.id;
    return { eligible: linked, linked };
  }
  if (tx.account === schedule.account && schedule.payee && tx.payee === schedule.payee) {
    return { eligible: true, linked: false };
  }
  return { eligible: false, linked: false };
}

/**
 * Normalize `account.last_sync` into a calendar-day moment in `timezone`, or
 * `null` when absent/unparseable. In production Actual, `last_sync` is an
 * epoch-millisecond string (e.g. `"1736380800000"`); `moment.tz(value, zone)`
 * on a numeric string is not a valid parse (moment expects either a real
 * ISO/format string or a genuine `number`), so every `missing` check silently
 * treated a real, freshly-synced account as unparseable/stale in production,
 * even though the test fixtures (plain `YYYY-MM-DD` strings) never exercised
 * this path (#295 review, H1). A numeric-looking value (string or number) is
 * parsed as epoch milliseconds; anything else falls back to `moment.tz`'s own
 * parsing (kept for robustness / any future non-numeric source); a result
 * that fails to parse is treated as unknown, i.e. `null` - same as no
 * `last_sync` at all, which the caller already treats as "stale" (favors
 * `cannotCheck` over a false `missing`, per the coordinator's instruction to
 * "treat invalid as null/stale").
 *
 * @param {?(string|number)} lastSync
 * @param {string} timezone
 * @returns {?moment.Moment}
 */
function parseLastSync(lastSync, timezone) {
  if (lastSync == null || lastSync === '') return null;
  const isNumeric = typeof lastSync === 'number' || /^-?\d+$/.test(String(lastSync).trim());
  const parsed = isNumeric ? moment.tz(Number(lastSync), timezone) : moment.tz(lastSync, timezone);
  return parsed.isValid() ? parsed.startOf('day') : null;
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
  // Shared across every binding in this evaluate() call, keyed by transaction
  // object identity (not id, so it works even when a fixture omits one): two
  // rules can bind to schedules that share the same account+payee (e.g. two
  // rent schedules paid from the same account to the same landlord). Without
  // this, `candidateTx` being rebuilt fresh per binding meant one unlinked
  // transaction could independently satisfy BOTH bindings' occurrences,
  // silently masking a real `missing` on one of them (#295 review, M11).
  // A transaction already claimed by an earlier binding is excluded from
  // every later binding's candidate list entirely.
  const globallyUsedTx = new Set();

  for (const binding of bindings) {
    if (binding.unmatched) {
      events.push({ event: 'ruleUnmatched', alertId: binding.id, scheduleId: null, occurrence: null, deadline: null });
      continue;
    }

    const schedule = binding.schedule;
    const dateConfig = schedule.date;

    // #295 review, H2: one bad schedule (a malformed recurrence config, or
    // any other unexpected throw from `expandOccurrences`/`getRecurringDescription`/
    // date parsing below) must not silence every other rule's evaluation in
    // the same sync. Each binding gets its own try/catch, isolating a fault
    // to a single `cannotCheck`/warning instead of aborting `evaluate()`
    // entirely (which would drop every OTHER rule's events too).
    try {
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
          cadenceText: typeof dateConfig === 'string' ? null : getRecurringDescription(dateConfig, CADENCE_DATE_FORMAT),
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
      const lastSync = account ? parseLastSync(account.last_sync, timezone) : null;
      // Actual's own "Skip next date" only moves `schedule.next_date` forward;
      // it leaves no other trace on the skipped occurrence. Any occurrence
      // strictly before `schedule.next_date` that reached this point with no
      // transaction is therefore a deliberately-skipped occurrence, not a
      // missed payment (#295 review, M9). `next_date` is only meaningful when
      // present (a one-off/completed schedule may not carry one), so its
      // absence leaves every occurrence subject to the normal missing/cannotCheck
      // logic exactly as before.
      const nextDateMoment = schedule.next_date ? moment.tz(schedule.next_date, timezone).startOf('day') : null;

      const candidateTx = (transactions || [])
        .map((tx) => ({ tx, match: matches(tx, schedule) }))
        .filter((c) => c.match.eligible && !globallyUsedTx.has(c.tx))
        .map((c) => ({ tx: c.tx, linked: c.match.linked, date: moment.tz(c.tx.date, timezone).startOf('day'), used: false }))
        .sort((a, b) => a.date.valueOf() - b.date.valueOf());

      const occurrenceResults = occurrenceDays.map((day, index) => {
        const deadline = day.clone().add(binding.graceDays, 'days');
        const earlyStart = day.clone().subtract(binding.earlyDays, 'days');
        // Widened early boundary for a *linked* candidate only (M12, see
        // LINKED_EARLY_WINDOW_DAYS above); an unlinked candidate keeps using
        // the rule's own, possibly narrower, `earlyDays`.
        const earlyStartLinked = day.clone().subtract(Math.max(binding.earlyDays, LINKED_EARLY_WINDOW_DAYS), 'days');
        const next = occurrenceDays[index + 1] || null;
        const lateEnd = next
          ? next.clone().subtract(binding.earlyDays, 'days').subtract(1, 'day')
          : today.clone();
        const lateStart = deadline.clone().add(1, 'day');
        const hasLateWindow = !lateEnd.isBefore(lateStart, 'day');

        return { day, deadline, earlyStart, earlyStartLinked, lateStart, lateEnd: hasLateWindow ? lateEnd : null };
      });

      // Pass 1: on-time (W(o)), earliest occurrence first. Among candidates in
      // an occurrence's on-time window, prefer Actual's own link, then a
      // candidate within amount tolerance, then simply the earliest -
      // instead of unconditionally taking the earliest regardless of amount
      // or link, which could pick a coincidentally-earlier wrong-amount
      // transaction over a same-window correct one and report a false
      // `wrongAmount` (#295 review, M11).
      for (const occ of occurrenceResults) {
        const inWindow = candidateTx.filter(
          (c) => !c.used
            && !c.date.isBefore(c.linked ? occ.earlyStartLinked : occ.earlyStart, 'day')
            && !c.date.isAfter(occ.deadline, 'day')
        );
        const candidate = inWindow.find((c) => c.linked)
          || inWindow.find((c) => amountMatchesSchedule(c.tx.amount, schedule, tolerancePct))
          || inWindow[0]
          || null;
        if (candidate) {
          candidate.used = true;
          globallyUsedTx.add(candidate.tx);
          const amountOk = candidate.linked || amountMatchesSchedule(candidate.tx.amount, schedule, tolerancePct);
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
          globallyUsedTx.add(candidate.tx);
          occ.receivedDate = candidate.date.format('YYYY-MM-DD');
          occ.receivedAmount = candidate.tx.amount;
          occ.state = 'late';
        }
      }

      // Fill remaining state: upcoming / skipped / missing / cannotCheck, and emit events.
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
        if (nextDateMoment && occ.day.isBefore(nextDateMoment, 'day')) {
          occ.state = 'skipped';
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
        // For an `isbetween` schedule, `expected` is a `{num1,num2}` range,
        // not a number; `receivedAmount - expected` would be NaN. The
        // meaningful "difference" for a range is the distance to whichever
        // bound the payment actually missed (below the range vs above it),
        // not a distance from the range object itself.
        const differenceBase = schedule.amountOp === 'isbetween' && expected && typeof expected === 'object'
          ? (occ.receivedAmount < Math.min(expected.num1, expected.num2) ? Math.min(expected.num1, expected.num2) : Math.max(expected.num1, expected.num2))
          : expected;
        events.push({
          event: 'wrongAmount',
          alertId: binding.id,
          scheduleId: binding.scheduleId,
          occurrence: occ.day.format('YYYY-MM-DD'),
          deadline: occ.deadline.format('YYYY-MM-DD'),
          expectedAmount: expected,
          receivedAmount: occ.receivedAmount,
          receivedDate: occ.receivedDate,
          difference: occ.receivedAmount - differenceBase,
          difference_raw: occ.receivedAmount - differenceBase
        });
      }

      const current = [...occurrenceResults].reverse().find((o) => !o.day.isAfter(today, 'day')) || occurrenceResults[0] || null;
      const upcoming = occurrenceResults.find((o) => o.day.isAfter(today, 'day'));

      evaluations.push({
        alertId: binding.id,
        scheduleId: binding.scheduleId,
        name: binding.scheduleName,
        cadenceText: typeof dateConfig === 'string' ? null : getRecurringDescription(dateConfig, CADENCE_DATE_FORMAT),
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
    } catch (error) {
      warnings.push({
        ruleId: binding.id,
        scheduleId: binding.scheduleId,
        message: `Rule "${binding.id}" (schedule "${binding.scheduleName}") threw during evaluation and was skipped: ${error.message}`
      });
      events.push({
        event: 'cannotCheck',
        alertId: binding.id,
        scheduleId: binding.scheduleId,
        occurrence: null,
        deadline: null,
        reason: 'error'
      });
    }
  }

  return { events, evaluations, warnings };
}

module.exports = { evaluate, MAX_LOOKBACK_DAYS, MAX_OCCURRENCES, LINKED_EARLY_WINDOW_DAYS };
