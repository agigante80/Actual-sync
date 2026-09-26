/**
 * Dashboard credential checks, shared by the HTTP middleware and the
 * /ws/logs handshake so both use one implementation. (#242, #246)
 */

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

// Hash both sides to a fixed width first: timingSafeEqual throws on a length
// mismatch, and comparing digests also keeps the credential length private.
const digest = (value) => createHash('sha256').update(String(value ?? ''), 'utf8').digest();
const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));
// A missing or empty configured secret must never match an empty credential.
const isSet = (value) => typeof value === 'string' && value.length > 0;

/**
 * Check an Authorization header against the dashboard auth config.
 * @param {Object} headers - request headers (only `authorization` is read)
 * @param {Object} authConfig - dashboard.auth
 * @returns {{ ok: boolean, reason?: 'missing'|'invalid'|'config', username?: string }}
 */
function checkCredentials(headers, authConfig = {}) {
  const authType = authConfig.type || 'none';
  const authHeader = (headers && headers.authorization) || '';

  if (authType === 'none') return { ok: true };

  if (authType === 'basic') {
    if (!isSet(authConfig.username) || !isSet(authConfig.password)) return { ok: false, reason: 'config' };
    if (!authHeader.startsWith('Basic ')) return { ok: false, reason: 'missing' };
    const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
    const [username, password] = credentials.split(':');
    // Both comparisons run every time, so a wrong username takes as long as a wrong password.
    const userOk = safeEqual(username, authConfig.username);
    const passOk = safeEqual(password, authConfig.password);
    return userOk && passOk ? { ok: true } : { ok: false, reason: 'invalid', username };
  }

  if (authType === 'token') {
    if (!isSet(authConfig.token)) return { ok: false, reason: 'config' };
    if (!authHeader.startsWith('Bearer ')) return { ok: false, reason: 'missing' };
    return safeEqual(authHeader.substring(7), authConfig.token)
      ? { ok: true }
      : { ok: false, reason: 'invalid' };
  }

  return { ok: false, reason: 'config' };
}

/**
 * Short-lived, single-use tickets for the /ws/logs handshake. Browsers cannot
 * set an Authorization header on a WebSocket, so the dashboard fetches a ticket
 * over authenticated HTTP and passes it as ?ticket=. Held in memory only; a
 * restart just means the dashboard asks for a new one.
 */
class WsTicketStore {
  constructor({ ttlMs = 30000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.tickets = new Map(); // ticket -> expiry time
  }

  mint() {
    this.prune();
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(ticket, this.now() + this.ttlMs);
    return ticket;
  }

  /** @returns {boolean} true once for a known, unexpired ticket */
  consume(ticket) {
    if (typeof ticket !== 'string' || !this.tickets.has(ticket)) return false;
    const expiry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return this.now() <= expiry;
  }

  prune() {
    const t = this.now();
    for (const [ticket, expiry] of this.tickets) {
      if (expiry < t) this.tickets.delete(ticket);
    }
  }
}

module.exports = { checkCredentials, WsTicketStore };
