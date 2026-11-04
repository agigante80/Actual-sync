const { bankSyncCounts } = require('../lib/bankSyncCounts');

describe('bankSyncCounts (#391)', () => {
    test('counts new and matched transaction ids', () => {
        expect(bankSyncCounts({
            newTransactions: ['t1', 't2'],
            matchedTransactions: ['t3'],
            updatedAccounts: ['a1']
        })).toEqual({ added: 2, updated: 1 });
    });

    test.each([
        ['undefined (api before 26.11.0)', undefined],
        ['null', null],
        ['an empty object', {}],
        ['non-array fields', { newTransactions: 'abc', matchedTransactions: 3 }],
        ['a non-object', 42]
    ])('%s counts as 0', (_label, result) => {
        expect(bankSyncCounts(result)).toEqual({ added: 0, updated: 0 });
    });

    test('empty arrays count as 0', () => {
        expect(bankSyncCounts({ newTransactions: [], matchedTransactions: [] })).toEqual({ added: 0, updated: 0 });
    });
});

describe('describeResultLengths (#434)', () => {
    const { describeResultLengths } = require('../lib/bankSyncCounts');
    test('returns array lengths only, never values', () => {
        expect(describeResultLengths({ newTransactions: ['a', 'b'], payee: 'X', matchedTransactions: [] }))
            .toEqual({ newTransactions: 2, matchedTransactions: 0 });
    });
    test('non-objects give {}', () => {
        expect(describeResultLengths(undefined)).toEqual({});
        expect(describeResultLengths('str')).toEqual({});
    });
});
