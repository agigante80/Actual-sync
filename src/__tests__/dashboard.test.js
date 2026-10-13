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
