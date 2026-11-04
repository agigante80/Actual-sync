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
        const input = { failedAccounts: [{ name: 'Alice Joint', error: 'boom' }] };
        expect(sanitizeFields(input).fields).toEqual(input);
        expect(sanitizeFields(input, { includePersonal: false }).fields).toEqual({});
    });

    test('the classified error object and the legacy string both pass', () => {
        const obj = { type: 'Error', code: 'E1', httpStatus: 503, category: 'timeout', safeMessage: 'x', stack: 'frames' };
        const out = sanitizeFields({ error: obj });
        expect(out.fields.error).toEqual({ type: 'Error', code: 'E1', httpStatus: 503, category: 'timeout', safeMessage: 'x' });
        expect(out.dropped).toBe(1);
        expect(sanitizeFields({ error: 'boom' })).toEqual({ fields: { error: 'boom' }, dropped: 0 });
    });

    test('non-object input gives no fields', () => {
        expect(sanitizeFields(undefined)).toEqual({ fields: {}, dropped: 0 });
        expect(sanitizeFields('str').dropped).toBe(1);
        expect(sanitizeFields([1]).dropped).toBe(1);
    });

    test('the drop observer sees paths, and a throwing observer never breaks logging', () => {
        jest.isolateModules(() => {
            const fresh = require('../lib/logFields');
            const seen = [];
            fresh.setDropObserver((paths) => seen.push(...paths));
            fresh.sanitizeFields({ nope: 1, webhooks: { x: 1 } });
            expect(seen).toEqual(['nope', 'webhooks.x']);
            fresh.setDropObserver(() => { throw new Error('observer'); });
            expect(() => fresh.sanitizeFields({ nope: 1 })).not.toThrow();
        });
    });
});

describe('splitEnvelope', () => {
    test('keeps the envelope keys at the top and moves the rest', () => {
        const { envelope, fields } = splitEnvelope({ event: 'e', component: 'c', server: 's', durationMs: 5, error: 'x' });
        expect(envelope).toEqual({ event: 'e', component: 'c', server: 's', error: 'x' });
        expect(fields).toEqual({ durationMs: 5 });
    });
});
