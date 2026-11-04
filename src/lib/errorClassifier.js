/**
 * Error classifier (#438, design D5): classify, never echo.
 *
 * One function feeds the log, sync_history and notifications, so the three
 * never disagree. An upstream message (Actual, GoCardless, SMTP, Telegram) can
 * carry payees, notes, IBANs or category names, and secret masking does not
 * catch personal data. So the result never contains upstream text:
 * `safeMessage` is our own text for the category, our own text from an error we
 * marked with markOwnError(), or a FULL-STRING match on the small allowlist
 * below. Anything else becomes the category text. There is no DEBUG exception.
 *
 * Categories are inferred from structured fields (code, HTTP status, name)
 * and, for the category only, from keywords in the message. The keywords pick
 * an enum member; the matched text is never copied into the result.
 */

const CATEGORIES = [
    'timeout', 'auth', 'upstream_unavailable', 'rate_limited',
    'not_found', 'validation', 'conflict', 'cancelled', 'internal'
];

const CATEGORY_TEXT = {
    timeout: 'Operation timed out',
    auth: 'Authentication failed',
    upstream_unavailable: 'Upstream service unavailable',
    rate_limited: 'Rate limited by the upstream service',
    not_found: 'Resource not found',
    validation: 'Request rejected as invalid',
    conflict: 'Conflict with existing data',
    cancelled: 'Operation cancelled',
    internal: 'Unexpected error (details withheld)'
};

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;
const CODE_TOKEN = /^[A-Z][A-Z0-9_]{2,39}$/;
const OWN = Symbol.for('actual-sync.ownError');

const CODE_CATEGORY = {
    ETIMEDOUT: 'timeout', ESOCKETTIMEDOUT: 'timeout', ECONNABORTED: 'timeout',
    UND_ERR_CONNECT_TIMEOUT: 'timeout', PHASE_TIMEOUT: 'timeout',
    ECONNREFUSED: 'upstream_unavailable', ECONNRESET: 'upstream_unavailable',
    ENOTFOUND: 'upstream_unavailable', EAI_AGAIN: 'upstream_unavailable',
    EHOSTUNREACH: 'upstream_unavailable', ENETUNREACH: 'upstream_unavailable',
    EPIPE: 'upstream_unavailable', ABORT_ERR: 'cancelled', ERR_CANCELED: 'cancelled',
    EAUTH: 'auth', ENOENT: 'not_found', ERR_INVALID_ARG_TYPE: 'validation',
    ITEM_LOGIN_REQUIRED: 'auth', INVALID_ACCESS_TOKEN: 'auth',
    SQLITE_BUSY: 'conflict', SQLITE_LOCKED: 'conflict', SQLITE_CONSTRAINT: 'conflict'
};

// Fixed identifiers @actual-app/api uses as a PostError reason. Matched whole.
const REASON_CATEGORY = {
    'network-failure': 'upstream_unavailable',
    unauthorized: 'auth',
    forbidden: 'auth',
    'decrypt-failure': 'auth',
    'invalid-password': 'auth',
    'file-not-found': 'not_found',
    'sync-error': 'conflict',
    'internal': 'internal'
};

const HTTP_PHRASES = {
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    408: 'Request Timeout', 409: 'Conflict', 422: 'Unprocessable Entity',
    429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout'
};

function categoryForStatus(status) {
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'not_found';
    if (status === 408) return 'timeout';
    if (status === 409) return 'conflict';
    if (status === 429) return 'rate_limited';
    if (status === 400 || status === 422) return 'validation';
    if (status >= 500 && status <= 599) return 'upstream_unavailable';
    return null;
}

// Keyword inference. Only the enum member leaves this function.
const KEYWORDS = [
    ['timeout', /time[d ]?-?out|timed out|did not finish within/i],
    ['rate_limited', /rate.?limit|too many requests|\b429\b/i],
    ['auth', /unauthori[sz]ed|forbidden|authentication|invalid password|decrypt|\b40[13]\b/i],
    ['not_found', /not found|does not exist|\b404\b/i],
    ['conflict', /already exists|conflict|duplicate|\b409\b/i],
    ['cancelled', /cancel+ed|aborted/i],
    ['upstream_unavailable', /network|ECONN|ENOTFOUND|unavailable|bad gateway|\b50[234]\b|socket hang up|could not get remote files/i],
    ['validation', /invalid|malformed|bad request|\b40[0]\b|\b422\b/i]
];

function categoryForText(text) {
    for (const [category, re] of KEYWORDS) if (re.test(text)) return category;
    return 'internal';
}

/** Our own full-string allowlist: "503 Service Unavailable" and Actual reasons. */
function allowlistedText(text) {
    const trimmed = text.trim();
    if (Object.prototype.hasOwnProperty.call(REASON_CATEGORY, trimmed)) {
        return { safeMessage: trimmed, category: REASON_CATEGORY[trimmed] };
    }
    const m = /^(\d{3}) ([A-Za-z ]+)$/.exec(trimmed);
    if (m && HTTP_PHRASES[m[1]] === m[2]) {
        const httpStatus = Number(m[1]);
        return { safeMessage: trimmed, category: categoryForStatus(httpStatus) || 'internal', httpStatus };
    }
    return null;
}

function statusOf(value) {
    const n = Number(value.httpStatus ?? value.statusCode ?? value.status ?? value.response?.status);
    return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

function safeCode(value) {
    const code = value && typeof value === 'object' ? value.code : undefined;
    if ((typeof code === 'string' || typeof code === 'number') && SAFE_CODE.test(String(code))) return code;
    return undefined;
}

/** Mark an error whose message is OUR text, so its message may be shown. */
function markOwnError(error, safeMessage, category) {
    Object.defineProperty(error, OWN, {
        value: { safeMessage, category }, enumerable: false, configurable: true
    });
    return error;
}

function ownOf(value) {
    const own = value && typeof value === 'object' ? value[OWN] : undefined;
    return own && typeof own.safeMessage === 'string' ? own : null;
}

function finish(out) {
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
}

/**
 * Reduce any thrown value (Error, string, object, anything) to
 * { type, code?, httpStatus?, category, safeMessage }.
 */
function classifyError(value) {
    if (typeof value === 'string') {
        const allowed = allowlistedText(value);
        const trimmed = value.trim();
        const asCode = CODE_TOKEN.test(trimmed) && Object.prototype.hasOwnProperty.call(CODE_CATEGORY, trimmed) ? trimmed : undefined;
        const category = allowed?.category || (asCode && CODE_CATEGORY[asCode]) || categoryForText(value);
        return finish({
            type: 'string',
            code: asCode,
            httpStatus: allowed?.httpStatus,
            category,
            safeMessage: allowed ? allowed.safeMessage : CATEGORY_TEXT[category]
        });
    }

    const isObject = value !== null && typeof value === 'object';
    const isError = value instanceof Error;
    const type = isError
        ? String(value.name || 'Error').slice(0, 60)
        : value === null ? 'null' : typeof value;
    if (!isObject) return { type, category: 'internal', safeMessage: CATEGORY_TEXT.internal };

    const code = safeCode(value);
    const httpStatus = statusOf(value);
    const own = ownOf(value);
    let message;
    try { message = typeof value.message === 'string' ? value.message : undefined; } catch (_) { /* getter threw */ }
    let reason;
    try { reason = typeof value.reason === 'string' ? value.reason : undefined; } catch (_) { /* getter threw */ }

    const fromReason = reason ? allowlistedText(reason) : null;
    const fromMessage = message ? allowlistedText(message) : null;
    const allowed = fromReason || fromMessage;

    let category = own?.category
        || (code !== undefined && CODE_CATEGORY[String(code)])
        || (httpStatus !== undefined && categoryForStatus(httpStatus))
        || allowed?.category
        || (type === 'AbortError' && 'cancelled')
        || (isError && /timeout/i.test(type) && 'timeout')
        || categoryForText([message, reason].filter(Boolean).join(' '));

    const safeMessage = own ? own.safeMessage
        : allowed ? allowed.safeMessage
        : httpStatus !== undefined && HTTP_PHRASES[httpStatus] && category === categoryForStatus(httpStatus)
            ? `${httpStatus} ${HTTP_PHRASES[httpStatus]}`
        : CATEGORY_TEXT[category];

    return finish({ type, code, httpStatus: httpStatus ?? allowed?.httpStatus, category, safeMessage });
}

/**
 * Stack frames (no message line) for DEBUG, only for our own errors. An error
 * whose first frame is inside @actual-app/api or node_modules is upstream's.
 */
function ownFrames(error) {
    if (!(error instanceof Error) || typeof error.stack !== 'string') return undefined;
    // Strip the header first: it is the message, and a message line can start with "at ".
    const header = String(error);
    const body = error.stack.startsWith(header) ? error.stack.slice(header.length) : '';
    const frames = realFrames(body);
    if (!frames) return undefined;
    const first = frames.split('\n')[0];
    if (!ownOf(error) && /node_modules|@actual-app\/api|handlers\$1\.api\//.test(first)) return undefined;
    return frames;
}

/**
 * Keep only lines that look like real stack frames: "at ..." with a file
 * position (path:line:col) or a node: internal. Max 15 lines, or undefined.
 */
function realFrames(text) {
    const frames = String(text).split('\n')
        .filter((l) => l.trim().startsWith('at ') && /node:|:\d+:\d+\)?$/.test(l.trim()))
        .slice(0, 15);
    return frames.length ? frames.join('\n') : undefined;
}

const ERROR_KEYS = new Set(['error', 'originalError', 'err']);
const DROPPED_KEYS = new Set(['errorMessage', 'errorStack', 'errorName']);

function isClassified(value) {
    return value !== null && typeof value === 'object' && !(value instanceof Error)
        && CATEGORIES.includes(value.category) && typeof value.safeMessage === 'string';
}

/**
 * Logger entry point: rewrite the error-carrying keys of a metadata object so
 * no upstream text reaches a record. Returns a new object; never throws.
 * A value that already looks classified is rebuilt from known fields only.
 */
function sanitizeErrorMeta(meta, { debug = false } = {}) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return meta;
    const out = {};
    for (const key of Object.keys(meta)) {
        if (DROPPED_KEYS.has(key)) continue;
        let value;
        try { value = meta[key]; } catch (_) { out[key] = '[unreadable]'; continue; }
        if (key === 'stack') {
            // Frames only, and only at DEBUG: the first stack line repeats the message.
            const frames = debug && typeof value === 'string' ? realFrames(value) : undefined;
            // Logged as `frames`: `stack` is a never field in the allowlist (#437).
            if (frames) out.frames = frames;
        } else if (ERROR_KEYS.has(key) && value !== undefined && value !== null) {
            out[key] = isClassified(value)
                ? finish({
                    type: typeof value.type === 'string' ? value.type.slice(0, 60) : undefined,
                    code: safeCode(value),
                    httpStatus: Number.isInteger(value.httpStatus) ? value.httpStatus : undefined,
                    category: value.category,
                    safeMessage: value.safeMessage
                })
                : classifyError(value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

module.exports = {
    CATEGORIES,
    classifyError,
    markOwnError,
    ownFrames,
    realFrames,
    sanitizeErrorMeta
};
