/**
 * History tab rendering (#263).
 *
 * Checks the table against the fixture's known total row count and failure
 * count, then that the server filter narrows it to one server's rows (#288).
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

  test('the server filter shows only that server\'s rows (#288)', async () => {
    await withDashboard('history-errors', async ({ page, fixture }) => {
      await clickTab(page, 'History');
      await page.waitForSelector('#history-body tr td:nth-child(2)');

      const name = fixture.state.servers[0].name;
      const expected = fixture.state.rowsFor(name);
      expect(expected).toBeLessThan(fixture.state.totalRows);
      await page.waitForSelector(`#history-server-filter option[value="${name}"]`);
      await page.select('#history-server-filter', name);
      await page.waitForFunction(
        (n) => document.querySelectorAll('#history-body tr').length === n,
        {}, expected
      );

      const servers = await page.$$eval('#history-body tr', (trs) => trs.map((tr) => tr.children[1]?.textContent || ''));
      expect(servers).toHaveLength(expected);
      expect(servers.every((s) => s.includes(name))).toBe(true);
    });
  });
});
