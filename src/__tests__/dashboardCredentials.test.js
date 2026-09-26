const crypto = require('node:crypto');
const { checkCredentials, WsTicketStore } = require('../lib/dashboardCredentials');

const basicHeader = (user, pass) => ({
  authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
});

describe('checkCredentials (#242, #246)', () => {
  const basic = { type: 'basic', username: 'admin', password: 'test-password' };
  const token = { type: 'token', token: 'correct-token' };

  test('auth type none always passes', () => {
    expect(checkCredentials({}, { type: 'none' })).toEqual({ ok: true });
    expect(checkCredentials({}, {})).toEqual({ ok: true });
  });

  test('basic: correct credentials pass', () => {
    expect(checkCredentials(basicHeader('admin', 'test-password'), basic)).toEqual({ ok: true });
  });

  test('basic: missing header is reported as missing', () => {
    expect(checkCredentials({}, basic)).toEqual({ ok: false, reason: 'missing' });
  });

  test('basic: wrong username with correct password fails', () => {
    expect(checkCredentials(basicHeader('root', 'test-password'), basic))
      .toEqual({ ok: false, reason: 'invalid', username: 'root' });
  });

  test('basic: wrong username still runs the password comparison', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      // Re-require so the module picks up the spied export.
      jest.isolateModules(() => {
        const { checkCredentials: check } = require('../lib/dashboardCredentials');
        check(basicHeader('wrong', 'wrong'), basic);
      });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test('token: correct token passes, same-length wrong token fails', () => {
    expect(checkCredentials({ authorization: 'Bearer correct-token' }, token)).toEqual({ ok: true });
    expect(checkCredentials({ authorization: 'Bearer Xorrect-token' }, token))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(checkCredentials({ authorization: 'Bearer correct-tokeX' }, token))
      .toEqual({ ok: false, reason: 'invalid' });
  });

  test('token: a different-length token fails without throwing', () => {
    expect(checkCredentials({ authorization: 'Bearer x' }, token)).toEqual({ ok: false, reason: 'invalid' });
  });

  test('token: a Basic header under token auth is missing, not invalid', () => {
    expect(checkCredentials(basicHeader('a', 'b'), token)).toEqual({ ok: false, reason: 'missing' });
  });

  test('an unknown auth type is a config error', () => {
    expect(checkCredentials({}, { type: 'magic' })).toEqual({ ok: false, reason: 'config' });
  });

  // CONFIG_STRICT=false lets a config through without its secret; an empty
  // credential must not then match the missing one.
  test.each([
    ['token missing, empty bearer', { type: 'token' }, { authorization: 'Bearer ' }],
    ['token empty, empty bearer', { type: 'token', token: '' }, { authorization: 'Bearer ' }],
    ['basic without username or password', { type: 'basic' }, { authorization: 'Basic ' }],
    ['basic with only a username', { type: 'basic', username: 'admin' }, basicHeader('admin', '')],
    ['basic with only a password', { type: 'basic', password: 'pw' }, basicHeader('', 'pw')]
  ])('a missing configured secret is a config error, never a match: %s', (_, cfg, headers) => {
    expect(checkCredentials(headers, cfg)).toEqual({ ok: false, reason: 'config' });
  });
});

describe('WsTicketStore (#242)', () => {
  test('a minted ticket is 64 hex chars and consumable exactly once', () => {
    const store = new WsTicketStore();
    const t = store.mint();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(store.consume(t)).toBe(true);
    expect(store.consume(t)).toBe(false);
  });

  test('an expired ticket is refused', () => {
    let now = 0;
    const store = new WsTicketStore({ ttlMs: 30000, now: () => now });
    const t = store.mint();
    now = 30001;
    expect(store.consume(t)).toBe(false);
  });

  test('a ticket used just inside its TTL is accepted', () => {
    let now = 0;
    const store = new WsTicketStore({ ttlMs: 30000, now: () => now });
    const t = store.mint();
    now = 30000;
    expect(store.consume(t)).toBe(true);
  });

  test('unknown and non-string tickets are refused', () => {
    const store = new WsTicketStore();
    expect(store.consume('nope')).toBe(false);
    expect(store.consume(undefined)).toBe(false);
  });

  test('minting prunes expired tickets', () => {
    let now = 0;
    const store = new WsTicketStore({ ttlMs: 10, now: () => now });
    store.mint();
    now = 100;
    store.mint();
    expect(store.tickets.size).toBe(1);
  });
});
