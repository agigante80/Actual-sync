/**
 * Occurrence dates for test fixtures, expanded by Actual itself (#298).
 *
 * Production reads each bound schedule's dates with `api.getScheduleDates`
 * (scheduleAlertsStep.js). That handler needs no open budget, so the tests
 * call the real @actual-app/api one too, over the same `occurrenceWindow()`:
 * the fixtures are checked against Actual's own recurrence rules, not a copy.
 *
 * A config Actual rejects is stored as the Error, exactly as the step does,
 * so `evaluate()` reports that schedule as cannotCheck.
 */
const api = require('@actual-app/api');
const { occurrenceWindow } = require('../../lib/scheduleAlerts');

/**
 * @param {Object[]} schedules - fixtures with `id` and `date`
 * @param {Date|string} now
 * @param {string} timezone
 * @returns {Promise<Object<string, string[]|Error>>} keyed by schedule id
 */
async function actualScheduleDates(schedules, now, timezone) {
    const { start, end } = occurrenceWindow(now, timezone);
    const byId = {};
    for (const schedule of schedules || []) {
        if (!schedule || schedule.id == null || Object.prototype.hasOwnProperty.call(byId, schedule.id)) continue;
        try {
            byId[schedule.id] = await api.getScheduleDates(schedule.date, { start, end });
        } catch (error) {
            byId[schedule.id] = error;
        }
    }
    return byId;
}

module.exports = { actualScheduleDates };
