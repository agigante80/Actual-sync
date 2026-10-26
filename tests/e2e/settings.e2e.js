/**
 * Settings tab: Danger Zone, orphaned server cleanup, notification stats and
 * date format preference controls (#263).
 */
const { launchBrowser, closeBrowser, withDashboard, withFixture, clickTab } = require('./fixtures/browser');

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
  describe('Configuration changes list (#259)', () => {
    const listText = (page) => page.$eval('#config-audit-list', (el) => el.textContent);
    const waitForList = (page) => page.waitForFunction(() => {
      const el = document.getElementById('config-audit-list');
      return el && !el.textContent.includes('Loading');
    });

    test('lists the seeded entries newest first, each with its remote address', async () => {
      await withDashboard('settings-audit', async ({ page }) => {
        await clickTab(page, 'Settings');
        await waitForList(page);

        const entries = await page.$$eval('#config-audit-list .config-audit-entry', (els) => els.map((el) => el.textContent));
        expect(entries).toHaveLength(3);
        // Newest first: 30, 90 then 180 minutes ago.
        expect(entries[0]).toContain('10.0.0.7');
        expect(entries[1]).toContain('192.168.1.21');
        expect(entries[1]).toContain('internet');
        expect(entries[2]).toContain('192.168.1.20');
        expect(entries[2]).toContain('rent');
      });
    });

    test('shows the empty state when nothing was recorded', async () => {
      await withDashboard('settings', async ({ page }) => {
        await clickTab(page, 'Settings');
        await waitForList(page);
        expect(await listText(page)).toContain('No configuration changes yet');
      });
    });

    test('shows the error state with the status, not the empty state, and the rest of Settings still renders', async () => {
      await withFixture('settings-audit', async ({ page, fixture }) => {
        // Set before the page is opened, so the first load already fails.
        fixture.service.syncHistory.getConfigAudit = () => { throw new Error('disk I/O error'); };
        await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });
        await clickTab(page, 'Settings');
        await waitForList(page);

        const text = await listText(page);
        expect(text).toContain('Failed to load configuration changes (HTTP 500)');
        expect(text).not.toContain('No configuration changes yet');
        expect(text).not.toContain('disk I/O error');

        await page.waitForFunction(() => {
          const el = document.getElementById('orphaned-servers-list');
          return el && !el.textContent.includes('Loading');
        });
        expect(await page.$eval('#orphaned-servers-list', (el) => el.textContent)).toContain('Old Budget');
      });
    });

    test('renders a markup-like target as text', async () => {
      await withDashboard('settings-audit', async ({ page }) => {
        await clickTab(page, 'Settings');
        await waitForList(page);

        expect(await listText(page)).toContain('<img src=x onerror="window.__xss=1">');
        expect(await page.$('#config-audit-list img')).toBeNull();
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      });
    });
  });

  describe('writes-enabled state (#259)', () => {
    test('an injected button still works through the Origin guard and capabilities reports writes on', async () => {
      await withFixture('writes-enabled', async ({ page, fixture }) => {
        await page.authenticate({ username: 'fixture-user', password: 'fixture-pass' });
        await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });

        // The per-server sync buttons are rendered through innerHTML after load,
        // so a click proves the delegated document listener still fires.
        await page.waitForSelector('button[data-action="triggerSyncByIndex"]');
        const syncResponse = page.waitForResponse((res) => res.url().endsWith('/api/dashboard/sync') && res.request().method() === 'POST');
        await page.click('button[data-action="triggerSyncByIndex"]');
        const res = await syncResponse;
        expect(res.status()).toBe(200);
        expect(fixture.calls.syncBank).toHaveLength(1);

        const capabilities = await page.evaluate(async () => (await fetch('/api/dashboard/capabilities')).json());
        expect(capabilities).toEqual({ configWrites: true, reason: null, channels: expect.any(Array) });
      });
    });
  });
});
