/**
 * Tests for the unhandled-rejection log-level classifier (#105)
 */

const { classifyRejection } = require('../lib/rejectionClassifier');

describe('classifyRejection (#105)', () => {
    test("returns 'debug' for an Error whose stack references @actual-app/api", () => {
        const e = new Error('Failed syncing account');
        e.stack = 'Error: Failed syncing account\n    at handlers$1.api/bank-sync (/app/node_modules/@actual-app/api/dist/index.js:111167:31)';
        expect(classifyRejection(e)).toBe('debug');
    });

    test("returns 'debug' for a 'handlers$1.api/' stack even without the package path", () => {
        const e = new Error('boom');
        e.stack = 'Error: boom\n    at handlers$1.api/download-budget (somewhere:1:1)';
        expect(classifyRejection(e)).toBe('debug');
    });

    test("returns 'debug' for an empty-message Error with an api stack", () => {
        const e = new Error('');
        e.stack = 'Error\n    at x (/app/node_modules/@actual-app/api/dist/index.js:114741:27)';
        expect(classifyRejection(e)).toBe('debug');
    });

    test("returns 'error' for a plain Error from application code", () => {
        const e = new Error('something broke');
        e.stack = 'Error: something broke\n    at HealthCheckService.syncBank (/app/src/syncService.js:445:39)';
        expect(classifyRejection(e)).toBe('error');
    });

    test("returns 'error' when our code is the origin even if a deeper frame is in @actual-app/api (M7)", () => {
        // A real bug in our code that merely passes through an api callback must
        // not be hidden at debug: only the originating (top) frame counts.
        const e = new Error('our own bug');
        e.stack = [
            'Error: our own bug',
            '    at ourHandler (/app/src/syncService.js:200:10)',
            '    at runBankSync (/app/node_modules/@actual-app/api/dist/index.js:111167:31)'
        ].join('\n');
        expect(classifyRejection(e)).toBe('error');
    });

    test("returns 'error' for non-Error reasons (string, null, plain object)", () => {
        expect(classifyRejection('api failure')).toBe('error');
        expect(classifyRejection(null)).toBe('error');
        expect(classifyRejection({ message: 'not an Error' })).toBe('error');
    });

    test("returns 'error' for an Error with no stack", () => {
        const e = new Error('no stack');
        e.stack = undefined;
        expect(classifyRejection(e)).toBe('error');
    });
});
