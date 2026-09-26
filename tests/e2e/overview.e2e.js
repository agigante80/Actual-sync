/**
 * Overview tab rendering, healthy and degraded (#263).
 */
const { launchBrowser, closeBrowser, withDashboard } = require('./fixtures/browser');

describe('dashboard overview tab (#263)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  test('healthy: status badge is green and every server list item has no error class', async () => {
    await withDashboard('healthy', async ({ page }) => {
      const badge = await page.$eval('#status-badge', (el) => ({
        text: el.textContent.trim(),
        className: el.className
      }));
      expect(badge.text).toBe('HEALTHY');
      expect(badge.className).toContain('status-healthy');

      const items = await page.$$eval('#servers .server-item', (els) => els.map((el) => el.className));
      expect(items).toHaveLength(3);
      expect(items.some((c) => c.includes('error'))).toBe(false);
    });
  });

  test('degraded: status badge is degraded and failing servers show an error with a dismiss button', async () => {
    await withDashboard('degraded', async ({ page }) => {
      const badge = await page.$eval('#status-badge', (el) => ({
        text: el.textContent.trim(),
        className: el.className
      }));
      expect(badge.text).toBe('DEGRADED');
      expect(badge.className).toContain('status-degraded');

      const errorServers = await page.$$eval('#servers .server-item.error', (els) => els.map((el) => el.id));
      expect(errorServers).toEqual(expect.arrayContaining(['server-Personal_Budget', 'server-Business_Budget']));

      const dismissButtons = await page.$$('#servers button[data-server-name]');
      expect(dismissButtons.length).toBeGreaterThan(0);
    });
  });
});
