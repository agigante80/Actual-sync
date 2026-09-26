/**
 * Dashboard basic auth (#263).
 *
 * A top-level page.goto() to a Basic-Auth-protected URL without
 * page.authenticate() first fails the navigation outright
 * (net::ERR_INVALID_AUTH_CREDENTIALS) because headless Chrome has no dialog to
 * answer the challenge with. Requests made with fetch() do not hit that
 * dialog path, so missing/wrong credentials are checked with an in-page
 * fetch(credentials: 'omit') instead of a raw navigation.
 *
 * Only two wrong attempts are made here, well under the 10-failures-per-15-min
 * dashboard login throttle (#246), so this spec never trips it.
 *
 * A page that has never navigated anywhere is still on about:blank, whose
 * origin cannot fetch() a different origin at all (no CORS headers make that
 * allowed), regardless of credentials. /icon.png needs no auth, so the page
 * navigates there first purely to get itself onto the fixture server's
 * origin before the same-origin fetch() calls below.
 */
const { launchBrowser, closeBrowser, withFixture } = require('./fixtures/browser');

describe('dashboard basic auth (#263)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  test('rejects no credentials and wrong credentials, accepts the right ones', async () => {
    await withFixture('auth-basic', async ({ page, fixture }) => {
      await page.goto(`${fixture.url}/icon.png`, { waitUntil: 'load' });

      const noCreds = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'omit' });
        return { status: res.status, body: await res.json() };
      }, `${fixture.url}/api/dashboard/status`);
      expect(noCreds.status).toBe(401);
      expect(noCreds.body.error).toMatch(/authentication/i);

      const wrongCreds = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          credentials: 'omit',
          headers: { Authorization: `Basic ${btoa('fixture-user:wrong-pass')}` }
        });
        return { status: res.status, body: await res.json() };
      }, `${fixture.url}/api/dashboard/status`);
      expect(wrongCreds.status).toBe(401);
      expect(wrongCreds.body.error).toMatch(/invalid credentials/i);

      await page.authenticate({ username: 'fixture-user', password: 'fixture-pass' });
      const response = await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });
      expect(response.status()).toBe(200);

      const statusBadge = await page.$eval('#status-badge', (el) => el.textContent.trim());
      expect(statusBadge).toBe('HEALTHY');
    });
  });
});
