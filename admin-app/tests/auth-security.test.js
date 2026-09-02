import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { assertTelegramConformance } from '../src/auth/conformance.js';
import { loadConfiguration } from '../src/auth/config.js';
import { createJwksVerifier } from '../src/auth/jwt.js';
import {
  createLocalAuthenticator,
  createLocalCredential,
  hashLocalPassword,
  LOCAL_AUTH_FAILURE,
  LOCAL_AUTH_ISSUER,
  parseScryptPasswordRecord,
} from '../src/auth/local.js';
import { createOidcService } from '../src/auth/oidc.js';
import { createSessionService, sessionCookie } from '../src/auth/sessions.js';
import { openDatabase } from '../src/content/database.js';
import { createHarness } from './helpers.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/telegram-oidc-conformance.json', import.meta.url)));
const NOW = new Date('2026-07-14T12:00:00.000Z');
const TEST_SALT = Buffer.alloc(16, 1);
const TEST_DIGEST = Buffer.alloc(32, 2);
const VALID_PASSWORD_HASH = passwordRecord({ salt: TEST_SALT, digest: TEST_DIGEST });

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

test('production configuration loads local credentials only from protected files and isolates runtime roots', (t) => {
  const harness = createHarness(t);
  const env = configEnvironment(harness.root);
  writeLocalCredentialFiles(harness.root);
  const config = loadConfiguration(env);
  assert.equal(config.localCredential.username, 'editor');
  assert.equal(config.localCredential.passwordRecord.serialized, VALID_PASSWORD_HASH);
  assert.equal(config.redirectUri, undefined);
  assert.equal(config.clientSecret, undefined);
  assert.throws(() => loadConfiguration({
    ...env, OKNOTIKA_UPLOADS_ROOT: `${harness.root}/public/private`,
  }), /outside the public/);
  assert.throws(() => loadConfiguration({
    ...env, OKNOTIKA_ARTICLE_RELEASES_ROOT: `${harness.root}/public/article-releases`,
  }), /outside the public/);
  assert.throws(() => loadConfiguration({
    ...env, OKNOTIKA_WEEKLY_INGEST_TOKEN: 'a'.repeat(31),
  }), /at least 32 bytes/);
  assert.equal(
    loadConfiguration({
      ...env, OKNOTIKA_WEEKLY_INGEST_TOKEN: 'a'.repeat(32),
    }).weeklyIngestionToken,
    'a'.repeat(32),
  );
  for (const weeklyIngestionToken of [
    'weekly ingestion token with forbidden whitespace',
    'weekly,ingestion,token,with,forbidden,commas',
    'еженедельный-токен-достаточной-длины',
  ]) {
    assert.throws(() => loadConfiguration({
      ...env,
      OKNOTIKA_WEEKLY_INGEST_TOKEN: weeklyIngestionToken,
    }), /printable ASCII/);
  }
});

test('production configuration rejects direct, plaintext, malformed and writable local credentials without disclosure', (t) => {
  const harness = createHarness(t);
  const { usernameFile, passwordHashFile } = writeLocalCredentialFiles(harness.root);
  const ingestionTokenFile = `${harness.root}/weekly-ingest-token`;
  writeFileSync(ingestionTokenFile, 'weekly-ingestion-credential-1234567890\n', { mode: 0o600 });
  const env = {
    ...configEnvironment(harness.root),
    OKNOTIKA_WEEKLY_INGEST_TOKEN_FILE: ingestionTokenFile,
  };
  delete env.OKNOTIKA_WEEKLY_INGEST_TOKEN;
  const config = loadConfiguration(env);
  assert.equal(config.localCredential.username, 'editor');
  assert.equal(config.weeklyIngestionToken, 'weekly-ingestion-credential-1234567890');
  for (const forbidden of [
    { OKNOTIKA_LOCAL_USERNAME: 'editor' },
    { OKNOTIKA_LOCAL_PASSWORD_HASH: VALID_PASSWORD_HASH },
    { OKNOTIKA_LOCAL_PASSWORD: 'do-not-store-this' },
    { OKNOTIKA_LOCAL_PASSWORD_FILE: passwordHashFile },
  ]) {
    assert.throws(() => loadConfiguration({ ...env, ...forbidden }), /prohibited/);
  }
  writeFileSync(passwordHashFile, 'plaintext-password\n', { mode: 0o600 });
  assert.throws(() => loadConfiguration(env), (error) => {
    assert.match(error.message, /malformed|weak/);
    assert.doesNotMatch(error.message, /plaintext-password/);
    return true;
  });
  writeFileSync(passwordHashFile, `${VALID_PASSWORD_HASH}\n`, { mode: 0o600 });
  chmodSync(usernameFile, 0o622);
  assert.throws(() => loadConfiguration(env), /protected, readable regular file/);
});

test('versioned scrypt records reject non-canonical, weak and excessive parameters', () => {
  const invalidRecords = [
    VALID_PASSWORD_HASH.replace('v=1', 'v=2'),
    passwordRecord({ N: 16384 }),
    passwordRecord({ N: 262144 }),
    passwordRecord({ r: 7 }),
    passwordRecord({ p: 3 }),
    passwordRecord({ N: '032768' }),
    passwordRecord({ salt: Buffer.alloc(8) }),
    passwordRecord({ digest: Buffer.alloc(16) }),
    VALID_PASSWORD_HASH.replace(TEST_SALT.toString('base64url'), 'not+base64'),
    `pbkdf2${VALID_PASSWORD_HASH.slice('scrypt'.length)}`,
  ];
  for (const record of invalidRecords) {
    assert.throws(() => parseScryptPasswordRecord(record), /malformed|weak/);
  }
  const parsed = parseScryptPasswordRecord(VALID_PASSWORD_HASH);
  assert.deepEqual({ version: parsed.version, N: parsed.N, r: parsed.r, p: parsed.p }, {
    version: 1, N: 32768, r: 8, p: 1,
  });
});

test('local authentication accepts the configured credential and returns one generic failure', async (t) => {
  const password = 'correct horse battery staple';
  const passwordHash = await hashLocalPassword(password, { salt: TEST_SALT });
  const credential = createLocalCredential({ username: 'editor', passwordHash });
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const authenticator = createLocalAuthenticator(db, credential, { clock: () => NOW });
  assert.deepEqual(await authenticator.authenticate({ username: 'editor', password }), {
    editorId: authenticator.editorId,
  });
  const editor = db.prepare('SELECT issuer, subject, credential_fingerprint FROM configured_editors').get();
  assert.equal(editor.issuer, LOCAL_AUTH_ISSUER);
  assert.equal(editor.subject, 'editor');
  assert.equal(editor.credential_fingerprint, credential.fingerprint);
  for (const supplied of [
    { username: 'somebody-else', password },
    { username: 'editor', password: 'wrong-password' },
    { username: 'somebody-else', password: 'wrong-password' },
    { username: 'editor', password: 'x'.repeat(1025) },
  ]) {
    await assert.rejects(authenticator.authenticate(supplied), (error) => {
      assert.equal(error.code, 'INVALID_LOCAL_CREDENTIALS');
      assert.equal(error.message, LOCAL_AUTH_FAILURE);
      assert.doesNotMatch(error.message, /somebody|wrong|correct|scrypt|editor/i);
      return true;
    });
  }
});

test('local editor initialization fails closed on a conflicting singleton identity', () => {
  const db = openDatabase(':memory:');
  const credential = createLocalCredential({ username: 'editor', passwordHash: VALID_PASSWORD_HASH });
  db.prepare(`
    INSERT INTO configured_editors (issuer, subject, enabled, created_at)
    VALUES ('https://oauth.telegram.org', '9988776655', 1, ?)
  `).run(NOW.toISOString());
  assert.throws(
    () => createLocalAuthenticator(db, credential, { clock: () => NOW }),
    /conflicts with the local credential identity/,
  );
  assert.deepEqual({
    ...db.prepare('SELECT issuer, subject, credential_fingerprint FROM configured_editors').get(),
  }, {
    issuer: 'https://oauth.telegram.org',
    subject: '9988776655',
    credential_fingerprint: null,
  });
  db.close();
});

test('credential rotation preserves the singleton editor and revokes active sessions once', () => {
  const db = openDatabase(':memory:');
  const firstCredential = createLocalCredential({
    username: 'editor',
    passwordHash: passwordRecord({ digest: Buffer.alloc(32, 3) }),
  });
  const first = createLocalAuthenticator(db, firstCredential, { clock: () => NOW });
  const sessions = createSessionService(db, { clock: () => NOW });
  const session = sessions.create(first.editorId);
  createLocalAuthenticator(db, firstCredential, { clock: () => NOW });
  assert.ok(sessions.authenticate(sessionCookie(session.token)));

  const rotationTime = new Date(NOW.valueOf() + 1000);
  const rotatedCredential = createLocalCredential({
    username: 'editor',
    passwordHash: passwordRecord({ digest: Buffer.alloc(32, 4) }),
  });
  const rotated = createLocalAuthenticator(db, rotatedCredential, { clock: () => rotationTime });
  assert.equal(rotated.editorId, first.editorId);
  assert.equal(sessions.authenticate(sessionCookie(session.token)), null);
  assert.deepEqual({ ...db.prepare(`
    SELECT revoked_at, revocation_reason FROM admin_sessions
  `).get() }, {
    revoked_at: rotationTime.toISOString(),
    revocation_reason: 'credential-rotated',
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM configured_editors').get().count, 1);
  db.close();
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
    OKNOTIKA_LOCAL_USERNAME_FILE: `${root}/local-username`,
    OKNOTIKA_LOCAL_PASSWORD_HASH_FILE: `${root}/local-password-hash`,
    OKNOTIKA_WEEKLY_INGEST_TOKEN: 'weekly-ingestion-token-for-tests-1234567890',
    OKNOTIKA_DATABASE_PATH: `${root}/db/admin.sqlite`,
    OKNOTIKA_UPLOADS_ROOT: `${root}/uploads`,
    OKNOTIKA_PREVIEWS_ROOT: `${root}/previews`,
    OKNOTIKA_ARTICLE_RELEASES_ROOT: `${root}/article-releases`,
    OKNOTIKA_PUBLIC_ROOT: `${root}/public`,
  };
}

function writeLocalCredentialFiles(root) {
  const usernameFile = `${root}/local-username`;
  const passwordHashFile = `${root}/local-password-hash`;
  writeFileSync(usernameFile, 'editor\n', { mode: 0o600 });
  writeFileSync(passwordHashFile, `${VALID_PASSWORD_HASH}\n`, { mode: 0o600 });
  return { usernameFile, passwordHashFile };
}

function passwordRecord({
  N = 32768,
  r = 8,
  p = 1,
  salt = TEST_SALT,
  digest = TEST_DIGEST,
} = {}) {
  return `scrypt$v=1$N=${N},r=${r},p=${p}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
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
