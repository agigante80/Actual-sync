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

  // Behaviour test: run the real dashboard.js in a vm with a fake WebSocket and
  // fake timers. (#280)
  describe('reconnect loop (#280)', () => {
    const vm = require('vm');
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'dashboard.js'), 'utf8');

    function harness() {
      const listeners = {};
      const sockets = [];
      let timers = [];
      let now = 0;
      class WS {
        constructor(u) { this.url = u; this.readyState = 0; sockets.push(this); }
        static get CONNECTING() { return 0; }
        static get OPEN() { return 1; }
        static get CLOSING() { return 2; }
        static get CLOSED() { return 3; }
        close() { this.readyState = 2; }
        send() {}
      }
      const ctx = {
        console: { log() {}, warn() {}, error() {} },
        document: {
          hidden: false,
          addEventListener(e, f) { listeners[e] = f; },
          querySelector: () => null,
          querySelectorAll: () => [],
          getElementById: () => ({ scrollHeight: 0, scrollTop: 0, clientHeight: 0, innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {} })
        },
        window: { location: { protocol: 'http:', host: 'h' } },
        WebSocket: WS, Date: class extends Date { static now() { return now; } }, Math, JSON, Error,
        Chart: { defaults: {} },
        fetch: async () => ({ ok: true, json: async () => ({ ticket: 't' + sockets.length }) }),
        getFetchOptions: () => ({}), addLogEntry() {},
        setTimeout(f, d) { const t = { f, at: now + d }; timers.push(t); return t; },
        clearTimeout(t) { timers = timers.filter(x => x !== t); },
        setInterval() { return 1; }, clearInterval() {},
        encodeURIComponent
      };
      vm.createContext(ctx);
      vm.runInContext(src + '\n;addLogEntry = function () {};\nthis.connectWebSocket = connectWebSocket;', ctx);
      const tick = () => new Promise(r => setImmediate(r));
      return {
        ctx, sockets, listeners, tick,
        pendingTimers: () => timers.length,
        async advance(ms) {
          now += ms;
          for (;;) {
            const due = timers.filter(t => t.at <= now);
            if (!due.length) break;
            timers = timers.filter(t => !due.includes(t));
            for (const t of due) { t.f(); await tick(); await tick(); }
          }
        },
        open(s) { s.readyState = 1; s.onopen && s.onopen(); },
        closed(s) { s.readyState = 3; s.onclose && s.onclose(); },
        live: () => sockets.filter(s => s.readyState === 1).length,
        visible: async (hidden) => { ctx.document.hidden = hidden; listeners.visibilitychange(); await tick(); await tick(); }
      };
    }

    test('a socket still CLOSING when the page becomes visible leaves exactly one open socket', async () => {
      const h = harness();
      await h.ctx.connectWebSocket();
      h.open(h.sockets[0]);
      h.sockets[0].close(); // CLOSING
      await h.visible(true);
      await h.visible(false);
      h.open(h.sockets[1]);
      h.closed(h.sockets[0]); // the old socket finally closes
      await h.advance(60000);
      expect(h.sockets).toHaveLength(2);
      expect(h.live()).toBe(1);
      expect(h.pendingTimers()).toBe(0);
    });

    test('becoming visible while a socket is CONNECTING opens no second socket', async () => {
      const h = harness();
      await h.ctx.connectWebSocket();
      expect(h.sockets[0].readyState).toBe(0);
      await h.visible(true);
      await h.visible(false);
      expect(h.sockets).toHaveLength(1);
    });

    test('becoming visible with a retry scheduled opens one socket and the retry does not add another', async () => {
      const h = harness();
      await h.ctx.connectWebSocket();
      h.open(h.sockets[0]);
      h.closed(h.sockets[0]); // schedules a retry
      expect(h.pendingTimers()).toBe(1);
      await h.visible(true);
      await h.visible(false);
      expect(h.sockets).toHaveLength(2);
      h.open(h.sockets[1]);
      await h.advance(60000);
      expect(h.sockets).toHaveLength(2);
      expect(h.live()).toBe(1);
    });
  });
});
