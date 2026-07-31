/**
 * Extract fenced ```json config snippets from markdown, for the doc guard (#177).
 *
 * Lives in helpers/ rather than inline in the test so the extraction rules can
 * be unit-tested directly. A review proved the previous inline version's headline
 * branch had zero coverage — deleting it left the suite green.
 *
 * Blocks in the docs appear at three nesting levels (whole config, a
 * `notifications` fragment, a bare server entry). Each is lifted to a whole
 * config so it can be validated. A block is skipped only when it does not look
 * like configuration at all, or when it is explicitly opted out with a
 * `<!-- config-guard: skip -->` comment on the line before the fence — the
 * escape hatch for documenting a genuine non-config payload such as an API
 * response.
 *
 * Known limitation: a typo in a top-level section name whose inner keys are not
 * themselves recognisable (e.g. `{"loging": {"level": "INFO"}}`) is still
 * skipped. Recognising those would need per-section key sets for every section.
 */
const SKIP_MARKER = /<!--\s*config-guard:\s*skip\s*-->\s*$/;

function buildSnippetExtractor(schema) {
    const topLevel = new Set(Object.keys(schema.properties));
    const notifKeys = new Set(Object.keys(schema.properties.notifications.properties));
    const serverKeys = new Set(Object.keys(schema.properties.servers.items.properties));

    const looksLikeSection = (v) => v && typeof v === 'object' && !Array.isArray(v) &&
        Object.keys(v).some(k => notifKeys.has(k) || serverKeys.has(k) || topLevel.has(k));

    return function configSnippets(markdown) {
        const out = [];
        const fence = /```json\n([\s\S]*?)```/g;
        let match;

        while ((match = fence.exec(markdown)) !== null) {
            const before = markdown.slice(0, match.index);
            if (SKIP_MARKER.test(before)) continue;

            let parsed;
            for (const candidate of [match[1], `{${match[1]}}`]) {
                try {
                    parsed = JSON.parse(candidate);
                    break;
                } catch { /* try the wrapped form */ }
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

            const keys = Object.keys(parsed);
            if (keys.length === 0) continue;

            if (keys.every(k => topLevel.has(k))) {
                out.push(parsed);
            } else if (keys.some(k => notifKeys.has(k))) {
                out.push({ notifications: parsed });
            } else if (keys.some(k => serverKeys.has(k))) {
                out.push({ servers: [parsed] });
            } else if (keys.length === 1 && looksLikeSection(parsed[keys[0]])) {
                // A single unrecognised wrapper around something plainly a config
                // section is a typo'd key ("notifcations"), not a payload sample.
                // Validate as-is so additionalProperties reports it.
                out.push(parsed);
            }
        }
        return out;
    };
}

module.exports = { buildSnippetExtractor };
