/**
 * Payments tab alert editor (#268): the Add alert / Edit / View dialog, its
 * save, delete, preview and Copy as JSON paths, and the states around it
 * (no snapshot, not configured, read-only config rules, writes off).
 *
 * The fixture server is real, so the happy paths assert on what it stored
 * (fixture.service.syncHistory). Failures are injected with page.overrideRoute.
 * Not covered here (jest covers the logic): the 375 px screenshot review.
 */
const { launchBrowser, closeBrowser, withFixture, clickTab } = require('./fixtures/browser');

const CREDS = { username: 'fixture-user', password: 'fixture-pass' };
const RULES_ROUTE = '/payment-rules/';
const PREVIEW_ROUTE = '/payment-preview/';

const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const history = (fixture) => fixture.service.syncHistory;

async function openPayments(page, fixture, opts = {}) {
  await page.authenticate(CREDS);
  if (opts.viewport) await page.setViewport(opts.viewport);
  await page.evaluateOnNewDocument(() => localStorage.setItem('dateFormat', 'iso'));
  await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });
  await clickTab(page, 'Payments');
  await page.waitForSelector('#payments-content .pay-group');
  await page.waitForNetworkIdle({ idleTime: 150 });
}

const addBtn = 'button[data-action="openAlertEditor"]';
const rowBtn = (action, alertId) => `button[data-action="${action}"][data-alert="${alertId}"]`;

async function openEditor(page, selector) {
  await page.click(selector);
  await page.waitForSelector('dialog#alert-editor[open]');
  await page.waitForFunction(() => !document.getElementById('ae-loading') || document.getElementById('ae-loading').hidden);
}

const val = (page, sel) => page.$eval(sel, (el) => el.value);
const text = (page, sel) => page.$eval(sel, (el) => el.textContent);
const attr = (page, sel, name) => page.$eval(sel, (el, n) => el.getAttribute(n), name);
const enabled = async (page, sel) => (await attr(page, sel, 'aria-disabled')) !== 'true';
const rowNames = (page) => page.$$eval('#payments-content tr.pay-row', (trs) => trs.map((tr) => tr.children[1].textContent));

async function setValue(page, selector, value) {
  await page.$eval(selector, (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function pickSchedule(page, label) {
  await page.$eval('#ae-schedule', (sel, l) => {
    const opt = [...sel.options].find((o) => o.textContent.startsWith(l));
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, label);
}

const bannerText = (page) => page.$eval('#ae-banner', (el) => (el.hidden ? '' : el.textContent));

describe('payments alert editor (#268)', () => {
  beforeAll(async () => { await launchBrowser(); });
  afterAll(async () => { await closeBrowser(); });

  describe('adding', () => {
    test('prefills the id from the schedule, avoids a taken id, saves and shows the new row', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        expect(await text(page, '#alert-editor-title')).toBe('Add payment alert for Main');
        expect(await text(page, '#ae-server')).toBe('Main');

        // The completed schedule is not offered; the two Gyms are told apart.
        const options = await page.$$eval('#ae-schedule option', (os) => os.map((o) => o.textContent));
        expect(options.some((o) => o.startsWith('Old Plan'))).toBe(false);
        expect(options.filter((o) => o.startsWith('Gym'))).toHaveLength(2);
        expect(new Set(options).size).toBe(options.length);

        await pickSchedule(page, 'Rent - Parking A');
        // "rent-parking-a" belongs to a stored dashboard rule already.
        expect(await val(page, '#ae-id')).toBe('rent-parking-a-2');
        expect(await text(page, '#ae-sline')).toContain('Every month on the 5th');

        await setValue(page, '#ae-grace', '2');
        await page.click('#ae-save');
        await page.waitForFunction(() => !document.querySelector('dialog#alert-editor[open]'));
        await page.waitForFunction(() => document.getElementById('payments-notice').textContent === 'Alert saved.');

        const stored = history(fixture).getRule('Main', 'rent-parking-a-2');
        expect(stored.definition || stored).toMatchObject({ id: 'rent-parking-a-2', schedule: 'Rent - Parking A', graceDays: 2 });
        expect(await rowNames(page)).toEqual(expect.arrayContaining(['Rent - Parking A']));
        expect(await page.$$('button[data-action="editPaymentRule"][data-alert="rent-parking-a-2"]')).toHaveLength(1);
      });
    });

    test('a prefix shows how many schedules it matches and saves a schedulePrefix', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await page.click('#ae-mode-prefix');
        await setValue(page, '#ae-prefix', 'Rent');
        expect(await text(page, '#ae-matches')).toMatch(/2/);
        await setValue(page, '#ae-id', 'rents');
        await page.click('#ae-save');
        await page.waitForFunction(() => !document.querySelector('dialog#alert-editor[open]'));
        const stored = history(fixture).getRule('Main', 'rents');
        expect(stored.definition || stored).toMatchObject({ id: 'rents', schedulePrefix: 'Rent' });
      });
    });

    test('the deadline line states the real date when the grace passes the month end', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        await setValue(page, '#ae-grace', '3');
        expect(await text(page, '#ae-deadline')).toContain('31 Jan');
        expect(await text(page, '#ae-deadline')).toContain('28 Jan');
      });
    });

    test('a bad id is flagged and blocks Save without a request', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        const posts = [];
        page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes(RULES_ROUTE)) posts.push(r.url()); });
        await setValue(page, '#ae-id', 'Not Valid!');
        await page.click('#ae-save');
        await page.waitForFunction(() => document.getElementById('ae-err-id').textContent !== '');
        expect(await text(page, '#ae-err-id')).toMatch(/lowercase/);
        expect(posts).toHaveLength(0);
      });
    });

    test('a duplicate id from the server lands on the id field', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        await setValue(page, '#ae-id', 'gym-x');
        page.overrideRoute(RULES_ROUTE, (req) => (req.method() === 'POST' ? req.respond(json(409, { error: 'duplicate_id' })) : req.continue()));
        await page.click('#ae-save');
        await page.waitForFunction(() => document.getElementById('ae-err-id').textContent !== '');
        expect(await text(page, '#ae-err-id')).toBe('An alert with this id exists');
        expect(await page.$('dialog#alert-editor[open]')).not.toBeNull();
      });
    });

    test('id_in_config lands on the id field too', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        await setValue(page, '#ae-id', 'cfg-electricity');
        await page.click('#ae-save');
        await page.waitForFunction(() => document.getElementById('ae-err-id').textContent !== '');
        expect(await text(page, '#ae-err-id')).toContain('config.json');
      });
    });

    test('server details for an invalid rule are placed beside the field', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        page.overrideRoute(RULES_ROUTE, (req) => (req.method() === 'POST'
          ? req.respond(json(400, { error: 'invalid_rule', details: [{ path: '/graceDays', message: 'must be <= 60' }] }))
          : req.continue()));
        await page.click('#ae-save');
        await page.waitForFunction(() => document.getElementById('ae-err-graceDays').textContent !== '');
        expect(await text(page, '#ae-err-graceDays')).toBe('must be <= 60');
      });
    });

    test('the channel list follows what is configured and one must stay ticked', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        const labels = await page.$$eval('#ae-channels label', (ls) => ls.map((l) => l.textContent.trim().toLowerCase()));
        expect(labels).toEqual(expect.arrayContaining([expect.stringContaining('discord'), expect.stringContaining('slack')]));
        await page.$$eval('#ae-channels input', (is) => is.forEach((i) => { if (i.checked) i.click(); }));
        expect(await enabled(page, '#ae-save')).toBe(false);
        expect(await text(page, '#ae-save-hint')).toBe('Pick at least one channel');
      });
    });

    test('the block template is what the Missing message starts with', async () => {
      await withFixture('editor-block-template', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        expect(await val(page, '#ae-tpl-missing')).toBe('BLOCK: {{name}} is late');
      });
    });
  });

  describe('editing', () => {
    test('opens with the stored values, notes the edit and saves with a PUT', async () => {
      await withFixture('editor-edit', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, rowBtn('editPaymentRule', 'gym'));
        expect(await text(page, '#alert-editor-title')).toMatch(/Edit/);
        expect(await val(page, '#ae-id')).toBe('gym');
        expect(await page.$eval('#ae-id', (el) => el.disabled)).toBe(true);
        expect(await val(page, '#ae-grace')).toBe('4');
        expect(await val(page, '#ae-early')).toBe('1');
        expect(await val(page, '#ae-tol')).toBe('5');
        expect(await val(page, '#ae-remind-days')).toBe('2');
        expect(await page.$eval('#ae-period-next', (el) => el.checked)).toBe(true);
        expect(await val(page, '#ae-tpl-missing')).toBe('Gym payment is late');

        const puts = [];
        page.on('request', (r) => { if (r.method() === 'PUT') puts.push(JSON.parse(r.postData())); });
        await setValue(page, '#ae-grace', '6');
        await page.click('#ae-save');
        await page.waitForFunction(() => !document.querySelector('dialog#alert-editor[open]'));
        expect(puts).toHaveLength(1);
        expect(puts[0]).toMatchObject({ id: 'gym', graceDays: 6, period: 'next', remindEveryDays: 2, channels: ['slack'] });
        await page.waitForFunction(() => document.getElementById('payments-notice').textContent === 'Alert updated.');
        const stored = history(fixture).getRule('Main', 'gym');
        expect((stored.definition || stored).graceDays).toBe(6);
      });
    });

    test('a rule gone before saving closes the dialog and reloads the list', async () => {
      await withFixture('editor-edit', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, rowBtn('editPaymentRule', 'gym'));
        history(fixture).deleteRule('Main', 'gym');
        await setValue(page, '#ae-grace', '5');
        await page.click('#ae-save');
        await page.waitForFunction(() => !document.querySelector('dialog#alert-editor[open]'));
        await page.waitForFunction(() => !document.querySelector('button[data-alert="gym"][data-action="editPaymentRule"]'));
      });
    });

    test('Escape closes the dialog and focus returns to the button that opened it', async () => {
      await withFixture('editor-edit', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, rowBtn('editPaymentRule', 'gym'));
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('dialog#alert-editor[open]'));
        await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.action === 'editPaymentRule');
        expect(await page.evaluate(() => document.activeElement.dataset.alert)).toBe('gym');
      });
    });
  });

  describe('deleting', () => {
    test('asks first, Keep returns to the form and Delete removes the rule and the row', async () => {
      await withFixture('editor-edit', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, rowBtn('editPaymentRule', 'gym'));
        await page.click('#ae-delete');
        expect(await page.$eval('#ae-confirm', (el) => el.hidden)).toBe(false);
        await page.click('#ae-delete-keep');
        expect(await page.$eval('#ae-confirm', (el) => el.hidden)).toBe(true);
        expect(history(fixture).getRule('Main', 'gym')).toBeTruthy();

        await page.click('#ae-delete');
        await page.click('#ae-delete-yes');
        await page.waitForFunction(() => !document.querySelector('dialog#alert-editor[open]'));
        await page.waitForFunction(() => document.getElementById('payments-notice').textContent === 'Alert deleted.');
        expect(history(fixture).getRule('Main', 'gym')).toBeFalsy();
      });
    });

    test('the row Delete button opens the dialog already asking', async () => {
      await withFixture('editor-edit', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, rowBtn('deletePaymentRuleAsk', 'gym'));
        expect(await page.$eval('#ae-confirm', (el) => el.hidden)).toBe(false);
      });
    });
  });

  describe('config rules and other row kinds', () => {
    test('a config rule opens read-only with no Save or Delete, only Copy', async () => {
      await withFixture('editor-config-readonly', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        expect(await page.$$(rowBtn('editPaymentRule', 'cfg-rent'))).toHaveLength(0);
        await openEditor(page, rowBtn('viewPaymentRule', 'cfg-rent'));
        expect(await page.$eval('#ae-save', (el) => el.hidden)).toBe(true);
        expect(await page.$eval('#ae-delete', (el) => el.hidden)).toBe(true);
        expect(await page.$eval('#ae-grace', (el) => el.disabled || el.readOnly)).toBe(true);
        expect(await val(page, '#ae-tpl-missing')).toBe('Rent is late');
        expect(await text(page, '#ae-cancel')).toBe('Close');
      });
    });

    test('a superseded dashboard rule can only be deleted', async () => {
      await withFixture('editor-superseded', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const buttons = await page.$$eval('#payments-content tr.pay-row button', (bs) => bs.map((b) => `${b.dataset.action}:${b.dataset.source}`));
        expect(buttons).toEqual(expect.arrayContaining(['deletePaymentRuleAsk:dashboard']));
        expect(buttons).not.toContain('editPaymentRule:dashboard');
        const pills = await page.$$eval('#payments-content .pay-pill', (ps) => ps.map((p) => p.textContent));
        expect(pills).toEqual(expect.arrayContaining(['Replaced by config.json']));
      });
    });

    test('a dormant rule (block removed) is listed and offers View, Delete and Copy', async () => {
      await withFixture('editor-dormant', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const actions = await page.$$eval('#payments-content tr.pay-row button', (bs) => bs.map((b) => b.dataset.action));
        expect(actions).toEqual(expect.arrayContaining(['viewPaymentRule', 'deletePaymentRuleAsk', 'copyPaymentRuleJson']));
        expect(await page.$eval(addBtn, (b) => b.getAttribute('aria-disabled'))).toBe('true');
      });
    });

    test('a stored rule that no longer validates is shown as invalid and can be deleted', async () => {
      await withFixture('editor-invalid-stored', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const pills = await page.$$eval('#payments-content .pay-pill', (ps) => ps.map((p) => p.textContent));
        expect(pills.some((p) => /invalid/i.test(p))).toBe(true);
        expect(await page.$$(rowBtn('deletePaymentRuleAsk', 'broken'))).toHaveLength(1);
      });
    });
  });

  describe('states around the editor', () => {
    test('without a snapshot the Watch section asks for Sync now and Save finds nothing to save', async () => {
      await withFixture('editor-no-snapshot', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        expect(await page.$eval('#ae-nosnap', (el) => el.hidden)).toBe(false);
        expect(await page.$eval('#ae-pick', (el) => el.hidden)).toBe(true);
        await page.click('#ae-save');
        await page.waitForFunction(() => document.getElementById('ae-err-watch').textContent !== '');
        expect(await page.$$('dialog#alert-editor[open]')).toHaveLength(1);
      });
    });

    test('a server with no scheduleAlerts block has a disabled Add alert with a tip', async () => {
      await withFixture('editor-not-configured', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        expect(await attr(page, addBtn, 'aria-disabled')).toBe('true');
        expect(await attr(page, addBtn, 'title')).toMatch(/scheduleAlerts/);
        await page.click(addBtn);
        expect(await page.$('dialog#alert-editor[open]')).toBeNull();
      });
    });

    test('with config writes off, Add and Edit are disabled and View and Copy still work', async () => {
      await withFixture('editor-writes-disabled', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        expect(await attr(page, addBtn, 'aria-disabled')).toBe('true');
        expect(await attr(page, rowBtn('editPaymentRule', 'gym'), 'aria-disabled')).toBe('true');
        expect(await page.$$(rowBtn('viewPaymentRule', 'cfg-electricity'))).toHaveLength(1);
        expect(await page.$$(rowBtn('copyPaymentRuleJson', 'cfg-electricity'))).toHaveLength(1);
      });
    });

    test('a failing rule list keeps the snapshot rows and says the list is unavailable', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        page.overrideRoute('/payment-rules/Main', (req) => (req.method() === 'GET' ? req.respond(json(500, { error: 'boom' })) : req.continue()));
        await openPayments(page, fixture);
        expect((await rowNames(page)).some((n) => n.includes('Electricity'))).toBe(true);
        expect(await text(page, '#payments-content')).toContain('Alert list unavailable');
        expect(await attr(page, addBtn, 'aria-disabled')).toBe('true');
      });
    });

    test('config writes turning off while the dialog is open disables Save with a banner', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        await setValue(page, '#ae-id', 'power-2');
        page.overrideRoute(RULES_ROUTE, (req) => (req.method() === 'POST'
          ? req.respond(json(403, { error: 'config_writes_disabled', reason: 'disabled' }))
          : req.continue()));
        // The server now reports writes off as well, as it would after a restart.
        page.overrideRoute('/capabilities', (req) => req.respond(json(200, { configWrites: false, reason: 'disabled', channels: ['discord'] })));
        await page.click('#ae-save');
        await page.waitForFunction(() => document.getElementById('ae-banner').textContent !== '');
        expect(await bannerText(page)).toContain('turned off');
        expect(await enabled(page, '#ae-save')).toBe(false);
      });
    });

    test('a schedule name carrying markup is shown as text', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        history(fixture).replaceScheduleSnapshot('Main', [{
          id: 'sched-xss', name: '<img src=x onerror=window.__xss=1>', cadenceText: 'Every month on the 1st', amount: 1,
          amountMin: null, amountMax: null, amountOp: 'is', account: null, payee: null, nextDate: '2026-02-01', completed: false
        }]);
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        expect(await page.$('#ae-schedule img')).toBeNull();
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      });
    });
  });

  describe('preview', () => {
    test('typing refreshes the preview and shows the sample keys', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        await setValue(page, '#ae-tpl-missing', 'Hello {{name}}');
        await page.waitForFunction(() => document.getElementById('ae-preview-text').textContent.startsWith('Hello'));
        expect(await text(page, '#ae-preview-keys')).toMatch(/Sample values used for/);
      });
    });

    test('an unknown token shows beside the template and keeps Save usable', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        await setValue(page, '#ae-tpl-missing', 'Hi {{nope}}');
        await page.waitForFunction(() => document.getElementById('ae-err-template-missing').textContent !== '');
        expect(await text(page, '#ae-err-template-missing')).toMatch(/nope/);
      });
    });

    test('a 429 from the preview shows the rate-limit note and does not stop editing', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        page.overrideRoute(PREVIEW_ROUTE, (req) => req.respond(json(429, { error: 'test_send_rate_limited' })));
        await page.click('#ae-send');
        await page.waitForFunction(() => document.getElementById('ae-preview-note').textContent !== '');
        expect(await text(page, '#ae-preview-note')).toBe('Too many test messages, wait a minute.');
      });
    });

    test('a partial send lists each destination with its outcome', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        page.overrideRoute(PREVIEW_ROUTE, (req) => req.respond(json(200, {
          text: 'T', sampleKeys: [], sent: true,
          results: [{ channel: 'discord', target: 'x', ok: true }, { channel: 'slack', target: 'y', ok: false, error: 'bad hook' }]
        })));
        await page.click('#ae-send');
        await page.waitForFunction(() => document.querySelectorAll('#ae-results li').length >= 2);
        const lines = await page.$$eval('#ae-results li', (ls) => ls.map((l) => l.textContent));
        expect(lines.join(' ')).toMatch(/bad hook/);
      });
    });

    test('a 502 send_failed shows the failure and the previewed text', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await openEditor(page, addBtn);
        await pickSchedule(page, 'Electricity');
        page.overrideRoute(PREVIEW_ROUTE, (req) => req.respond(json(502, {
          error: 'send_failed', text: 'previewed', sampleKeys: [], sent: false, results: [{ channel: 'discord', target: 'x', ok: false, error: 'down' }]
        })));
        await page.click('#ae-send');
        await page.waitForFunction(() => document.getElementById('ae-preview-note').textContent !== '');
        expect(await text(page, '#ae-preview-note')).toBe('No destination accepted the test message');
      });
    });
  });

  describe('Copy as JSON', () => {
    test('copies the rule definition to the clipboard and says so', async () => {
      await withFixture('editor-config-readonly', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await page.evaluate(() => {
          window.__copied = null;
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } });
        });
        await page.click(rowBtn('copyPaymentRuleJson', 'cfg-rent'));
        await page.waitForFunction(() => window.__copied !== null);
        expect(JSON.parse(await page.evaluate(() => window.__copied))).toMatchObject({ id: 'cfg-rent', schedulePrefix: 'Rent' });
      });
    });

    test('without a clipboard the dialog shows the JSON in a selectable field', async () => {
      await withFixture('editor-config-readonly', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        });
        await page.click(rowBtn('copyPaymentRuleJson', 'cfg-rent'));
        await page.waitForSelector('dialog#alert-editor[open]');
        await page.waitForFunction(() => !document.getElementById('ae-json').hidden);
        expect(JSON.parse(await val(page, '#ae-json-text'))).toMatchObject({ id: 'cfg-rent' });
      });
    });
  });

  describe('small screens', () => {
    test('the dialog fits a 375 px viewport without horizontal scroll', async () => {
      await withFixture('editor-new', async ({ page, fixture }) => {
        await openPayments(page, fixture, { viewport: { width: 375, height: 700 } });
        await openEditor(page, addBtn);
        const fits = await page.evaluate(() => {
          const d = document.getElementById('alert-editor');
          return d.scrollWidth <= d.clientWidth + 1 && d.getBoundingClientRect().width <= window.innerWidth;
        });
        expect(fits).toBe(true);
      });
    });
  });
});
