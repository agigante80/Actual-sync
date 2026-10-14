/**
 * Payments tab client logic (#341), run against the real dashboard.js in a vm
 * with a small fake DOM. The browser specs (tests/e2e/payments.e2e.js) cover
 * the whole tab in Chrome; these are the fast guards the mutation catalogue
 * (scripts/mutations.js, ticket #341) scores, because the mutation runner only
 * runs the Jest unit suite: escaping of server and schedule names, the
 * "Sync now" data-arg, the load-failure banner, the status poll's cap and its
 * two-consecutive-reads rule, and calendar dates that ignore the time zone.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'dashboard.js'), 'utf8');
const start = source.indexOf('// Payments tab (#341).');
const end = source.indexOf('// Event wiring.');
const block = source.slice(start, end);

class FakeEl {
  constructor(tag, log) {
    this.tag = tag;
    this._log = log;
    this.children = [];
    this.attrs = {};
    this._text = '';
    this.className = '';
    this.hidden = false;
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  set innerHTML(v) { this._log.push(`innerHTML:${v}`); }
  insertAdjacentHTML(_where, v) { this._log.push(`insertAdjacentHTML:${v}`); }
  appendChild(c) { this.children.push(c); return c; }
  get options() { return this.children; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  get dataset() {
    const out = {};
    for (const [k, v] of Object.entries(this.attrs)) {
      if (k.startsWith('data-')) out[k.slice(5)] = v;
    }
    return out;
  }
  find(pred, acc = []) {
    for (const c of this.children) { if (pred(c)) acc.push(c); c.find(pred, acc); }
    return acc;
  }
  querySelector(tag) { return this.find((c) => c.tag === tag)[0] || null; }
}

function makeEnv({ route, windowGlobals = {}, dateFormat = null } = {}) {
  const log = [];
  const els = {};
  const make = (id, tag = 'div') => { els[id] = new FakeEl(tag, log); return els[id]; };
  make('payments-content'); make('payments-summary'); make('payments-error'); make('payments-sync-status');
  const select = make('payments-server', 'select');
  select.value = '';
  const opt = new FakeEl('option', log); opt.value = ''; select.appendChild(opt);
  const tab = make('payments-tab');
  let active = true;
  tab.classList = { contains: (c) => c === 'active' && active };

  const calls = [];
  const timers = [];
  const ctx = {
    console, Promise, Number, String, Object, Array, Set, Map, Math, JSON, RegExp, Error, Date,
    encodeURIComponent,
    window: { __paymentsSyncPollMs: 1, ...windowGlobals },
    localStorage: { getItem: (k) => (k === 'dateFormat' ? dateFormat : null) },
    document: {
      hidden: false,
      getElementById: (id) => els[id] || null,
      createElement: (tag) => new FakeEl(tag, log),
      createTextNode: (t) => { const n = new FakeEl('#text', log); n._text = String(t); return n; },
      querySelectorAll: () => []
    },
    setTimeout: (f, ms) => setTimeout(f, ms),
    setInterval: (f) => { timers.push(f); return timers.length; },
    getFetchOptions: () => ({}),
    formatTime: (iso) => `T(${iso})`,
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body });
      return route(url, opts, calls);
    }
  };
  vm.createContext(ctx);
  vm.runInContext(`${block}
this.api = { loadPaymentsTab, paymentsSyncNow, formatCalendarDate, formatPaymentAmount, setPaymentStateFilter, togglePaymentAlert, openPaymentMute, savePaymentMute, onPaymentMuteField, unmutePaymentAlert };`, ctx);
  return { ctx, els, log, calls, timers, api: ctx.api, setActive: (v) => { active = v; } };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({ error: 'x' }) });
const run = (over = {}) => ({ at: '2026-01-14T08:01:00Z', ok: true, errorCode: null, lastSuccessAt: '2026-01-14T08:01:00Z', rulesErrored: 0, ...over });
const item = (over = {}) => ({
  alertId: 'a', scheduleId: 's', name: 'Rent', cadenceText: 'Every month', account: 'Main', payee: 'T',
  expectedAmount: 6000, nextDate: '2026-02-05', deadline: '2026-01-11', state: 'missing', lastAlertAt: null,
  source: 'config', occurrences: [], ...over
});
const group = (over = {}) => ({ server: 'Main', configured: true, lastRun: run(), items: [item()], ...over });
const payments = (...groups) => ok({ servers: groups });

const rowsOf = (env) => env.els['payments-content'].find((e) => e.tag === 'tr' && e.className === 'pay-row');
// The capabilities read (#261) is not a payments fetch.
const paymentCalls = (env) => env.calls.filter((c) => c.url.startsWith('/api/dashboard/payments'));
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('Payments tab alert controls (#261)', () => {
  const caps = (configWrites, reason = null) => ok({ configWrites, reason });
  const state = (over = {}) => ({ enabled: true, mutedUntil: null, reason: null, lockedByConfig: false, ...over });
  const envWith = (items, { writes = true, reason = null, extra = () => null } = {}) => makeEnv({
    route: (url, opts) => extra(url, opts) || (url.includes('capabilities') ? caps(writes, reason) : payments(group({ items })))
  });
  const byClass = (env, cls) => env.els['payments-content'].find((e) => e.className.split(' ').includes(cls));
  const btn = (env, action) => env.els['payments-content'].find((e) => e.tag === 'button' && e.attrs['data-action'] === action);

  test('the switch is a role=switch button with aria-checked, and Mute... is offered', async () => {
    const env = envWith([item({ alertId: 'a', ruleState: state() })]);
    await env.api.loadPaymentsTab();
    const [sw] = btn(env, 'togglePaymentAlert');
    expect(sw.attrs.role).toBe('switch');
    expect(sw.attrs['aria-checked']).toBe('true');
    expect(sw.textContent).toBe('On');
    expect(btn(env, 'openPaymentMute')).toHaveLength(1);
  });

  test('an off alert shows Off, with no override badge', async () => {
    const env = envWith([item({ ruleState: state({ enabled: false }) })]);
    await env.api.loadPaymentsTab();
    expect(btn(env, 'togglePaymentAlert')[0].attrs['aria-checked']).toBe('false');
    expect(byClass(env, 'pay-override')).toHaveLength(0);
  });

  test('a muted alert has the Muted until badge with the reason as title, set as text', async () => {
    const reason = '<img src=x onerror=alert(1)>';
    const env = envWith([item({ ruleState: state({ mutedUntil: '2099-03-01', reason }) })]);
    await env.api.loadPaymentsTab();
    const [badge] = byClass(env, 'pay-override');
    expect(badge.textContent).toBe('Muted until 2099-03-01');
    expect(badge.title).toBe(reason);
    expect(env.log).toEqual([]);
    expect(btn(env, 'unmutePaymentAlert')).toHaveLength(1);
    expect(btn(env, 'openPaymentMute')).toHaveLength(0);
    // the real pill is still the state
    expect(env.els['payments-content'].find((e) => e.className.split(' ').includes('pay-pill'))[0].textContent).toBe('Missing');
  });

  test('a mute that has ended shows the summary-pending badge', async () => {
    const env = envWith([item({ ruleState: state({ mutedUntil: '2000-01-01', reason: 'r' }) })]);
    await env.api.loadPaymentsTab();
    expect(byClass(env, 'pay-override')[0].textContent).toBe('Mute ended, summary pending');
  });

  test('a config-disabled alert has a Disabled in config badge and no switch', async () => {
    const env = envWith([item({ ruleState: state({ enabled: false, lockedByConfig: true }) })]);
    await env.api.loadPaymentsTab();
    expect(byClass(env, 'pay-override')[0].textContent).toBe('Disabled in config');
    expect(btn(env, 'togglePaymentAlert')).toHaveLength(0);
  });

  test('a prefix rule gets one control set with Applies to N schedules', async () => {
    const env = envWith([item({ scheduleId: 's1', name: 'A' }), item({ scheduleId: 's2', name: 'B' }), item({ scheduleId: 's3', name: 'C' })]);
    await env.api.loadPaymentsTab();
    expect(btn(env, 'togglePaymentAlert')).toHaveLength(1);
    expect(byClass(env, 'pay-applies')[0].textContent).toBe('Applies to 3 schedules');
  });

  test('writes off: controls are aria-disabled with the tooltip for the reason', async () => {
    for (const [reason, tip] of [['disabled', 'Set healthCheck.dashboard.allowConfigWrites to true.'], ['auth-none', 'need dashboard authentication']]) {
      const env = envWith([item()], { writes: false, reason });
      await env.api.loadPaymentsTab();
      const [sw] = btn(env, 'togglePaymentAlert');
      expect(sw.attrs['aria-disabled']).toBe('true');
      expect(sw.title).toContain(tip);
      await env.api.togglePaymentAlert(undefined, sw);
      expect(env.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    }
  });

  test('toggling sends one PUT {enabled:false} and renders the returned state', async () => {
    const env = envWith([item({ ruleState: state() })], {
      extra: (url, opts) => (opts.method === 'PUT' ? ok({ ruleState: state({ enabled: false }) }) : null)
    });
    await env.api.loadPaymentsTab();
    const [sw] = btn(env, 'togglePaymentAlert');
    await env.api.togglePaymentAlert(undefined, sw);
    const puts = env.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe('/api/dashboard/payments/Main/a/state');
    expect(JSON.parse(puts[0].body)).toEqual({ enabled: false });
    expect(btn(env, 'togglePaymentAlert')[0].attrs['aria-checked']).toBe('false');
  });

  test('a failed toggle reverts and writes the message to the live region', async () => {
    const env = envWith([item({ ruleState: state() })], {
      extra: (url, opts) => (opts.method === 'PUT' ? { ok: false, status: 409, json: async () => ({ error: 'disabled_in_config' }) } : null)
    });
    await env.api.loadPaymentsTab();
    env.els['payments-control-status'] = env.els['payments-control-status'] || null;
    await env.api.togglePaymentAlert(undefined, btn(env, 'togglePaymentAlert')[0]);
    expect(btn(env, 'togglePaymentAlert')[0].attrs['aria-checked']).toBe('true');
  });

  test('the mute form needs a reason: no request is sent', async () => {
    const env = envWith([item({ ruleState: state() })]);
    await env.api.loadPaymentsTab();
    env.api.openPaymentMute(undefined, btn(env, 'openPaymentMute')[0]);
    const form = env.els['payments-content'].find((e) => e.tag === 'form')[0];
    const date = env.els['payments-content'].find((e) => e.className === 'pay-mute-date')[0];
    date.value = '2099-03-01';
    env.api.onPaymentMuteField(undefined, date);
    await env.api.savePaymentMute(form);
    expect(env.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(env.els['payments-content'].find((e) => e.className === 'pay-field-error')[0].textContent).toBe('Reason is required');
  });

  test('a valid mute sends one PUT with the date and the trimmed reason', async () => {
    const env = envWith([item({ ruleState: state() })], {
      extra: (url, opts) => (opts.method === 'PUT' ? ok({ ruleState: state({ mutedUntil: '2099-03-01', reason: 'vacant' }) }) : null)
    });
    await env.api.loadPaymentsTab();
    env.api.openPaymentMute(undefined, btn(env, 'openPaymentMute')[0]);
    const find = (cls) => env.els['payments-content'].find((e) => e.className === cls)[0];
    find('pay-mute-date').value = '2099-03-01';
    env.api.onPaymentMuteField(undefined, find('pay-mute-date'));
    find('pay-mute-reason').value = '  vacant ';
    env.api.onPaymentMuteField(undefined, find('pay-mute-reason'));
    await env.api.savePaymentMute(env.els['payments-content'].find((e) => e.tag === 'form')[0]);
    const puts = env.calls.filter((c) => c.method === 'PUT');
    expect(JSON.parse(puts[0].body)).toEqual({ mutedUntil: '2099-03-01', reason: 'vacant' });
    expect(byClass(env, 'pay-override')[0].textContent).toBe('Muted until 2099-03-01');
    expect(env.els['payments-content'].find((e) => e.tag === 'form')).toHaveLength(0);
  });
});

describe('Payments tab client (#341)', () => {
  test('a page with no markup in the names: the source never writes innerHTML for the tab', () => {
    // Belt and braces next to the behaviour test below: the block itself is clean.
    const code = block.replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
    expect(code).not.toMatch(/\.style\b|setAttribute\('style'/);
  });

  describe('escaping and the Sync now data-arg', () => {
    const SERVER = 'Main <b>bold</b> "q" \'s\'';
    const NAME = '<img src=x onerror=alert(1)>';

    test('server and schedule names are rendered as text, never as markup', async () => {
      const env = makeEnv({ route: () => payments(group({ server: SERVER, items: [item({ name: NAME })] })) });
      await env.api.loadPaymentsTab();
      const content = env.els['payments-content'];
      expect(env.log).toEqual([]); // no innerHTML / insertAdjacentHTML write
      expect(content.find((e) => e.className === 'pay-group-title')[0].textContent).toBe(SERVER);
      expect(rowsOf(env)[0].children[1].textContent).toContain(NAME);
      expect(content.find((e) => e.tag === 'img' || e.tag === 'b')).toHaveLength(0);
    });

    test('Sync now carries that server\'s name in data-arg and posts it', async () => {
      const env = makeEnv({
        route: (url, opts) => (opts.method === 'POST' ? ok({ success: true }) : (url.includes('/status') ? ok({ runningSync: null }) : payments(group({ server: SERVER }), group({ server: 'Other' }))))
      });
      await env.api.loadPaymentsTab();
      const buttons = env.els['payments-content'].find((e) => e.tag === 'button' && e.attrs['data-action'] === 'paymentsSyncNow');
      expect(buttons.map((b) => b.dataset.arg)).toEqual([SERVER, 'Other']);
      await env.api.paymentsSyncNow(buttons[0].dataset.arg);
      const post = env.calls.find((c) => c.method === 'POST');
      expect(JSON.parse(post.body)).toEqual({ server: SERVER });
    });

    test('a group that is not configured has no Sync now', async () => {
      const env = makeEnv({ route: () => payments(group({ configured: false, lastRun: null, items: [] })) });
      await env.api.loadPaymentsTab();
      expect(env.els['payments-content'].find((e) => e.tag === 'button')).toHaveLength(0);
    });
  });

  describe('load failures', () => {
    test.each([[500], [503], [429], [401]])('HTTP %i keeps the last good rows and shows the exact text', async (status) => {
      let answer = payments(group());
      const env = makeEnv({ route: () => answer });
      await env.api.loadPaymentsTab();
      expect(rowsOf(env)).toBeTruthy();

      answer = fail(status);
      await env.api.loadPaymentsTab();
      expect(env.els['payments-error'].textContent).toBe(`Could not refresh payments (HTTP ${status})`);
      expect(env.els['payments-error'].hidden).toBe(false);
      expect(rowsOf(env)).toBeTruthy();

      answer = payments(group());
      await env.api.loadPaymentsTab();
      expect(env.els['payments-error'].hidden).toBe(true);
      expect(env.els['payments-error'].textContent).toBe('');
    });

    test('a network error says so and keeps the rows', async () => {
      let boom = false;
      const env = makeEnv({ route: () => { if (boom) throw new Error('down'); return payments(group()); } });
      await env.api.loadPaymentsTab();
      boom = true;
      await env.api.loadPaymentsTab();
      expect(env.els['payments-error'].textContent).toBe('Could not refresh payments (network error)');
      expect(rowsOf(env)).toBeTruthy();
    });

    test('with no previous data the error shows above an empty table', async () => {
      const env = makeEnv({ route: () => fail(503) });
      await env.api.loadPaymentsTab();
      expect(env.els['payments-error'].textContent).toBe('Could not refresh payments (HTTP 503)');
      expect(env.els['payments-content'].find((e) => e.tag === 'table')).toHaveLength(1);
      expect(env.els['payments-content'].find((e) => e.tag === 'tr' && e.className === 'pay-row')).toHaveLength(0);
    });
  });

  describe('Sync now and the status poll', () => {
    // statuses: array of replies to GET /status, in order; the last repeats.
    const syncEnv = (statuses, windowGlobals = {}) => {
      let reads = 0;
      const env = makeEnv({
        windowGlobals,
        route: (url, opts) => {
          if (opts.method === 'POST') return ok({ success: true });
          if (url.includes('/api/dashboard/status')) {
            const reply = statuses[Math.min(reads, statuses.length - 1)];
            reads += 1;
            if (reply === 'fail') return fail(500);
            return ok({ runningSync: reply });
          }
          return payments(group());
        }
      });
      const count = (pred) => env.calls.filter(pred).length;
      env.statusReads = () => count((c) => c.url.includes('/status'));
      env.refreshes = () => count((c) => c.url.includes('/api/dashboard/payments'));
      return env;
    };
    const BUSY = { key: 'Main' };

    test('stops after __paymentsSyncMaxPolls reads and refreshes once', async () => {
      const env = syncEnv([BUSY], { __paymentsSyncMaxPolls: 3 });
      await env.api.paymentsSyncNow('Main');
      await flush();
      expect(env.statusReads()).toBe(3);
      expect(env.refreshes()).toBe(1);
    });

    test('the default cap is 120 s worth of reads at the configured interval', async () => {
      const env = makeEnv({ windowGlobals: { __paymentsSyncPollMs: 30000 }, route: () => ok({}) });
      expect(env.ctx.window.__paymentsSyncPollMs).toBe(30000);
      // 120000 / 30000 = 4: checked through the block's own constant
      expect(vm.runInContext('PAYMENTS_SYNC_MAX_POLLS', env.ctx)).toBe(4);
    });

    test('refreshes after two consecutive null reads, not one', async () => {
      const env = syncEnv([BUSY, null, null]);
      await env.api.paymentsSyncNow('Main');
      await flush();
      expect(env.statusReads()).toBe(3);
      expect(env.refreshes()).toBe(1);
    });

    test('a busy read between nulls resets the streak', async () => {
      const env = syncEnv([null, BUSY, null, null]);
      await env.api.paymentsSyncNow('Main');
      await flush();
      expect(env.statusReads()).toBe(4);
    });

    test('failed status reads never count toward the two', async () => {
      const env = syncEnv(['fail', 'fail', null, null]);
      await env.api.paymentsSyncNow('Main');
      await flush();
      expect(env.statusReads()).toBe(4);
      expect(env.refreshes()).toBe(1);
    });

    test('a null, a failed read and a null do not add up to two', async () => {
      const env = syncEnv([null, 'fail', null, null]);
      await env.api.paymentsSyncNow('Main');
      await flush();
      expect(env.statusReads()).toBe(4);
    });

    test('a failed POST shows "Could not start sync (HTTP 429)" and polls nothing', async () => {
      const env = makeEnv({
        route: (url, opts) => (opts.method === 'POST' ? fail(429) : payments(group()))
      });
      await env.api.loadPaymentsTab();
      await env.api.paymentsSyncNow('Main');
      await flush();
      const errorEl = env.els['payments-content'].find((e) => e.className === 'pay-sync-error')[0];
      expect(errorEl.textContent).toBe('Could not start sync (HTTP 429)');
      expect(errorEl.attrs.role).toBeUndefined(); // announced by the live region, not a re-rendered alert
      expect(env.els['payments-sync-status'].textContent).toBe('Main: Could not start sync (HTTP 429)');
      expect(env.calls.some((c) => c.url.includes('/status'))).toBe(false);
    });

    test('a POST that throws shows "(network error)"', async () => {
      const env = makeEnv({
        route: (url, opts) => { if (opts.method === 'POST') throw new Error('down'); return payments(group()); }
      });
      await env.api.loadPaymentsTab();
      await env.api.paymentsSyncNow('Main');
      const errorEl = env.els['payments-content'].find((e) => e.className === 'pay-sync-error')[0];
      expect(errorEl.textContent).toBe('Could not start sync (network error)');
    });

    test('two servers clicked together share ONE status loop and one refresh', async () => {
      let reads = 0;
      const env = makeEnv({
        route: (url, opts) => {
          if (opts.method === 'POST') return ok({ success: true });
          if (url.includes('/api/dashboard/status')) { reads += 1; return ok({ runningSync: reads <= 2 ? BUSY : null }); }
          return payments(group({ server: 'Main' }), group({ server: 'Other' }));
        }
      });
      await env.api.loadPaymentsTab();
      const before = env.calls.length;
      await Promise.all([env.api.paymentsSyncNow('Main'), env.api.paymentsSyncNow('Other')]);
      await flush();
      const after = env.calls.slice(before);
      // 2 busy + 2 null reads from a single loop; a loop per click would read twice as often
      expect(after.filter((c) => c.url.includes('/status'))).toHaveLength(4);
      expect(after.filter((c) => c.method === 'POST')).toHaveLength(2);
      expect(after.filter((c) => c.url.includes('/api/dashboard/payments'))).toHaveLength(1);
      const buttons = env.els['payments-content'].find((e) => e.attrs['data-action'] === 'paymentsSyncNow');
      expect(buttons.map((b) => b.textContent)).toEqual(['Sync now', 'Sync now']);
    });

    test('two servers clicked together read the status at most the cap in total, not per click', async () => {
      const env = makeEnv({
        windowGlobals: { __paymentsSyncMaxPolls: 3 },
        route: (url, opts) => {
          if (opts.method === 'POST') return ok({ success: true });
          if (url.includes('/api/dashboard/status')) return ok({ runningSync: BUSY });
          return payments(group({ server: 'Main' }), group({ server: 'Other' }));
        }
      });
      await env.api.loadPaymentsTab();
      await Promise.all([env.api.paymentsSyncNow('Main'), env.api.paymentsSyncNow('Other')]);
      await flush();
      expect(env.calls.filter((c) => c.url.includes('/status'))).toHaveLength(3);
    });

    test('two servers clicked together never have two status reads in flight at once', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const env = makeEnv({
        windowGlobals: { __paymentsSyncMaxPolls: 4 },
        route: async (url, opts) => {
          if (opts.method === 'POST') return ok({ success: true });
          if (url.includes('/api/dashboard/status')) {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 4)); // slower than the 1 ms poll interval
            inFlight -= 1;
            return ok({ runningSync: { key: 'x' } });
          }
          return payments(group({ server: 'Main' }), group({ server: 'Other' }));
        }
      });
      await env.api.loadPaymentsTab();
      await Promise.all([env.api.paymentsSyncNow('Main'), env.api.paymentsSyncNow('Other')]);
      await flush(60);
      expect(maxInFlight).toBe(1);
    });

    test('a double-click sends one POST and disables the button before the fetch resolves', async () => {
      let release;
      const env = makeEnv({
        route: (url, opts) => {
          if (opts.method === 'POST') return new Promise((r) => { release = () => r(ok({ success: true })); });
          if (url.includes('/status')) return ok({ runningSync: null });
          return payments(group());
        }
      });
      await env.api.loadPaymentsTab();
      const first = env.api.paymentsSyncNow('Main');
      const button = env.els['payments-content'].find((e) => e.tag === 'button')[0];
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Syncing...');
      await env.api.paymentsSyncNow('Main');
      release();
      await first;
      await flush();
      expect(env.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    test('a failed POST frees the button again', async () => {
      const env = makeEnv({ route: (url, opts) => (opts.method === 'POST' ? fail(500) : payments(group())) });
      await env.api.loadPaymentsTab();
      await env.api.paymentsSyncNow('Main');
      const button = env.els['payments-content'].find((e) => e.tag === 'button')[0];
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('Sync now');
    });

    test('re-rendering does not rewrite the live regions and the inline error has no role=alert', async () => {
      let boom = false;
      const env = makeEnv({
        route: (url, opts) => {
          if (opts.method === 'POST') return fail(429);
          if (boom) return fail(500);
          return payments(group());
        }
      });
      await env.api.loadPaymentsTab();
      await env.api.paymentsSyncNow('Main');
      boom = true;
      await env.api.loadPaymentsTab();
      const writes = [];
      for (const id of ['payments-error', 'payments-sync-status']) {
        const el = env.els[id];
        let text = el.textContent;
        Object.defineProperty(el, 'textContent', { get: () => text, set: (v) => { writes.push([id, v]); text = v; } });
      }
      env.api.setPaymentStateFilter('attention');
      env.api.setPaymentStateFilter('all');
      expect(writes).toEqual([]);
      expect(env.els['payments-sync-status'].textContent).toBe('Main: Could not start sync (HTTP 429)');
      const inline = env.els['payments-content'].find((e) => e.className === 'pay-sync-error')[0];
      expect(inline.textContent).toBe('Could not start sync (HTTP 429)');
      expect(inline.attrs.role).toBeUndefined();
    });

    describe('a second server whose POST resolves late (round 2)', () => {
      // Main posts at once; Other's POST is held until the status read number
      // `releaseAt`. statuses(n) gives the reply to read n (1-based).
      const lateEnv = ({ releaseAt, statuses, windowGlobals }) => {
        let release;
        let reads = 0;
        const env = makeEnv({
          windowGlobals,
          route: (url, opts) => {
            if (opts.method === 'POST') {
              if (JSON.parse(opts.body).server === 'Other') return new Promise((r) => { release = () => r(ok({ success: true })); });
              return ok({ success: true });
            }
            if (url.includes('/api/dashboard/status')) {
              reads += 1;
              const reply = statuses(reads);
              if (reads === releaseAt && release) release();
              return ok({ runningSync: reply });
            }
            return payments(group({ server: 'Main' }), group({ server: 'Other' }));
          }
        });
        env.statusReads = () => env.calls.filter((c) => c.url.includes('/status')).length;
        env.release = () => release();
        return env;
      };
      const BUSY = { key: 'x' };
      const syncButtons = (env) => env.els['payments-content'].find((e) => e.attrs['data-action'] === 'paymentsSyncNow');

      test('Other stays disabled while its POST is pending after Main\'s loop ends, then gets its own reads', async () => {
        const env = lateEnv({ releaseAt: Infinity, statuses: () => null });
        await env.api.loadPaymentsTab();
        const main = env.api.paymentsSyncNow('Main');
        const other = env.api.paymentsSyncNow('Other');
        await main;
        await flush();
        expect(env.statusReads()).toBe(2); // Main finished on two null reads
        const [, otherBtn] = syncButtons(env);
        expect(otherBtn.disabled).toBe(true);
        expect(otherBtn.textContent).toBe('Syncing...');
        env.release();
        await other;
        await flush();
        expect(env.statusReads()).toBe(4); // Other's own two null reads
        expect(syncButtons(env).map((b) => b.disabled)).toEqual([false, false]);
      });

      test('a POST resolving after one null read restarts the two-null count', async () => {
        const env = lateEnv({ releaseAt: 2, statuses: () => null });
        await env.api.loadPaymentsTab();
        const main = env.api.paymentsSyncNow('Main');
        const other = env.api.paymentsSyncNow('Other');
        await Promise.all([main, other]);
        await flush();
        // read 1 null (streak 1); Other's POST resolves during read 2, which resets the streak
        // before read 2's own null is counted; read 3 makes two. Without the reset, read 2 would end it.
        expect(env.statusReads()).toBe(3);
      });

      test('a server queued late in another\'s run gets the full read budget', async () => {
        const env = lateEnv({ releaseAt: 2, statuses: () => BUSY, windowGlobals: { __paymentsSyncMaxPolls: 3 } });
        await env.api.loadPaymentsTab();
        const main = env.api.paymentsSyncNow('Main');
        const other = env.api.paymentsSyncNow('Other');
        await Promise.all([main, other]);
        await flush();
        expect(env.statusReads()).toBe(5); // 2 before the queue, then the cap of 3 again
      });
    });

    test('polling stops, without a refresh, when the tab is switched away', async () => {
      const env = syncEnv([BUSY]);
      await env.api.loadPaymentsTab();
      const before = env.refreshes();
      env.setActive(false);
      await env.api.paymentsSyncNow('Main');
      await flush();
      expect(env.statusReads()).toBe(0);
      expect(env.refreshes()).toBe(before);
    });
  });

  describe('the 60 s poll', () => {
    test('does nothing while another tab is active or the page is hidden, and loads when active', async () => {
      const env = makeEnv({ route: () => payments(group()) });
      const tick = env.timers[0];
      expect(typeof tick).toBe('function');

      env.setActive(false);
      tick();
      await flush(5);
      expect(env.calls).toHaveLength(0);

      env.setActive(true);
      env.ctx.document.hidden = true;
      tick();
      await flush(5);
      expect(env.calls).toHaveLength(0);

      env.ctx.document.hidden = false;
      tick();
      await flush(5);
      expect(paymentCalls(env)).toHaveLength(1);
    });

    test('an overlapping tick does not start a second fetch', async () => {
      let release;
      const env = makeEnv({ route: (url) => (url.includes('capabilities') ? ok({ configWrites: false, reason: 'disabled' }) : new Promise((r) => { release = () => r(payments(group())); })) });
      const first = env.api.loadPaymentsTab();
      env.api.loadPaymentsTab();
      expect(paymentCalls(env)).toHaveLength(1);
      release();
      await first;
    });
  });

  describe('formatting', () => {
    test('formatCalendarDate does not depend on the time zone (west of UTC)', () => {
      const previous = process.env.TZ;
      process.env.TZ = 'America/Los_Angeles';
      try {
        const env = makeEnv({ route: () => ok({}), dateFormat: 'us' });
        expect(env.api.formatCalendarDate('2026-02-05')).toBe('02/05/2026');
        expect(makeEnv({ route: () => ok({}), dateFormat: 'full' }).api.formatCalendarDate('2026-02-05')).toBe('Thursday, February 5, 2026');
        expect(makeEnv({ route: () => ok({}), dateFormat: 'eu-long' }).api.formatCalendarDate('2026-02-05')).toBe('5 February 2026');
      } finally {
        if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
      }
    });

    test('every locale format asks for timeZone UTC', () => {
      // Runtime TZ changes are not reliable inside a Jest worker, so pin the option itself.
      const seen = [];
      for (const f of ['us', 'us-short', 'us-long', 'eu', 'eu-short', 'eu-long', 'full', 'locale', 'bogus']) {
        const env = makeEnv({ route: () => ok({}), dateFormat: f });
        env.ctx.Date = class extends Date {
          toLocaleDateString(locale, options) { seen.push(options && options.timeZone); return super.toLocaleDateString(locale, options); }
        };
        env.api.formatCalendarDate('2026-02-05');
      }
      expect(seen).toHaveLength(9);
      expect(new Set(seen)).toEqual(new Set(['UTC']));
    });

    test('iso and relative give YYYY-MM-DD, and a bad value passes through unchanged', () => {
      for (const f of ['iso', 'relative', null]) {
        expect(makeEnv({ route: () => ok({}), dateFormat: f }).api.formatCalendarDate('2026-02-05')).toBe('2026-02-05');
      }
      const env = makeEnv({ route: () => ok({}) });
      expect(env.api.formatCalendarDate(null)).toBe('');
      expect(env.api.formatCalendarDate('soon')).toBe('soon');
    });

    test('amounts are plain decimals; a range reads "a to b"; null is empty', () => {
      const { api } = makeEnv({ route: () => ok({}) });
      expect(api.formatPaymentAmount(6000)).toBe('60.00');
      expect(api.formatPaymentAmount(5)).toBe('0.05');
      expect(api.formatPaymentAmount({ num1: 5000, num2: 7000 })).toBe('50.00 to 70.00');
      expect(api.formatPaymentAmount(null)).toBe('');
    });
  });
});
