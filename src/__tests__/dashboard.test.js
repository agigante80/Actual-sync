/**
 * Dashboard page static checks (#244): the page must load no third-party
 * script, so it works offline and no external host can run code in the
 * authenticated admin UI.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'services', 'dashboard.html'), 'utf8');

describe('dashboard.html external references (#244)', () => {
  test('every <script src> is a same-origin path', () => {
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      expect(src).toMatch(/^\/(?!\/)/);
    }
  });

  test('references chart.js through the local vendor route', () => {
    expect(html).toContain('src="/vendor/chart.umd.min.js"');
  });

  test('no CDN or https script source remains in src/', () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(full); } else files.push(full);
      }
    };
    walk(path.join(__dirname, '..'));
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      expect(`${f}: ${/cdn\.jsdelivr\.net/.test(text)}`).toBe(`${f}: false`);
      expect(`${f}: ${/<script[^>]+src=["']https?:/i.test(text)}`).toBe(`${f}: false`);
    }
  });
});

describe('dashboard.html is CSP-clean (#243)', () => {
  test('has no inline <script> body', () => {
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter((m) => !/\bsrc\s*=/.test(m[1]) && m[2].trim() !== '');
    expect(inline).toEqual([]);
  });

  test('has no inline event handler attributes', () => {
    expect(html.match(/\son[a-z]+\s*=\s*["']/gi)).toBeNull();
  });

  test('loads its script from the same-origin /dashboard.js', () => {
    expect(html).toContain('src="/dashboard.js"');
  });

  test('the script file builds no inline handler attributes either', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'services', 'dashboard.js'), 'utf8');
    expect(js.match(/\son(click|change|error|load|input|submit)\s*=\s*["'`]/gi)).toBeNull();
    expect(js).not.toMatch(/javascript:/i);
    expect(js).not.toMatch(/\beval\(|new Function\(/);
  });
});

describe('running sync indicator (#284)', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'services', 'dashboard.js'), 'utf8');
  const fn = js.match(/function formatRunningSync\(running\) \{[\s\S]*?\n\}/);
  // eslint-disable-next-line no-new-func
  const formatRunningSync = fn && new Function(`${fn[0]}; return formatRunningSync;`)();

  test('the page has a slot for it and the script fills it with textContent', () => {
    expect(html).toContain('id="running-sync"');
    expect(js).toMatch(/getElementById\('running-sync'\)/);
    expect(js).toMatch(/runningSyncEl\.textContent = formatRunningSync\(data\.runningSync\)/);
    expect(js).not.toMatch(/runningSyncEl\.innerHTML/);
  });

  test('is empty when nothing runs', () => {
    expect(formatRunningSync(null)).toBe('');
    expect(formatRunningSync(undefined)).toBe('');
    expect(formatRunningSync({ startedAt: 'x' })).toBe('');
  });

  test('names the server and when it started', () => {
    const text = formatRunningSync({ key: 'Main', startedAt: '2026-09-26T01:00:00.000Z' });
    expect(text).toMatch(/^Syncing: Main since /);
  });

  test('keeps a markup-looking name as plain text and survives a bad date', () => {
    expect(formatRunningSync({ key: '<img src=x>', startedAt: 'nope' })).toBe('Syncing: <img src=x>');
  });
});
