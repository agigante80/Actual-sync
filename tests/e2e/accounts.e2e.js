/**
 * Accounts card: syncable/manual accounts always shown, closed accounts
 * hidden by default and revealed by the checkbox (#263).
 */
const { launchBrowser, closeBrowser, withDashboard } = require('./fixtures/browser');

describe('dashboard accounts card (#263)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  test('closed accounts are hidden until the checkbox is toggled', async () => {
    await withDashboard('accounts', async ({ page, fixture }) => {
      await page.waitForSelector('#accounts-list .acct-server');

      const before = await page.$$eval('#accounts-list .acct-row', (els) => els.length);
      expect(before).toBe(fixture.state.openCount);

      const hint = await page.$eval('#accounts-list', (el) => el.textContent);
      expect(hint).toContain('closed hidden');

      await page.click('#show-closed-accounts');
      await page.waitForFunction(
        (expected) => document.querySelectorAll('#accounts-list .acct-row').length === expected,
        {},
        fixture.state.openCount + fixture.state.closedCount
      );

      const closedRows = await page.$$eval('#accounts-list .acct-row.closed', (els) => els.length);
      expect(closedRows).toBe(fixture.state.closedCount);
    });
  });
});
