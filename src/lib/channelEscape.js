/**
 * Channel output escaping (#257).
 *
 * templateRenderer.js renders every template with escaping OFF (`noEscape:
 * true`) except Telegram/email-HTML, which lean on Handlebars' own HTML
 * escaping. Slack and Discord instead escape the WHOLE rendered string here,
 * after templating, so a payee name containing platform markup (`*bold*`,
 * `` `code` ``, a bare `&`) cannot alter the message structure the operator
 * wrote. See docs/NOTIFICATIONS.md "Message templates" for the full per-channel
 * table.
 */

/**
 * Escape the three characters Slack's mrkdwn parser treats specially.
 * Slack has no user-facing markup story in v1 (plain-text semantics), so this
 * simply neutralises `&`, `<` and `>` the same way HTML does.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeSlack(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Backslash-escape the characters Discord's Markdown parser treats specially,
 * so a rendered value cannot turn into bold/italic/strikethrough/code/quote/
 * masked-link markup, or a mention-like `>` the operator did not write.
 * `[`, `]`, `(`, `)` are included so a value cannot complete a masked link
 * (`[label](url)`) that spans a template's literal text and a rendered
 * variable. `@` is neutralised separately below: Discord mentions
 * (`@everyone`, `@here`, `<@id>`) are not Markdown syntax, so backslash-
 * escaping an `@` does not suppress them; a zero-width space breaks the
 * exact-match the mention parser looks for while leaving the text visually
 * unchanged. This is defense in depth alongside `allowed_mentions: { parse:
 * [] }`, which `sendTemplated`'s Discord branch always sends. (#257 review)
 *
 * @param {string} text
 * @returns {string}
 */
function escapeDiscordMarkdown(text) {
  return String(text)
    .replace(/[\\*_~`|>()[\]]/g, (ch) => `\\${ch}`)
    .replace(/@/g, '@​');
}

// Tags templateRenderer's telegram_markup check allows in literal template
// text. Only these can appear in a rendered Telegram message, so the
// truncator only ever needs to track this set.
const TELEGRAM_TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a']);

const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:\s+[a-zA-Z-]+(?:="[^"]*")?)*\s*>/;
const ENTITY_RE = /^&[#a-zA-Z0-9]+;/;

/**
 * Split rendered Telegram HTML into atomic units - each unit is a whole tag
 * (open or close), a whole HTML entity, or a single Unicode code point - so a
 * truncation point can never land inside one. Indexing by UTF-16 code unit
 * instead of code point would let a cut fall between the two surrogate
 * halves of an astral character (most emoji), producing a lone surrogate and
 * an ill-formed string. (#257 review)
 *
 * @param {string} text
 * @returns {{raw: string, tag: string|null, closing: boolean}[]}
 */
function tokenizeTelegramHtml(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const tagMatch = TAG_RE.exec(rest);
    if (tagMatch && TELEGRAM_TAGS.has(tagMatch[2].toLowerCase())) {
      tokens.push({ raw: tagMatch[0], tag: tagMatch[2].toLowerCase(), closing: tagMatch[1] === '/' });
      i += tagMatch[0].length;
      continue;
    }
    const entityMatch = ENTITY_RE.exec(rest);
    if (entityMatch) {
      tokens.push({ raw: entityMatch[0], tag: null, closing: false });
      i += entityMatch[0].length;
      continue;
    }
    const codePoint = text.codePointAt(i);
    const charWidth = codePoint > 0xffff ? 2 : 1; // surrogate pair vs single unit
    tokens.push({ raw: text.slice(i, i + charWidth), tag: null, closing: false });
    i += charWidth;
  }
  return tokens;
}

/**
 * Truncate plain text to at most `max` Unicode code points without ever
 * splitting a surrogate pair. Used for content that carries no tags or
 * entities to preserve (for example the plain-text Telegram fallback sent
 * without `parse_mode` after a 400).
 *
 * @param {string} text
 * @param {number} [max=4096]
 * @returns {string}
 */
function truncateCodePoints(text, max = 4096) {
  const value = String(text);
  if (value.length <= max) return value; // fast path: cannot exceed max code points either
  let output = '';
  let count = 0;
  for (const char of value) { // iterates by code point, not UTF-16 unit
    if (count >= max) break;
    output += char;
    count += 1;
  }
  return output;
}

/**
 * Truncate rendered Telegram HTML to at most `max` characters without ever
 * cutting inside a tag or an HTML entity, and close any `<b>`/`<i>`/... tags
 * left open at the cut point so the result is still valid Telegram HTML.
 *
 * @param {string} text - already-rendered, already HTML-escaped message text
 * @param {number} [max=4096] - Telegram's message length limit
 * @returns {string}
 */
function truncateTelegramHtml(text, max = 4096) {
  const value = String(text);
  if (value.length <= max) return value;

  const tokens = tokenizeTelegramHtml(value);
  const stack = [];
  let output = '';

  for (const token of tokens) {
    const nextStack = stack.slice();
    if (token.tag && !token.closing) nextStack.push(token.tag);
    else if (token.tag && token.closing) {
      const idx = nextStack.lastIndexOf(token.tag);
      if (idx !== -1) nextStack.splice(idx, 1);
    }
    const closingSuffix = nextStack
      .slice()
      .reverse()
      .map((tag) => `</${tag}>`)
      .join('');

    if (output.length + token.raw.length + closingSuffix.length > max) break;

    output += token.raw;
    stack.length = 0;
    stack.push(...nextStack);
  }

  const suffix = stack
    .slice()
    .reverse()
    .map((tag) => `</${tag}>`)
    .join('');

  return output + suffix;
}

module.exports = { escapeSlack, escapeDiscordMarkdown, truncateTelegramHtml, truncateCodePoints };
