/**
 * Security events: the D7 audit floor (#444).
 */
const { Logger } = require('../lib/logger');

describe('Logger.security (audit floor, #444)', () => {
  let logger;
  let lines;
  let spies;

  beforeEach(() => {
    jest.useFakeTimers();
    lines = [];
    const grab = (...a) => lines.push(JSON.parse(a[0]));
    spies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation(grab));
    logger = new Logger({ level: 'ERROR', format: 'json', logDir: null });
  });

  afterEach(() => {
    logger.close();
    spies.forEach(s => s.mockRestore());
    jest.useRealTimers();
  });

  test('is emitted at level ERROR, with event, category and fields', () => {
    logger.security('authn_login_fail', { remoteAddress: '1.2.3.4' });
    logger.warn('dropped by the level');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'authn_login_fail', category: 'security', remoteAddress: '1.2.3.4'
    });
  });

  test('sourceKey groups rotating addresses into one budget, record keeps the address', () => {
    for (let i = 0; i < 60; i++) {
      logger.security('authn_login_fail', { realm: 'dashboard', remoteAddress: `2001:db8::${i.toString(16)}` },
        { sourceKey: '2001:db8::/56' });
    }
    const fails = lines.filter(l => l.event === 'authn_login_fail');
    expect(fails).toHaveLength(10);
    expect(fails[0].remoteAddress).toBe('2001:db8::0');
  });

  test('the realm is part of the key: a metrics success does not hide a dashboard one', () => {
    logger.security('authn_login_success', { realm: 'metrics', remoteAddress: '1.2.3.4' }, { dedupeMs: 3600000 });
    logger.security('authn_login_success', { realm: 'dashboard', remoteAddress: '1.2.3.4' }, { dedupeMs: 3600000 });
    expect(lines.map(l => l.realm)).toEqual(['metrics', 'dashboard']);
  });

  test('flushSecurity writes a pending suppressed count before the window ends', () => {
    for (let i = 0; i < 15; i++) logger.security('authn_login_fail', { remoteAddress: '9.9.9.9' });
    logger.flushSecurity();
    const sup = lines.find(l => l.event === 'security.suppressed');
    expect(sup).toMatchObject({ suppressedCount: 5, suppressedEvent: 'authn_login_fail' });
  });

  test('a success is an INFO record and also survives level ERROR', () => {
    logger.security('authn_login_success', { remoteAddress: '1.2.3.4' }, { dedupeMs: 3600000 });
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('INFO');
  });

  test('dedupeMs logs a success once per source per window, silently', () => {
    for (let i = 0; i < 5; i++) {
      logger.security('authn_login_success', { remoteAddress: '1.2.3.4' }, { dedupeMs: 1000 });
    }
    logger.security('authn_login_success', { remoteAddress: '5.6.7.8' }, { dedupeMs: 1000 });
    expect(lines).toHaveLength(2);
    jest.advanceTimersByTime(1001);
    logger.security('authn_login_success', { remoteAddress: '1.2.3.4' }, { dedupeMs: 1000 });
    expect(lines).toHaveLength(3);
    expect(lines.some(l => l.event === 'security.suppressed')).toBe(false);
  });

  test('100 failures from one source give bounded records plus one suppressed count', () => {
    for (let i = 0; i < 100; i++) {
      logger.security('authn_login_fail', { remoteAddress: '9.9.9.9' });
    }
    const fails = lines.filter(l => l.event === 'authn_login_fail');
    expect(fails.length).toBeLessThanOrEqual(10);
    expect(lines.some(l => l.event === 'security.suppressed')).toBe(false);
    jest.advanceTimersByTime(60001);
    const sup = lines.filter(l => l.event === 'security.suppressed');
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({
      category: 'security', suppressedCount: 100 - fails.length,
      suppressedEvent: 'authn_login_fail', remoteAddress: '9.9.9.9'
    });
  });

  test('the limit is per source: another address is not suppressed', () => {
    for (let i = 0; i < 50; i++) logger.security('authn_login_fail', { remoteAddress: '9.9.9.9' });
    const before = lines.length;
    logger.security('authn_login_fail', { remoteAddress: '8.8.8.8' });
    expect(lines).toHaveLength(before + 1);
  });

  test('a new window after the trip logs again and flushes the count on rollover', () => {
    for (let i = 0; i < 20; i++) logger.security('authn_login_fail', { remoteAddress: '9.9.9.9' });
    jest.advanceTimersByTime(60001);
    logger.security('authn_login_fail', { remoteAddress: '9.9.9.9' });
    expect(lines.filter(l => l.event === 'security.suppressed')).toHaveLength(1);
    expect(lines.at(-1).event).toBe('authn_login_fail');
  });

  test('close() flushes a pending suppressed count', () => {
    for (let i = 0; i < 12; i++) logger.security('authn_login_fail', { remoteAddress: '9.9.9.9' });
    logger.close();
    expect(lines.filter(l => l.event === 'security.suppressed')[0].suppressedCount).toBe(2);
  });

  test('a child logger shares the limiter with its parent', () => {
    const child = logger.child({ component: 'dashboard' });
    for (let i = 0; i < 6; i++) logger.security('authn_login_fail', { remoteAddress: '9.9.9.9' });
    for (let i = 0; i < 6; i++) child.security('authn_login_fail', { remoteAddress: '9.9.9.9' });
    expect(lines.filter(l => l.event === 'authn_login_fail')).toHaveLength(10);
  });

  test('secrets in fields are still redacted and the message is the static event name', () => {
    logger.security('authn_login_fail', { remoteAddress: '1.2.3.4', password: 'hunter2' });
    expect(JSON.stringify(lines)).not.toContain('hunter2');
  });

  test('tracked sources are bounded', () => {
    for (let i = 0; i < 3000; i++) logger.security('authn_login_fail', { remoteAddress: `10.0.${i >> 8}.${i & 255}` });
    expect(logger.securityState.sources.size).toBeLessThanOrEqual(1000);
  });
});
