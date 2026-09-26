/**
 * Manual sync trigger and error dismissal (#263).
 */
const { launchBrowser, closeBrowser, withDashboard } = require('./fixtures/browser');

describe('dashboard manual sync and dismiss (#263)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  test('triggers a sync for a known server and rejects an unknown one', async () => {
    await withDashboard('healthy', async ({ page, fixture }) => {
      const ok = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server: 'Main Budget' })
        });
        return { status: res.status, body: await res.json() };
      }, `${fixture.url}/api/dashboard/sync`);

      expect(ok.status).toBe(200);
      expect(ok.body.success).toBe(true);
      expect(fixture.calls.syncBank).toContain('Main Budget');

      const unknown = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server: 'No Such Budget' })
        });
        return { status: res.status, body: await res.json() };
      }, `${fixture.url}/api/dashboard/sync`);

      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toMatch(/server not found/i);
    });
  });

  test('dismisses a server error and rejects dismissing an unknown server', async () => {
    await withDashboard('degraded', async ({ page, fixture }) => {
      const before = await page.evaluate(async (url) => (await fetch(url)).json(), `${fixture.url}/api/dashboard/status`);
      expect(before.servers['Personal Budget'].error).toBeTruthy();

      const dismissed = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server: 'Personal Budget' })
        });
        return { status: res.status, body: await res.json() };
      }, `${fixture.url}/api/dashboard/dismiss-error`);
      expect(dismissed.status).toBe(200);
      expect(dismissed.body.success).toBe(true);

      const after = await page.evaluate(async (url) => (await fetch(url)).json(), `${fixture.url}/api/dashboard/status`);
      expect(after.servers['Personal Budget'].error).toBeUndefined();
      expect(after.servers['Personal Budget'].errorDismissed).toBe(true);

      const unknown = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server: 'No Such Budget' })
        });
        return { status: res.status, body: await res.json() };
      }, `${fixture.url}/api/dashboard/dismiss-error`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toMatch(/server not found/i);
    });
  });

  test('the dismiss button in the UI calls the same endpoint', async () => {
    await withDashboard('degraded', async ({ page, fixture }) => {
      const button = await page.$('button[data-server-name="Personal Budget"]');
      expect(button).not.toBeNull();
      await button.click();

      await page.waitForFunction(async (url) => {
        const res = await fetch(url);
        const data = await res.json();
        return data.servers['Personal Budget'].errorDismissed === true;
      }, {}, `${fixture.url}/api/dashboard/status`);
    });
  });
});
