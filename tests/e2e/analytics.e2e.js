/**
 * Analytics tab charts (#263). The dashboard creates its three Chart.js
 * charts on initial load regardless of which tab is active, so this checks
 * Chart.getChart() on each canvas rather than requiring a tab switch first.
 */
const { launchBrowser, closeBrowser, withDashboard, clickTab } = require('./fixtures/browser');

describe('dashboard analytics tab (#263)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  test('all three charts render with data', async () => {
    await withDashboard('analytics-degraded', async ({ page }) => {
      await page.waitForFunction(() => {
        // eslint-disable-next-line no-undef -- Chart is a global served by the app from its npm dependency (#244)
        return typeof Chart !== 'undefined'
          && Chart.getChart('successRateChart')
          && Chart.getChart('durationChart')
          && Chart.getChart('timelineChart');
      });

      const charts = await page.evaluate(() => {
        // eslint-disable-next-line no-undef -- see above
        const c = (id) => Chart.getChart(id);
        return {
          successRateLabels: c('successRateChart').data.labels.length,
          durationDatasets: c('durationChart').data.datasets.length,
          timelinePoints: c('timelineChart').data.datasets[0].data.length
        };
      });

      expect(charts.successRateLabels).toBeGreaterThan(0);
      expect(charts.durationDatasets).toBeGreaterThan(0);
      expect(charts.timelinePoints).toBeGreaterThan(0);
    });
  });

  test('the dashboard makes no external request while rendering charts (#244)', async () => {
    await withDashboard('analytics-degraded', async ({ page }) => {
      await page.waitForFunction(
        // eslint-disable-next-line no-undef -- see above
        () => typeof Chart !== 'undefined' && Chart.getChart('successRateChart')
      );
      // The harness aborts and records every request outside the fixture
      // server, so an empty list proves nothing was fetched from a CDN.
      expect(page.__externalRequests).toEqual([]);
    });
  });

  test('the total syncs metric matches the seeded history', async () => {
    await withDashboard('analytics-degraded', async ({ page }) => {
      // loadAnalyticsTab() (unlike the charts) only runs when the Analytics
      // tab is actually opened, not on initial page load. (#263)
      await clickTab(page, 'Analytics');
      await page.waitForFunction(
        () => document.getElementById('analytics-total-syncs').textContent.trim() !== '0'
      );
      const total = await page.$eval('#analytics-total-syncs', (el) => el.textContent.trim());
      // analytics-degraded seeds exactly 48 history rows (seedRun count: 48),
      // all inside the analytics window. (#289)
      expect(Number(total)).toBe(48);
    });
  });
});
