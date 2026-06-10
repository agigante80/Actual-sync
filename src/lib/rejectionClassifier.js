/**
 * Classify an unhandled promise rejection to decide its log level. (#105)
 *
 * Several @actual-app/api operations (download-budget, bank-sync, load-budget)
 * reject promises the library does not await internally, so the same failure is
 * already surfaced and logged through the normal sync error path. Logging it
 * again at ERROR in the global unhandledRejection handler inflates the error
 * count with non-actionable noise. Those api-originated rejections are
 * downgraded to 'debug'; genuinely unexpected rejections from our own code
 * stay at 'error'.
 *
 * @param {*} reason - The rejection reason (Error or otherwise)
 * @returns {'debug'|'error'} The log level to use
 */
function classifyRejection(reason) {
    if (reason instanceof Error && typeof reason.stack === 'string') {
        // Match only the ORIGINATING frame (the first "at ..." line). The api's own
        // un-awaited rejections originate inside @actual-app/api; an error thrown by
        // OUR code that merely passes through an api callback has our frame on top
        // and must stay at ERROR so a real bug is not hidden at DEBUG.
        const originFrame = reason.stack
            .split('\n')
            .find(line => line.trim().startsWith('at ')) || '';
        if (originFrame.includes('@actual-app/api') || originFrame.includes('handlers$1.api/')) {
            return 'debug';
        }
    }
    return 'error';
}

module.exports = { classifyRejection };
