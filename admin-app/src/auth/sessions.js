import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = '__Host-oknotika_session';
export const OIDC_BINDING_COOKIE = '__Host-oknotika_oidc';

export function createSessionService(db, {
  clock = () => new Date(),
  idleTimeoutMs = 30 * 60 * 1000,
  absoluteTimeoutMs = 8 * 60 * 60 * 1000,
} = {}) {
  function create(editorId) {
    const editor = db.prepare('SELECT id FROM configured_editors WHERE id = ? AND enabled = 1').get(editorId);
    if (!editor) throw new Error('An enabled editor is required to create a session');
    const token = randomBytes(32).toString('base64url');
    const csrfToken = deriveCsrf(token);
    const created = clock();
    const absolute = new Date(created.valueOf() + absoluteTimeoutMs);
    const idle = new Date(Math.min(created.valueOf() + idleTimeoutMs, absolute.valueOf()));
    db.prepare(`
      INSERT INTO admin_sessions
        (token_hash, csrf_hash, editor_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      hash(token), hash(csrfToken), editorId, created.toISOString(), created.toISOString(),
      idle.toISOString(), absolute.toISOString(),
    );
    return { token, csrfToken, editorId, expiresAt: absolute.toISOString() };
  }

  function authenticate(cookieHeader) {
    const token = readUniqueCookie(cookieHeader, SESSION_COOKIE);
    if (!token) return null;
    const timestamp = clock();
    const row = db.prepare(`
      SELECT s.*, e.issuer, e.subject, e.enabled
      FROM admin_sessions s
      JOIN configured_editors e ON e.id = s.editor_id
      WHERE s.token_hash = ?
    `).get(hash(token));
    if (!row || row.revoked_at || row.enabled !== 1) return null;
    if (Date.parse(row.idle_expires_at) <= timestamp.valueOf() || Date.parse(row.absolute_expires_at) <= timestamp.valueOf()) {
      revokeTokenHash(row.token_hash, 'expired');
      return null;
    }
    const nextIdle = new Date(Math.min(
      timestamp.valueOf() + idleTimeoutMs,
      Date.parse(row.absolute_expires_at),
    ));
    db.prepare(`
      UPDATE admin_sessions SET last_seen_at = ?, idle_expires_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(timestamp.toISOString(), nextIdle.toISOString(), row.token_hash);
    return { ...row, token, csrf_token: deriveCsrf(token), idle_expires_at: nextIdle.toISOString() };
  }

  function verifyCsrf(session, suppliedToken) {
    if (!session || typeof suppliedToken !== 'string') return false;
    return safeHashEqual(session.csrf_hash, hash(suppliedToken));
  }

  function revoke(cookieHeader, reason = 'logout') {
    const token = readUniqueCookie(cookieHeader, SESSION_COOKIE);
    if (!token) return false;
    return revokeTokenHash(hash(token), reason);
  }

  function revokeEditor(editorId, reason = 'editor-disabled') {
    const result = db.prepare(`
      UPDATE admin_sessions SET revoked_at = ?, revocation_reason = ?
      WHERE editor_id = ? AND revoked_at IS NULL
    `).run(clock().toISOString(), reason, editorId);
    return Number(result.changes);
  }

  function revokeTokenHash(tokenHash, reason) {
    const result = db.prepare(`
      UPDATE admin_sessions SET revoked_at = ?, revocation_reason = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(clock().toISOString(), reason, tokenHash);
    return result.changes === 1;
  }

  return { create, authenticate, verifyCsrf, revoke, revokeEditor };
}

export function sessionCookie(token, { maxAgeSeconds = 8 * 60 * 60 } = {}) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

export function oidcBindingCookie(token, { maxAgeSeconds = 10 * 60 } = {}) {
  return `${OIDC_BINDING_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

export function expireCookie(name) {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export function readUniqueCookie(header, name) {
  if (typeof header !== 'string' || header === '') return null;
  const values = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{20,256}$/.test(value) ? value : null;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deriveCsrf(sessionToken) {
  return createHash('sha256').update('oknotika-admin-csrf\0').update(sessionToken).digest('base64url');
}

function safeHashEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
