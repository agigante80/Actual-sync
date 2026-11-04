/**
 * A logFields stand-in that lets every key through. For tests of the logger
 * machinery (secret redaction, serialization, syslog framing, rotation) that
 * feed it arbitrary shapes on purpose. Use it with
 *   jest.mock('../lib/logFields', () => require('./helpers/openLogFields'));
 * Records stay flat, as before #437. The allowlist and `fields` are tested in logFields.test.js and loggerFields.test.js.
 */
const actual = jest.requireActual('../../lib/logFields');

module.exports = {
    ...actual,
    sanitizeFields: (input) => ({
        fields: input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {},
        dropped: 0
    }),
    // Flat records, as before #437: these tests read keys at the top level.
    splitEnvelope: (flat) => ({ envelope: { ...flat }, fields: {} })
};
