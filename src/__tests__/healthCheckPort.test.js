/**
 * HealthCheckService port and rate-limit seams (#263).
 *
 * These options exist purely so the e2e fixture harness can run many
 * HealthCheckService instances side by side without a fixed port collision,
 * and can drive more requests than the production rate limit allows. They
 * are deliberately not part of config/config.schema.json: they are a test
 * seam, not a user-facing setting, and both defaults must still match
 * production behavior when the options are left unset.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { HealthCheckService } = require('../services/healthCheck');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

describe('HealthCheckService port and rate limit seams (#263)', () => {
  let service;

  afterEach(async () => {
    if (service) {
      try { await service.stop(); } catch { /* already stopped / never started */ }
      service = null;
    }
  });

  test('port 0 asks the OS for a free port, resolved once listening', async () => {
    service = new HealthCheckService({ port: 0, host: '127.0.0.1', loggerConfig: { level: 'ERROR' } });
    expect(service.port).toBe(0);

    await service.start();

    const assigned = service.server.address().port;
    expect(assigned).toBeGreaterThan(0);
  });

  test('defaults to port 3000 when no port option is given', () => {
    service = new HealthCheckService({ loggerConfig: { level: 'ERROR' } });
    expect(service.port).toBe(3000);
  });

  test('defaults rateLimitMax to 60 when no option is given', () => {
    service = new HealthCheckService({ loggerConfig: { level: 'ERROR' } });
    expect(service.rateLimitMax).toBe(60);
  });

  test('accepts a custom rateLimitMax for e2e fixtures', () => {
    service = new HealthCheckService({ rateLimitMax: 500, loggerConfig: { level: 'ERROR' } });
    expect(service.rateLimitMax).toBe(500);
  });

  test('rateLimitMax has no corresponding user-facing config schema key', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'config.schema.json'), 'utf8'));
    expect(JSON.stringify(schema)).not.toContain('rateLimitMax');
  });

  test('rateLimitMax actually changes the enforced limit, not only the stored property', async () => {
    service = new HealthCheckService({ port: 0, host: '127.0.0.1', rateLimitMax: 3, loggerConfig: { level: 'ERROR' } });
    await service.start();
    const port = service.server.address().port;

    const codes = [];
    for (let i = 0; i < 4; i++) codes.push(await get(port, '/health'));
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  test('uses the injected now() for status.startTime instead of the real clock', () => {
    const fixedNow = () => new Date('2026-01-15T12:00:00.000Z');
    service = new HealthCheckService({ now: fixedNow, loggerConfig: { level: 'ERROR' } });
    expect(service.status.startTime).toBe('2026-01-15T12:00:00.000Z');
  });

  test('defaults now() to the real clock when no option is given', () => {
    const before = Date.now();
    service = new HealthCheckService({ loggerConfig: { level: 'ERROR' } });
    const startTime = new Date(service.status.startTime).getTime();
    expect(startTime).toBeGreaterThanOrEqual(before);
    expect(startTime).toBeLessThanOrEqual(Date.now());
  });
});
