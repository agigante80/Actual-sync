/**
 * The one timezone the service shows times in and schedules cron jobs in (#266).
 *
 * `timezone` (IANA name) from the config wins; without it the process zone is
 * used (TZ, else the system; UTC when that is blank or invalid), which is also what node-schedule used before the
 * key existed, so existing setups keep their behaviour.
 */
const moment = require('moment-timezone');

/**
 * @param {Object} [cfg] the loaded config object
 * @returns {string} an IANA timezone name
 */
function resolveTimezone(cfg) {
    if (cfg && cfg.timezone) return cfg.timezone;
    const processZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // A blank TZ (Unraid's empty field) gives 'Etc/Unknown' and a typo gives
    // undefined; either breaks toLocaleString or moment().tz() at startup.
    return isValidTimezone(processZone) ? processZone : 'UTC';
}

/**
 * @param {Object} [cfg] the loaded config object
 * @returns {string|null} a startup warning when the process zone was unusable
 *   and UTC is used instead, else null
 */
function describeTimezoneFallback(cfg) {
    if (cfg && cfg.timezone) return null;
    if (isValidTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)) return null;
    return `TZ=${JSON.stringify(process.env.TZ === undefined ? '' : process.env.TZ)} is blank or not a valid IANA timezone; using UTC. Set TZ or the "timezone" config key to a valid name such as "America/New_York".`;
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

module.exports = { resolveTimezone, isValidTimezone, describeTimezoneFallback };
