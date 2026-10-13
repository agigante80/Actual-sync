/**
 * The one timezone the service shows times in and schedules cron jobs in (#266).
 *
 * `timezone` (IANA name) from the config wins; without it the process zone is
 * used (TZ, else the system), which is also what node-schedule used before the
 * key existed, so existing setups keep their behaviour.
 */
const moment = require('moment-timezone');

/**
 * @param {Object} [cfg] the loaded config object
 * @returns {string} an IANA timezone name
 */
function resolveTimezone(cfg) {
    return (cfg && cfg.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * @param {*} name
 * @returns {boolean} true when both moment-timezone (cron, alerts) and Intl
 *   (toLocaleString in notifications) know the name
 */
function isValidTimezone(name) {
    if (typeof name !== 'string' || name.trim() === '') return false;
    if (!moment.tz.zone(name)) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: name });
        return true;
    } catch {
        return false;
    }
}

module.exports = { resolveTimezone, isValidTimezone };
