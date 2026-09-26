/**
 * History tab rendering (#263).
 *
 * The dashboard's history-tab filter select sends `serverName` to
 * /api/dashboard/history, but the route ignores that query parameter and
 * always returns the unfiltered set (pre-existing bug, not fixed here). This
 * spec therefore checks the table against the fixture's known total row count
 * and failure count rather than any server-scoped filtering.
 */
const { launchBrowser, closeBrowser, withDashboard, clickTab } = require('./fixtures/browser');

describe('dashboard history tab (#263)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  test('lists every seeded row with the right number of failures', async () => {
    await withDashboard('history-errors', async ({ page, fixture }) => {
      await clickTab(page, 'History');
      await page.waitForSelector('#history-body tr td:nth-child(2)');

      const rows = await page.$$eval('#history-body tr', (trs) => trs.map((tr) => ({
        status: tr.querySelector('.status-icon')?.className || '',
        server: tr.children[1]?.textContent || ''
      })));

      expect(rows).toHaveLength(fixture.state.totalRows);
      const failures = rows.filter((r) => r.status.includes('failure'));
      expect(failures).toHaveLength(fixture.state.failureCount);
    });
  });
});
