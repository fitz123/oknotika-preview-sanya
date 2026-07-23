import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { assertTelegramConformance } from '../src/auth/conformance.js';
import { loadConfiguration } from '../src/auth/config.js';
import { createJwksVerifier } from '../src/auth/jwt.js';
import { createOidcService } from '../src/auth/oidc.js';
import { createSessionService, sessionCookie } from '../src/auth/sessions.js';
import { createHarness } from './helpers.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/telegram-oidc-conformance.json', import.meta.url)));
const NOW = new Date('2026-07-14T12:00:00.000Z');

test('official Telegram discovery fixture conforms to the pinned code/S256/basic/RS256 profile', () => {
  const metadata = assertTelegramConformance(fixture.metadata);
  assert.equal(metadata.issuer, 'https://oauth.telegram.org');
  assert.deepEqual(fixture.selectedContract, {
    responseType: 'code',
    grantType: 'authorization_code',
    pkceMethod: 'S256',
    tokenEndpointAuthMethod: 'client_secret_basic',
    idTokenSigningAlgorithm: 'RS256',
    redirectUriPolicy: 'exact',
  });
  assert.throws(
    () => assertTelegramConformance({ ...fixture.metadata, issuer: 'https://evil.example' }),
    /pinned issuer/,
  );
  assert.throws(
    () => assertTelegramConformance({ ...fixture.metadata, code_challenge_methods_supported: ['plain'] }),
    /S256/,
  );
});

test('production configuration pins canonical origins, exact callback and private runtime roots', () => {
  const env = {
    OKNOTIKA_ADMIN_ORIGIN: 'https://admin.oknotika.ru',
    OKNOTIKA_PUBLIC_ORIGIN: 'https://oknotika.ru',
    TELEGRAM_OIDC_CLIENT_ID: '123456789',
    TELEGRAM_OIDC_CLIENT_SECRET: 'secret',
    TELEGRAM_OIDC_REDIRECT_URI: 'https://admin.oknotika.ru/auth/callback',
    TELEGRAM_OIDC_SIGNING_ALG: 'RS256',
    OKNOTIKA_DATABASE_PATH: '/var/lib/oknotika-admin/db/admin.sqlite',
    OKNOTIKA_UPLOADS_ROOT: '/var/lib/oknotika-admin/uploads',
    OKNOTIKA_PREVIEWS_ROOT: '/var/lib/oknotika-admin/previews',
    OKNOTIKA_ARTICLE_RELEASES_ROOT: '/var/lib/oknotika-admin/article-releases',
    OKNOTIKA_PUBLIC_ROOT: '/srv/oknotika/current',
  };
  assert.equal(loadConfiguration(env).redirectUri, env.TELEGRAM_OIDC_REDIRECT_URI);
  assert.throws(() => loadConfiguration({
    ...env, TELEGRAM_OIDC_REDIRECT_URI: 'https://admin.oknotika.ru/auth/other',
  }), /exactly equal/);
  assert.throws(() => loadConfiguration({
    ...env, TELEGRAM_OIDC_SIGNING_ALG: 'ES256',
  }), /pinned to RS256/);
  assert.throws(() => loadConfiguration({
    ...env, OKNOTIKA_UPLOADS_ROOT: '/srv/oknotika/current/private',
  }), /outside the public/);
  assert.throws(() => loadConfiguration({
    ...env, OKNOTIKA_ARTICLE_RELEASES_ROOT: '/srv/oknotika/current/article-releases',
  }), /outside the public/);
});

test('production configuration reads OIDC secrets from systemd credential files', (t) => {
  const harness = createHarness(t);
  const clientIdFile = `${harness.root}/client-id`;
  const clientSecretFile = `${harness.root}/client-secret`;
  writeFileSync(clientIdFile, '123456789\n', { mode: 0o600 });
  writeFileSync(clientSecretFile, 'credential-secret\n', { mode: 0o600 });
  const config = loadConfiguration({
    OKNOTIKA_ADMIN_ORIGIN: 'https://admin.oknotika.ru',
    OKNOTIKA_PUBLIC_ORIGIN: 'https://oknotika.ru',
    TELEGRAM_OIDC_CLIENT_ID_FILE: clientIdFile,
    TELEGRAM_OIDC_CLIENT_SECRET_FILE: clientSecretFile,
    TELEGRAM_OIDC_REDIRECT_URI: 'https://admin.oknotika.ru/auth/callback',
    OKNOTIKA_DATABASE_PATH: `${harness.root}/db/admin.sqlite`,
    OKNOTIKA_UPLOADS_ROOT: `${harness.root}/uploads`,
    OKNOTIKA_PREVIEWS_ROOT: `${harness.root}/previews`,
    OKNOTIKA_ARTICLE_RELEASES_ROOT: `${harness.root}/article-releases`,
    OKNOTIKA_PUBLIC_ROOT: `${harness.root}/public`,
  });
  assert.equal(config.clientId, '123456789');
  assert.equal(config.clientSecret, 'credential-secret');
  assert.throws(() => loadConfiguration({
    ...configEnvironment(harness.root),
    TELEGRAM_OIDC_CLIENT_ID: 'direct',
    TELEGRAM_OIDC_CLIENT_ID_FILE: clientIdFile,
  }), /mutually exclusive/);
});

test('authorization code flow binds exact redirect, state, nonce and S256 verifier then consumes state once', async (t) => {
  const harness = createHarness(t, { clock: () => NOW });
  const key = signingKey('known');
  let idToken;
  let tokenRequest;
  let jwksRequests = 0;
  const fetchImpl = async (url, options) => {
    if (url === fixture.metadata.token_endpoint) {
      tokenRequest = options;
      return Response.json({ access_token: 'opaque', token_type: 'Bearer', id_token: idToken });
    }
    if (url === fixture.metadata.jwks_uri) {
      jwksRequests += 1;
      return Response.json({ keys: [key.publicJwk] });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const oidc = createOidcService(harness.db, {
    clientId: '123456789',
    clientSecret: 'client-secret',
    redirectUri: 'https://admin.oknotika.ru/auth/callback',
    discovery: fixture.metadata,
    fetchImpl,
    clock: () => NOW,
  });
  const started = oidc.beginAuthorization();
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.searchParams.get('redirect_uri'), 'https://admin.oknotika.ru/auth/callback');
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('code_challenge'));
  const state = authorization.searchParams.get('state');
  const nonce = authorization.searchParams.get('nonce');
  idToken = signedJwt(key, claims({ nonce }));

  const result = await oidc.finishAuthorization({
    callbackUrl: `https://admin.oknotika.ru/auth/callback?code=one-time-code&state=${state}`,
    browserBinding: started.browserBinding,
  });
  assert.equal(result.editorId, harness.editorId);
  assert.equal(jwksRequests, 1);
  assert.match(tokenRequest.headers.authorization, /^Basic /);
  assert.equal(tokenRequest.body.get('redirect_uri'), 'https://admin.oknotika.ru/auth/callback');
  assert.ok(tokenRequest.body.get('code_verifier'));
  await assert.rejects(
    oidc.finishAuthorization({
      callbackUrl: `https://admin.oknotika.ru/auth/callback?code=replay&state=${state}`,
      browserBinding: started.browserBinding,
    }),
    /invalid, expired|already been consumed/,
  );
});

test('OIDC transactions reject expiry, wrong browser binding, duplicate parameters and redirect mismatch before exchange', async (t) => {
  let current = new Date(NOW);
  let tokenRequests = 0;
  const harness = createHarness(t, { clock: () => current });
  const oidc = createOidcService(harness.db, {
    clientId: '123456789',
    clientSecret: 'secret',
    redirectUri: 'https://admin.oknotika.ru/auth/callback',
    discovery: fixture.metadata,
    clock: () => current,
    stateTtlMs: 1_000,
    fetchImpl: async () => {
      tokenRequests += 1;
      throw new Error('token exchange must not run');
    },
  });

  const expired = oidc.beginAuthorization();
  const expiredState = new URL(expired.authorizationUrl).searchParams.get('state');
  current = new Date(NOW.valueOf() + 1_001);
  await assert.rejects(oidc.finishAuthorization({
    callbackUrl: `https://admin.oknotika.ru/auth/callback?code=code&state=${expiredState}`,
    browserBinding: expired.browserBinding,
  }), /invalid, expired/);

  current = new Date(NOW);
  const wrongBrowser = oidc.beginAuthorization();
  const wrongBrowserState = new URL(wrongBrowser.authorizationUrl).searchParams.get('state');
  await assert.rejects(oidc.finishAuthorization({
    callbackUrl: `https://admin.oknotika.ru/auth/callback?code=code&state=${wrongBrowserState}`,
    browserBinding: 'another-browser-binding-value',
  }), /another browser/);

  for (const query of [
    'code=one&code=two&state=state',
    'code=one&state=state&state=again',
  ]) {
    await assert.rejects(oidc.finishAuthorization({
      callbackUrl: `https://admin.oknotika.ru/auth/callback?${query}`,
      browserBinding: wrongBrowser.browserBinding,
    }), /repeats/);
  }
  await assert.rejects(oidc.finishAuthorization({
    callbackUrl: `https://evil.example/auth/callback?code=code&state=${wrongBrowserState}`,
    browserBinding: wrongBrowser.browserBinding,
  }), /exact redirect URI/);
  assert.equal(tokenRequests, 0);
});

test('non-allowlisted issuer/subject is denied after valid signature and claims', async (t) => {
  const harness = createHarness(t, { clock: () => NOW });
  const key = signingKey('known');
  let token;
  const oidc = createOidcService(harness.db, {
    clientId: '123456789',
    clientSecret: 'secret',
    redirectUri: 'https://admin.oknotika.ru/auth/callback',
    discovery: fixture.metadata,
    clock: () => NOW,
    fetchImpl: async (url) => url === fixture.metadata.token_endpoint
      ? Response.json({ access_token: 'opaque', token_type: 'Bearer', id_token: token })
      : Response.json({ keys: [key.publicJwk] }),
  });
  const started = oidc.beginAuthorization();
  const url = new URL(started.authorizationUrl);
  token = signedJwt(key, claims({ nonce: url.searchParams.get('nonce'), sub: 'not-enrolled' }));
  await assert.rejects(oidc.finishAuthorization({
    callbackUrl: `https://admin.oknotika.ru/auth/callback?code=code&state=${url.searchParams.get('state')}`,
    browserBinding: started.browserBinding,
  }), /not enrolled/);

  const bootstrap = oidc.beginAuthorization();
  const bootstrapUrl = new URL(bootstrap.authorizationUrl);
  token = signedJwt(key, claims({ nonce: bootstrapUrl.searchParams.get('nonce'), sub: '9988776655' }));
  const verified = await oidc.finishIdentityVerification({
    callbackUrl: `https://admin.oknotika.ru/auth/callback?code=bootstrap&state=${bootstrapUrl.searchParams.get('state')}`,
    browserBinding: bootstrap.browserBinding,
  });
  assert.equal(verified.iss, fixture.metadata.issuer);
  assert.equal(verified.sub, '9988776655');
});

test('JWT verification rejects wrong alg/claims/signature and validates azp only when present/applicable', async () => {
  const key = signingKey('known');
  const verifier = createJwksVerifier({
    jwksUri: fixture.metadata.jwks_uri,
    issuer: fixture.metadata.issuer,
    audience: '123456789',
    clock: () => NOW,
    fetchImpl: async () => Response.json({ keys: [key.publicJwk] }),
  });
  const valid = claims({ nonce: 'nonce' });
  assert.equal((await verifier.verifyIdToken(signedJwt(key, valid), { nonce: 'nonce' })).sub, 'editor-123');
  await assert.rejects(
    verifier.verifyIdToken(signedJwt(key, { ...valid, iss: 'https://evil.example' }), { nonce: 'nonce' }),
    /issuer/,
  );
  for (const [changed, message, expectedNonce = 'nonce'] of [
    [{ sub: '' }, /subject/],
    [{ aud: 'other-client' }, /audience/],
    [{ exp: valid.iat - 1 }, /expired|lifetime/],
    [{ iat: valid.iat + 600 }, /iat/],
    [{ nonce: 'other-nonce' }, /nonce/],
  ]) {
    await assert.rejects(
      verifier.verifyIdToken(signedJwt(key, { ...valid, ...changed }), { nonce: expectedNonce }),
      message,
    );
  }
  await assert.rejects(
    verifier.verifyIdToken(signedJwt(key, { ...valid, aud: ['123456789', 'other'] }), { nonce: 'nonce' }),
    /requires azp/,
  );
  assert.equal((await verifier.verifyIdToken(signedJwt(key, {
    ...valid, aud: ['123456789', 'other'], azp: '123456789',
  }), { nonce: 'nonce' })).azp, '123456789');
  await assert.rejects(
    verifier.verifyIdToken(signedJwt(key, valid, { algorithm: 'HS256' }), { nonce: 'nonce' }),
    /unapproved signing algorithm/,
  );
  const signed = signedJwt(key, valid);
  const [tamperedHeader, tamperedPayload, tamperedSignature] = signed.split('.');
  const tampered = `${tamperedHeader}.${tamperedPayload}.${tamperedSignature[0] === 'A' ? 'B' : 'A'}${tamperedSignature.slice(1)}`;
  await assert.rejects(verifier.verifyIdToken(tampered, { nonce: 'nonce' }), /signature/);
});

test('unknown kid performs one bounded JWKS refresh and then fails closed', async () => {
  const known = signingKey('known');
  const unknown = signingKey('unknown');
  let requests = 0;
  const verifier = createJwksVerifier({
    jwksUri: fixture.metadata.jwks_uri,
    issuer: fixture.metadata.issuer,
    audience: '123456789',
    clock: () => NOW,
    fetchImpl: async () => {
      requests += 1;
      return Response.json({ keys: [known.publicJwk] });
    },
  });
  await assert.rejects(
    verifier.verifyIdToken(signedJwt(unknown, claims({ nonce: 'nonce' })), { nonce: 'nonce' }),
    /unknown after one JWKS refresh/,
  );
  assert.equal(requests, 2);
});

test('opaque sessions enforce Secure __Host cookie, idle/absolute expiry, logout and editor revocation', (t) => {
  let now = new Date(NOW);
  const harness = createHarness(t, { clock: () => now });
  const sessions = createSessionService(harness.db, { clock: () => now });
  const created = sessions.create(harness.editorId);
  const serialized = sessionCookie(created.token);
  assert.match(serialized, /^__Host-oknotika_session=/);
  assert.match(serialized, /; Path=\/;/);
  assert.match(serialized, /; Secure;/);
  assert.match(serialized, /; HttpOnly;/);
  assert.match(serialized, /; SameSite=Lax$/);
  assert.doesNotMatch(serialized, /Domain=/i);
  assert.ok(sessions.authenticate(serialized));
  now = new Date(NOW.valueOf() + 31 * 60 * 1000);
  assert.equal(sessions.authenticate(serialized), null);

  now = new Date(NOW);
  const second = sessions.create(harness.editorId);
  const secondCookie = sessionCookie(second.token);
  assert.equal(sessions.revoke(secondCookie), true);
  assert.equal(sessions.authenticate(secondCookie), null);

  const third = sessions.create(harness.editorId);
  const thirdCookie = sessionCookie(third.token);
  harness.service.disableEditor(harness.editorId);
  assert.equal(sessions.authenticate(thirdCookie), null);
  assert.equal(
    harness.db.prepare("SELECT COUNT(*) AS count FROM admin_sessions WHERE revocation_reason = 'editor-disabled'").get().count,
    1,
  );

  const otherHarness = createHarness(t, { clock: () => now });
  const absoluteSessions = createSessionService(otherHarness.db, {
    clock: () => now,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    absoluteTimeoutMs: 8 * 60 * 60 * 1000,
  });
  const absolute = absoluteSessions.create(otherHarness.editorId);
  now = new Date(NOW.valueOf() + 8 * 60 * 60 * 1000 + 1);
  assert.equal(absoluteSessions.authenticate(sessionCookie(absolute.token)), null);
});

function signingKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    publicJwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  };
}

function claims(overrides = {}) {
  const now = Math.floor(NOW.valueOf() / 1000);
  return {
    iss: fixture.metadata.issuer,
    sub: 'editor-123',
    aud: '123456789',
    iat: now,
    exp: now + 3600,
    nonce: 'nonce',
    ...overrides,
  };
}

function configEnvironment(root) {
  return {
    OKNOTIKA_ADMIN_ORIGIN: 'https://admin.oknotika.ru',
    OKNOTIKA_PUBLIC_ORIGIN: 'https://oknotika.ru',
    TELEGRAM_OIDC_CLIENT_ID: '123456789',
    TELEGRAM_OIDC_CLIENT_SECRET: 'secret',
    TELEGRAM_OIDC_REDIRECT_URI: 'https://admin.oknotika.ru/auth/callback',
    OKNOTIKA_DATABASE_PATH: `${root}/db/admin.sqlite`,
    OKNOTIKA_UPLOADS_ROOT: `${root}/uploads`,
    OKNOTIKA_PREVIEWS_ROOT: `${root}/previews`,
    OKNOTIKA_ARTICLE_RELEASES_ROOT: `${root}/article-releases`,
    OKNOTIKA_PUBLIC_ROOT: `${root}/public`,
  };
}

function signedJwt(key, payload, { algorithm = 'RS256' } = {}) {
  const header = encode({ alg: algorithm, kid: key.kid, typ: 'JWT' });
  const encodedPayload = encode(payload);
  const data = `${header}.${encodedPayload}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), key.privateKey).toString('base64url');
  return `${data}.${signature}`;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
