import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { transaction } from '../content/database.js';

export const LOGIN_CSRF_COOKIE = '__Host-oknotika_login';
export const LOGIN_BODY_MAXIMUM = 4096;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createLoginCsrfService(db, {
  clock = () => new Date(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > DEFAULT_TTL_MS) {
    throw new TypeError('Login CSRF lifetime must be between one and ten minutes');
  }

  function issue() {
    const created = clock();
    const expires = new Date(created.valueOf() + ttlMs);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const browserBinding = randomBytes(TOKEN_BYTES).toString('base64url');
    db.prepare('DELETE FROM local_login_csrf_tokens WHERE expires_at <= ?')
      .run(created.toISOString());
    db.prepare(`
      INSERT INTO local_login_csrf_tokens
        (token_hash, browser_binding_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(hash(token), hash(browserBinding), created.toISOString(), expires.toISOString());
    return Object.freeze({ token, browserBinding, maxAgeSeconds: Math.floor(ttlMs / 1000) });
  }

  function consume({ token, browserBinding } = {}) {
    const suppliedToken = validToken(token) ? token : fakeToken();
    const suppliedBinding = validToken(browserBinding) ? browserBinding : fakeToken();
    const tokenHash = hash(suppliedToken);
    const bindingHash = hash(suppliedBinding);
    const timestamp = clock().toISOString();
    const accepted = transaction(db, () => {
      const row = db.prepare(`
        SELECT browser_binding_hash, expires_at, consumed_at
        FROM local_login_csrf_tokens WHERE token_hash = ?
      `).get(tokenHash);
      const bindingMatches = safeHashEqual(row?.browser_binding_hash ?? fakeHash(), bindingHash);
      if (!row || row.consumed_at || row.expires_at <= timestamp || !bindingMatches) return false;
      const result = db.prepare(`
        UPDATE local_login_csrf_tokens SET consumed_at = ?
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `).run(timestamp, tokenHash, timestamp);
      return result.changes === 1;
    });
    if (!accepted) throw invalidLoginCsrf();
  }

  return Object.freeze({ issue, consume });
}

export function loginCsrfCookie(token, { maxAgeSeconds = DEFAULT_TTL_MS / 1000 } = {}) {
  if (!validToken(token) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new TypeError('A valid login browser binding is required');
  }
  return `${LOGIN_CSRF_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Strict`;
}

function validToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fakeToken() {
  return 'A'.repeat(43);
}

function fakeHash() {
  return '0'.repeat(64);
}

function safeHashEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function invalidLoginCsrf() {
  const error = new Error('Login request is invalid or expired');
  error.code = 'INVALID_LOGIN_CSRF';
  return error;
}
