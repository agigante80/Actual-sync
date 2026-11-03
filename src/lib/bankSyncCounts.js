/**
 * Transaction counts from one runBankSync result (#391).
 *
 * Since @actual-app/api 26.11.0 (actualbudget/actual#8998) runBankSync
 * resolves to { newTransactions, matchedTransactions, updatedAccounts }, each
 * an array of ids. Older versions resolve undefined. Only the counts leave
 * here: the ids are transaction data and are never passed on.
 *
 * Anything that is not an array (undefined, null, a malformed result) counts
 * as 0, so an unexpected upstream shape can never throw or inflate a count.
 *
 * @param {*} result - What runBankSync resolved to
 * @returns {{ added: number, updated: number }}
 */
function bankSyncCounts(result) {
    const count = (ids) => (Array.isArray(ids) ? ids.length : 0);
    return {
        added: count(result?.newTransactions),
        updated: count(result?.matchedTransactions)
    };
}

module.exports = { bankSyncCounts };
