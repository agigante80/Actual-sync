/**
 * Puppeteer harness for the dashboard e2e specs (#263).
 *
 * openPage() configures a page the way every spec needs it: a fixed viewport,
 * UTC timezone, reduced motion (charts animate otherwise, so a screenshot or a
 * "chart is drawn" check can race the animation), en-US locale, and a frozen
 * clock so "5m ago" labels never depend on wall-clock time.
 *
 * The clock is real @sinonjs/fake-timers running INSIDE the page, installed
 * through evaluateOnNewDocument before any dashboard script runs. fake-timers
 * is written for Node and CommonJS: its one external dependency is
 * '@sinonjs/commons' (only used for `.global`), and it conditionally
 * `require()`s a couple of Node builtins it does not need in a browser. A tiny
 * `require` shim satisfies the former and lets the latter's own try/catch
 * absorb the rest, so the unmodified source runs as-is in the page.
 *
 * Network is locked down: the Chart.js CDN URL the dashboard hardcodes is
 * intercepted and served from the local dependency (pinned to the same
 * version), and every other cross-origin request is aborted and recorded, so
 * a spec that accidentally reaches the network fails loudly instead of being
 * silently slow or flaky.
 */

const fs = require('fs');
const path = require('path');
const { startFixtureServer, FIXTURE_NOW } = require('./index');

// puppeteer@25 ships ESM only; the rest of this suite (and Jest itself, here)
// is CommonJS, so it is loaded with a dynamic import rather than require(). (#263)
let puppeteerPromise;
function loadPuppeteer() {
  if (!puppeteerPromise) puppeteerPromise = import('puppeteer').then((m) => m.default || m);
  return puppeteerPromise;
}

const ARTIFACTS_DIR = path.join(__dirname, '..', 'artifacts');

// The exact CDN URL src/services/dashboard.html hardcodes for chart.js@4.4.0.
// That version ships dist/chart.umd.js only (no .min.js), so the request is
// served with the unminified bundle. (#263)
const CHART_JS_CDN_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
const CHART_JS_PATH = path.join(
  path.dirname(path.dirname(require.resolve('chart.js'))),
  'dist',
  'chart.umd.js'
);
const CHART_JS_SOURCE = fs.readFileSync(CHART_JS_PATH, 'utf8');

const FAKE_TIMERS_SOURCE = fs.readFileSync(
  require.resolve('@sinonjs/fake-timers/src/fake-timers-src.js'),
  'utf8'
);

/**
 * Build the evaluateOnNewDocument script that installs a frozen fake-timers
 * clock before the page's own scripts run.
 * @param {number} now - epoch ms the clock starts (and stays) at
 */
function fakeTimersInjectionScript(now) {
  return `(() => {
    const module = { exports: {} };
    const exports = module.exports;
    const require = (name) => {
      if (name === '@sinonjs/commons') return { global: globalThis };
      throw new Error('fake-timers browser shim: unsupported require("' + name + '")');
    };
    ${FAKE_TIMERS_SOURCE}
    window.__fixtureClock = module.exports.install({ now: ${now}, toFake: ['Date'] });
  })();`;
}

let sharedBrowser = null;

async function launchBrowser() {
  if (!sharedBrowser) {
    const puppeteer = await loadPuppeteer();
    sharedBrowser = await puppeteer.launch({
      headless: true,
      args: ['--lang=en-US', '--no-sandbox', '--disable-setuid-sandbox']
    });
  }
  return sharedBrowser;
}

async function closeBrowser() {
  if (sharedBrowser) {
    const browser = sharedBrowser;
    sharedBrowser = null;
    await browser.close();
  }
}

/**
 * Open a page configured for deterministic, network-locked e2e runs.
 * @param {import('puppeteer').Browser} browser
 * @param {{ baseUrl?: string, now?: number }} [options] - `baseUrl` is the
 *   fixture server origin; any request outside it (other than the pinned
 *   Chart.js CDN URL) is aborted and recorded on `page.__externalRequests`.
 */
async function openPage(browser, { baseUrl, now = FIXTURE_NOW } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.emulateTimezone('UTC');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  const consoleLog = [];
  page.on('console', (msg) => consoleLog.push(`[console:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => consoleLog.push(`[pageerror] ${err && err.stack ? err.stack : err}`));

  await page.evaluateOnNewDocument(fakeTimersInjectionScript(now));

  const externalRequests = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();

    if (url === CHART_JS_CDN_URL) {
      req.respond({ status: 200, contentType: 'application/javascript', body: CHART_JS_SOURCE });
      return;
    }

    // Chrome requests /favicon.ico for the tab on every top-level navigation,
    // regardless of what the navigated URL actually serves. Left alone, this
    // is a same-origin request the fixture server would answer (and count),
    // silently consuming one slot of a spec's rate-limit budget or an extra
    // row in its server log before the spec's own requests even start. It is
    // answered locally instead of touching the fixture server at all. (#263)
    if (/\/favicon\.ico(\?.*)?$/.test(url)) {
      req.respond({ status: 204, body: '' });
      return;
    }

    if (baseUrl && url.startsWith(baseUrl)) {
      req.continue();
      return;
    }

    // A spec should only ever talk to its own fixture server and the pinned
    // Chart.js file above. Anything else (a real CDN, a typo'd URL, a route
    // that changed) is aborted and recorded so the spec fails instead of
    // hanging or quietly depending on the network. (#263)
    externalRequests.push(url);
    req.abort('failed').catch(() => {});
  });

  page.__consoleLog = consoleLog;
  page.__externalRequests = externalRequests;
  return page;
}

function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 120);
}

/**
 * Switch the dashboard to a tab by its visible label (e.g. "History"). The
 * dashboard's switchTab() reads the global `event` its onclick attribute
 * provides, so the button is clicked through the DOM rather than calling
 * switchTab() directly from page.evaluate, which would leave `event` unset.
 * (#263)
 * @param {import('puppeteer').Page} page
 * @param {string} label - text the tab button contains, e.g. "History"
 */
async function clickTab(page, label) {
  const clicked = await page.evaluate((text) => {
    const btn = [...document.querySelectorAll('.tabs .tab')].find((b) => b.textContent.includes(text));
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`clickTab: no tab button contains "${label}"`);
}

/**
 * Scroll the .card whose text contains `text` into view, for screenshots that
 * frame one card rather than the whole page. (#263)
 * @param {import('puppeteer').Page} page
 * @param {string} text
 */
async function scrollToCardWithText(page, text) {
  const found = await page.evaluate((needle) => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes(needle));
    if (!card) return false;
    card.scrollIntoView({ block: 'center' });
    return true;
  }, text);
  if (!found) throw new Error(`scrollToCardWithText: no .card contains "${text}"`);
}

/**
 * Best-effort failure artifacts: a full-page screenshot, the browser console
 * log and the fixture server's captured log, written to
 * tests/e2e/artifacts/ (gitignored). Never throws, so a problem while saving
 * artifacts never masks the real test failure. (#263)
 */
async function saveFailureArtifacts({ page, fixture, testName }) {
  try {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const base = path.join(ARTIFACTS_DIR, `${sanitizeName(testName)}-${Date.now()}`);

    if (page && !page.isClosed()) {
      await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    }

    const lines = [];
    if (page && page.__consoleLog && page.__consoleLog.length) {
      lines.push('=== browser console ===', ...page.__consoleLog, '');
    }
    if (page && page.__externalRequests && page.__externalRequests.length) {
      lines.push('=== blocked external requests ===', ...page.__externalRequests, '');
    }
    if (fixture && fixture.serverLog && fixture.serverLog.length) {
      lines.push('=== fixture server log ===');
      for (const entry of fixture.serverLog) {
        lines.push(`[${entry.level}] ${entry.message}${entry.meta ? ' ' + JSON.stringify(entry.meta) : ''}`);
      }
    }
    fs.writeFileSync(`${base}.log`, lines.join('\n'));
  } catch {
    // Artifacts are a debugging convenience, not part of the test contract.
  }
}

/**
 * Run one e2e check against a fixture state: start the fixture server, open a
 * configured page, run `fn({ page, fixture })`, and always tear both down. On
 * failure, artifacts are written before the error is rethrown so Jest still
 * reports the original failure. Does NOT navigate anywhere; use this directly
 * for specs that need to control navigation themselves (e.g. an auth spec
 * that must issue an unauthenticated request first). (#263)
 * @param {string} stateName - a module in ./states
 * @param {(ctx: { page: import('puppeteer').Page, fixture: Object }) => Promise<any>} fn
 * @param {{ fixtureOverrides?: Object, testName?: string }} [options]
 */
async function withFixture(stateName, fn, options = {}) {
  const { fixtureOverrides, testName } = options;
  const fixture = await startFixtureServer(stateName, fixtureOverrides);
  const browser = await launchBrowser();
  const page = await openPage(browser, { baseUrl: fixture.url, now: fixture.now });
  const name = testName
    || (typeof expect !== 'undefined' && expect.getState().currentTestName)
    || stateName;

  try {
    return await fn({ page, fixture });
  } catch (err) {
    await saveFailureArtifacts({ page, fixture, testName: name });
    throw err;
  } finally {
    await page.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
}

/**
 * Like withFixture, but navigates to `routePath` (default /dashboard) and
 * waits for the network to go idle before running `fn`. This is what most
 * specs want. (#263)
 * @param {string} stateName
 * @param {(ctx: { page: import('puppeteer').Page, fixture: Object }) => Promise<any>} fn
 * @param {{ path?: string, fixtureOverrides?: Object, testName?: string }} [options]
 */
async function withDashboard(stateName, fn, options = {}) {
  const { path: routePath = '/dashboard', ...rest } = options;
  return withFixture(stateName, async (ctx) => {
    await ctx.page.goto(ctx.fixture.url + routePath, { waitUntil: 'networkidle0' });
    return fn(ctx);
  }, rest);
}

module.exports = {
  launchBrowser,
  closeBrowser,
  openPage,
  withFixture,
  withDashboard,
  clickTab,
  scrollToCardWithText
};
