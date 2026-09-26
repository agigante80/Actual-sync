#!/usr/bin/env node

/**
 * Dashboard Screenshot Generator (#263)
 *
 * Generates the documentation screenshots listed in tests/e2e/screenshots.json,
 * using the same fixture harness as the e2e specs: a real HealthCheckService
 * plus a real SyncHistoryService on a temp SQLite file, seeded deterministically
 * and viewed through a frozen clock. There is no running service to start, no
 * fetch or WebSocket mocking, and no dependency on wall-clock time, so the
 * output is the same on every machine and every run.
 *
 * Usage:
 *   npm run screenshots
 */

const fs = require('fs');
const path = require('path');
const { launchBrowser, closeBrowser, openPage, clickTab, scrollToCardWithText } = require('../tests/e2e/fixtures/browser');
const { startFixtureServer } = require('../tests/e2e/fixtures/index');

const SCREENSHOTS_DIR = path.join(__dirname, '../docs/screenshots');
const MANIFEST_PATH = path.join(__dirname, '../tests/e2e/screenshots.json');

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw);
}

const TAB_LABELS = {
  overview: 'Overview',
  analytics: 'Analytics',
  history: 'History',
  settings: 'Settings'
};

/**
 * Render one manifest entry to a PNG under docs/screenshots/.
 * @param {import('puppeteer').Browser} browser
 * @param {{ file: string, state: string, tab?: string, scrollToText?: string,
 *   fullPage?: boolean, description?: string }} entry
 */
async function renderScreenshot(browser, entry) {
  console.log(`Capturing: ${entry.file} (${entry.description || entry.state})`);

  // page.screenshot({ fullPage: true }) resizes the viewport to the full
  // content height and captures all of it, so a scroll position taken
  // beforehand has no visible effect at all: two manifest entries that only
  // differed by scrollToText produced byte-identical PNGs before this check
  // was added. scrollToText only means something when fullPage is off. (#263)
  if (entry.scrollToText && entry.fullPage !== false) {
    throw new Error(`${entry.file}: scrollToText requires "fullPage": false, otherwise the scroll has no effect`);
  }

  const fixture = await startFixtureServer(entry.state);
  const page = await openPage(browser, { baseUrl: fixture.url, now: fixture.now });

  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(`${fixture.url}/dashboard`, { waitUntil: 'networkidle0' });

    if (entry.tab && entry.tab !== 'overview') {
      const label = TAB_LABELS[entry.tab];
      if (!label) throw new Error(`Unknown tab "${entry.tab}" for ${entry.file}`);
      await clickTab(page, label);
      // Tab-specific fetches (history, analytics, settings) run after the
      // click; give them a moment to land before scrolling or capturing.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    if (entry.scrollToText) {
      await scrollToCardWithText(page, entry.scrollToText);
    } else {
      await page.evaluate(() => window.scrollTo(0, 0));
    }

    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, entry.file),
      fullPage: entry.fullPage !== false,
      type: 'png'
    });

    console.log(`  saved ${entry.file}`);
  } finally {
    await page.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
}

async function main() {
  console.log('Dashboard screenshot generator (#263)');
  console.log('======================================\n');

  const manifest = loadManifest();
  const browser = await launchBrowser();

  try {
    for (const entry of manifest) {
      await renderScreenshot(browser, entry);
    }
    console.log(`\nGenerated ${manifest.length} screenshots in ${SCREENSHOTS_DIR}`);
  } finally {
    await closeBrowser();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { main, renderScreenshot };
