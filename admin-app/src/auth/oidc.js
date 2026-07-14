import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { transaction } from '../content/database.js';
import { createJwksVerifier } from './jwt.js';

const STATE_TTL_MS = 10 * 60 * 1000;

export function createOidcService(db, {
  clientId,
  clientSecret,
  redirectUri,
  discovery,
  allowedAlgorithm = 'RS256',
  fetchImpl = fetch,
  clock = () => new Date(),
  stateTtlMs = STATE_TTL_MS,
  requestTimeoutMs = 5_000,
} = {}) {
  if (!clientId || !clientSecret) throw new TypeError('OIDC client credentials are required');
  if (new URL(redirectUri).href !== redirectUri) throw new TypeError('redirectUri must be an exact absolute URL');
  const verifier = createJwksVerifier({
    jwksUri: discovery.jwks_uri,
    issuer: discovery.issuer,
    audience: clientId,
    allowedAlgorithm,
    fetchImpl,
    clock,
    timeoutMs: requestTimeoutMs,
  });

  function beginAuthorization() {
    const state = randomToken(32);
    const nonce = randomToken(32);
    const pkceVerifier = randomToken(64);
    const browserBinding = randomToken(32);
    const timestamp = clock();
    const expires = new Date(timestamp.valueOf() + stateTtlMs);
    db.prepare('DELETE FROM oidc_login_transactions WHERE expires_at <= ?').run(timestamp.toISOString());
    db.prepare(`
      INSERT INTO oidc_login_transactions
        (state_hash, browser_binding_hash, nonce, pkce_verifier, redirect_uri, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      hashSecret(state),
      hashSecret(browserBinding),
      nonce,
      pkceVerifier,
      redirectUri,
      timestamp.toISOString(),
      expires.toISOString(),
    );
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(pkceVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { authorizationUrl: url.href, browserBinding, expiresAt: expires.toISOString() };
  }

  async function finishAuthorization({ callbackUrl, browserBinding }) {
    const claims = await finishIdentityVerification({ callbackUrl, browserBinding });
    const editor = db.prepare(`
      SELECT id, issuer, subject FROM configured_editors
      WHERE issuer = ? AND subject = ? AND enabled = 1
    `).get(claims.iss, claims.sub);
    if (!editor) throw new Error('Telegram identity is not enrolled for this admin');
    return { editorId: Number(editor.id), claims };
  }

  async function finishIdentityVerification({ callbackUrl, browserBinding }) {
    const callback = new URL(callbackUrl);
    const expected = new URL(redirectUri);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash) {
      throw new Error('OIDC callback does not match the exact redirect URI');
    }
    rejectDuplicateParameters(callback.searchParams, ['state', 'code', 'error']);
    const state = callback.searchParams.get('state');
    if (!state || !browserBinding) throw new Error('OIDC callback is incomplete');
    const login = consumeLoginTransaction(state, browserBinding);
    if (callback.searchParams.has('error')) throw new Error('Telegram denied the authorization request');
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('OIDC callback is incomplete');
    const tokens = await exchangeCode(code, login.pkce_verifier);
    return verifier.verifyIdToken(tokens.id_token, { nonce: login.nonce });
  }

  function consumeLoginTransaction(state, browserBinding) {
    return transaction(db, () => {
      const row = db.prepare(`
        SELECT * FROM oidc_login_transactions
        WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `).get(hashSecret(state), clock().toISOString());
      if (!row || !safeHashEqual(row.browser_binding_hash, hashSecret(browserBinding))) {
        throw new Error('OIDC state is invalid, expired or bound to another browser');
      }
      const updated = db.prepare(`
        UPDATE oidc_login_transactions SET consumed_at = ?
        WHERE state_hash = ? AND consumed_at IS NULL
      `).run(clock().toISOString(), row.state_hash);
      if (updated.changes !== 1) throw new Error('OIDC state has already been consumed');
      if (row.redirect_uri !== redirectUri) throw new Error('OIDC redirect URI binding is invalid');
      return row;
    });
  }

  async function exchangeCode(code, pkceVerifier) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkceVerifier,
    });
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetchImpl(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('OIDC token response is too large');
    if (!response.ok) throw new Error(`OIDC token exchange failed with HTTP ${response.status}`);
    const tokens = JSON.parse(text);
    if (typeof tokens.id_token !== 'string' || tokens.token_type !== 'Bearer') {
      throw new Error('OIDC token response is incomplete');
    }
    return tokens;
  }

  return { beginAuthorization, finishAuthorization, finishIdentityVerification };
}

function rejectDuplicateParameters(parameters, names) {
  for (const name of names) {
    if (parameters.getAll(name).length > 1) throw new Error(`OIDC callback repeats ${name}`);
  }
}

function randomToken(bytes) {
  return randomBytes(bytes).toString('base64url');
}

function hashSecret(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeHashEqual(left, right) {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
