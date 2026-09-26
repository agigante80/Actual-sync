/**
 * Settings tab: Danger Zone, orphaned server cleanup, notification stats and
 * date format preference controls (#263).
 */
const { launchBrowser, closeBrowser, withDashboard, clickTab } = require('./fixtures/browser');

describe('dashboard settings tab (#263)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  test('shows the Danger Zone, the orphaned server and notification activity', async () => {
    await withDashboard('settings', async ({ page }) => {
      await clickTab(page, 'Settings');

      const headings = await page.$$eval('#settings-tab h3', (els) => els.map((el) => el.textContent));
      expect(headings.some((h) => h.includes('Danger Zone'))).toBe(true);

      await page.waitForFunction(() => {
        const el = document.getElementById('orphaned-servers-list');
        return el && !el.textContent.includes('Loading');
      });
      const orphanedText = await page.$eval('#orphaned-servers-list', (el) => el.textContent);
      expect(orphanedText).toContain('Old Budget');

      await page.waitForFunction(() => {
        const el = document.getElementById('notification-stats');
        return el && !el.textContent.includes('Loading');
      });
      const statsText = await page.$eval('#notification-stats', (el) => el.textContent);
      expect(statsText).toMatch(/failure alerts/);
      expect(statsText).toContain('Family Budget');
    });
  });

  test('changing the date format enables Save and Reset only while it differs from the saved value', async () => {
    await withDashboard('settings', async ({ page }) => {
      await clickTab(page, 'Settings');

      const initiallyDisabled = await page.$eval('#save-date-format-btn', (el) => el.disabled);
      expect(initiallyDisabled).toBe(true);

      await page.select('#date-format-select', 'iso');
      // change events on <select> already fire on page.select(); no manual dispatch needed.
      const afterChange = await page.$eval('#save-date-format-btn', (el) => el.disabled);
      expect(afterChange).toBe(false);

      const resetVisible = await page.$eval('#reset-date-format-btn', (el) => el.style.display !== 'none');
      expect(resetVisible).toBe(true);

      await page.select('#date-format-select', 'relative');
      const afterRevert = await page.$eval('#save-date-format-btn', (el) => el.disabled);
      expect(afterRevert).toBe(true);
    });
  });
});
