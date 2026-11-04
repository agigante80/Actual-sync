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
      let intervalId = 0;
      const activeIntervals = new Set();
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
          getElementById: () => ({ scrollHeight: 0, scrollTop: 0, clientHeight: 0, innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, appendChild() {}, addEventListener() {} })
        },
        window: { location: { protocol: 'http:', host: 'h' } },
        WebSocket: WS, Date: class extends Date { static now() { return now; } }, Math, JSON, Error,
        Chart: { defaults: {} },
        fetch: async () => ({ ok: true, json: async () => ({ ticket: 't' + sockets.length }) }),
        getFetchOptions: () => ({}), addLogEntry() {},
        setTimeout(f, d) { const t = { f, at: now + d }; timers.push(t); return t; },
        clearTimeout(t) { timers = timers.filter(x => x !== t); },
        setInterval() { const id = ++intervalId; activeIntervals.add(id); return id; },
        clearInterval(id) { activeIntervals.delete(id); },
        encodeURIComponent
      };
      vm.createContext(ctx);
      vm.runInContext(src + '\n;addLogEntry = function () {};\nthis.connectWebSocket = connectWebSocket;', ctx);
      const tick = () => new Promise(r => setImmediate(r));
      return {
        ctx, sockets, listeners, tick, activeIntervals,
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
      const pageIntervals = h.activeIntervals.size; // the page's own pollers
      await h.ctx.connectWebSocket();
      h.open(h.sockets[0]);
      h.sockets[0].close(); // CLOSING
      await h.visible(true);
      await h.visible(false);
      h.open(h.sockets[1]);
      expect(h.activeIntervals.size).toBe(pageIntervals + 1); // the live socket's keep-alive
      h.closed(h.sockets[0]); // the old socket finally closes
      expect(h.activeIntervals.size).toBe(pageIntervals + 1); // still running
      expect(h.pendingTimers()).toBe(0); // and no retry was scheduled
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

    test('a retry firing after the replacement socket exists opens no second socket', async () => {
      const h = harness();
      await h.ctx.connectWebSocket();
      h.open(h.sockets[0]);
      h.sockets[0].close(); // CLOSING, so a replacement may start
      let release;
      const realFetch = h.ctx.fetch;
      let held = false;
      h.ctx.fetch = (url, ...rest) => {
        if (held || !/ws-ticket/.test(url)) return realFetch(url, ...rest); // pollers and later tickets are not held
        held = true;
        return new Promise(r => { release = () => r({ ok: true, json: async () => ({ ticket: 'late' }) }); });
      };
      const pending = h.ctx.connectWebSocket(); // ticket request held open
      await h.tick();
      h.closed(h.sockets[0]); // old socket closes meanwhile and schedules a retry
      expect(h.pendingTimers()).toBe(1);
      release();
      await pending;
      expect(h.sockets).toHaveLength(2); // the replacement, still CONNECTING
      await h.advance(60000); // the retry fires
      expect(h.sockets).toHaveLength(2);
      h.open(h.sockets[1]);
      expect(h.live()).toBe(1);
    });

    test('a new socket does not inherit a stale pong clock and survives its first keep-alive tick', async () => {
      const h = harness();
      let tickFn;
      h.ctx.setInterval = (f) => { tickFn = f; return 1; };
      await h.ctx.connectWebSocket();
      await h.advance(200000); // long past the 90s keep-alive timeout since load
      const sent = [];
      const s = h.sockets[0];
      s.send = (m) => sent.push(m);
      h.open(s);
      tickFn();
      expect(sent).toHaveLength(1);
      expect(s.readyState).toBe(1);
    });
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

describe('transaction totals per sync (#424)', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'services', 'dashboard.js'), 'utf8');
  const fn = js.match(/function formatTransactionCounts\(added, updated\) \{[\s\S]*?\n\}/);
  // eslint-disable-next-line no-new-func
  const formatTransactionCounts = fn && new Function(`${fn[0]}; return formatTransactionCounts;`)();

  test('formats added and updated', () => {
    expect(formatTransactionCounts(7, 3)).toBe('7 added · 3 updated');
    expect(formatTransactionCounts(0, 2)).toBe('0 added · 2 updated');
  });

  test('is a dash when nothing was imported or the row predates the columns', () => {
    expect(formatTransactionCounts(0, 0)).toBe('-');
    expect(formatTransactionCounts(null, null)).toBe('-');
    expect(formatTransactionCounts(undefined, undefined)).toBe('-');
  });

  test('coerces to numbers so markup in a value cannot pass through', () => {
    expect(formatTransactionCounts('<b>x</b>', 1)).toBe('0 added · 1 updated');
  });

  test('the history table has a Transactions column, and the sync history rows and activity list use the helper', () => {
    expect(html).toMatch(/<th>Transactions<\/th>/);
    expect(js).toMatch(/formatTransactionCounts\(record\.transactions_added, record\.transactions_updated\)/);
    expect(js).toMatch(/formatTransactionCounts\(\s*status\.lastSyncTransactions/);
    expect(js).not.toMatch(/colspan="6"/);
  });
});

describe('per-account results (#430)', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'services', 'dashboard.js'), 'utf8');
  const fn = js.match(/function formatAccountResult\(a\) \{[\s\S]*?\n\}/);
  // eslint-disable-next-line no-new-func
  const formatAccountResult = fn && new Function(`${fn[0]}; return formatAccountResult;`)();
  const synced = (added, updated) => ({ status: 'synced', transactions_added: added, transactions_updated: updated });

  test('formats new, none, updated, unknown, failed and skipped', () => {
    expect(formatAccountResult(synced(5, 0))).toBe('5 new');
    expect(formatAccountResult(synced(15, 2))).toBe('15 new, 2 updated');
    expect(formatAccountResult(synced(0, 0))).toBe('no new');
    expect(formatAccountResult(synced(0, 3))).toBe('no new, 3 updated');
    expect(formatAccountResult(synced(null, null))).toBe('count unknown');
    expect(formatAccountResult({ status: 'failed', transactions_added: null })).toBe('failed');
    expect(formatAccountResult({ status: 'skipped', transactions_added: null })).toBe('skipped');
  });

  test('unknown counts are never shown as "no new"', () => {
    expect(formatAccountResult(synced(undefined, undefined))).toBe('count unknown');
  });

  test('the account lines are placed with textContent, never innerHTML', () => {
    const body = (name) => {
      const m = js.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
      return m ? m[0] : '';
    };
    for (const name of ['toggleHistoryRow', 'renderAccounts', 'textEl']) {
      expect(body(name)).not.toBe('');
      expect(body(name)).not.toMatch(/innerHTML|insertAdjacentHTML/);
    }
    expect(js).toMatch(/includeAccounts=1/);
  });
});
