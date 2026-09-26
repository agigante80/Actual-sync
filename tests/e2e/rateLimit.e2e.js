/**
 * Dashboard rate limiting (#263): the 61st request from one IP inside the
 * 1-minute window gets 429, once rateLimitMax is set to 60.
 *
 * The page first navigates to /icon.png rather than /dashboard: /icon.png is
 * explicitly exempt from the limiter (#113), and /dashboard's own scripts
 * would otherwise burn several requests against the budget before the test's
 * own loop starts, making the exact "61st" assertion depend on the dashboard's
 * init sequence rather than on the limiter itself.
 */
const { launchBrowser, closeBrowser, withFixture } = require('./fixtures/browser');

describe('dashboard rate limiting (#263)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  test('the 61st request in a minute is rejected with 429', async () => {
    await withFixture('healthy', async ({ page, fixture }) => {
      await page.goto(`${fixture.url}/icon.png`, { waitUntil: 'load' });

      const statuses = await page.evaluate(async (url) => {
        const results = [];
        for (let i = 0; i < 61; i++) {
          const res = await fetch(url, { credentials: 'omit' });
          results.push(res.status);
        }
        return results;
      }, `${fixture.url}/api/dashboard/status`);

      expect(statuses.slice(0, 60)).toEqual(new Array(60).fill(200));
      expect(statuses[60]).toBe(429);
    }, { fixtureOverrides: { rateLimitMax: 60 } });
  });
});
