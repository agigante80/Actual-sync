/**
 * Content-Security-Policy in a real browser (#243).
 *
 * Jest can assert the header is sent; only a browser proves the dashboard still
 * WORKS under it. This loads the dashboard with the policy enforced, exercises
 * every tab, the charts, the live log stream (a same-origin WebSocket) and a
 * delegated button click, and fails on any CSP violation, whether surfaced as a
 * securitypolicyviolation event or as a "Refused to ..." console message.
 */
const { launchBrowser, closeBrowser, withFixture, clickTab } = require('./fixtures/browser');

describe('dashboard under its Content-Security-Policy (#243)', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  const refusedMessages = (page) => page.__consoleLog.filter((l) => /Refused to|Content Security Policy/i.test(l));

  test('every tab, the charts, the log stream and the buttons work with no violation', async () => {
    await withFixture('settings', async ({ page, fixture }) => {
      const response = await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });

      // The policy really is on the document being tested.
      const policy = response.headers()['content-security-policy'];
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy.match(/script-src [^;]*/)[0]).not.toContain('unsafe-inline');
      expect(response.headers()['x-frame-options']).toBe('DENY');

      // Charts drew (script from 'self', canvas drawing needs no extra directive).
      await page.waitForFunction(
        // eslint-disable-next-line no-undef -- Chart is the global from /vendor/chart.umd.min.js
        () => typeof Chart !== 'undefined' && Chart.getChart('successRateChart') && Chart.getChart('timelineChart')
      );

      // Live log stream: connect, then receive a line the server broadcasts.
      await page.waitForFunction(() => document.getElementById('logs').textContent.includes('Connected to log stream'));
      fixture.service.broadcastLog('info', 'csp-e2e-marker');
      await page.waitForFunction(() => document.getElementById('logs').textContent.includes('csp-e2e-marker'));

      // Tabs are wired by delegated listeners, not onclick attributes.
      for (const label of ['Analytics', 'History', 'Payments', 'Settings', 'Overview']) {
        await clickTab(page, label);
        const active = await page.$eval('.tab.active', (el) => el.textContent);
        expect(active).toContain(label);
      }

      // A button inside the Settings tab, dispatched through data-action.
      await clickTab(page, 'Settings');
      const posted = page.waitForResponse((r) => r.url().endsWith('/api/dashboard/test-notification') && r.request().method() === 'POST');
      await page.evaluate(() => {
        [...document.querySelectorAll('button[data-action="testNotification"]')]
          .find((b) => b.dataset.arg === 'discord').click();
      });
      // The click reached testNotification('discord') through the delegated listener.
      expect((await posted).request().postData()).toContain('discord');

      expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
      expect(refusedMessages(page)).toEqual([]);
      expect(page.__externalRequests).toEqual([]);
    });
  });

  // withFixture's guard against a spec reaching the network (#289). Both layers
  // are exercised: interception (no CSP on about:blank) and the CSP refusal.
  test('withFixture rejects a spec that fetches an external URL on a page without a CSP', async () => {
    await expect(withFixture('healthy', async ({ page }) => {
      await page.evaluate(() => fetch('https://cdn.example.com/x').catch(() => {}));
    })).rejects.toThrow(/left the fixture server and were blocked[\s\S]*cdn\.example\.com\/x/);
  });

  test('withFixture rejects a dashboard spec that fetches an external URL (CSP path)', async () => {
    await expect(withFixture('healthy', async ({ page, fixture }) => {
      await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => fetch('https://cdn.example.com/x.js').catch(() => {}));
      await page.waitForFunction(() => window.__cspViolations.length > 0);
    })).rejects.toThrow(/CSP violation[\s\S]*cdn\.example\.com/);
  });

  test('withFixture rejects a CSP violation from the spec\'s last step', async () => {
    await expect(withFixture('healthy', async ({ page, fixture }) => {
      await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });
      // No wait: the guard itself must give the report time to arrive.
      await page.evaluate(() => fetch('https://cdn.example.com/x.js').catch(() => {}));
    })).rejects.toThrow(/CSP violation[\s\S]*cdn\.example\.com/);
  });

  test('withFixture rejects a CSP violation that happened before a later navigation', async () => {
    await expect(withFixture('healthy', async ({ page, fixture }) => {
      await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => fetch('https://cdn.example.com/x.js').catch(() => {}));
      await page.waitForFunction(() => window.__cspViolations.length > 0);
      // A new document drops window.__cspViolations; the Node-side list keeps it.
      await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });
    })).rejects.toThrow(/CSP violation[\s\S]*cdn\.example\.com/);
  });

  test('the detector works: an injected inline script is blocked and reported', async () => {
    await withFixture('healthy', async ({ page, fixture }) => {
      await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });

      await page.evaluate(() => {
        window.__injectedRan = false;
        const s = document.createElement('script');
        s.textContent = 'window.__injectedRan = true;';
        document.body.appendChild(s);
      });
      await page.waitForFunction(() => window.__cspViolations.length > 0);

      expect(await page.evaluate(() => window.__injectedRan)).toBe(false);
      expect((await page.evaluate(() => window.__cspViolations))[0]).toContain('script-src');

      // The violation was provoked on purpose; clear it so withFixture's
      // leftover-violation guard (#289) does not fail this test.
      await page.evaluate(() => { window.__cspViolations = []; });
      page.__cspViolations.length = 0;
    });
  });
});
