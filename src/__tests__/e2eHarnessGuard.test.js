/**
 * Runs the e2e specs that pin withFixture's "no external requests, no CSP
 * violations" guard (#289) under the e2e Jest config. The mutation runner only
 * executes src/__tests__, so without this bridge a mutant that drops either
 * guard in tests/e2e/fixtures/browser.js would never be caught.
 *
 * Why it can skip: this file is matched by the unit suite, and the CI `test`
 * job sets PUPPETEER_SKIP_DOWNLOAD=true with no Chrome, so launching the
 * browser there fails and would turn every PR's unit job red. Without Chrome
 * the test skips loudly; the e2e job (which has Chrome) runs the same specs
 * directly. Do not remove the skip. A skipped run is scored "survived" (not
 * caught) by scripts/mutationTest.js, so a mutation run without Chrome cannot
 * silently pass.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function chromeAvailable() {
  const res = spawnSync(
    process.execPath,
    ['-e', "import('puppeteer').then(p => p.default.executablePath()).then(console.log)"],
    { cwd: ROOT, encoding: 'utf8', env: process.env }
  );
  const exe = (res.stdout || '').trim().split('\n').pop();
  return res.status === 0 && !!exe && fs.existsSync(exe);
}

const hasChrome = chromeAvailable();
if (!hasChrome) {
  console.warn('e2eHarnessGuard: Chrome for Puppeteer not found; SKIPPING the withFixture '
    + 'guard bridge. It needs Chrome. The e2e job runs these specs (tests/e2e/csp.e2e.js).');
}
const run = hasChrome ? it : it.skip;

describe('e2e harness guard (#289)', () => {
  run('withFixture rejects specs that reach the network, with and without a CSP', () => {
    const res = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', path.join(ROOT, 'node_modules', '.bin', 'jest'),
        '--config', 'jest.e2e.config.js', '--runInBand', '--forceExit',
        'tests/e2e/csp.e2e.js', '-t', 'withFixture rejects'],
      { cwd: ROOT, encoding: 'utf8', timeout: 110000 }
    );
    expect(res.stderr + res.stdout).toMatch(/3 passed/);
    expect(res.status).toBe(0);
  }, 120000);
});
