/**
 * Jest project for the browser e2e specs (#263).
 *
 * Kept separate from the unit-test config in package.json rather than folded
 * into it: e2e specs launch a real browser and a real HTTP+SQLite fixture
 * server per test, so they are far slower than the unit suite and must never
 * affect its runtime or its coverage thresholds. `npm test` never matches
 * `*.e2e.js`, and this config never collects coverage, so neither run touches
 * the other's numbers.
 *
 * Run this through `npm run test:e2e`, not a bare `npx jest --config
 * jest.e2e.config.js`: puppeteer@25 ships ESM only, tests/e2e/fixtures/browser.js
 * loads it with a dynamic import(), and Jest's CommonJS VM refuses dynamic
 * import() unless Node is started with --experimental-vm-modules. The npm
 * script sets that flag; a bare jest invocation will fail with "A dynamic
 * import callback was invoked without --experimental-vm-modules".
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  testMatch: ['<rootDir>/tests/e2e/**/*.e2e.js'],
  // Puppeteer launches a real browser and each spec starts a fixture server;
  // slower and noisier than the unit suite's default.
  testTimeout: 30000,
  collectCoverage: false
};
