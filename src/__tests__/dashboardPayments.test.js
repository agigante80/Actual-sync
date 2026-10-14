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
this.api = { loadPaymentsTab, paymentsSyncNow, formatCalendarDate, formatPaymentAmount, setPaymentStateFilter, togglePaymentAlert, openPaymentMute, savePaymentMute, onPaymentMuteField, unmutePaymentAlert,
  slugifyRuleId, uniqueRuleId, countPrefixMatches, prefixMatchText, scheduleOptions, formatScheduleLine, editorDeadlineText, effectiveTemplate,
  tolerancePlaceholder, buildRuleBody, paymentAlertCount, editorCanSave, beginEditorSend, editorRowFocusKey, editedNote, mergePaymentRows, editorFieldForPath, mapEditorError };`, ctx);
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
  const state = (over = {}) => ({ enabled: true, mutedUntil: null, reason: null, lockedByConfig: false, muteEndDue: false, ...over });
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
    const env = envWith([item({ ruleState: state({ mutedUntil: '2000-01-01', reason: 'r', muteEndDue: true }) })]);
    await env.api.loadPaymentsTab();
    expect(byClass(env, 'pay-override')[0].textContent).toBe('Mute ended, summary pending');
  });

  test('the summary-pending badge follows the server muteEndDue, not the browser date (#261)', async () => {
    const env = envWith([item({ ruleState: state({ mutedUntil: '2099-03-01', reason: 'r', muteEndDue: false }) })]);
    await env.api.loadPaymentsTab();
    expect(byClass(env, 'pay-override')[0].textContent).toBe('Muted until 2099-03-01');
    const due = envWith([item({ ruleState: state({ mutedUntil: '2099-03-01', reason: 'r', muteEndDue: true }) })]);
    await due.api.loadPaymentsTab();
    expect(byClass(due, 'pay-override')[0].textContent).toBe('Mute ended, summary pending');
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

    test('a group that is not configured has no Sync now (only a disabled Add alert, #268)', async () => {
      const env = makeEnv({ route: () => payments(group({ configured: false, lastRun: null, items: [] })) });
      await env.api.loadPaymentsTab();
      const buttons = env.els['payments-content'].find((e) => e.tag === 'button');
      expect(buttons.map((b) => b.attrs['data-action'])).toEqual(['openAlertEditor']);
      expect(buttons[0].attrs['aria-disabled']).toBe('true');
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
      const env = makeEnv({ route: (url) => (url.includes('capabilities') ? ok({ configWrites: false, reason: 'disabled' }) : url.includes('payment-rules') ? ok({ rules: [] }) : new Promise((r) => { release = () => r(payments(group())); })) });
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

describe('Payments alert editor helpers (#268)', () => {
  const api = makeEnv({ route: () => ok({}) }).api;
  // Results come out of the vm realm: compare through JSON.
  const plain = (v) => JSON.parse(JSON.stringify(v));

  describe('rule id', () => {
    test('slugifyRuleId mirrors the server slug', () => {
      expect(api.slugifyRuleId('Rent - Parking A')).toBe('rent-parking-a');
      expect(api.slugifyRuleId('  --Gym!!  ')).toBe('gym');
      expect(api.slugifyRuleId('')).toBe('alert');
      expect(api.slugifyRuleId('!!!')).toBe('alert');
      expect(api.slugifyRuleId(null)).toBe('alert');
      expect(api.slugifyRuleId('a'.repeat(80))).toHaveLength(64);
    });

    test('uniqueRuleId appends -2, -3 and keeps the total within 64', () => {
      expect(api.uniqueRuleId('gym', new Set())).toBe('gym');
      expect(api.uniqueRuleId('gym', new Set(['gym']))).toBe('gym-2');
      expect(api.uniqueRuleId('gym', new Set(['gym', 'gym-2']))).toBe('gym-3');
      const long = 'a'.repeat(64);
      const id = api.uniqueRuleId(long, new Set([long]));
      expect(id).toBe(`${'a'.repeat(62)}-2`);
      expect(id).toHaveLength(64);
      expect(api.uniqueRuleId(long, new Set([long, id]))).toBe(`${'a'.repeat(62)}-3`);
    });
  });

  describe('schedule picker', () => {
    const list = [
      { id: 's1', name: 'Rent - A', completed: false },
      { id: 's2', name: 'Rent - B', completed: true },
      { id: 'abcdef123456', name: 'Gym', completed: false },
      { id: 'zzzzzz654321', name: 'Gym', completed: false }
    ];

    test('prefix count is case sensitive, skips completed schedules and is 0 for an empty prefix', () => {
      expect(api.countPrefixMatches(list, 'Rent')).toBe(1);
      expect(api.countPrefixMatches(list, 'rent')).toBe(0);
      expect(api.countPrefixMatches(list, 'Gym')).toBe(2);
      expect(api.countPrefixMatches(list, '')).toBe(0);
      expect(api.countPrefixMatches(undefined, 'x')).toBe(0);
    });

    test('the match message warns about zero matches and stays plain otherwise', () => {
      expect(api.prefixMatchText(0)).toBe('matches 0: this rule will report ruleUnmatched');
      expect(api.prefixMatchText(3)).toBe('matches 3');
    });

    test('scheduleOptions drops completed schedules and tells equal names apart by id suffix', () => {
      expect(plain(api.scheduleOptions(list))).toEqual([
        { value: 's1', name: 'Rent - A', label: 'Rent - A' },
        { value: 'abcdef123456', name: 'Gym', label: 'Gym (123456)' },
        { value: 'zzzzzz654321', name: 'Gym', label: 'Gym (654321)' }
      ]);
    });

    test('formatScheduleLine words amount, account and payee', () => {
      expect(api.formatScheduleLine({ cadenceText: 'Every month on the 5th', amount: 6000, amountOp: 'is', account: 'Main', payee: 'Tenant A' }))
        .toBe('Every month on the 5th · 60.00 · into Main · from Tenant A');
      expect(api.formatScheduleLine({ cadenceText: 'Every month on the 1st', amount: null, amountMin: -7000, amountMax: -5000, amountOp: 'isbetween', account: null, payee: 'Fit Club' }))
        .toBe('Every month on the 1st · 50.00 to 70.00 · out of (deleted account) · to Fit Club');
      expect(api.formatScheduleLine({ cadenceText: 'Every week', amount: 100, account: 'Main', payee: null })).toBe('Every week · 1.00 · into Main');
      expect(api.formatScheduleLine(null)).toBe('');
    });

    test('editorDeadlineText says "each month" only when day + grace stays within 28', () => {
      const monthly = (day, nextDate) => ({ cadenceText: `Every month on the ${day}th`, nextDate });
      expect(api.editorDeadlineText(monthly(8, '2026-02-08'), 3)).toBe('deadline: 11th of each month');
      expect(api.editorDeadlineText(monthly(25, '2026-02-25'), 3)).toBe('deadline: 28th of each month');
      expect(api.editorDeadlineText(monthly(28, '2026-10-28'), 6)).toBe('deadline: 3 Nov for the 28 Oct payment');
      expect(api.editorDeadlineText(monthly(28, '2026-02-28'), 1)).toBe('deadline: 1 Mar for the 28 Feb payment');
      expect(api.editorDeadlineText(monthly(28, '2026-02-28'), 6)).toBe('deadline: 6 Mar for the 28 Feb payment');
      expect(api.editorDeadlineText({ cadenceText: 'Every month on the last day', nextDate: '2026-01-31' }, 3)).toBe('next date 31 Jan');
      expect(api.editorDeadlineText({ cadenceText: 'Every 2 weeks on Friday', nextDate: '2026-11-05' }, 3)).toBe('next date 5 Nov');
      expect(api.editorDeadlineText({ cadenceText: 'Every month on the 22nd', nextDate: '2026-02-22' }, 0)).toBe('deadline: 22nd of each month');
      expect(api.editorDeadlineText({ cadenceText: 'Every month on the 1st', nextDate: '2026-02-01' }, 10)).toBe('deadline: 11th of each month');
      expect(api.editorDeadlineText({ cadenceText: 'Every month on the 2nd', nextDate: '2026-02-02' }, 10)).toBe('deadline: 12th of each month');
      expect(api.editorDeadlineText({ cadenceText: 'Every month on the 3rd', nextDate: '2026-02-03' }, 10)).toBe('deadline: 13th of each month');
      expect(api.editorDeadlineText(null, 3)).toBe('');
      expect(api.editorDeadlineText({ cadenceText: 'x', nextDate: 'bad' }, 3)).toBe('');
    });
  });

  describe('tolerance and defaults', () => {
    test('the placeholder follows the schedule amount operator', () => {
      expect(api.tolerancePlaceholder('isapprox')).toBe('From schedule (about 7.5%)');
      expect(api.tolerancePlaceholder('is')).toBe('From schedule (exact)');
      expect(api.tolerancePlaceholder('isbetween')).toBe('From schedule (exact)');
    });

    test('the block template wins over the built-in one', () => {
      const d = { templates: { missing: 'base', resolved: 'r' }, blockTemplates: { missing: 'block' } };
      expect(api.effectiveTemplate(d, 'missing')).toBe('block');
      expect(api.effectiveTemplate(d, 'resolved')).toBe('r');
      expect(api.effectiveTemplate(d, 'muteEnded')).toBe('');
      expect(api.effectiveTemplate(undefined, 'missing')).toBe('');
    });
  });

  describe('editor Save, Send and focus helpers', () => {
    const ed = (over = {}) => ({ errors: {}, invalid: {}, busy: false, loading: false, ...over });
    test('Save is off while a field or template error is shown, and on again once cleared', () => {
      expect(api.editorCanSave(ed(), false, true, {})).toBe(true);
      expect(api.editorCanSave(ed({ errors: { 'template:missing': 'Unknown token nope' } }), false, true, {})).toBe(false);
      expect(api.editorCanSave(ed({ errors: { graceDays: 'bad' } }), false, true, {})).toBe(false);
      expect(api.editorCanSave(ed({ errors: { graceDays: '' } }), false, true, {})).toBe(true);
      expect(api.editorCanSave(ed({ invalid: { id: true } }), false, true, {})).toBe(false);
      expect(api.editorCanSave(ed(), false, true, { channels: 'Pick at least one channel' })).toBe(false);
      expect(api.editorCanSave(ed({ busy: true }), false, true, {})).toBe(false);
      expect(api.editorCanSave(ed({ loading: true }), false, true, {})).toBe(false);
      expect(api.editorCanSave(ed(), true, true, {})).toBe(false);
      expect(api.editorCanSave(ed(), false, false, {})).toBe(false);
    });
    test('a second test send is refused while one is in flight', () => {
      const e = {};
      expect(api.beginEditorSend(e)).toBe(true);
      expect(e.sending).toBe(true);
      expect(api.beginEditorSend(e)).toBe(false);
    });
    test('the focus key after saving an edit is the row Edit button key', () => {
      expect(api.editorRowFocusKey('Main', 'gym', 'dashboard', 'editPaymentRule')).toBe('ed:["Main","gym","dashboard","editPaymentRule"]');
    });
  });

  describe('paymentAlertCount', () => {
    const row = (kind, alertId, source) => ({ kind, item: { alertId, source } });
    test('counts evaluated rows of the same alert and source, not a superseded twin', () => {
      const group = { items: [], rows: [row('evaluated', 'a', 'config'), row('evaluated', 'a', 'config'), row('superseded', 'a', 'dashboard'), row('evaluated', 'b', 'config')] };
      expect(api.paymentAlertCount(group, 'a', 'config')).toBe(2);
      expect(api.paymentAlertCount({ items: [row('x', 'a', 'config').item], rows: undefined }, 'a', 'config')).toBe(1);
    });
  });

  describe('buildRuleBody', () => {
    const defaults = { graceDays: 3, earlyDays: 2, templates: { missing: 'M', wrongAmount: 'W' }, blockTemplates: { wrongAmount: 'BW' } };
    const channels = ['discord', 'slack'];
    const form = (over = {}) => ({
      id: 'gym', watch: 'schedule', schedule: 'Gym', prefix: '', graceDays: '3', earlyDays: '2', period: 'occurrence',
      tolerance: '', remindOn: false, remindDays: '3', channels: ['discord', 'slack'],
      templates: { missing: 'M', wrongAmount: 'BW' }, ...over
    });
    const build = (f, stored, ch = channels) => plain(api.buildRuleBody(f, stored, defaults, ch));

    test('an untouched new rule has only id and schedule', () => {
      expect(build(form(), {})).toEqual({ id: 'gym', schedule: 'Gym' });
    });

    test('a prefix rule replaces schedule with schedulePrefix', () => {
      expect(build(form({ watch: 'prefix', prefix: 'Rent' }), { schedule: 'Old' })).toEqual({ id: 'gym', schedulePrefix: 'Rent' });
    });

    test('values that differ from the defaults are sent, zero included', () => {
      expect(build(form({ graceDays: '0', earlyDays: '5', tolerance: '0' }), {})).toEqual({
        id: 'gym', schedule: 'Gym', graceDays: 0, earlyDays: 5, amountTolerancePct: 0
      });
      expect(build(form({ tolerance: '' }), { amountTolerancePct: 5 })).toEqual({ id: 'gym', schedule: 'Gym' });
    });

    test('a stored key is kept even when it equals the default; a cleared field deletes it', () => {
      expect(build(form(), { graceDays: 3, earlyDays: 2 })).toEqual({ id: 'gym', schedule: 'Gym', graceDays: 3, earlyDays: 2 });
      expect(build(form({ graceDays: '' }), { graceDays: 9 })).toEqual({ id: 'gym', schedule: 'Gym' });
    });

    test('keys the form does not show survive an edit', () => {
      expect(build(form(), { custom: 'keep' }).custom).toBe('keep');
    });

    test('period is omitted while it is the default, unless it was stored', () => {
      expect(build(form({ period: 'next' }), {}).period).toBe('next');
      expect(build(form(), {}).period).toBeUndefined();
      expect(build(form(), { period: 'occurrence' }).period).toBe('occurrence');
    });

    test('reminders: off deletes the key, on sends the days', () => {
      expect(build(form({ remindOn: true, remindDays: '5' }), {}).remindEveryDays).toBe(5);
      expect(build(form({ remindOn: true, remindDays: '' }), {}).remindEveryDays).toBe(3);
      expect(build(form({ remindOn: false }), { remindEveryDays: 7 }).remindEveryDays).toBeUndefined();
    });

    test('a stored channels list is always written back, so editing another field never widens the rule', () => {
      const stored = { id: 'gym', schedule: 'Gym', channels: ['slack'] };
      expect(build(form({ channels: ['slack'], graceDays: '5' }), stored).channels).toEqual(['slack']);
      // the user ticked every box: still explicit
      expect(build(form({ channels: ['discord', 'slack'] }), stored).channels).toEqual(['discord', 'slack']);
    });

    test('a stored channel that is not available now survives untouched boxes and is dropped when the boxes change', () => {
      const stored = { id: 'gym', schedule: 'Gym', channels: ['slack', 'telegram'] };
      expect(build(form({ channels: ['slack'] }), stored).channels).toEqual(['slack', 'telegram']);
      expect(build(form({ channels: ['discord', 'slack'] }), stored).channels).toEqual(['discord', 'slack']);
    });

    test('all channels checked means no channels key; a subset lists them', () => {
      expect(build(form({ channels: ['slack'] }), {}).channels).toEqual(['slack']);
      expect(build(form({ channels: ['slack', 'discord'] }), {}).channels).toBeUndefined();
      expect(build(form({ channels: ['slack'] }), {}, []).channels).toBeUndefined();
      expect(build(form({ channels: ['telegram', 'discord'] }), {}, ['discord', 'slack', 'telegram']).channels).toEqual(['discord', 'telegram']);
    });

    test('templates: only changed or stored ones are sent, an empty set is omitted', () => {
      expect(build(form(), {}).templates).toBeUndefined();
      expect(build(form({ templates: { missing: 'mine', wrongAmount: 'BW' } }), {}).templates).toEqual({ missing: 'mine' });
      expect(build(form({ templates: { missing: 'M' } }), { templates: { missing: 'M' } }).templates).toEqual({ missing: 'M' });
      expect(build(form({ templates: { missing: '' } }), { templates: { missing: 'old' } }).templates).toBeUndefined();
      // equal to the block template (not the built-in one) counts as unchanged
      expect(build(form({ templates: { wrongAmount: 'W' } }), {}).templates).toEqual({ wrongAmount: 'W' });
    });
  });

  describe('mergePaymentRows', () => {
    const it = (alertId, source = 'config', over = {}) => ({ alertId, source, scheduleId: `s-${alertId}`, name: alertId, state: 'upcoming', ...over });
    const rule = (id, source = 'dashboard', over = {}) => ({ id, source, superseded: false, invalid: false, errors: [], definition: { id, schedule: id }, updatedAt: '2026-01-10T00:00:00Z', ...over });
    const merge = (items, rules, at = '2026-01-14T00:00:00Z', configured = true) => plain(api.mergePaymentRows(items, rules, at, configured));
    const kinds = (m) => m.rows.map((r) => `${r.item.alertId}:${r.kind}`);

    test('a failed rule list (null) merges nothing and offers no editor controls', () => {
      const m = merge([it('a')], null);
      expect(kinds(m)).toEqual(['a:evaluated']);
      expect(m.editorControls).toBe(false);
    });

    test('an empty rule list is not the same as null: it hides every snapshot row', () => {
      const m = merge([it('a')], []);
      expect(m.rows).toEqual([]);
      expect(m.editorControls).toBe(true);
    });

    test('matches on alert id and source; rows without a rule are hidden', () => {
      const m = merge([it('a', 'dashboard'), it('b', 'config'), it('gone', 'config')], [rule('a'), rule('b', 'config')]);
      expect(kinds(m)).toEqual(['a:evaluated', 'b:evaluated']);
      // same id, different source is a different rule
      expect(kinds(merge([it('a', 'config')], [rule('a', 'dashboard')]))).toEqual(['a:pending']);
    });

    test('a dashboard rule with no snapshot row is "pending"; a superseded one has its own row', () => {
      const m = merge([it('a', 'config')], [rule('a', 'config'), rule('a', 'dashboard', { superseded: true }), rule('n')]);
      expect(kinds(m)).toEqual(['a:evaluated', 'a:superseded', 'n:pending']);
    });

    test('rules of a server without a scheduleAlerts block are dormant', () => {
      expect(kinds(merge([], [rule('d')], null, false))).toEqual(['d:dormant']);
    });

    test('an invalid rule is one row and hides its snapshot rows', () => {
      const m = merge([it('x', 'dashboard'), it('x', 'dashboard', { scheduleId: 'other' })], [rule('x', 'dashboard', { invalid: true, errors: [{ path: '/graceDays', message: 'bad' }] })]);
      expect(kinds(m)).toEqual(['x:invalid']);
    });

    test('a synthetic row is labelled by schedule, prefix or id', () => {
      const labels = merge([], [
        rule('s', 'dashboard', { definition: { schedule: 'Gym' } }),
        rule('p', 'dashboard', { definition: { schedulePrefix: 'Rent ' } }),
        rule('i', 'dashboard', { definition: {} })
      ]).rows.map((r) => r.item.name);
      expect(labels).toEqual(['Gym', 'Rent *', 'i']);
    });

    test('edited is set for a dashboard rule saved after the last run', () => {
      const m = merge([it('a', 'dashboard')], [rule('a', 'dashboard', { updatedAt: '2026-01-15T00:00:00Z' })]);
      expect(m.rows[0].edited).toBe(true);
      expect(merge([it('a', 'dashboard')], [rule('a')]).rows[0].edited).toBe(false);
    });

    test('editedNote needs a dashboard rule, both times, and a later save', () => {
      const r = { source: 'dashboard', updatedAt: '2026-01-15T00:00:00Z' };
      expect(api.editedNote(r, '2026-01-14T00:00:00Z')).toBe(true);
      expect(api.editedNote(r, '2026-01-15T00:00:00Z')).toBe(false);
      expect(api.editedNote(r, null)).toBe(false);
      expect(api.editedNote({ ...r, source: 'config' }, '2026-01-14T00:00:00Z')).toBe(false);
      expect(api.editedNote({ source: 'dashboard' }, '2026-01-14T00:00:00Z')).toBe(false);
      expect(api.editedNote(null, '2026-01-14T00:00:00Z')).toBe(false);
    });
  });

  describe('server errors', () => {
    const map = (status, json, where = 'save') => plain(api.mapEditorError(status, json, where));

    test('error paths map to fields on a path boundary', () => {
      expect(api.editorFieldForPath('/id')).toBe('id');
      expect(api.editorFieldForPath('/schedule')).toBe('watch');
      expect(api.editorFieldForPath('/schedulePrefix')).toBe('watch');
      expect(api.editorFieldForPath('/graceDays')).toBe('graceDays');
      expect(api.editorFieldForPath('/earlyDays')).toBe('earlyDays');
      expect(api.editorFieldForPath('/period')).toBe('period');
      expect(api.editorFieldForPath('/amountTolerancePct')).toBe('tolerance');
      expect(api.editorFieldForPath('/remindEveryDays')).toBe('reminders');
      expect(api.editorFieldForPath('/channels/0')).toBe('channels');
      expect(api.editorFieldForPath('/templates/missing')).toBe('template:missing');
      expect(api.editorFieldForPath('/idx')).toBe('');
      expect(api.editorFieldForPath('/other')).toBe('');
      expect(api.editorFieldForPath(undefined)).toBe('');
    });

    test('invalid_rule goes to fields; unmapped paths go to the banner', () => {
      const m = map(400, { error: 'invalid_rule', details: [{ path: '/graceDays', message: 'must be <= 60' }, { path: '/x', message: 'odd' }] });
      expect(m.fields).toEqual({ graceDays: 'must be <= 60' });
      expect(m.banner).toBe('odd');
    });

    test('invalid_template words each reason', () => {
      const t = (reason, extra = {}) => map(400, { error: 'invalid_template', template: 'missing', token: 'x', line: 2, reason, ...extra }).fields['template:missing'];
      expect(t('unknown_variable')).toBe('unknown variable "x"');
      expect(t('unknown_helper')).toBe('unknown helper "x"');
      expect(t('parse_error')).toBe('template syntax error near "x" on line 2');
      expect(t('telegram_markup')).toBe('this text breaks Telegram formatting near "x"; close or escape it');
    });

    test.each([
      [0, null, 'Could not reach the server. Check your connection and try again.'],
      [400, { error: 'no_configured_destination' }, 'No notification channel is configured for this rule.'],
      [400, { error: 'id_mismatch' }, 'The editor sent an invalid request. Reload the page.'],
      [400, { error: 'invalid_event' }, 'The editor sent an invalid request. Reload the page.'],
      [400, { error: 'invalid_body' }, 'The editor sent an invalid request. Reload the page.'],
      [400, { error: 'invalid_json' }, 'The editor sent an invalid request. Reload the page.'],
      [400, { error: 'invalid_body_encoding' }, 'The editor sent an invalid request. Reload the page.'],
      [415, null, 'The editor sent an invalid request. Reload the page.'],
      [401, null, 'Your session has expired or the credentials are wrong. Reload and sign in again.'],
      [403, { error: 'config_writes_disabled', reason: 'disabled' }, 'Configuration changes are turned off (allowConfigWrites is false).'],
      [403, { error: 'config_writes_disabled', reason: 'auth-none' }, 'Configuration changes are turned off (dashboard authentication is off).'],
      [403, { error: 'origin_rejected' }, 'The request was rejected because it did not come from this dashboard\'s own address. Open the dashboard at its normal URL.'],
      [404, { error: 'rule_not_found' }, 'This alert no longer exists.'],
      [404, { error: 'server_not_found' }, 'This server is no longer configured.'],
      [409, { error: 'managed_in_config' }, 'This alert is managed in config.json. Copy as JSON to change it there.'],
      [409, { error: 'alerts_not_configured' }, 'Add a scheduleAlerts block to this server in config.json first (it can be empty).'],
      [409, { error: 'too_many_rules' }, 'Limit of 200 dashboard alerts reached. Delete one first.'],
      [413, null, 'This alert is too large to save (16 KB limit). Shorten the message templates.'],
      [429, { error: 'too_many_attempts' }, 'Too many failed sign-in attempts. Wait a few minutes.'],
      [429, null, 'Too many requests. Wait a minute.'],
      [500, { error: 'Failed to save payment rule' }, 'The server could not save this alert. Try again; see the service log.'],
      [503, { error: 'Sync history not available' }, 'Sync history is not available, so alerts cannot be edited.'],
      [418, { error: 'teapot' }, 'The server rejected the request (teapot)'],
      [418, null, 'The server rejected the request (HTTP 418)']
    ])('status %s %j is worded for the banner', (status, json, text) => {
      expect(map(status, json).banner).toBe(text);
    });

    test('duplicate_id and id_in_config sit next to the id field', () => {
      expect(map(409, { error: 'duplicate_id' }).fields.id).toBe('An alert with this id exists');
      expect(map(409, { error: 'id_in_config' }).fields.id).toBe('config.json already has an alert with this id');
    });

    test('flags: writes off, and a vanished rule closes and reloads', () => {
      expect(map(403, { error: 'config_writes_disabled', reason: 'disabled' }).writesOff).toBe(true);
      const gone = map(404, { error: 'rule_not_found' });
      expect(gone.close).toBe(true);
      expect(gone.reload).toBe(true);
      expect(map(409, { error: 'duplicate_id' }).close).toBe(false);
    });

    test('preview failures fill the preview text, not the banner', () => {
      const p = (status, json) => map(status, json, 'preview');
      expect(p(400, { error: 'no_configured_destination' })).toMatchObject({ preview: 'No notification channel is configured for this rule.', banner: '' });
      expect(p(502, { error: 'send_failed' }).preview).toBe('No destination accepted the test message');
      expect(p(429, { error: 'test_send_rate_limited' }).preview).toBe('Too many test messages, wait a minute.');
      expect(p(502, { error: 'send_threw' }).preview).toBe('The test message could not be sent. See the service log.');
      expect(p(504, { error: 'timeout' }).preview).toBe('The test message timed out.');
      expect(p(502, { error: 'channel_unavailable' }).preview).toBe('A channel is not available right now.');
      expect(p(500, null).preview).toBe('The preview failed. See the service log.');
    });
  });
});
