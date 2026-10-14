/**
 * Runs the e2e specs that pin withFixture's "no external requests, no CSP
 * violations" guard (#289) under the e2e Jest config. The mutation runner only
 * executes src/__tests__, so without this bridge a mutant that drops either
 * guard in tests/e2e/fixtures/browser.js would never be caught.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

describe('e2e harness guard (#289)', () => {
  it('withFixture rejects specs that reach the network, with and without a CSP', () => {
    const res = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', path.join(ROOT, 'node_modules', '.bin', 'jest'),
        '--config', 'jest.e2e.config.js', '--runInBand', '--forceExit',
        'tests/e2e/csp.e2e.js', '-t', 'withFixture rejects'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(res.stderr + res.stdout).toMatch(/2 passed/);
    expect(res.status).toBe(0);
  }, 120000);
});
