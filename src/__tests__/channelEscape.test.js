/**
 * Tests for src/lib/channelEscape.js (#257)
 */

const { escapeSlack, escapeDiscordMarkdown, truncateTelegramHtml } = require('../lib/channelEscape');

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
});
