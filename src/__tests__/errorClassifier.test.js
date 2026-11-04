/**
 * Error classifier (#438, D5): classify, never echo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { Logger } = require('../lib/logger');
const {
    CATEGORIES, classifyError, markOwnError, ownFrames, sanitizeErrorMeta
} = require('../lib/errorClassifier');
const { enhanceActualApiError } = require('../lib/actualApiError');
const { PhaseTimeoutError } = require('../lib/actualTimeouts');
const { SyncHistoryService } = require('../services/syncHistory');

const SENTINEL = 'SENTINEL_PAYEE';

describe('classifyError', () => {
    test('never carries the message, reason or cause of an upstream error', () => {
        const e = Object.assign(new Error(`Category 'Rent to ${SENTINEL}' already exists`), {
            reason: `IBAN ES9121000418450200051332 ${SENTINEL}`,
            cause: new Error(SENTINEL),
            statusCode: 409
        });
        const c = classifyError(e);
        expect(JSON.stringify(c)).not.toContain(SENTINEL);
        expect(JSON.stringify(c)).not.toContain('IBAN');
        expect(c).toEqual({ type: 'Error', httpStatus: 409, category: 'conflict', safeMessage: '409 Conflict' });
    });

    test.each([
        [{ code: 'ETIMEDOUT' }, 'timeout'],
        [{ code: 'ECONNREFUSED' }, 'upstream_unavailable'],
        [{ statusCode: 401 }, 'auth'],
        [{ statusCode: 404 }, 'not_found'],
        [{ statusCode: 429 }, 'rate_limited'],
        [{ statusCode: 422 }, 'validation'],
        [{ statusCode: 503 }, 'upstream_unavailable'],
        [{ name: 'AbortError' }, 'cancelled'],
        [{}, 'internal']
    ])('maps %j to %s', (props, category) => {
        const e = Object.assign(new Error('x'), props);
        if (props.name) e.name = props.name;
        const c = classifyError(e);
        expect(c.category).toBe(category);
        expect(CATEGORIES).toContain(c.category);
    });

    test('safeMessage is a full-string allowlist match or our own category text', () => {
        expect(classifyError('503 Service Unavailable').safeMessage).toBe('503 Service Unavailable');
        expect(classifyError('503 Service Unavailable').httpStatus).toBe(503);
        expect(classifyError('network-failure')).toEqual(expect.objectContaining({
            category: 'upstream_unavailable', safeMessage: 'network-failure'
        }));
        // A partial match is not a match: the payee after it must not survive.
        const c = classifyError(`503 Service Unavailable for ${SENTINEL}`);
        expect(c.safeMessage).toBe('Upstream service unavailable');
        expect(JSON.stringify(c)).not.toContain(SENTINEL);
        // The status phrase must be the standard one for that code.
        expect(classifyError(`503 ${SENTINEL}`).safeMessage).not.toContain(SENTINEL);
    });

    test('an Actual PostError reason is read from the whitelist only', () => {
        expect(classifyError({ type: 'PostError', reason: 'unauthorized' })).toEqual(expect.objectContaining({
            category: 'auth', safeMessage: 'unauthorized'
        }));
        expect(JSON.stringify(classifyError({ type: 'PostError', reason: SENTINEL }))).not.toContain(SENTINEL);
    });

    test('handles non-errors, odd codes and throwing getters', () => {
        expect(classifyError(null).category).toBe('internal');
        expect(classifyError(undefined).type).toBe('undefined');
        expect(classifyError({ code: `x ${SENTINEL} y` }).code).toBeUndefined();
        const hostile = { get message() { throw new Error(SENTINEL); } };
        expect(JSON.stringify(classifyError(hostile))).not.toContain(SENTINEL);
        expect(classifyError('SQLITE_BUSY')).toEqual(expect.objectContaining({ code: 'SQLITE_BUSY', category: 'conflict' }));
    });

    test('our own marked errors keep their text', () => {
        const own = markOwnError(new Error('raw'), 'Our own words', 'validation');
        expect(classifyError(own)).toEqual(expect.objectContaining({ category: 'validation', safeMessage: 'Our own words' }));
        const t = classifyError(new PhaseTimeoutError('downloadBudget', 5000));
        expect(t).toEqual(expect.objectContaining({
            category: 'timeout', code: 'PHASE_TIMEOUT',
            safeMessage: "Actual API call 'downloadBudget' did not finish within 5s"
        }));
    });

    test('enhanced Actual API errors show our headline, not the upstream text', () => {
        const upstream = new Error(`network-failure ${SENTINEL}`);
        const enhanced = enhanceActualApiError(upstream, {
            phase: 'download', serverUrl: 'http://x', syncId: 'b', isEncrypted: false
        }, { warn() {}, debug() {} });
        const c = classifyError(enhanced);
        expect(c.category).toBe('upstream_unavailable');
        expect(c.safeMessage).toMatch(/^Network connection to Actual Budget server failed\. /);
        expect(JSON.stringify(c)).not.toContain(SENTINEL);
    });
});

describe('ownFrames', () => {
    test('returns frames without the message line, and nothing for upstream frames', () => {
        const e = new Error(SENTINEL);
        const frames = ownFrames(e);
        expect(frames).toMatch(/^\s*at /);
        expect(frames).not.toContain(SENTINEL);
        const upstream = new Error('x');
        upstream.stack = 'Error: x\n    at f (/app/node_modules/@actual-app/api/dist/app.js:1:1)';
        expect(ownFrames(upstream)).toBeUndefined();
        expect(ownFrames('str')).toBeUndefined();
    });
});

describe('sanitizeErrorMeta', () => {
    test('classifies error keys, drops legacy raw keys, keeps frames only', () => {
        const out = sanitizeErrorMeta({
            error: `bad ${SENTINEL}`, originalError: new Error(SENTINEL),
            errorMessage: SENTINEL, errorStack: SENTINEL, errorName: SENTINEL,
            stack: `Error: ${SENTINEL}\n    at f (/app/x.js:1:1)`, accountId: 'a1'
        }, { debug: true });
        expect(JSON.stringify(out)).not.toContain(SENTINEL);
        expect(out.error.category).toBeDefined();
        expect(out.stack).toBe('    at f (/app/x.js:1:1)');
        expect(out.accountId).toBe('a1');
    });

    test('rebuilds an already classified object from known fields only', () => {
        const out = sanitizeErrorMeta({ error: { category: 'timeout', safeMessage: 'x', extra: SENTINEL, code: `a ${SENTINEL}` } });
        expect(out.error).toEqual({ category: 'timeout', safeMessage: 'x' });
    });
});

describe('Logger never writes upstream text (#438)', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errcls-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('DEBUG level, every error shape, console and file', () => {
        const lines = [];
        const spies = ['log', 'warn', 'error'].map((m) => jest.spyOn(console, m).mockImplementation((l) => lines.push(l)));
        try {
            const logger = new Logger({ format: 'json', fileFormat: 'json', level: 'DEBUG', logDir: dir, rotation: { enabled: false } });
            const err = Object.assign(new Error(`Category '${SENTINEL}' already exists`), { reason: SENTINEL, cause: new Error(SENTINEL) });
            logger.error(err);
            logger.error('m', { error: err });
            logger.warn('m', { error: err.message, errorMessage: err.message, errorStack: err.stack });
            logger.debug('m', { nested: { failure: err }, originalError: err });
            logger.info('m', { cause: err });
        } finally { spies.forEach((s) => s.mockRestore()); }
        const file = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
        expect(lines.length).toBe(5);
        expect(lines.join('\n')).not.toContain(SENTINEL);
        expect(file).not.toContain(SENTINEL);
    });

    test('stack frames appear only at DEBUG', () => {
        const run = (level) => {
            const lines = [];
            const spy = jest.spyOn(console, 'error').mockImplementation((l) => lines.push(l));
            try { new Logger({ format: 'json', level, logDir: null }).error(new Error('x')); } finally { spy.mockRestore(); }
            return JSON.parse(lines[0]);
        };
        expect(run('INFO').stack).toBeUndefined();
        expect(run('DEBUG').stack).toMatch(/at /);
    });
});

describe('sync_history migration (#438)', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errmig-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const quiet = { loggerConfig: { level: 'ERROR', logDir: null } };
    beforeEach(() => { ['log', 'warn', 'error'].forEach((m) => jest.spyOn(console, m).mockImplementation(() => {})); });
    afterEach(() => jest.restoreAllMocks());

    test('rewrites old raw rows to their category once and leaves later rows alone', () => {
        const dbPath = path.join(dir, 'h.db');
        const first = new SyncHistoryService({ dbPath, ...quiet });
        const insert = (msg) => first.db.prepare(
            "INSERT INTO sync_history (timestamp, server_name, status, error_message) VALUES (?,'s','failure',?)"
        ).run(new Date().toISOString(), msg);
        insert(`1 account(s) failed to sync: Category 'Rent to ${SENTINEL}' already exists`);
        insert(`Request timed out for ${SENTINEL}`);
        insert(null);
        first.db.pragma('user_version = 0');
        first.close();

        const second = new SyncHistoryService({ dbPath, ...quiet });
        const rows = second.db.prepare('SELECT error_message m FROM sync_history ORDER BY id').all().map((r) => r.m);
        expect(rows).toEqual(['Conflict with existing data', 'Operation timed out', null]);
        expect(JSON.stringify(rows)).not.toContain(SENTINEL);
        expect(second.db.pragma('user_version', { simple: true })).toBe(1);

        // Runs once: a row stored afterwards is not touched at the next start.
        second.db.prepare("UPDATE sync_history SET error_message = 'Our own text' WHERE id = 3").run();
        second.close();
        const third = new SyncHistoryService({ dbPath, ...quiet });
        expect(third.db.prepare('SELECT error_message m FROM sync_history WHERE id = 3').get().m).toBe('Our own text');
        third.close();
    });
});

describe('review round 1 (#438)', () => {
    test('M1: a stack field is dropped unless the record is DEBUG', () => {
        const meta = { error: 'x', stack: 'Error: x\n    at f (/app/x.js:1:1)' };
        expect(sanitizeErrorMeta(meta, { debug: false }).stack).toBeUndefined();
        expect(sanitizeErrorMeta(meta).stack).toBeUndefined();
        expect(sanitizeErrorMeta(meta, { debug: true }).stack).toMatch(/at f/);
    });

    test('M1: an ERROR record with a stack field at INFO level has no stack', () => {
        const lines = [];
        const spy = jest.spyOn(console, 'error').mockImplementation((l) => lines.push(l));
        try {
            new Logger({ format: 'json', level: 'INFO', logDir: null })
                .error('m', { stack: 'Error: x\n    at f (/app/x.js:1:1)' });
        } finally { spy.mockRestore(); }
        expect(JSON.parse(lines[0]).stack).toBeUndefined();
    });

    test('M3: ITEM_LOGIN_REQUIRED and INVALID_ACCESS_TOKEN are auth', () => {
        for (const code of ['ITEM_LOGIN_REQUIRED', 'INVALID_ACCESS_TOKEN']) {
            expect(classifyError(Object.assign(new Error('x'), { code })).category).toBe('auth');
        }
    });

    test('L1: a one-word uppercase string that is not a known code is not copied into code', () => {
        expect(classifyError('RossiMarco'.toUpperCase()).code).toBeUndefined();
        expect(classifyError('ITEM_LOGIN_REQUIRED').code).toBe('ITEM_LOGIN_REQUIRED');
    });

    test('L2: message lines that start with "at " are not stack frames', () => {
        const e = new Error('Payee list:\n    at Rossi Marco 120.00 EUR');
        expect(ownFrames(e) || '').not.toContain('Rossi');
        const out = sanitizeErrorMeta({ stack: e.stack }, { debug: true });
        expect(JSON.stringify(out)).not.toContain('Rossi');
        expect(sanitizeErrorMeta({ stack: 'at Rossi Marco 120.00 EUR' }, { debug: true }).stack).toBeUndefined();
    });

    test('L2: a DEBUG logger record of that error carries no payee', () => {
        const lines = [];
        const spy = jest.spyOn(console, 'error').mockImplementation((l) => lines.push(l));
        try {
            new Logger({ format: 'json', level: 'DEBUG', logDir: null })
                .error(new Error('Payee list:\n    at Rossi Marco 120.00 EUR'));
        } finally { spy.mockRestore(); }
        expect(lines.join('\n')).not.toContain('Rossi');
    });
});
