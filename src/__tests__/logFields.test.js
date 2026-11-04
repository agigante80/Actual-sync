/**
 * Field allowlist with data classes (D3, #437): sanitizeFields() and the registry.
 */
const { FIELDS, CLASS, MAX_DEPTH, ENVELOPE_KEYS, sanitizeFields, splitEnvelope } = require('../lib/logFields');

// This file calls sanitizeFields() with unregistered keys on purpose.
allowDroppedFields();

describe('registry', () => {
    test('every entry has a known class and a type', () => {
        const classes = new Set(Object.values(CLASS));
        for (const [key, spec] of Object.entries(FIELDS)) {
            expect({ key, ok: classes.has(spec.class) }).toEqual({ key, ok: true });
            expect({ key, ok: spec.type !== undefined }).toEqual({ key, ok: true });
        }
    });

    test('the envelope keys are registered (droppedFieldCount is written by the logger)', () => {
        for (const key of ENVELOPE_KEYS.filter((k) => k !== 'droppedFieldCount')) {
            expect(FIELDS).toHaveProperty(key);
        }
        expect(FIELDS).not.toHaveProperty('droppedFieldCount');
    });

    test('financial, upstream and secret keys exist so a leak is a named decision', () => {
        expect(FIELDS.payee.class).toBe(CLASS.FINANCIAL);
        expect(FIELDS.errorStack.class).toBe(CLASS.UPSTREAM);
        expect(FIELDS.chatId.class).toBe(CLASS.SECRET);
    });

    test('stack is upstream (never emitted); frames is the op key for our own frames (H1)', () => {
        expect(FIELDS.stack.class).toBe(CLASS.UPSTREAM);
        expect(sanitizeFields({ stack: 'Error: SENTINEL_MESSAGE\n at x' })).toEqual({ fields: {}, dropped: 1 });
        expect(FIELDS.frames.class).toBe(CLASS.OP);
        expect(sanitizeFields({ frames: '    at ourCode (/app/src/x.js:1:1)' }).dropped).toBe(0);
    });

    test('operational timer, queue and alert keys are registered (M1)', () => {
        const input = { operation: 'sync-Main', slow: true, verySlow: false, ahead: 2, events: 3 };
        expect(sanitizeFields(input)).toEqual({ fields: input, dropped: 0 });
    });
});

describe('sanitizeFields', () => {
    test('keeps registered scalars and counts nothing', () => {
        const out = sanitizeFields({ durationMs: 12, status: 'success', accountId: 'a1', isAutomated: true });
        expect(out).toEqual({ fields: { durationMs: 12, status: 'success', accountId: 'a1', isAutomated: true }, dropped: 0 });
    });

    test('drops an unregistered key and counts it, without naming it', () => {
        const out = sanitizeFields({ durationMs: 1, surprise: 'SENTINEL_VALUE' });
        expect(out.fields).toEqual({ durationMs: 1 });
        expect(out.dropped).toBe(1);
        expect(JSON.stringify(out)).not.toMatch(/surprise|SENTINEL_VALUE/);
    });

    test('drops a transaction object under any key', () => {
        const tx = { payee: 'SENTINEL_PAYEE', amount: -12345, notes: 'rent' };
        const out = sanitizeFields({ result: { newTransactions: [tx] }, transactions: [tx], tx, count: 1 });
        expect(out.fields).toEqual({ count: 1 });
        expect(out.dropped).toBe(3);
        expect(JSON.stringify(out)).not.toMatch(/SENTINEL_PAYEE|12345/);
    });

    test.each(['payee', 'errorStack', 'chatId', 'password', 'url'])('never emits the never-class key %s', (key) => {
        const out = sanitizeFields({ [key]: 'x' });
        expect(out).toEqual({ fields: {}, dropped: 1 });
    });

    test('a registered scalar key holding an object is dropped whole', () => {
        const out = sanitizeFields({ durationMs: { payee: 'SENTINEL_PAYEE' }, status: ['a'] });
        expect(out.fields).toEqual({});
        expect(out.dropped).toBe(2);
    });

    test('a wrong scalar type is dropped (a string where a number is registered)', () => {
        expect(sanitizeFields({ durationMs: '12', port: NaN })).toEqual({ fields: {}, dropped: 2 });
    });

    test('null is kept, undefined is skipped without a count', () => {
        expect(sanitizeFields({ status: null, mode: undefined })).toEqual({ fields: { status: null }, dropped: 0 });
    });

    test('an object keeps registered children and drops the others', () => {
        const out = sanitizeFields({ webhooks: { slack: 2, discord: 1, url: 'https://x' } });
        expect(out.fields).toEqual({ webhooks: { slack: 2, discord: 1 } });
        expect(out.dropped).toBe(1);
    });

    test('arrays of scalars and of registered objects pass; stray items are dropped', () => {
        const out = sanitizeFields({
            servers: ['A', 'B', { x: 1 }],
            schedules: [{ schedule: '0 3 * * *', servers: ['A'], nextInvocation: 'soon', leak: 'x' }]
        });
        expect(out.fields).toEqual({
            servers: ['A', 'B'],
            schedules: [{ schedule: '0 3 * * *', servers: ['A'], nextInvocation: 'soon' }]
        });
        expect(out.dropped).toBe(2);
    });

    test('objects deeper than MAX_DEPTH are refused', () => {
        expect(MAX_DEPTH).toBe(3);
        // schedules (1) > item (2) > servers (3) > string is fine; one more object level is not.
        const out = sanitizeFields({ schedules: [{ servers: [{ deeper: 1 }] }] });
        expect(out.fields).toEqual({ schedules: [{ servers: [] }] });
        expect(out.dropped).toBe(1);
    });

    test('a map of counts accepts numbers only and plain key names', () => {
        const out = sanitizeFields({ lengths: { newTransactions: 2, 'bad key': 3, text: 'SENTINEL_PAYEE' } });
        expect(out.fields).toEqual({ lengths: { newTransactions: 2 } });
        expect(out.dropped).toBe(2);
    });

    test('prototype names are not registered keys', () => {
        const out = sanitizeFields(JSON.parse('{"__proto__": {"x": 1}, "constructor": 1, "hasOwnProperty": 2}'));
        expect(out).toEqual({ fields: {}, dropped: 3 });
    });

    test('class personal follows includePersonal', () => {
        const input = { accountName: 'Alice Joint', remoteAddress: '10.0.0.1', accountId: 'a1' };
        expect(sanitizeFields(input).fields).toEqual(input);
        const off = sanitizeFields(input, { includePersonal: false });
        expect(off.fields).toEqual({ accountId: 'a1' });
        expect(off.dropped).toBe(2);
    });

    test('a personal child inside an allowed object follows includePersonal too', () => {
        const input = { failedAccounts: [{ name: 'Alice Joint', error: { category: 'auth', safeMessage: 'x' } }] };
        expect(sanitizeFields(input).fields).toEqual(input);
        expect(sanitizeFields(input, { includePersonal: false }).fields).toEqual({});
    });

    test('the classified error object passes; a string error is dropped (#438)', () => {
        const obj = { type: 'Error', code: 'E1', httpStatus: 503, category: 'timeout', safeMessage: 'x', stack: 'frames' };
        const out = sanitizeFields({ error: obj });
        expect(out.fields.error).toEqual({ type: 'Error', code: 'E1', httpStatus: 503, category: 'timeout', safeMessage: 'x' });
        expect(out.dropped).toBe(1);
        expect(sanitizeFields({ error: 'boom' })).toEqual({ fields: {}, dropped: 1 });
        takeDroppedFields();
    });

    test('non-object input gives no fields', () => {
        expect(sanitizeFields(undefined)).toEqual({ fields: {}, dropped: 0 });
        expect(sanitizeFields('str').dropped).toBe(1);
        expect(sanitizeFields([1]).dropped).toBe(1);
    });

    test('the drop observer sees paths, and a throwing observer never breaks logging', () => {
        // The observer is global (M2): put the harness's back afterwards.
        const key = Symbol.for('actual-sync.logFields.dropObserver');
        const harness = globalThis[key];
        jest.isolateModules(() => {
            const fresh = require('../lib/logFields');
            const seen = [];
            fresh.setDropObserver((paths) => seen.push(...paths));
            fresh.sanitizeFields({ nope: 1, webhooks: { x: 1 } });
            expect(seen).toEqual(['nope', 'webhooks.x']);
            fresh.setDropObserver(() => { throw new Error('observer'); });
            expect(() => fresh.sanitizeFields({ nope: 1 })).not.toThrow();
        });
        globalThis[key] = harness;
    });
});

describe('splitEnvelope', () => {
    test('keeps the envelope keys at the top and moves the rest', () => {
        const { envelope, fields } = splitEnvelope({ event: 'e', component: 'c', server: 's', durationMs: 5, error: 'x' });
        expect(envelope).toEqual({ event: 'e', component: 'c', server: 's', error: 'x' });
        expect(fields).toEqual({ durationMs: 5 });
    });
});

describe('keys and lengths accept only the known result names (L1)', () => {
    test('known names pass', () => {
        const input = {
            keys: ['newTransactions', 'matchedTransactions', 'updatedAccounts', 'errors'],
            lengths: { newTransactions: 2, matchedTransactions: 0, updatedAccounts: 1, errors: 0 }
        };
        expect(sanitizeFields(input)).toEqual({ fields: input, dropped: 0 });
    });

    test('other names are dropped and counted, never written', () => {
        const out = sanitizeFields({
            keys: ['newTransactions', 'SENTINEL_KEY'],
            lengths: { newTransactions: 2, SENTINEL_LEN: 5 }
        });
        expect(out.fields).toEqual({ keys: ['newTransactions'], lengths: { newTransactions: 2 } });
        expect(out.dropped).toBe(2);
        expect(JSON.stringify(out)).not.toMatch(/SENTINEL/);
    });
});

describe('drop observer survives jest.resetModules (M2)', () => {
    test('a re-required logFields still reports to the harness', () => {
        jest.resetModules();
        const fresh = require('../lib/logFields');
        takeDroppedFields();
        fresh.sanitizeFields({ bogusKeyAfterReset: 1 });
        expect(takeDroppedFields()).toEqual(['bogusKeyAfterReset']);
    });
});

describe('audit records keep remoteAddress without includePersonal (M3)', () => {
    test('sanitizeFields keeps a keepOnAudit key only when audit is true', () => {
        const input = { remoteAddress: '10.0.0.9', accountName: 'Alice' };
        expect(sanitizeFields(input, { includePersonal: false, audit: true }).fields).toEqual({ remoteAddress: '10.0.0.9' });
        expect(sanitizeFields(input, { includePersonal: false }).fields).toEqual({});
    });
});

describe('version fields (security review of #437)', () => {
    test('a version-shaped serverVersion is kept', () => {
        expect(sanitizeFields({ serverVersion: '26.11.0', testedUpTo: '25.1.0-beta.2' }))
            .toEqual({ fields: { serverVersion: '26.11.0', testedUpTo: '25.1.0-beta.2' }, dropped: 0 });
    });
    test('server-supplied text in serverVersion is dropped', () => {
        expect(sanitizeFields({ serverVersion: '26.11.0 contact alice@example.com' }))
            .toEqual({ fields: {}, dropped: 1 });
    });
});
