/**
 * Jest setup (setupFilesAfterEnv): a log call that carries an unregistered or
 * never-emitted field fails the test that made it (D3, D9, #437).
 *
 * A test that drops fields on purpose reads and clears them with
 * takeDroppedFields() before it ends. A file that exercises the allowlist
 * itself calls allowDroppedFields() once at its top.
 */
const { setDropObserver } = require('../../lib/logFields');

let dropped = [];
let allowed = false;

setDropObserver((paths) => { dropped.push(...paths); });

/** Return the dropped field paths recorded so far and forget them. */
function takeDroppedFields() {
    const taken = dropped;
    dropped = [];
    return taken;
}

global.takeDroppedFields = takeDroppedFields;
global.allowDroppedFields = () => { allowed = true; };

beforeEach(() => { dropped = []; });

afterEach(() => {
    const left = takeDroppedFields();
    if (left.length > 0 && !allowed) {
        throw new Error(`A log call dropped fields not in src/lib/logFields.js: ${[...new Set(left)].join(', ')}`);
    }
});
