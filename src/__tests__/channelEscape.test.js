/**
 * Tests for src/lib/channelEscape.js (#257)
 */

const { escapeSlack, escapeDiscordMarkdown, truncateTelegramHtml, truncateCodePoints } = require('../lib/channelEscape');

describe('escapeSlack', () => {
  test('escapes &, < and >', () => {
    expect(escapeSlack('Bob & Co <ltd> x>y')).toBe('Bob &amp; Co &lt;ltd&gt; x&gt;y');
  });

  test('leaves plain text unchanged', () => {
    expect(escapeSlack('Hello World 123')).toBe('Hello World 123');
  });

  test('coerces non-string input', () => {
    expect(escapeSlack(42)).toBe('42');
  });
});

describe('escapeDiscordMarkdown', () => {
  test('backslash-escapes \\ * _ ~ ` | >', () => {
    expect(escapeDiscordMarkdown('\\ * _ ~ ` | >')).toBe('\\\\ \\* \\_ \\~ \\` \\| \\>');
  });

  test('escapes markup inside a sentence', () => {
    expect(escapeDiscordMarkdown('*bold* and _italic_ and `code`')).toBe('\\*bold\\* and \\_italic\\_ and \\`code\\`');
  });

  test('leaves plain text unchanged', () => {
    expect(escapeDiscordMarkdown('Hello World 123')).toBe('Hello World 123');
  });

  // M2 (#257 review): [ ] ( ) were left active, so a rendered value spanning
  // a template's literal text and a variable could complete a masked link
  // ([label](url)) the operator never wrote.
  test('escapes [ ] ( ) so a value cannot complete a masked link', () => {
    expect(escapeDiscordMarkdown('[label](url)')).toBe('\\[label\\]\\(url\\)');
  });

  // M2 (#257 review): @everyone/@here/<@id> are not Markdown syntax, so
  // backslash-escaping an @ does nothing to suppress them. A zero-width
  // space after @ breaks the mention parser's exact match while the text
  // still reads the same to a human.
  test('inserts a zero-width space after @ to defuse mentions', () => {
    // The trailing > is also backslash-escaped by the existing markup rule,
    // same as any other > in the text; that is unrelated to the mention fix.
    expect(escapeDiscordMarkdown('@everyone hi @here <@123>')).toBe('@​everyone hi @​here <@​123\\>');
  });
});

describe('truncateTelegramHtml', () => {
  test('a 4000-character rendering is unchanged', () => {
    const text = 'a'.repeat(4000);
    expect(truncateTelegramHtml(text)).toBe(text);
    expect(truncateTelegramHtml(text).length).toBe(4000);
  });

  test('a rendering exactly at the 4096 limit is unchanged', () => {
    const text = 'a'.repeat(4096);
    expect(truncateTelegramHtml(text)).toBe(text);
  });

  test('a 5000-character rendering with <b> open at offset 4080 truncates to 4096 and ends with </b>', () => {
    const text = 'x'.repeat(4080) + '<b>' + 'y'.repeat(5000 - 4080 - 3);
    expect(text.length).toBe(5000);

    const out = truncateTelegramHtml(text);

    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith('</b>')).toBe(true);
  });

  test('never splits an HTML entity straddling the truncation boundary', () => {
    // Fill up to 4 characters short of the limit, then place an entity that
    // would straddle the boundary if truncation cut mid-entity.
    const text = 'a'.repeat(4093) + '&amp;' + 'b'.repeat(50);
    const out = truncateTelegramHtml(text);

    expect(out.length).toBeLessThanOrEqual(4096);
    // The output must not end with a partial entity fragment like "&am" or "&a".
    expect(out).not.toMatch(/&[a-zA-Z0-9#]*$/);
  });

  test('closes multiple nested open tags left open at the cut point', () => {
    const text = '<b><i>' + 'z'.repeat(5000);
    const out = truncateTelegramHtml(text, 100);

    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('</i></b>')).toBe(true);
  });

  test('a custom max is honored', () => {
    const text = 'a'.repeat(200);
    const out = truncateTelegramHtml(text, 50);
    expect(out.length).toBe(50);
  });

  test('coerces non-string input and short input is returned unchanged', () => {
    expect(truncateTelegramHtml(123)).toBe('123');
  });

  // H2 (#257 review): the tokenizer's fallback branch used to consume one
  // UTF-16 unit at a time, so a truncation point could fall between the two
  // surrogate halves of an astral character (most emoji), producing a lone
  // surrogate. 4095 (an odd offset) plus a 2-unit emoji puts the pair exactly
  // across the default 4096 boundary.
  test('never splits a surrogate pair at the truncation boundary', () => {
    const text = 'a'.repeat(4095) + '\u{1F600}' + 'b'.repeat(50);
    const out = truncateTelegramHtml(text);

    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.isWellFormed()).toBe(true);
  });
});

describe('truncateCodePoints', () => {
  test('short input is returned unchanged', () => {
    expect(truncateCodePoints('hello', 10)).toBe('hello');
  });

  test('truncates to exactly max code points', () => {
    const text = 'a'.repeat(5000);
    const out = truncateCodePoints(text, 4096);
    expect([...out]).toHaveLength(4096);
  });

  // H2-adjacent (#257 review): a naive `text.slice(0, max)` counts UTF-16
  // units, not code points, so an astral character at the boundary would be
  // split into a lone surrogate. truncateCodePoints iterates by code point
  // and must drop the whole character instead.
  test('never splits a surrogate pair at the truncation boundary', () => {
    const text = 'a'.repeat(4095) + '\u{1F600}\u{1F600}';
    const out = truncateCodePoints(text, 4096);

    expect([...out]).toHaveLength(4096);
    expect(out.isWellFormed()).toBe(true);
  });

  test('coerces non-string input', () => {
    expect(truncateCodePoints(123, 10)).toBe('123');
  });
});
