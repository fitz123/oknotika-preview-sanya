import {
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

export function createJwksVerifier({
  jwksUri,
  issuer,
  audience,
  allowedAlgorithm = 'RS256',
  fetchImpl = fetch,
  clock = () => new Date(),
  timeoutMs = 5_000,
  clockToleranceSeconds = 30,
  maxTokenLifetimeSeconds = 7_200,
} = {}) {
  if (allowedAlgorithm !== 'RS256') throw new Error('Only the pinned RS256 profile is supported');
  let cachedKeys = null;

  async function verifyIdToken(token, { nonce }) {
    const parts = parseCompactJwt(token);
    const header = parseJsonPart(parts[0], 'JWT header');
    if (header.alg !== allowedAlgorithm) throw new Error('ID token uses an unapproved signing algorithm');
    if (typeof header.kid !== 'string' || header.kid === '') throw new Error('ID token kid is required');
    if (header.typ !== undefined && header.typ !== 'JWT') throw new Error('ID token typ is invalid');
    if (header.crit !== undefined) throw new Error('Critical JWT extensions are not supported');

    let keys = cachedKeys ?? await refreshKeys();
    let key = selectKey(keys, header.kid);
    if (!key) {
      keys = await refreshKeys();
      key = selectKey(keys, header.kid);
      if (!key) throw new Error('ID token kid is unknown after one JWKS refresh');
    }
    if (key.alg !== undefined && key.alg !== allowedAlgorithm) throw new Error('JWKS key algorithm is not allowed');
    if (key.kty !== 'RSA' || (key.use !== undefined && key.use !== 'sig')) {
      throw new Error('JWKS key cannot be used for RS256 signatures');
    }

    const signature = decodeBase64Url(parts[2], 'JWT signature');
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    let publicKey;
    try {
      publicKey = createPublicKey({ key, format: 'jwk' });
    } catch {
      throw new Error('JWKS signing key is invalid');
    }
    if (!verifySignature('RSA-SHA256', signed, publicKey, signature)) {
      throw new Error('ID token signature is invalid');
    }

    const claims = parseJsonPart(parts[1], 'JWT payload');
    validateClaims(claims, {
      issuer,
      audience,
      nonce,
      now: Math.floor(clock().valueOf() / 1000),
      clockToleranceSeconds,
      maxTokenLifetimeSeconds,
    });
    return claims;
  }

  async function refreshKeys() {
    const response = await fetchImpl(jwksUri, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`JWKS request failed with HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('JWKS response is too large');
    const document = JSON.parse(text);
    if (!Array.isArray(document.keys) || document.keys.length > 32) throw new Error('JWKS response is invalid');
    cachedKeys = document.keys;
    return cachedKeys;
  }

  return { verifyIdToken, refreshKeys };
}

function selectKey(keys, kid) {
  const matches = keys.filter((key) => key?.kid === kid);
  if (matches.length > 1) throw new Error('JWKS contains a duplicate kid');
  return matches[0] ?? null;
}

function validateClaims(claims, {
  issuer,
  audience,
  nonce,
  now,
  clockToleranceSeconds,
  maxTokenLifetimeSeconds,
}) {
  if (claims.iss !== issuer) throw new Error('ID token issuer is invalid');
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('ID token subject is invalid');
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (!Array.isArray(audiences) || audiences.length === 0 || audiences.some((value) => typeof value !== 'string')) {
    throw new Error('ID token audience is invalid');
  }
  if (!audiences.includes(audience)) throw new Error('ID token audience does not include this client');
  if (audiences.length > 1 && typeof claims.azp !== 'string') {
    throw new Error('ID token with multiple audiences requires azp');
  }
  if (claims.azp !== undefined && claims.azp !== audience) throw new Error('ID token azp is invalid');
  if (!Number.isInteger(claims.exp) || claims.exp <= now - clockToleranceSeconds) {
    throw new Error('ID token is expired or exp is invalid');
  }
  if (!Number.isInteger(claims.iat) || claims.iat > now + clockToleranceSeconds) {
    throw new Error('ID token iat is invalid');
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maxTokenLifetimeSeconds) {
    throw new Error('ID token lifetime is invalid');
  }
  if (typeof nonce !== 'string' || !safeStringEqual(claims.nonce, nonce)) {
    throw new Error('ID token nonce is invalid');
  }
}

function parseCompactJwt(token) {
  if (typeof token !== 'string') throw new TypeError('ID token is required');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('ID token is not a valid compact JWT');
  }
  return parts;
}

function parseJsonPart(encoded, label) {
  try {
    const value = JSON.parse(decodeBase64Url(encoded, label).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function decodeBase64Url(value, label) {
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length === 0 || decoded.toString('base64url') !== value) throw new Error();
    return decoded;
  } catch {
    throw new Error(`${label} is not valid base64url`);
  }
}

function safeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
