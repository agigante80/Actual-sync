/**
 * Log field allowlist with data classes (D3, #437).
 *
 * Every key a log call may carry is registered here with a data class, a type
 * and, for objects, its allowed child keys (at most MAX_DEPTH levels). The
 * logger runs every context and metadata object through sanitizeFields()
 * before any sink sees it:
 *
 *   - an unregistered key is dropped (the record carries `droppedFieldCount`,
 *     never the key names: a spread object can turn data into keys);
 *   - a registered key whose value has the wrong shape (an object where a
 *     scalar is registered, an unregistered child key) is dropped;
 *   - a key of class upstream, financial or secret is dropped, always;
 *   - a key of class personal is dropped when the logger runs with
 *     includePersonal: false.
 *
 * Add a key here in the same change that logs it. The source of truth for the
 * classes is docs/LOGGING.md ("Field allowlist").
 */

const CLASS = Object.freeze({
    OP: 'op',
    ID: 'id',
    PERSONAL: 'personal',
    UPSTREAM: 'upstream',
    FINANCIAL: 'financial',
    SECRET: 'secret'
});

// Classes that are never written, whatever the configuration (D3).
const NEVER_EMITTED = new Set([CLASS.UPSTREAM, CLASS.FINANCIAL, CLASS.SECRET]);

// A registered key may hold a scalar, an array or an object, at most this
// many levels deep (the top-level key is level 1).
const MAX_DEPTH = 3;

// Keys that stay at the top of the record (D4 envelope) instead of moving
// under `fields`.
const ENVELOPE_KEYS = Object.freeze(['event', 'component', 'correlationId', 'server', 'error', 'category', 'droppedFieldCount']);

const op = (type, extra) => ({ class: CLASS.OP, type, ...extra });
const id = (type = 'string', extra) => ({ class: CLASS.ID, type, ...extra });
const personal = (type = 'string', extra) => ({ class: CLASS.PERSONAL, type, ...extra });
const never = (klass, type = 'string') => ({ class: klass, type });

// The classified error object (D5). A plain string is accepted while the
// older call sites still log error.message; #438 moves them to the object and
// removes the string form.
const ERROR_SPEC = op(['string', 'object'], {
    children: {
        type: op('string'),
        code: op(['string', 'number']),
        httpStatus: op('number'),
        category: op('string'),
        safeMessage: op('string')
    }
});

const FIELDS = Object.freeze({
    // --- envelope ---
    event: op('string'),
    component: op('string'),
    correlationId: id(),
    server: id(),
    category: op('string'),
    error: ERROR_SPEC,

    // --- ids (operator-chosen names and opaque identifiers) ---
    serverName: id(),
    accountId: id(),
    alertId: id(),
    scheduleId: id(),
    syncId: id(),
    ruleId: id(),
    localBudgetId: id(),
    id: id(['string', 'number']),
    name: id(),
    label: id(),
    target: id(),
    realm: id(),
    servers: id('array', { items: 'string' }),
    availableServers: id('array', { items: 'string' }),
    requestedServer: id(),
    ruleIds: id('array', { items: 'string' }),

    // --- personal (off with includePersonal: false) ---
    accountName: personal(),
    succeededAccounts: personal('array', { items: 'string' }),
    failedAccounts: personal('array', {
        items: { type: 'object', children: { name: personal(), error: ERROR_SPEC } }
    }),
    remoteAddress: personal(),
    sourceKey: personal(),
    origin: personal(['string']),
    allowedOrigins: personal('array', { items: 'string' }),
    dataDir: personal(),
    dbDir: personal(),
    dbPath: personal(),
    emailHost: personal(),

    // --- op: counts, durations, outcomes ---
    durationMs: op('number'),
    elapsedMs: op('number'),
    timeoutMs: op('number'),
    msAfterTimeout: op('number'),
    minIntervalMs: op('number'),
    baseRetryDelayMs: op('number'),
    delayMinutes: op('number'),
    windowMinutes: op('number'),
    dedupeMs: op('number'),
    timeSinceLastMs: op('number'),
    uptime: op('number'),
    duration: op('number'),
    rate: op('number'),
    accountCount: op('number'),
    accountsProcessed: op('number'),
    accountsSucceeded: op('number'),
    accountsFailed: op('number'),
    added: op('number'),
    updated: op('number'),
    transactionsAdded: op('number'),
    transactionsUpdated: op('number'),
    attempts: op('number'),
    attemptNumber: op('number'),
    attempt: op('number'),
    maxAttempts: op('number'),
    maxRetries: op('number'),
    retryAttempt: op('number'),
    count: op('number'),
    failedCount: op('number'),
    succeededCount: op('number'),
    deletedRecords: op('number'),
    deletedRows: op('number'),
    days: op('number'),
    retentionDays: op('number'),
    limit: op('number'),
    max: op('number'),
    remaining: op('number'),
    pending: op('number'),
    occurrence: op('number'),
    consecutiveFailures: op('number'),
    totalSyncs: op('number'),
    port: op('number'),
    scheduleCount: op('number'),
    serverCount: op('number'),
    statusCode: op('number'),
    httpStatus: op('number'),
    suppressedCount: op('number'),
    suppressedEvent: op('string'),
    textLength: op('number'),
    recentSyncsCount: op('number'),
    rules: op('number'),
    sentItems: op('number'),
    deferredItems: op('number'),
    emailRecipients: op('number'),
    recipients: op('number'),
    removedChars: op('number'),
    consolePreview: op('string'),

    code: op(['string', 'number']),
    errorCode: op(['string', 'number']),
    errorType: op('string'),

    abandoned: op('boolean'),
    attempted: op(['boolean', 'number']),
    authorized: op('boolean'),
    configured: op('boolean'),
    delivered: op(['boolean', 'number']),
    encrypted: op('boolean'),
    forceRun: op('boolean'),
    found: op('boolean'),
    hasConfig: op('boolean'),
    hasEmailConfig: op('boolean'),
    hasEmailTransporter: op('boolean'),
    hasMessage: op('boolean'),
    hasNotificationService: op('boolean'),
    hasStack: op('boolean'),
    includeAccounts: op('boolean'),
    isAutomated: op('boolean'),
    notifyOnSuccess: op(['string', 'boolean']),
    persisted: op(['string', 'boolean']),
    sent: op(['boolean', 'number']),
    skipped: op(['boolean', 'number']),
    success: op('boolean'),
    syncable: op('boolean'),
    telegram: op('boolean'),
    email: op('boolean'),

    action: op('string'),
    channel: op('string'),
    channels: op('array', { items: 'string' }),
    failedChannels: op('array', { items: 'string' }),
    command: op('string'),
    config: op(['string', 'boolean']),
    host: op('string'),
    configuredHost: op('string'),
    hint: op('string'),
    method: op('string'),
    mode: op('string'),
    note: op('string'),
    outcome: op('string'),
    path: op('string'),
    phase: op('string'),
    reason: op('string'),
    status: op('string'),
    schedule: op('string'),
    timezone: op('string'),
    currentTime: op('string'),
    cutoffDate: op('string'),
    mutedUntil: op('string'),
    retryTime: op('string'),
    // Names of the top-level keys of a runBankSync result and the length of
    // each array under them (#434): counts and key names, never values.
    keys: op('array', { items: 'string' }),
    lengths: op('object', { mapOf: 'number' }),
    stack: op('string'),

    webhooks: op('object', { children: { slack: op('number'), discord: op('number') } }),
    filters: op('object', {
        children: {
            serverName: id(),
            status: op('string'),
            limit: op('number'),
            offset: op('number'),
            days: op('number'),
            includeAccounts: op('boolean')
        }
    }),
    thresholds: op('object', {
        children: {
            minAccounts: op('number'),
            minTransactions: op('number'),
            minFailures: op('number'),
            failureRate: op('number'),
            consecutiveFailures: op('number'),
            minIntervalMs: op('number')
        }
    }),
    schedules: op('array', {
        items: { type: 'object', children: { schedule: op('string'), servers: id('array', { items: 'string' }), nextInvocation: op('string') } }
    }),

    // --- classes that are never emitted (kept so a leak is a named decision) ---
    chatId: never(CLASS.SECRET),
    password: never(CLASS.SECRET),
    token: never(CLASS.SECRET),
    url: never(CLASS.SECRET),
    webhookUrl: never(CLASS.SECRET),
    dashboard: never(CLASS.SECRET),
    errorMessage: never(CLASS.UPSTREAM),
    errorStack: never(CLASS.UPSTREAM),
    stackFirstLine: never(CLASS.UPSTREAM),
    toString: never(CLASS.UPSTREAM),
    originalError: never(CLASS.UPSTREAM),
    previousError: never(CLASS.UPSTREAM),
    messageId: never(CLASS.UPSTREAM),
    payee: never(CLASS.FINANCIAL),
    amount: never(CLASS.FINANCIAL),
    notes: never(CLASS.FINANCIAL),
    transactions: never(CLASS.FINANCIAL, 'array'),
    result: never(CLASS.FINANCIAL, 'object')
});

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const MAP_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

// The test harness registers an observer so that a dropped field fails the
// test. Production never records key names (D3).
let dropObserver = null;
function setDropObserver(fn) {
    dropObserver = typeof fn === 'function' ? fn : null;
}

const DROP = Symbol('drop');

function typeOfValue(value) {
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'invalid';
    return typeof value;
}

function typeMatches(spec, value) {
    const wanted = Array.isArray(spec.type) ? spec.type : [spec.type];
    return wanted.includes(typeOfValue(value));
}

/**
 * Sanitize one value against its spec. Returns DROP when the whole value is
 * refused; counts every refused key or item in ctx.
 */
function sanitizeValue(spec, value, path, depth, ctx) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!typeMatches(spec, value)) return reject(ctx, path);

    const kind = typeOfValue(value);
    if (kind === 'array') {
        if (depth >= MAX_DEPTH && spec.items && typeof spec.items === 'object') return reject(ctx, path);
        const itemSpec = typeof spec.items === 'string' ? { class: spec.class, type: spec.items } : spec.items;
        if (!itemSpec) return reject(ctx, path);
        const out = [];
        value.forEach((item, i) => {
            const clean = sanitizeValue({ class: spec.class, ...itemSpec }, item, `${path}[${i}]`, depth + 1, ctx);
            if (clean !== DROP && clean !== undefined) out.push(clean);
        });
        return out;
    }
    if (kind === 'object') {
        if (depth > MAX_DEPTH) return reject(ctx, path);
        const out = {};
        if (spec.mapOf) {
            for (const key of Object.keys(value)) {
                const itemSpec = { class: spec.class, type: spec.mapOf };
                const clean = MAP_KEY.test(key)
                    ? sanitizeValue(itemSpec, value[key], `${path}.${key}`, depth + 1, ctx)
                    : reject(ctx, `${path}.${key}`);
                if (clean !== DROP && clean !== undefined) out[key] = clean;
            }
            return out;
        }
        const children = spec.children || {};
        for (const key of Object.keys(value)) {
            const childPath = `${path}.${key}`;
            if (!hasOwn(children, key)) { reject(ctx, childPath); continue; }
            const childSpec = children[key];
            if (!admitted(childSpec, ctx)) { reject(ctx, childPath); continue; }
            const clean = sanitizeValue(childSpec, value[key], childPath, depth + 1, ctx);
            if (clean !== DROP && clean !== undefined) out[key] = clean;
        }
        return out;
    }
    return value;
}

function reject(ctx, path) {
    ctx.dropped++;
    if (dropObserver) ctx.paths.push(path);
    return DROP;
}

function admitted(spec, ctx) {
    if (NEVER_EMITTED.has(spec.class)) return false;
    if (spec.class === CLASS.PERSONAL && !ctx.includePersonal) return false;
    return true;
}

/**
 * Filter a flat object of log fields.
 * @param {Object} input - context or metadata, already secret-redacted
 * @param {Object} [options]
 * @param {boolean} [options.includePersonal=true] - emit class `personal`
 * @returns {{fields: Object, dropped: number}} the allowed fields (flat) and
 *   how many keys, items or values were refused
 */
function sanitizeFields(input, { includePersonal = true } = {}) {
    const ctx = { dropped: 0, paths: [], includePersonal };
    const fields = {};
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        for (const key of Object.keys(input)) {
            if (!hasOwn(FIELDS, key) || !admitted(FIELDS[key], ctx)) { reject(ctx, key); continue; }
            const clean = sanitizeValue(FIELDS[key], input[key], key, 1, ctx);
            if (clean !== DROP && clean !== undefined) fields[key] = clean;
        }
    } else if (input !== undefined && input !== null) {
        reject(ctx, '(non-object metadata)');
    }
    if (ctx.dropped > 0 && dropObserver) {
        try { dropObserver(ctx.paths); } catch { /* an observer must never break logging */ }
    }
    return { fields, dropped: ctx.dropped };
}

const ENVELOPE = new Set(ENVELOPE_KEYS);

/** Split a flat field object into the record envelope and the `fields` object. */
function splitEnvelope(flat) {
    const envelope = {};
    const fields = {};
    for (const key of Object.keys(flat || {})) {
        (ENVELOPE.has(key) ? envelope : fields)[key] = flat[key];
    }
    return { envelope, fields };
}

module.exports = {
    CLASS,
    FIELDS,
    ENVELOPE_KEYS,
    MAX_DEPTH,
    sanitizeFields,
    splitEnvelope,
    setDropObserver
};
