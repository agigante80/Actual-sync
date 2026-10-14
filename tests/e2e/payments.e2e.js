/**
 * Payments tab (#341): the read-only view of GET /api/dashboard/payments.
 *
 * Every spec sets localStorage.dateFormat = 'iso' before load so date
 * assertions are format-stable. The refresh specs need short intervals, which
 * dashboard.js reads once at load from page globals, so they use withFixture
 * plus evaluateOnNewDocument plus a manual goto (withDashboard navigates before
 * the spec body runs, too late for a global). The fake page clock fakes only
 * Date, so timers are real. Failures of the payments, sync and status routes
 * are injected with page.overrideRoute (see fixtures/browser.js).
 */
const { launchBrowser, closeBrowser, withFixture, clickTab } = require('./fixtures/browser');

const PAYMENTS_URL = '/api/dashboard/payments';

async function until(fn, message, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Load the dashboard with the given globals and date format, open Payments.
 * @param {{ dateFormat?: string|null, tz?: string, globals?: Object, viewport?: Object, openTab?: boolean }} [opts]
 */
async function openPayments(page, fixture, opts = {}) {
  const { dateFormat = 'iso', tz, globals = {}, viewport, openTab = true } = opts;
  if (tz) await page.emulateTimezone(tz);
  if (viewport) await page.setViewport(viewport);
  await page.evaluateOnNewDocument((fmt, g) => {
    if (fmt) localStorage.setItem('dateFormat', fmt); else localStorage.removeItem('dateFormat');
    Object.assign(window, g);
  }, dateFormat, globals);
  await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });
  if (openTab) {
    await clickTab(page, 'Payments');
    await page.waitForSelector('#payments-content .pay-group');
  }
}

const rowTexts = (page) => page.$$eval('#payments-content tr.pay-row', (trs) => trs.map((tr) => ({
  cells: [...tr.children].map((td) => td.textContent),
  pill: tr.querySelector('.pay-pill')?.textContent,
  pillClass: tr.querySelector('.pay-pill')?.className
})));

const groupTitles = (page) => page.$$eval('#payments-content .pay-group-title', (hs) => hs.map((h) => h.textContent));
const errorText = (page) => page.$eval('#payments-error', (el) => (el.hidden ? '' : el.textContent));

const jsonError = (status, error = 'boom') => ({ status, contentType: 'application/json', body: JSON.stringify({ error }) });

describe('dashboard payments tab (#341)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  describe('rendering', () => {
    test('shows the first row with a red Missing pill, calendar dates, amount and last alert', async () => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const rows = await rowTexts(page);
        const first = rows[0];
        expect(first.pill).toBe('Missing');
        expect(first.pillClass).toContain('pay-missing');
        // cells: State, Name, Cadence, Account, Amount, Next due, Deadline, Last alert, Source
        expect(first.cells[1]).toContain('Rent - Parking');
        expect(first.cells[2]).toBe('Every month on the 5th');
        expect(first.cells[4]).toBe('60.00');
        expect(first.cells[5]).toBe('2026-02-05');
        expect(first.cells[5]).not.toBe('Just now');
        expect(first.cells[6]).toBe('2026-01-11');
        expect(first.cells[7]).toBe('2026-01-12 08:01:00');
        expect(first.cells[8]).toBe('config');
        expect(await page.$eval('#payments-summary', (el) => el.textContent)).toBe('12 watched · 2 need attention');
        expect(await page.$eval('.pay-asof', (el) => el.textContent)).toBe('as of 2026-01-14 08:01:00');
      });
    });

    test('expands a row with aria-expanded and aria-controls on the button', async () => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await page.click('tr.pay-row button.pay-expand');
        const info = await page.$eval('tr.pay-row button.pay-expand', (btn) => {
          const strip = document.getElementById(btn.getAttribute('aria-controls'));
          return {
            expanded: btn.getAttribute('aria-expanded'),
            hasStrip: !!strip,
            hidden: strip && strip.hidden,
            occurrences: strip ? strip.querySelectorAll('.pay-occ li').length : 0,
            trExpanded: btn.closest('tr').hasAttribute('aria-expanded'),
            late: strip ? [...strip.querySelectorAll('.pay-occ li')].map((li) => li.textContent).find((t) => t.includes('Late')) : ''
          };
        });
        expect(info).toMatchObject({ expanded: 'true', hasStrip: true, hidden: false, occurrences: 6, trExpanded: false });
        expect(info.late).toContain('received 2025-10-14');
        expect(info.late).toContain('(+3d)');
      });
    });

    test('Enter on the focused button collapses an expanded row', async () => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await page.click('tr.pay-row button.pay-expand');
        await page.focus('tr.pay-row button.pay-expand');
        await page.keyboard.press('Enter');
        const info = await page.$eval('tr.pay-row button.pay-expand', (btn) => ({
          expanded: btn.getAttribute('aria-expanded'),
          hidden: document.getElementById(btn.getAttribute('aria-controls')).hidden
        }));
        expect(info).toEqual({ expanded: 'false', hidden: true });
      });
    });

    test('lists a skipped row after received rows, and a range as "a to b"', async () => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const rows = await rowTexts(page);
        const pills = rows.map((r) => r.pill);
        const skipped = rows[pills.indexOf('Skipped')];
        expect(skipped.pillClass).toContain('pay-skipped');
        expect(pills.indexOf('Skipped')).toBeGreaterThan(pills.lastIndexOf('Received'));
        // attention first, then late, upcoming, received, skipped
        expect(pills.slice(0, 3)).toEqual(['Missing', 'Wrong amount', 'Late']);
        const power = rows.find((r) => r.cells[1].includes('Electricity'));
        expect(power.cells[4]).toBe('50.00 to 70.00');
      });
    });

    test('the "Needs attention" filter keeps only attention rows and matches the header', async () => {
      await withFixture('payments-many', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        expect(await page.$eval('#payments-summary', (el) => el.textContent)).toBe('50 watched · 15 need attention');
        await page.click('button[data-action="setPaymentStateFilter"][data-arg="attention"]');
        const pills = (await rowTexts(page)).map((r) => r.pill);
        expect(pills).toHaveLength(15);
        expect(new Set(pills)).toEqual(new Set(['Missing', 'Wrong amount', 'Cannot check']));
        expect(await page.$eval('#payments-summary', (el) => el.textContent)).toContain('15 need attention');

        await page.click('button[data-action="setPaymentStateFilter"][data-arg="ok"]');
        const okPills = (await rowTexts(page)).map((r) => r.pill);
        expect(okPills).toHaveLength(35);
        expect(okPills).toContain('Skipped');
      });
    });

    test('a search that matches nothing shows a single "No matching schedules" row', async () => {
      await withFixture('payments-many', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await page.type('#payments-search', 'zzz');
        const body = await page.$$eval('#payments-content table tbody tr', (trs) => trs.map((tr) => tr.textContent));
        expect(body).toEqual(['No matching schedules']);
        // the input kept focus across the re-render
        expect(await page.evaluate(() => document.activeElement.id)).toBe('payments-search');
      });
    });

    test('a stale snapshot shows grey Cannot check pills', async () => {
      await withFixture('payments-stale', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const rows = await rowTexts(page);
        expect(rows).toHaveLength(3);
        for (const r of rows) {
          expect(r.pill).toBe('Cannot check');
          expect(r.pillClass).toContain('pay-cannotCheck');
        }
      });
    });

    test('a failed evaluation keeps the previous rows, with a failure line and the last success as "as of"', async () => {
      await withFixture('payments-eval-failed', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        expect(await rowTexts(page)).toHaveLength(4);
        expect(await page.$eval('.pay-asof', (el) => el.textContent)).toBe('as of 2026-01-14 08:01:00');
        expect(await page.$eval('.pay-failure', (el) => el.textContent))
          .toBe('last evaluation failed at 2026-01-15 08:01:00 (actual_read_failed)');
      });
    });

    test('a failed first run shows no table, only "No successful evaluation yet" and the failure line', async () => {
      await withFixture('payments-first-run-failed', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        expect(await page.$$('#payments-content table')).toHaveLength(0);
        const notes = await page.$$eval('#payments-content .pay-note, #payments-content .pay-failure', (els) => els.map((e) => e.textContent));
        expect(notes).toEqual([
          'No successful evaluation yet',
          'last evaluation failed at 2026-01-15 08:01:00 (actual_read_failed)'
        ]);
        expect(await page.$$('.pay-asof')).toHaveLength(1);
        expect(await page.$eval('.pay-asof', (el) => el.textContent)).toBe('');
      });
    });

    test('a server without alerts shows a README link, no table and no Sync now', async () => {
      await withFixture('payments-not-configured', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const info = await page.$eval('#payments-content', (el) => ({
          text: el.textContent,
          href: el.querySelector('a')?.getAttribute('href'),
          tables: el.querySelectorAll('table').length,
          buttons: el.querySelectorAll('button').length
        }));
        expect(info.text).toContain('Missing-payment alerts are not configured for this server.');
        expect(info.href).toMatch(/#-missing-payment-alerts$/);
        expect(info.tables).toBe(0);
        expect(info.buttons).toBe(0);
      });
    });

    test('a configured server that never ran says "Runs after the next sync" and has one Sync now', async () => {
      await withFixture('payments-no-sync-yet', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const info = await page.$eval('#payments-content', (el) => ({
          text: el.textContent,
          syncButtons: el.querySelectorAll('button[data-action="paymentsSyncNow"]').length
        }));
        expect(info.text).toContain('Runs after the next sync');
        expect(info.syncButtons).toBe(1);
      });
    });

    test('All groups servers: ok, failed and not configured, each with its own lines', async () => {
      await withFixture('payments-multi-server', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        expect(await groupTitles(page)).toEqual(['Main', 'Other', 'Third']);
        const groups = await page.$$eval('#payments-content .pay-group', (secs) => secs.map((sec) => ({
          rows: sec.querySelectorAll('tr.pay-row').length,
          asOf: sec.querySelector('.pay-asof')?.textContent || null,
          failure: sec.querySelector('.pay-failure')?.textContent || null,
          sync: [...sec.querySelectorAll('.pay-group-head button')].map((b) => b.dataset.arg)
        })));
        expect(groups[0]).toEqual({ rows: 3, asOf: 'as of 2026-01-14 08:01:00', failure: null, sync: ['Main'] });
        expect(groups[1].rows).toBe(3);
        expect(groups[1].failure).toBe('last evaluation failed at 2026-01-15 08:01:00 (actual_read_failed)');
        expect(groups[1].asOf).toMatch(/^as of 2026-01-1\d /);
        expect(groups[1].sync).toEqual(['Other']);
        expect(groups[2]).toEqual({ rows: 0, asOf: null, failure: null, sync: [] });
        // totals over the groups shown: 3 + 3 watched
        expect(await page.$eval('#payments-summary', (el) => el.textContent)).toMatch(/^6 watched/);
      });
    });

    test('Sync now in the Other heading syncs only Other', async () => {
      await withFixture('payments-multi-server', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await page.evaluate(() => {
          const sec = [...document.querySelectorAll('.pay-group')].find((s) => s.querySelector('.pay-group-title').textContent === 'Other');
          sec.querySelector('button[data-action="paymentsSyncNow"]').click();
        });
        await until(() => fixture.calls.syncBank.length > 0, 'a syncBank call');
        expect(fixture.calls.syncBank).toEqual(['Other']);
      });
    });

    test('selecting one server shows only that group and queries it URL-encoded', async () => {
      await withFixture('payments-multi-server', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        const urls = [];
        page.on('request', (r) => { if (r.url().includes(PAYMENTS_URL)) urls.push(r.url()); });
        await page.select('#payments-server', 'Main');
        await until(async () => (await groupTitles(page)).length === 1, 'one group');
        expect(await groupTitles(page)).toEqual(['Main']);
        expect(urls[urls.length - 1]).toContain('?server=Main');
        await page.select('#payments-server', '');
        await until(async () => (await groupTitles(page)).length === 3, 'three groups');
      });
    });

    test('names that look like markup are shown literally (XSS) and Sync now posts the exact server name', async () => {
      await withFixture('payments-markup', async ({ page, fixture }) => {
        let dialog = false;
        page.on('dialog', async (d) => { dialog = true; await d.dismiss(); });
        await openPayments(page, fixture);
        const info = await page.$eval('#payments-content', (el) => ({
          title: el.querySelector('.pay-group-title').textContent,
          name: el.querySelector('tr.pay-row').children[1].textContent,
          injected: el.querySelectorAll('img, script, b, i').length,
          syncArg: el.querySelector('button[data-action="paymentsSyncNow"]').getAttribute('data-arg')
        }));
        expect(info.title).toBe('Main <b>bold</b> "q" \'s\'');
        expect(info.name).toContain('<img src=x onerror=alert(1)>');
        expect(info.injected).toBe(0);
        expect(info.syncArg).toBe(info.title);

        await page.click('button[data-action="paymentsSyncNow"]');
        await until(() => fixture.calls.syncBank.length > 0, 'a syncBank call');
        expect(fixture.calls.syncBank).toEqual([info.title]);
        expect(dialog).toBe(false);
        expect(page.__consoleLog.filter((l) => /pageerror|console:error/.test(l))).toEqual([]);
      });
    });

    test('at 375 px rows become cards and Account moves into the expanded view', async () => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        await openPayments(page, fixture, { viewport: { width: 375, height: 800 } });
        const card = await page.$eval('tr.pay-row', (tr) => ({
          display: getComputedStyle(tr).display,
          accountDisplay: getComputedStyle(tr.querySelector('td[data-label="Account"]')).display,
          headDisplay: getComputedStyle(document.querySelector('.pay-table thead')).display
        }));
        expect(card).toEqual({ display: 'block', accountDisplay: 'none', headDisplay: 'none' });
        await page.click('tr.pay-row button.pay-expand');
        const details = await page.$eval('tr.pay-strip-row:not([hidden]) .pay-details', (dl) => ({
          display: getComputedStyle(dl).display,
          text: dl.textContent
        }));
        expect(details.display).toBe('block');
        expect(details.text).toContain('AccountMain');
      });
    });

    test('at desktop width the expanded view does not repeat Account', async () => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        await page.click('tr.pay-row button.pay-expand');
        expect(await page.$eval('tr.pay-strip-row:not([hidden]) .pay-details', (dl) => getComputedStyle(dl).display)).toBe('none');
      });
    });
  });

  describe('refresh and Sync now', () => {
    // The stub is armed by the click: it answers null until syncBank has been
    // called, so the dashboard's own load-time status reads cannot use up the
    // task. After the click it returns a task `busyReads` times, then null.
    const armedRunning = (ctl, busyReads) => {
      let served = 0;
      return () => {
        if (!ctl.fixture || ctl.fixture.calls.syncBank.length === 0) return null;
        if (busyReads === Infinity || served < busyReads) {
          served += 1;
          return { key: 'Main', startedAt: '2026-01-15T12:00:00.000Z' };
        }
        return null;
      };
    };

    const track = (page) => {
      const events = [];
      page.on('request', (r) => {
        const url = r.url();
        if (url.includes('/api/dashboard/status')) events.push('status');
        else if (url.includes(PAYMENTS_URL)) events.push('payments');
        else if (url.includes('/api/dashboard/sync') && r.method() === 'POST') events.push('sync');
      });
      return events;
    };

    test('refreshes after two consecutive null status reads, without waiting for the 60 s poll', async () => {
      const ctl = { fixture: null };
      await withFixture('payments-no-sync-yet', async ({ page, fixture }) => {
        ctl.fixture = fixture;
        await openPayments(page, fixture, { globals: { __paymentsSyncPollMs: 100 } });
        expect(await rowTexts(page)).toHaveLength(0);
        const events = track(page);
        await page.click('button[data-action="paymentsSyncNow"]');
        await until(async () => (await rowTexts(page)).length === 12, 'the seeded rows');
        expect(fixture.calls.syncBank).toEqual(['Main']);
        expect(events.filter((e) => e === 'sync')).toHaveLength(1);
        // busy once, then null twice, then one refresh
        const statusReads = events.filter((e) => e === 'status').length;
        expect(statusReads).toBeGreaterThanOrEqual(3);
        expect(events.filter((e) => e === 'payments')).toHaveLength(1);
      }, { fixtureOverrides: { getRunningSync: armedRunning(ctl, 1) } });
    });

    test('stops after __paymentsSyncMaxPolls reads and refreshes once (no Date.now involved)', async () => {
      const ctl = { fixture: null };
      await withFixture('payments-no-sync-yet', async ({ page, fixture }) => {
        ctl.fixture = fixture;
        await openPayments(page, fixture, { globals: { __paymentsSyncPollMs: 100, __paymentsSyncMaxPolls: 5 } });
        const events = track(page);
        await page.click('button[data-action="paymentsSyncNow"]');
        await until(() => events.includes('payments'), 'the refresh after the cap');
        await new Promise((r) => setTimeout(r, 700));
        expect(events.filter((e) => e === 'status')).toHaveLength(5);
        expect(events.filter((e) => e === 'payments')).toHaveLength(1);
      }, { fixtureOverrides: { getRunningSync: armedRunning(ctl, Infinity) } });
    });

    test('a 429 on the sync POST shows "Could not start sync (HTTP 429)" and starts no status polling', async () => {
      await withFixture('payments-no-sync-yet', async ({ page, fixture }) => {
        await openPayments(page, fixture, { globals: { __paymentsSyncPollMs: 100 } });
        page.overrideRoute('/api/dashboard/sync', (req) => (req.method() === 'POST'
          ? req.respond(jsonError(429, 'Too many requests'))
          : req.continue()));
        const events = track(page);
        await page.click('button[data-action="paymentsSyncNow"]');
        await page.waitForSelector('.pay-sync-error');
        expect(await page.$eval('.pay-sync-error', (el) => [el.textContent, el.getAttribute('role')]))
          .toEqual(['Could not start sync (HTTP 429)', 'alert']);
        await new Promise((r) => setTimeout(r, 500));
        expect(events).not.toContain('status');
        expect(fixture.calls.syncBank).toEqual([]);
      });
    });

    test('an aborted sync POST shows "Could not start sync (network error)", and a later success clears it', async () => {
      await withFixture('payments-no-sync-yet', async ({ page, fixture }) => {
        await openPayments(page, fixture, { globals: { __paymentsSyncPollMs: 100 } });
        const remove = page.overrideRoute('/api/dashboard/sync', (req) => (req.method() === 'POST'
          ? req.abort('failed')
          : req.continue()));
        await page.click('button[data-action="paymentsSyncNow"]');
        await page.waitForSelector('.pay-sync-error');
        expect(await page.$eval('.pay-sync-error', (el) => el.textContent)).toBe('Could not start sync (network error)');
        remove();
        await page.click('button[data-action="paymentsSyncNow"]');
        await until(async () => (await rowTexts(page)).length === 12, 'rows after the retry');
        expect(await page.$('.pay-sync-error')).toBeNull();
      });
    });

    test('failed status reads never count toward the two consecutive null reads', async () => {
      const ctl = { fixture: null };
      await withFixture('payments-no-sync-yet', async ({ page, fixture }) => {
        ctl.fixture = fixture;
        await openPayments(page, fixture, { globals: { __paymentsSyncPollMs: 100 } });
        const events = track(page);
        let failures = 2;
        page.overrideRoute('/api/dashboard/status', (req) => {
          if (ctl.fixture.calls.syncBank.length > 0 && failures > 0) {
            failures -= 1;
            return req.respond(jsonError(500));
          }
          return req.continue();
        });
        await page.click('button[data-action="paymentsSyncNow"]');
        await until(() => events.includes('payments'), 'the refresh');
        // fail, fail, null, null: no refresh before the fourth read
        const beforeRefresh = events.slice(0, events.indexOf('payments')).filter((e) => e === 'status').length;
        expect(beforeRefresh).toBe(4);
      }, { fixtureOverrides: { getRunningSync: () => null } });
    });

    test('the poll does nothing while another tab is active; switching to Payments loads once', async () => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        const urls = [];
        page.on('request', (r) => { if (r.url().includes(PAYMENTS_URL)) urls.push(r.url()); });
        await openPayments(page, fixture, { globals: { __paymentsPollMs: 200 }, openTab: false });
        await new Promise((r) => setTimeout(r, 1000));
        expect(urls).toHaveLength(0);
        await clickTab(page, 'Payments');
        await page.waitForSelector('#payments-content .pay-group');
        expect(urls.length).toBeGreaterThanOrEqual(1);
        // and once active, the interval polls
        const seen = urls.length;
        await until(() => urls.length > seen, 'a poll tick');
      });
    });
  });

  describe('load failures', () => {
    const cases = [
      ['500', (req) => req.respond(jsonError(500)), 'Could not refresh payments (HTTP 500)'],
      ['503', (req) => req.respond(jsonError(503)), 'Could not refresh payments (HTTP 503)'],
      ['429', (req) => req.respond(jsonError(429)), 'Could not refresh payments (HTTP 429)'],
      ['401', (req) => req.respond(jsonError(401)), 'Could not refresh payments (HTTP 401)'],
      ['network error', (req) => req.abort('failed'), 'Could not refresh payments (network error)']
    ];

    test.each(cases)('a refresh failing with %s keeps the rows, shows the error and a good refresh clears it', async (_name, handler, text) => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        await openPayments(page, fixture);
        expect(await rowTexts(page)).toHaveLength(12);

        const remove = page.overrideRoute(PAYMENTS_URL, handler);
        await clickTab(page, 'Overview');
        await clickTab(page, 'Payments');
        await until(async () => (await errorText(page)) === text, `error "${text}"`);
        expect(await page.$eval('#payments-error', (el) => el.getAttribute('role'))).toBe('alert');
        expect(await rowTexts(page)).toHaveLength(12);

        remove();
        await clickTab(page, 'Overview');
        await clickTab(page, 'Payments');
        await until(async () => (await errorText(page)) === '', 'the error to clear');
        expect(await rowTexts(page)).toHaveLength(12);
      });
    });

    test('with no previous data the error shows above an empty table', async () => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        page.overrideRoute(PAYMENTS_URL, (req) => req.respond(jsonError(503)));
        await openPayments(page, fixture, { openTab: false });
        await clickTab(page, 'Payments');
        await until(async () => (await errorText(page)) === 'Could not refresh payments (HTTP 503)', 'the error');
        expect(await page.$$eval('#payments-content table tbody tr', (trs) => trs.length)).toBe(0);
      });
    });
  });

  describe('dates', () => {
    // The harness emulates UTC, where a day-shift bug cannot show, so these
    // run in America/Los_Angeles.
    const nextDueCell = (page) => page.$eval('tr.pay-row', (tr) => tr.querySelector('td[data-label="Next due"]').textContent);

    test.each([
      ['us', '02/05/2026'],
      ['eu-long', '5 February 2026'],
      ['full', 'Thursday, February 5, 2026'],
      ['iso', '2026-02-05'],
      ['relative', '2026-02-05'],
      ['us-short', 'Feb 5, 2026'],
      ['eu', '05/02/2026'],
      ['eu-short', '5 Feb 2026'],
      ['us-long', 'February 5, 2026'],
      ['locale', '2/5/2026'],
      ['not-a-format', '2/5/2026']
    ])('dateFormat %s renders 2026-02-05 as %s west of UTC', async (format, expected) => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        await openPayments(page, fixture, { dateFormat: format, tz: 'America/Los_Angeles' });
        expect(await nextDueCell(page)).toBe(expected);
      });
    });

    test('Last alert and "as of" are instants and follow formatTime (relative by default)', async () => {
      await withFixture('payments-attention', async ({ page, fixture }) => {
        await openPayments(page, fixture, { dateFormat: null });
        const first = (await rowTexts(page))[0];
        expect(first.cells[7]).toBe('3d ago');
        expect(first.cells[5]).toBe('2026-02-05');
        expect(await page.$eval('.pay-asof', (el) => el.textContent)).toBe('as of 1d ago');
      });
    });
  });
});
