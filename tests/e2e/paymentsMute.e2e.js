/**
 * Payments tab alert controls (#261): the on/off switch, the mute form, the
 * "Muted until" / "Disabled in config" badge beside the real state pill, the
 * read-only tooltips and the orphaned overrides card in Settings.
 *
 * The writing states need basic auth, so every spec authenticates the page
 * before it navigates. Failures of the state route are injected with
 * page.overrideRoute (see fixtures/browser.js); the fixture server is real, so
 * the happy paths assert on what it stored (fixture.service.syncHistory).
 */
const { launchBrowser, closeBrowser, withFixture, clickTab } = require('./fixtures/browser');

const CREDS = { username: 'fixture-user', password: 'fixture-pass' };
const STATE_ROUTE = '/state';

const jsonError = (status, error = 'boom', extra = {}) => ({
  status, contentType: 'application/json', body: JSON.stringify({ error, ...extra })
});

async function openPayments(page, fixture, opts = {}) {
  const { viewport, auth = true } = opts;
  if (auth) await page.authenticate(CREDS);
  if (viewport) await page.setViewport(viewport);
  await page.evaluateOnNewDocument(() => localStorage.setItem('dateFormat', 'iso'));
  await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });
  await clickTab(page, 'Payments');
  await page.waitForSelector('#payments-content .pay-group');
  // Capabilities load with the tab; the controls are live once the switch is not aria-disabled.
  await page.waitForFunction(() => document.querySelector('#payments-content .pay-switch'));
}

/** Everything a spec asserts about one row, found by its Name cell. */
const rowInfo = (page, name) => page.evaluate((needle) => {
  const tr = [...document.querySelectorAll('#payments-content tr.pay-row')]
    .find((r) => r.children[1].textContent.includes(needle));
  if (!tr) return null;
  const sw = tr.querySelector('.pay-switch');
  const badge = tr.querySelector('.pay-override');
  return {
    pills: [...tr.querySelectorAll('.pay-pill')].map((p) => p.textContent),
    badge: badge ? badge.textContent : null,
    badgeTitle: badge ? badge.title : null,
    badgeAria: badge ? badge.getAttribute('aria-label') : null,
    switchText: sw ? sw.textContent : null,
    switchChecked: sw ? sw.getAttribute('aria-checked') : null,
    switchDisabled: sw ? sw.getAttribute('aria-disabled') : null,
    switchTitle: sw ? sw.title : null,
    control: tr.children[9].textContent,
    buttons: [...tr.children[9].querySelectorAll('button')].map((b) => b.textContent)
  };
}, name);

const liveText = (page) => page.$eval('#payments-control-status', (el) => el.textContent);
const focusKey = (page) => page.evaluate(() => (document.activeElement && document.activeElement.dataset.focus) || '');
const focusKind = async (page) => (await focusKey(page)).split(':')[0];

/** Count state-route requests the page sends from now on. */
function countStateRequests(page) {
  const seen = [];
  page.on('request', (req) => {
    if (req.url().includes(STATE_ROUTE)) seen.push({ method: req.method(), body: req.postData() });
  });
  return seen;
}

const clickBtn = (page, action, alertId) => page.click(`button[data-action="${action}"][data-alert="${alertId}"]`);

async function setField(page, selector, value) {
  await page.$eval(selector, (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

const history = (fixture) => fixture.service.syncHistory;

describe('payments alert controls (#261)', () => {
  beforeAll(async () => { await launchBrowser(); });
  afterAll(async () => { await closeBrowser(); });

  describe('the switch', () => {
    test('turns an alert off with one PUT, shows Off, and leaves the single real pill', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const seen = countStateRequests(page);
        const before = await rowInfo(page, 'Rent - Parking');
        expect(before.switchText).toBe('On');
        expect(before.switchChecked).toBe('true');

        await clickBtn(page, 'togglePaymentAlert', 'parking-a');
        await page.waitForFunction(() => {
          const sw = document.querySelector('button.pay-switch[data-alert="parking-a"]');
          return sw && sw.getAttribute('aria-checked') === 'false' && !sw.hasAttribute('data-busy');
        });

        expect(seen).toHaveLength(1);
        expect(seen[0].method).toBe('PUT');
        expect(JSON.parse(seen[0].body)).toEqual({ enabled: false });
        const after = await rowInfo(page, 'Rent - Parking');
        expect(after.switchText).toBe('Off');
        expect(after.pills).toEqual(['Missing']);
        expect(history(fixture).getOverride('Main', 'parking-a').enabled).toBe(false);
        expect(await focusKind(page)).toBe('sw');
      });
    });

    test.each([
      [409, 'disabled_in_config', /switched off in the configuration file/],
      [400, 'invalid_body', /not understood/],
      [403, 'config_writes_disabled', /Changes from the dashboard/]
    ])('a %i answer reverts the switch and says why in the live region', async (status, code, pattern) => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        page.overrideRoute(STATE_ROUTE, (req) => req.respond(jsonError(status, code, { reason: 'disabled' })));
        await clickBtn(page, 'togglePaymentAlert', 'parking-a');
        await page.waitForFunction(() => document.getElementById('payments-control-status').textContent !== '');
        expect(await liveText(page)).toMatch(pattern);
        const info = await rowInfo(page, 'Rent - Parking');
        expect(info.switchChecked).toBe('true');
        expect(info.switchText).toBe('On');
        const outside = await page.evaluate(() => !document.getElementById('payments-content').contains(document.getElementById('payments-control-status')));
        expect(outside).toBe(true);
        expect(history(fixture).getOverride('Main', 'parking-a')).toBeNull();
      });
    });

    test('a network failure reverts the switch and reports it', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        page.overrideRoute(STATE_ROUTE, (req) => req.abort('failed'));
        await clickBtn(page, 'togglePaymentAlert', 'parking-a');
        await page.waitForFunction(() => document.getElementById('payments-control-status').textContent !== '');
        expect(await liveText(page)).toMatch(/network error/);
        expect((await rowInfo(page, 'Rent - Parking')).switchChecked).toBe('true');
      });
    });
  });

  describe('the mute form', () => {
    test('mutes with a date and reason: one PUT, a badge with the reason, the pill unchanged, focus on Unmute', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const seen = countStateRequests(page);
        await clickBtn(page, 'openPaymentMute', 'parking-a');
        await page.waitForSelector('.pay-mute-form');
        expect(await focusKind(page)).toBe('date');
        await setField(page, '.pay-mute-date', '2026-03-01');
        await setField(page, '.pay-mute-reason', 'vacant');
        await page.click('.pay-mute-form button[type="submit"]');
        await page.waitForSelector('button[data-action="unmutePaymentAlert"][data-alert="parking-a"]');

        expect(seen).toHaveLength(1);
        expect(JSON.parse(seen[0].body)).toEqual({ mutedUntil: '2026-03-01', reason: 'vacant' });
        const info = await rowInfo(page, 'Rent - Parking');
        expect(info.badge).toBe('Muted until 2026-03-01');
        expect(info.badgeTitle).toBe('vacant');
        expect(info.badgeAria).toBe('Muted until 2026-03-01. Reason: vacant');
        expect(info.pills).toEqual(['Missing']);
        expect(await page.$('.pay-mute-form')).toBeNull();
        expect(await focusKind(page)).toBe('unmute');
        const stored = history(fixture).getOverride('Main', 'parking-a');
        expect(stored.mutedUntil).toBe('2026-03-01');
        expect(stored.reason).toBe('vacant');
      });
    });

    test('Enter in the reason field saves the form', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await clickBtn(page, 'openPaymentMute', 'parking-a');
        await page.waitForSelector('.pay-mute-form');
        await setField(page, '.pay-mute-date', '2026-02-01');
        await page.focus('.pay-mute-reason');
        await page.keyboard.type('away');
        await page.keyboard.press('Enter');
        await page.waitForSelector('button[data-action="unmutePaymentAlert"][data-alert="parking-a"]');
        expect(history(fixture).getOverride('Main', 'parking-a').reason).toBe('away');
      });
    });

    test('a missing reason shows the message next to the reason field and sends nothing', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const seen = countStateRequests(page);
        await clickBtn(page, 'openPaymentMute', 'parking-a');
        await page.waitForSelector('.pay-mute-form');
        await setField(page, '.pay-mute-date', '2026-03-01');
        await page.click('.pay-mute-form button[type="submit"]');
        await page.waitForSelector('.pay-field-error');
        const next = await page.evaluate(() => {
          const err = document.querySelector('.pay-field-error');
          return { text: err.textContent, afterReasonLabel: err.previousElementSibling && err.previousElementSibling.querySelector('.pay-mute-reason') !== null };
        });
        expect(next).toEqual({ text: 'Reason is required', afterReasonLabel: true });
        expect(await liveText(page)).toContain('Reason is required');
        expect(seen).toHaveLength(0);
        expect(await focusKind(page)).toBe('reason');
      });
    });

    test('Esc closes the form, sends nothing and returns focus to Mute...', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const seen = countStateRequests(page);
        await clickBtn(page, 'openPaymentMute', 'parking-a');
        await page.waitForSelector('.pay-mute-form');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.pay-mute-form'));
        expect(seen).toHaveLength(0);
        expect(await focusKey(page)).toMatch(/^mute:/);
      });
    });

    test('the open form and its typed values survive the filter, the search and a visibility change', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await clickBtn(page, 'openPaymentMute', 'parking-a');
        await page.waitForSelector('.pay-mute-form');
        await setField(page, '.pay-mute-date', '2026-02-10');
        await setField(page, '.pay-mute-reason', 'half typed');

        await page.click('button[data-action="setPaymentStateFilter"][data-arg="all"]');
        await setField(page, '#payments-search', 'Rent');
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { value: false, configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.waitForNetworkIdle({ idleTime: 200 });

        const values = await page.evaluate(() => ({
          date: document.querySelector('.pay-mute-date').value,
          reason: document.querySelector('.pay-mute-reason').value
        }));
        expect(values).toEqual({ date: '2026-02-10', reason: 'half typed' });
      });
    });

    test('a form for an alert that has left the snapshot is dropped on the next load', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await clickBtn(page, 'openPaymentMute', 'power');
        await page.waitForSelector('.pay-mute-form');
        // The next evaluation no longer contains "power".
        const { controlEvaluations } = require('./fixtures/states/_payments');
        history(fixture).replacePaymentSnapshot('Main', controlEvaluations().filter((e) => e.alertId !== 'power'), {});
        await page.evaluate(() => { loadPaymentsTab(); });
        await page.waitForFunction(() => !document.querySelector('.pay-mute-form'));
        expect(await rowInfo(page, 'Electricity')).toBeNull();
      });
    });

    test('invalid_muted_until keeps the form open with the message beside the date field', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await clickBtn(page, 'openPaymentMute', 'parking-a');
        await page.waitForSelector('.pay-mute-form');
        await setField(page, '.pay-mute-date', '2026-03-01');
        await setField(page, '.pay-mute-reason', 'vacant');
        page.overrideRoute(STATE_ROUTE, (req) => req.respond(jsonError(400, 'invalid_muted_until')));
        await page.click('.pay-mute-form button[type="submit"]');
        await page.waitForSelector('.pay-field-error');
        const beside = await page.evaluate(() => {
          const err = document.querySelector('.pay-field-error');
          return { text: err.textContent, afterDate: err.previousElementSibling.querySelector('.pay-mute-date') !== null, formOpen: !!document.querySelector('.pay-mute-form') };
        });
        expect(beside).toEqual({ text: 'Pick a date from today up to one year ahead.', afterDate: true, formOpen: true });
        expect(await focusKind(page)).toBe('date');
      });
    });

    test('a reason with markup is shown as text only', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const reason = '<img src=x onerror="window.__xss=1">';
        await clickBtn(page, 'openPaymentMute', 'parking-a');
        await page.waitForSelector('.pay-mute-form');
        await setField(page, '.pay-mute-date', '2026-03-01');
        await setField(page, '.pay-mute-reason', reason);
        await page.click('.pay-mute-form button[type="submit"]');
        await page.waitForSelector('button[data-action="unmutePaymentAlert"][data-alert="parking-a"]');
        const info = await rowInfo(page, 'Rent - Parking');
        expect(info.badgeTitle).toBe(reason);
        expect(await page.$('#payments-content img')).toBeNull();
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
        expect(page.__consoleLog.filter((l) => l.startsWith('[pageerror]'))).toEqual([]);
      });
    });
  });

  describe('a muted alert', () => {
    test('Unmute sends one PUT with a null date and leaves one pill and no badge', async () => {
      await withFixture('payments-muted', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const seen = countStateRequests(page);
        const before = await rowInfo(page, 'Rent - Parking');
        expect(before.badge).toBe('Muted until 2026-01-20');
        expect(before.buttons).toContain('Unmute');
        await clickBtn(page, 'unmutePaymentAlert', 'parking-a');
        await page.waitForFunction(() => document.querySelector('button[data-action="openPaymentMute"][data-alert="parking-a"]'));
        expect(seen).toHaveLength(1);
        expect(JSON.parse(seen[0].body)).toEqual({ mutedUntil: null });
        const after = await rowInfo(page, 'Rent - Parking');
        expect(after.pills).toEqual(['Missing']);
        expect(after.badge).toBeNull();
        expect(history(fixture).getOverride('Main', 'parking-a')).toBeNull();
        expect(await focusKind(page)).toBe('mute');
      });
    });

    test('the real pill is the snapshot state, not replaced by the badge', async () => {
      await withFixture('payments-muted', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const rows = await page.$$eval('#payments-content tr.pay-row', (trs) => trs.map((tr) => ({
          pill: tr.querySelector('.pay-pill').textContent,
          pillIsBadge: tr.querySelector('.pay-pill').classList.contains('pay-override')
        })));
        expect(rows[0]).toEqual({ pill: 'Missing', pillIsBadge: false });
        const info = await rowInfo(page, 'Rent - Parking');
        expect(info.badgeTitle).toBe('Tenant is on holiday, paying late');
      });
    });

    test('at 375px the badge stays on screen and the page does not scroll sideways', async () => {
      await withFixture('payments-muted', async ({ page, fixture }) => {
        await openPayments(page, fixture, { viewport: { width: 375, height: 800 } });
        const m = await page.evaluate(() => {
          const wrap = document.querySelector('#payments-content .pay-state');
          const badge = wrap.querySelector('.pay-override').getBoundingClientRect();
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            badgeInside: badge.left >= 0 && badge.right <= document.documentElement.clientWidth
          };
        });
        expect(m.overflow).toBeLessThanOrEqual(0);
        expect(m.badgeInside).toBe(true);
      });
    });
  });

  describe('a rule that matches several schedules', () => {
    test('shows the controls once with the schedule count, and moves them when the first row is filtered out', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const rent = async () => {
          const names = ['Rent North', 'Rent South', 'Rent East'];
          const out = {};
          for (const n of names) out[n] = (await rowInfo(page, n)).control;
          return out;
        };
        const first = await rent();
        const withControls = Object.entries(first).filter(([, text]) => text !== '');
        expect(withControls).toHaveLength(1);
        expect(withControls[0][1]).toContain('Applies to 3 schedules');
        const firstOwner = withControls[0][0];

        const other = Object.keys(first).find((n) => n !== firstOwner);
        await setField(page, '#payments-search', other.replace('Rent ', ''));
        await page.waitForFunction((n) => {
          const tr = [...document.querySelectorAll('#payments-content tr.pay-row')].find((r) => r.children[1].textContent.includes(n));
          return tr && tr.children[9].textContent.includes('Applies to');
        }, {}, other);
        expect(await rowInfo(page, firstOwner)).toBeNull();
      });
    });

    test('an alert on a single schedule shows no count', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        expect((await rowInfo(page, 'Rent - Parking')).control).not.toContain('Applies to');
      });
    });
  });

  describe('an alert switched off in the configuration file', () => {
    test('shows Disabled in config and has no switch', async () => {
      await withFixture('payments-writes-enabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const info = await rowInfo(page, 'Old Subscription');
        expect(info.badge).toBe('Disabled in config');
        expect(info.switchText).toBeNull();
        expect(info.buttons).not.toContain('Mute...');
        expect(info.pills).toEqual(['Received']);
      });
    });
  });

  describe('when the dashboard may not write', () => {
    test('writes-disabled: the controls are aria-disabled with the reason, and a click sends nothing', async () => {
      await withFixture('payments-writes-disabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const seen = countStateRequests(page);
        const info = await rowInfo(page, 'Rent - Parking');
        expect(info.switchDisabled).toBe('true');
        expect(info.switchTitle).toBe('Changes from the dashboard are off. Set healthCheck.dashboard.allowConfigWrites to true.');
        await clickBtn(page, 'togglePaymentAlert', 'parking-a');
        await clickBtn(page, 'openPaymentMute', 'parking-a');
        await new Promise((r) => setTimeout(r, 200));
        expect(seen).toHaveLength(0);
        expect(await page.$('.pay-mute-form')).toBeNull();
        expect((await rowInfo(page, 'Rent - Parking')).switchChecked).toBe('true');
      });
    });

    test('writes-auth-none: the tooltip says dashboard authentication is needed', async () => {
      await withFixture('payments-writes-auth-none', async ({ page, fixture }) => {
        await openPayments(page, fixture, { auth: false });
        const info = await rowInfo(page, 'Rent - Parking');
        expect(info.switchDisabled).toBe('true');
        expect(info.switchTitle).toBe('Changes from the dashboard need dashboard authentication (basic or token).');
      });
    });
  });

  describe('orphaned overrides card (Settings)', () => {
    test('lists overrides whose alert or server is gone, and Delete removes one with one DELETE', async () => {
      await withFixture('payments-orphaned-override', async ({ page, fixture }) => {
        await page.authenticate(CREDS);
        await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });
        await clickTab(page, 'Settings');
        await page.waitForSelector('#orphaned-overrides-list .orphan-row');
        const labels = await page.$$eval('#orphaned-overrides-list .orphan-label', (els) => els.map((e) => e.textContent));
        expect(labels.sort()).toEqual(['Gone / old-rule', 'Main / removed-alert']);

        const seen = countStateRequests(page);
        await page.click('#orphaned-overrides-list button[data-alert="removed-alert"]');
        await page.waitForFunction(() => document.querySelectorAll('#orphaned-overrides-list .orphan-row').length === 1);
        expect(seen).toHaveLength(1);
        expect(seen[0].method).toBe('DELETE');
        expect(history(fixture).getOverride('Main', 'removed-alert')).toBeNull();

        await page.click('#orphaned-overrides-list button[data-alert="old-rule"]');
        await page.waitForFunction(() => document.querySelector('#orphaned-overrides-list .orphan-empty'));
        expect(await page.$eval('#orphaned-overrides-list', (el) => el.textContent)).toContain('No orphaned overrides');
      });
    });
  });
});
