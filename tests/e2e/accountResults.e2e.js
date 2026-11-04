/**
 * Per-account results of a sync (#430): the History row expander and the
 * last result on each Accounts card row. Account names are untrusted and
 * must render as text.
 */
const { launchBrowser, closeBrowser, withDashboard, clickTab } = require('./fixtures/browser');

describe('dashboard per-account sync results (#430)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  test('a History row expands to one line per account, markup shown as text', async () => {
    await withDashboard('account-results', async ({ page, fixture }) => {
      await clickTab(page, 'History');
      await page.waitForSelector('#history-body .hist-toggle');

      // Newest first: row 0 is the sync with account rows.
      await page.click('#history-body tr:nth-child(1) .hist-toggle');
      await page.waitForSelector('#history-body .hist-detail .hist-accounts li');
      const lines = await page.$$eval('#history-body .hist-detail li', (els) => els.map((e) => e.textContent));
      expect(lines).toEqual([
        'Everyday Checking: 5 new, 2 updated',
        'Rewards Card: no new',
        'Joint Account: 15 new',
        'Holiday Fund: count unknown',
        'Cash Wallet: skipped',
        `${fixture.state.markupName}: failed`
      ]);
      expect(await page.$('#injected')).toBeNull();

      // Collapses again.
      await page.click('#history-body tr:nth-child(1) .hist-toggle');
      expect(await page.$('#history-body .hist-detail')).toBeNull();
    });
  });

  test('a sync recorded before per-account rows says the breakdown is not available', async () => {
    await withDashboard('account-results', async ({ page }) => {
      await clickTab(page, 'History');
      await page.waitForSelector('#history-body .hist-toggle');
      const rows = await page.$$('#history-body > tr');
      expect(rows).toHaveLength(2);
      await page.click('#history-body tr:nth-child(2) .hist-toggle');
      await page.waitForSelector('#history-body .hist-detail');
      const text = await page.$eval('#history-body .hist-detail', (el) => el.textContent);
      expect(text).toContain('not available');
      expect(text).not.toContain('no new');
    });
  });

  test('the Accounts card shows each account\'s last sync result', async () => {
    await withDashboard('account-results', async ({ page, fixture }) => {
      await page.waitForSelector('#accounts-list .acct-result');
      const results = await page.$$eval('#accounts-list .acct-row', (rows) => rows.map((r) => ({
        name: r.querySelector('.acct-name').textContent,
        result: r.querySelector('.acct-result')?.textContent || ''
      })));
      const by = Object.fromEntries(results.map((r) => [r.name, r.result]));
      expect(by['Everyday Checking']).toMatch(/^last sync: 5 new, 2 updated, /);
      expect(by['Joint Account']).toMatch(/^last sync: 15 new, /);
      expect(by['Rewards Card']).toMatch(/^last sync: no new, /);
      expect(by['Cash Wallet']).toMatch(/^last sync: skipped, /);
      expect(by[fixture.state.markupName]).toMatch(/^last sync: failed, /);
      expect(await page.$('#injected')).toBeNull();
    });
  });
});
