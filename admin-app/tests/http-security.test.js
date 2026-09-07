import assert from 'node:assert/strict';
import { readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createLoginCsrfService, LOGIN_CSRF_COOKIE } from '../src/auth/login.js';
import { createLocalAuthenticator, createLocalCredential, hashLocalPassword } from '../src/auth/local.js';
import { createSessionService, sessionCookie } from '../src/auth/sessions.js';
import { createAdminActions } from '../src/http/admin-actions.js';
import { createAdminHandler } from '../src/http/handler.js';
import { createProxiedRequest } from '../src/http/node-adapter.js';
import { assertMutationRequest, assertTrustedProxyHeaders } from '../src/http/security.js';
import { createPublisher } from '../src/render/publisher.js';
import { articleInput, createHarness, weeklyIngestionInput } from './helpers.js';

const ADMIN_ORIGIN = 'https://admin.oknotika.ru';

test('article listing preserves a legacy source written after the multi-source migration', (t) => {
  const harness = createHarness(t);
  const created = harness.service.createArticle(
    articleInput(harness.coverAssetId),
    harness.editorId,
  );
  const legacyRevisionId = Number(harness.db.prepare(`
    INSERT INTO article_revisions
      (article_id, revision_number, title, publication_at, lead, body_markdown,
       cover_asset_id, cover_alt, source_url, created_by, created_at)
    VALUES (?, 2, 'Legacy rollback edit', '2026-07-14T00:00:00.000Z', 'Lead', 'Body',
            ?, 'Cover', 'https://example.com/rollback-source', ?,
            '2026-07-14T00:00:00.000Z')
  `).run(created.articleId, harness.coverAssetId, harness.editorId).lastInsertRowid);
  harness.db.prepare(`
    UPDATE articles SET current_revision_id = ?, updated_at = ?
    WHERE id = ?
  `).run(legacyRevisionId, '2026-07-14T00:00:00.000Z', created.articleId);
  const actions = createAdminActions({
    db: harness.db,
    contentService: harness.service,
    publicOrigin: 'https://oknotika.ru',
  });

  const listed = actions.listArticles()[0];
  assert.deepEqual(listed.source_urls, [
    'https://example.com/rollback-source',
  ]);
  assert.equal(listed.deletion_eligible, true);

  harness.db.prepare(`
    INSERT INTO audit_events (event_type, article_id, created_at)
    VALUES ('article.published', ?, '2026-07-14T00:00:00.000Z')
  `).run(created.articleId);
  assert.equal(actions.listArticles()[0].deletion_eligible, false);
});

test('Node adapter authenticates before buffering and applies route-specific body limits', async () => {
  const unauthenticated = fakeIncoming({
    url: '/api/uploads',
    body: Buffer.alloc(10 * 1024 * 1024),
    headers: mutationHeaders({ contentType: 'image/png', contentLength: 10 * 1024 * 1024 }),
  });
  const rejected = await createProxiedRequest(unauthenticated, {
    adminOrigin: ADMIN_ORIGIN,
    sessionService: { authenticate: () => null },
  });
  assert.equal(rejected.body, null);
  assert.equal(unauthenticated.iterated, false);
  assert.equal(unauthenticated.resumed, true);

  const authenticatedSessionService = {
    authenticate: () => ({ csrf_hash: 'unused' }),
    verifyCsrf: () => true,
  };
  const oversizedJson = fakeIncoming({
    url: '/api/articles',
    body: Buffer.from('{}'),
    headers: mutationHeaders({ contentType: 'application/json', contentLength: 1024 * 1024 + 1 }),
  });
  await assert.rejects(
    createProxiedRequest(oversizedJson, {
      adminOrigin: ADMIN_ORIGIN,
      sessionService: authenticatedSessionService,
    }),
    (error) => error.code === 'REQUEST_TOO_LARGE',
  );
  assert.equal(oversizedJson.iterated, false);

  const upload = fakeIncoming({
    url: '/api/uploads',
    body: Buffer.from([0x89, 0x50]),
    headers: mutationHeaders({ contentType: 'image/png', contentLength: 2 }),
  });
  const accepted = await createProxiedRequest(upload, {
    adminOrigin: ADMIN_ORIGIN,
    sessionService: authenticatedSessionService,
  });
  assert.deepEqual(Buffer.from(await accepted.arrayBuffer()), Buffer.from([0x89, 0x50]));
  assert.equal(upload.iterated, true);

  const socialLinks = fakeIncoming({
    url: '/api/social-links',
    body: Buffer.from('{}'),
    headers: mutationHeaders({ contentType: 'application/json', contentLength: 2 }),
  });
  const acceptedSocialLinks = await createProxiedRequest(socialLinks, {
    adminOrigin: ADMIN_ORIGIN,
    sessionService: authenticatedSessionService,
  });
  assert.equal(await acceptedSocialLinks.text(), '{}');
  assert.equal(socialLinks.iterated, true);

  const deleteBody = Buffer.from('{"expectedRevisionId":23,"confirmation":"DELETE_FOREVER"}');
  const deleteDraft = fakeIncoming({
    url: '/api/articles/17/delete',
    body: deleteBody,
    headers: mutationHeaders({ contentType: 'application/json', contentLength: deleteBody.length }),
  });
  const acceptedDelete = await createProxiedRequest(deleteDraft, {
    adminOrigin: ADMIN_ORIGIN,
    sessionService: authenticatedSessionService,
  });
  assert.equal(
    await acceptedDelete.text(),
    '{"expectedRevisionId":23,"confirmation":"DELETE_FOREVER"}',
  );
  assert.equal(deleteDraft.iterated, true);

  const loginBody = Buffer.from('csrf=token&username=editor&password=private');
  const login = fakeIncoming({
    url: '/login',
    body: loginBody,
    headers: loginHeaders(loginBody.length),
  });
  const acceptedLogin = await createProxiedRequest(login, {
    adminOrigin: ADMIN_ORIGIN,
    sessionService: { authenticate: () => null },
  });
  assert.deepEqual(Buffer.from(await acceptedLogin.arrayBuffer()), loginBody);
  assert.equal(login.iterated, true);

  const originNullLogin = fakeIncoming({
    url: '/login',
    body: loginBody,
    headers: loginHeaders(loginBody.length, {
      origin: 'null',
      cookie: `${LOGIN_CSRF_COOKIE}=browser-binding-for-test`,
    }),
  });
  const acceptedOriginNullLogin = await createProxiedRequest(originNullLogin, {
    adminOrigin: ADMIN_ORIGIN,
    sessionService: { authenticate: () => null },
  });
  assert.deepEqual(Buffer.from(await acceptedOriginNullLogin.arrayBuffer()), loginBody);
  assert.equal(originNullLogin.iterated, true);

  for (const [label, overrides] of [
    ['cross-site Origin null login', { origin: 'null', 'sec-fetch-site': 'cross-site' }],
    ['none-site Origin null login', { origin: 'null', 'sec-fetch-site': 'none' }],
    ['missing-site Origin null login', { origin: 'null', 'sec-fetch-site': null }],
    ['wrong-mode Origin null login', { origin: 'null', 'sec-fetch-mode': 'cors' }],
    ['missing-mode Origin null login', { origin: 'null', 'sec-fetch-mode': null }],
    ['arbitrary-origin login', { origin: 'https://evil.example' }],
  ]) {
    const blockedLogin = fakeIncoming({
      url: '/login',
      body: loginBody,
      headers: loginHeaders(loginBody.length, overrides),
    });
    const discardedOriginNullLogin = await createProxiedRequest(blockedLogin, {
      adminOrigin: ADMIN_ORIGIN,
      sessionService: { authenticate: () => null },
    });
    assert.equal(discardedOriginNullLogin.body, null, label);
    assert.equal(blockedLogin.iterated, false, label);
    assert.equal(blockedLogin.resumed, true, label);
  }

  const crossSiteLogin = fakeIncoming({
    url: '/login',
    body: loginBody,
    headers: loginHeaders(loginBody.length, { origin: 'https://evil.example' }),
  });
  const discardedLogin = await createProxiedRequest(crossSiteLogin, {
    adminOrigin: ADMIN_ORIGIN,
    sessionService: { authenticate: () => null },
  });
  assert.equal(discardedLogin.body, null);
  assert.equal(crossSiteLogin.iterated, false);
  assert.equal(crossSiteLogin.resumed, true);

  const oversizedLogin = fakeIncoming({
    url: '/login',
    body: Buffer.alloc(4097),
    headers: loginHeaders(4097),
  });
  await assert.rejects(
    createProxiedRequest(oversizedLogin, {
      adminOrigin: ADMIN_ORIGIN,
      sessionService: { authenticate: () => null },
    }),
    (error) => error.code === 'REQUEST_TOO_LARGE',
  );
  assert.equal(oversizedLogin.iterated, false);
  assert.equal(oversizedLogin.resumed, true);
});

test('Unix-socket proxy headers must be single-valued and match the canonical origin', () => {
  const valid = new Headers({
    host: 'admin.oknotika.ru',
    'x-forwarded-host': 'admin.oknotika.ru',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.17',
  });
  assert.doesNotThrow(() => assertTrustedProxyHeaders(valid, ADMIN_ORIGIN));
  for (const changed of [
    { host: 'evil.example' },
    { 'x-forwarded-host': 'evil.example' },
    { 'x-forwarded-proto': 'http' },
    { 'x-forwarded-for': '203.0.113.17, 127.0.0.1' },
  ]) {
    assert.throws(
      () => assertTrustedProxyHeaders(new Headers({ ...Object.fromEntries(valid), ...changed }), ADMIN_ORIGIN),
      /Trusted proxy/,
    );
  }
});

test('mutations require session-bound CSRF, exact Origin and same-origin Fetch Metadata', (t) => {
  const harness = createHarness(t);
  const sessions = createSessionService(harness.db);
  const created = sessions.create(harness.editorId);
  const session = sessions.authenticate(sessionCookie(created.token));
  const valid = mutationRequest({ csrf: created.csrfToken });
  assert.doesNotThrow(() => assertMutationRequest(valid, {
    adminOrigin: ADMIN_ORIGIN, session, sessionService: sessions,
  }));
  for (const request of [
    mutationRequest({ origin: 'https://evil.example', csrf: created.csrfToken }),
    mutationRequest({ site: 'cross-site', csrf: created.csrfToken }),
    mutationRequest({ csrf: 'attacker-token' }),
    mutationRequest({ csrf: null }),
  ]) {
    assert.throws(() => assertMutationRequest(request, {
      adminOrigin: ADMIN_ORIGIN, session, sessionService: sessions,
    }), /Origin|Fetch Metadata|CSRF/);
  }
});

test('local login form creates an authenticated session that can use the API and log out', async (t) => {
  let now = new Date('2026-07-14T12:00:00.000Z');
  const fixture = await createLocalLoginFixture(t, { clock: () => now });
  const challenge = await requestLoginChallenge(fixture.handler);
  assert.match(challenge.html, /<form class="login-form" method="post" action="\/login">/);
  assert.match(challenge.html, /name="username" type="text" autocomplete="username"/);
  assert.match(challenge.html, /name="password" type="password" autocomplete="current-password"/);
  assert.doesNotMatch(challenge.html, /Telegram|\/auth\/start|\/auth\/callback/);
  assert.match(challenge.setCookie, new RegExp(`^${LOGIN_CSRF_COOKIE}=`));
  assert.match(challenge.setCookie, /; Secure;/);
  assert.match(challenge.setCookie, /; HttpOnly;/);
  assert.match(challenge.setCookie, /; SameSite=Strict$/);

  const loggedIn = await submitLogin(fixture.handler, challenge, {
    username: fixture.username,
    password: fixture.password,
  });
  assert.equal(loggedIn.status, 303);
  assert.equal(loggedIn.headers.get('location'), '/');
  const responseCookies = loggedIn.headers.getSetCookie();
  const sessionSetCookie = responseCookies.find(value => value.startsWith('__Host-oknotika_session='));
  assert.ok(sessionSetCookie);
  assert.match(sessionSetCookie, /; Path=\/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax$/);
  assert.ok(responseCookies.some(value => value.startsWith(`${LOGIN_CSRF_COOKIE}=`) && value.includes('Max-Age=0')));
  const cookie = cookiePair(sessionSetCookie);
  assert.equal((await fixture.handler(new Request(`${ADMIN_ORIGIN}/api/articles`, {
    headers: { cookie },
  }))).status, 200);
  assert.equal((await fixture.handler(new Request(`${ADMIN_ORIGIN}/login`, {
    headers: { cookie },
  }))).headers.get('location'), '/');
  assert.equal((await fixture.handler(new Request(`${ADMIN_ORIGIN}/api/articles`, {
    headers: { cookie: `${cookie}; ${cookie}` },
  }))).status, 401);

  const dashboard = await fixture.handler(new Request(`${ADMIN_ORIGIN}/`, { headers: { cookie } }));
  const sessionCsrf = /<meta name="csrf-token" content="([^"]+)">/.exec(await dashboard.text())?.[1];
  assert.ok(sessionCsrf);
  const logout = await fixture.handler(new Request(`${ADMIN_ORIGIN}/logout`, {
    method: 'POST',
    headers: {
      cookie,
      origin: ADMIN_ORIGIN,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'x-csrf-token': sessionCsrf,
    },
  }));
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get('set-cookie'), /__Host-oknotika_session=.*Max-Age=0/);
  assert.equal((await fixture.handler(new Request(`${ADMIN_ORIGIN}/api/articles`, {
    headers: { cookie },
  }))).status, 401);

  const secondChallenge = await requestLoginChallenge(fixture.handler);
  const secondLogin = await submitLogin(fixture.handler, secondChallenge, {
    username: fixture.username,
    password: fixture.password,
  });
  const secondCookie = cookiePair(secondLogin.headers.getSetCookie()
    .find(value => value.startsWith('__Host-oknotika_session=')));
  now = new Date(now.valueOf() + 31 * 60 * 1000);
  assert.equal((await fixture.handler(new Request(`${ADMIN_ORIGIN}/api/articles`, {
    headers: { cookie: secondCookie },
  }))).status, 401);
});

test('favicon probe cannot rotate the browser-bound login challenge', async (t) => {
  const fixture = await createLocalLoginFixture(t);
  const challenge = await requestLoginChallenge(fixture.handler);
  const favicon = await fixture.handler(new Request(`${ADMIN_ORIGIN}/favicon.ico`, {
    headers: {
      cookie: challenge.cookie,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'no-cors',
    },
  }));
  assert.equal(favicon.status, 204);
  assert.equal(favicon.headers.get('location'), null);
  assert.deepEqual(favicon.headers.getSetCookie(), []);

  const loggedIn = await submitLogin(fixture.handler, challenge, {
    username: fixture.username,
    password: fixture.password,
  }, { origin: 'null' });
  assert.equal(loggedIn.status, 303);
  assert.equal(loggedIn.headers.get('location'), '/');
});

test('local login accepts Origin null only for same-origin navigate and still consumes CSRF', async (t) => {
  const fixture = await createLocalLoginFixture(t);
  const challenge = await requestLoginChallenge(fixture.handler);
  const loggedIn = await submitLogin(fixture.handler, challenge, {
    username: fixture.username,
    password: fixture.password,
  }, { origin: 'null' });
  assert.equal(loggedIn.status, 303);
  assert.equal(loggedIn.headers.get('location'), '/');
  assert.ok(loggedIn.headers.getSetCookie().some(value => value.startsWith('__Host-oknotika_session=')));

  const replay = await submitLogin(fixture.handler, challenge, {
    username: fixture.username,
    password: fixture.password,
  }, { origin: 'null' });
  assert.equal(replay.status, 403);

  const missingCookie = await requestLoginChallenge(fixture.handler);
  const missingCookieResponse = await submitLogin(fixture.handler, {
    ...missingCookie,
    cookie: '',
  }, { username: fixture.username, password: fixture.password }, { origin: 'null' });
  assert.equal(missingCookieResponse.status, 403);

  for (const [label, metadata] of [
    ['cross-site Origin null login', { origin: 'null', site: 'cross-site' }],
    ['none-site Origin null login', { origin: 'null', site: 'none' }],
    ['missing-site Origin null login', { origin: 'null', site: null }],
    ['wrong-mode Origin null login', { origin: 'null', mode: 'cors' }],
    ['missing-mode Origin null login', { origin: 'null', mode: null }],
    ['arbitrary-origin login', { origin: 'https://evil.example' }],
  ]) {
    const blockedChallenge = await requestLoginChallenge(fixture.handler);
    const response = await submitLogin(fixture.handler, blockedChallenge, {
      username: fixture.username,
      password: fixture.password,
    }, metadata);
    assert.equal(response.status, 403, label);
    assert.match(await response.text(), /Запрос на вход недействителен/, label);
  }
});

test('local login returns generic credential errors and rejects CSRF replay or cookie failures', async (t) => {
  const fixture = await createLocalLoginFixture(t);
  for (const supplied of [
    { username: 'unknown-editor', password: fixture.password },
    { username: fixture.username, password: 'incorrect-password-value' },
  ]) {
    const challenge = await requestLoginChallenge(fixture.handler);
    const response = await submitLogin(fixture.handler, challenge, supplied);
    assert.equal(response.status, 401);
    const html = await response.text();
    assert.match(html, /Неверный логин или пароль/);
    assert.doesNotMatch(html, new RegExp(supplied.username));
    assert.doesNotMatch(html, new RegExp(supplied.password));
    assert.equal(response.headers.get('location'), null);
    assert.ok(response.headers.getSetCookie().some(value => value.startsWith(`${LOGIN_CSRF_COOKIE}=`)));
  }

  const missingCookie = await requestLoginChallenge(fixture.handler);
  const missingCookieResponse = await submitLogin(fixture.handler, {
    ...missingCookie,
    cookie: '',
  }, { username: fixture.username, password: fixture.password });
  assert.equal(missingCookieResponse.status, 403);

  const duplicateCookie = await requestLoginChallenge(fixture.handler);
  const duplicateCookieResponse = await submitLogin(fixture.handler, {
    ...duplicateCookie,
    cookie: `${duplicateCookie.cookie}; ${duplicateCookie.cookie}`,
  }, { username: fixture.username, password: fixture.password });
  assert.equal(duplicateCookieResponse.status, 403);

  const mismatchedToken = await requestLoginChallenge(fixture.handler);
  const mismatchedTokenResponse = await submitLogin(fixture.handler, {
    ...mismatchedToken,
    csrfToken: 'A'.repeat(43),
  }, { username: fixture.username, password: fixture.password });
  assert.equal(mismatchedTokenResponse.status, 403);

  const replayed = await requestLoginChallenge(fixture.handler);
  const firstAttempt = await submitLogin(fixture.handler, replayed, {
    username: fixture.username,
    password: 'incorrect-password-value',
  });
  assert.equal(firstAttempt.status, 401);
  const replay = await submitLogin(fixture.handler, replayed, {
    username: fixture.username,
    password: fixture.password,
  });
  assert.equal(replay.status, 403);

  for (const metadata of [
    { origin: 'https://evil.example' },
    { site: 'cross-site' },
    { mode: 'cors' },
  ]) {
    const crossSite = await requestLoginChallenge(fixture.handler);
    const crossSiteResponse = await submitLogin(fixture.handler, crossSite, {
      username: fixture.username,
      password: fixture.password,
    }, metadata);
    assert.equal(crossSiteResponse.status, 403);
    assert.match(await crossSiteResponse.text(), /Запрос на вход недействителен/);
  }
});

test('optimistic revision checks reject stale forms and actions emit audit events', async (t) => {
  const harness = createHarness(t);
  const created = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
  const revised = harness.service.reviseArticle(
    created.articleId,
    articleInput(harness.coverAssetId, { title: 'Вторая редакция' }),
    harness.editorId,
    { expectedRevisionId: created.revisionId },
  );
  assert.throws(
    () => harness.service.reviseArticle(
      created.articleId,
      articleInput(harness.coverAssetId, { title: 'Перезапись устаревшей формы' }),
      harness.editorId,
      { expectedRevisionId: created.revisionId },
    ),
    /Revision conflict/,
  );
  const publisher = createPublisher(harness.db, {
    releasesRoot: resolve(harness.root, 'article-releases'),
    publicOrigin: 'https://oknotika.ru',
    clock: () => new Date('2026-07-14T12:00:00.000Z'),
  });
  const actions = createAdminActions({
    db: harness.db,
    contentService: harness.service,
    publisher,
    uploadStore: { store: async () => ({}) },
    previewsRoot: `${harness.root}/previews`,
    publicOrigin: 'https://oknotika.ru',
  });
  await assert.rejects(
    actions.publish(created.articleId, revised.revisionId, harness.editorId, 'yes'),
    /Explicit PUBLISH/,
  );
  assert.match((await actions.publish(
    created.articleId, revised.revisionId, harness.editorId, 'PUBLISH',
  )).releaseId, /^20260714120000-/);
  assert.equal(harness.service.getArticle(created.articleId).state, 'published');
  assert.equal(
    harness.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'article.published'").get().count,
    1,
  );
  await assert.rejects(
    actions.withdraw(created.articleId, revised.revisionId, harness.editorId, 'PUBLISH'),
    /Explicit WITHDRAW/,
  );
});

test('authenticated draft deletion route requires exact confirmation and surfaces not-found', async (t) => {
  const harness = createHarness(t);
  const created = harness.service.createArticle(
    articleInput(harness.coverAssetId),
    harness.editorId,
  );
  const sessions = createSessionService(harness.db);
  const createdSession = sessions.create(harness.editorId);
  const cookie = sessionCookie(createdSession.token);
  const actions = createAdminActions({
    db: harness.db,
    contentService: harness.service,
    publicOrigin: 'https://oknotika.ru',
  });
  const handler = createAdminHandler({
    adminOrigin: ADMIN_ORIGIN,
    sessionService: sessions,
    actions,
  });
  const mutate = (body) => handler(new Request(
    `${ADMIN_ORIGIN}/api/articles/${created.articleId}/delete`,
    {
      method: 'POST',
      headers: {
        cookie,
        origin: ADMIN_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'x-csrf-token': createdSession.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  ));

  const dashboard = await handler(new Request(`${ADMIN_ORIGIN}/`, { headers: { cookie } }));
  assert.match(
    await dashboard.text(),
    new RegExp(`data-action="delete" data-id="${created.articleId}"[^>]*>Удалить навсегда`),
  );

  const wrongConfirmation = await mutate({
    expectedRevisionId: created.revisionId,
    confirmation: 'DELETE',
  });
  assert.equal(wrongConfirmation.status, 400);
  assert.match((await wrongConfirmation.json()).error, /DELETE_FOREVER/);

  const missingRevision = await mutate({ confirmation: 'DELETE_FOREVER' });
  assert.equal(missingRevision.status, 400);
  assert.match((await missingRevision.json()).error, /expectedRevisionId/);

  const staleRevision = await mutate({
    expectedRevisionId: created.revisionId + 1,
    confirmation: 'DELETE_FOREVER',
  });
  assert.equal(staleRevision.status, 400);
  assert.match((await staleRevision.json()).error, /Revision conflict/);

  const deleted = await mutate({
    expectedRevisionId: created.revisionId,
    confirmation: 'DELETE_FOREVER',
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    (({ status, articleId }) => ({ status, articleId }))(await deleted.json()),
    { status: 'deleted', articleId: created.articleId },
  );

  const repeated = await mutate({
    expectedRevisionId: created.revisionId,
    confirmation: 'DELETE_FOREVER',
  });
  assert.equal(repeated.status, 404);
  assert.deepEqual(await repeated.json(), {
    status: 'not_found',
    articleId: created.articleId,
    error: 'Draft not found',
  });
});

test('admin handler keeps XSS escaped and rejects raw HTML through authenticated API', async (t) => {
  const harness = createHarness(t);
  const sessions = createSessionService(harness.db);
  const createdSession = sessions.create(harness.editorId);
  const cookie = sessionCookie(createdSession.token);
  const article = harness.service.createArticle(articleInput(harness.coverAssetId, {
    title: '<img src=x onerror=alert(1)>',
  }), harness.editorId);
  assert.ok(article.articleId);
  const actions = createAdminActions({
    db: harness.db,
    contentService: harness.service,
    publisher: { publish: async () => ({}), rollback: async () => ({}) },
    uploadStore: { store: async () => ({}) },
    previewsRoot: `${harness.root}/previews`,
    publicOrigin: 'https://oknotika.ru',
  });
  const handler = createAdminHandler({
    adminOrigin: ADMIN_ORIGIN,
    sessionService: sessions,
    actions,
    previewsRoot: `${harness.root}/previews`,
  });
  const dashboard = await handler(new Request(`${ADMIN_ORIGIN}/`, { headers: { cookie } }));
  const html = await dashboard.text();
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);

  const invalid = articleInput(harness.coverAssetId, { bodyMarkdown: '<script>alert(1)</script>' });
  const response = await handler(new Request(`${ADMIN_ORIGIN}/api/articles`, {
    method: 'POST',
    headers: {
      cookie,
      origin: ADMIN_ORIGIN,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'x-csrf-token': createdSession.csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(invalid),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /raw HTML/);
});

test('weekly draft can be edited after Tuesday ingestion and manually published Friday from the admin', async (t) => {
  const harness = createHarness(t, {
    clock: () => new Date('2026-07-28T09:00:00.000Z'),
  });
  const ingested = harness.service.ingestWeeklyDraft(weeklyIngestionInput(harness.coverAssetId));
  const sessions = createSessionService(harness.db);
  const createdSession = sessions.create(harness.editorId);
  const cookie = sessionCookie(createdSession.token);
  const publisher = createPublisher(harness.db, {
    releasesRoot: resolve(harness.root, 'friday-releases'),
    publicOrigin: 'https://oknotika.ru',
    clock: () => new Date('2026-07-31T15:00:00.000Z'),
  });
  const actions = createAdminActions({
    db: harness.db,
    contentService: harness.service,
    publisher,
    uploadStore: { store: async () => ({}) },
    previewsRoot: `${harness.root}/friday-previews`,
    publicOrigin: 'https://oknotika.ru',
  });
  const handler = createAdminHandler({
    adminOrigin: ADMIN_ORIGIN,
    sessionService: sessions,
    actions,
    previewsRoot: `${harness.root}/friday-previews`,
  });
  const mutate = (path, body) => handler(new Request(`${ADMIN_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      cookie,
      origin: ADMIN_ORIGIN,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'x-csrf-token': createdSession.csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }));

  const draftDashboard = await handler(new Request(`${ADMIN_ORIGIN}/`, { headers: { cookie } }));
  const draftHtml = await draftDashboard.text();
  assert.match(draftHtml, /<h1>Новости<\/h1>/);
  assert.match(draftHtml, /Дайджест недели/);
  assert.match(draftHtml, /2026-W31/);
  assert.match(draftHtml, />Черновик</);
  assert.match(draftHtml, />Предпросмотр</);
  assert.match(draftHtml, /Последнее изменение:/);
  assert.match(draftHtml, /Telegram: настроен/);
  assert.match(draftHtml, /YouTube: настроен/);
  assert.match(draftHtml, /VK: настроен/);
  assert.match(draftHtml, /FUTUCHAT: настроен/);
  assert.match(draftHtml, /data-action="delete"[^>]*>Удалить навсегда</);
  assert.doesNotMatch(draftHtml, /Operational rollback|data-action="rollback"/);

  const loadedSocial = await (await handler(new Request(`${ADMIN_ORIGIN}/api/social-links`, {
    headers: { cookie },
  }))).json();
  assert.deepEqual({
    telegramUrl: loadedSocial.telegramUrl,
    youtubeUrl: loadedSocial.youtubeUrl,
    vkUrl: loadedSocial.vkUrl,
    futuchatUrl: loadedSocial.futuchatUrl,
  }, {
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: 'https://youtube.com/@oknotika',
    vkUrl: 'https://vk.ru/oknotika',
    futuchatUrl: 'https://t.me/FUTU_CHAT',
  });

  const listed = await (await handler(new Request(`${ADMIN_ORIGIN}/api/articles`, {
    headers: { cookie },
  }))).json();
  assert.deepEqual(listed.articles[0].source_urls, [
    'https://example.com/news/one',
    'https://example.org/news/two',
  ]);

  const editedArticle = weeklyIngestionInput(harness.coverAssetId, {
    article: {
      title: 'Дайджест недели: проверено редактором',
      lead: 'Проверенные главные новости оконной отрасли.',
      sourceUrls: [
        'https://example.com/news/one',
        'https://example.org/news/two',
        'https://example.net/news/three',
      ],
    },
  }).article;
  const revisedResponse = await mutate(`/api/articles/${ingested.articleId}/revisions`, {
    article: editedArticle,
    expectedRevisionId: ingested.revisionId,
  });
  assert.equal(revisedResponse.status, 201);
  const revised = await revisedResponse.json();
  assert.notEqual(revised.revisionId, ingested.revisionId);
  assert.equal(
    harness.db.prepare('SELECT current_revision_id FROM articles WHERE id = ?').get(ingested.articleId)
      .current_revision_id,
    revised.revisionId,
  );

  const socialResponse = await mutate('/api/social-links', {
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: 'https://youtube.com/@oknotika',
    vkUrl: 'https://vk.ru/oknotika',
    futuchatUrl: 'https://t.me/FUTU_CHAT',
    confirmation: 'SOCIAL_LINKS',
  });
  assert.equal(socialResponse.status, 200);
  assert.deepEqual(
    (({ telegramUrl, youtubeUrl, vkUrl, futuchatUrl }) => ({
      telegramUrl, youtubeUrl, vkUrl, futuchatUrl,
    }))(await socialResponse.json()),
    {
      telegramUrl: 'https://t.me/oknotika',
      youtubeUrl: 'https://youtube.com/@oknotika',
      vkUrl: 'https://vk.ru/oknotika',
      futuchatUrl: 'https://t.me/FUTU_CHAT',
    },
  );
  const socialAudit = harness.db.prepare(`
    SELECT details_json FROM audit_events
    WHERE event_type = 'social_links.updated'
    ORDER BY id DESC LIMIT 1
  `).get();
  assert.deepEqual(JSON.parse(socialAudit.details_json), {
    telegramConfigured: true,
    youtubeConfigured: true,
    vkConfigured: true,
    futuchatConfigured: true,
  });

  const publishResponse = await mutate(`/api/articles/${ingested.articleId}/publish`, {
    expectedRevisionId: revised.revisionId,
    confirmation: 'PUBLISH',
  });
  assert.equal(publishResponse.status, 200);
  assert.match((await publishResponse.json()).releaseId, /^20260731150000-/);

  const publishedDashboard = await handler(new Request(`${ADMIN_ORIGIN}/`, { headers: { cookie } }));
  const publishedHtml = await publishedDashboard.text();
  assert.match(publishedHtml, />Опубликовано</);
  assert.match(publishedHtml, /https:\/\/oknotika\.ru\/articles\/[^/]+\/</);
  assert.match(publishedHtml, /YouTube: настроен/);
  assert.match(publishedHtml, /FUTUCHAT: настроен/);
  assert.doesNotMatch(publishedHtml, /data-action="delete"/);
  assert.equal(harness.service.getArticle(ingested.articleId).state, 'published');

  let activeDirectory = resolve(
    harness.root,
    'friday-releases',
    readlinkSync(publisher.activePath),
  );
  let publicHtml = readFileSync(
    resolve(activeDirectory, `articles/${ingested.slug}/index.html`),
    'utf8',
  );
  for (const destination of [
    'https://t.me/oknotika',
    'https://youtube.com/@oknotika',
    'https://vk.ru/oknotika',
    'https://t.me/FUTU_CHAT',
  ]) {
    assert.match(publicHtml, new RegExp(destination.replaceAll('.', '\\.')));
  }

  const updatedSocial = await mutate('/api/social-links', {
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: 'https://youtube.com/@oknotika-updated',
    vkUrl: '',
    futuchatUrl: '',
    confirmation: 'SOCIAL_LINKS',
  });
  assert.equal(updatedSocial.status, 200);
  activeDirectory = resolve(
    harness.root,
    'friday-releases',
    readlinkSync(publisher.activePath),
  );
  publicHtml = readFileSync(
    resolve(activeDirectory, `articles/${ingested.slug}/index.html`),
    'utf8',
  );
  assert.match(publicHtml, /https:\/\/youtube\.com\/@oknotika-updated/);
  assert.doesNotMatch(publicHtml, /https:\/\/vk\.(?:com|ru)\/oknotika|https:\/\/t\.me\/FUTU_CHAT/);
});

test('admin handler removes OIDC routes and preserves editor lifecycle, preview, upload and logout', async (t) => {
  let tick = 0;
  const harness = createHarness(t, {
    clock: () => new Date(Date.parse('2026-07-14T00:00:00.000Z') + tick++ * 1000),
  });
  const sessions = createSessionService(harness.db);
  const publisher = createPublisher(harness.db, {
    releasesRoot: resolve(harness.root, 'handler-releases'),
    publicOrigin: 'https://oknotika.ru',
    clock: () => new Date(Date.parse('2026-07-15T00:00:00.000Z') + tick++ * 1000),
  });
  const previewsRoot = resolve(harness.root, 'handler-previews');
  const actions = createAdminActions({
    db: harness.db,
    contentService: harness.service,
    publisher,
    uploadStore: {
      store: async () => ({
        uploadId: 7, assetId: harness.coverAssetId, mediaType: 'image/png', width: 1, height: 1,
      }),
    },
    previewsRoot,
    publicOrigin: 'https://oknotika.ru',
  });
  const handler = createAdminHandler({
    adminOrigin: ADMIN_ORIGIN,
    sessionService: sessions,
    actions,
    previewsRoot,
  });

  const start = await handler(new Request(`${ADMIN_ORIGIN}/auth/start`, {
    headers: { 'sec-fetch-site': 'same-origin' },
  }));
  assert.equal(start.status, 303);
  assert.equal(start.headers.get('location'), '/login');
  assert.equal(start.headers.get('set-cookie'), null);
  const callback = await handler(new Request(`${ADMIN_ORIGIN}/auth/callback?code=one&state=test`, {
    headers: { cookie: `__Host-oknotika_oidc=${'b'.repeat(43)}` },
  }));
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/login');
  assert.equal(callback.headers.get('set-cookie'), null);

  const createdSession = sessions.create(harness.editorId);
  const cookie = sessionCookie(createdSession.token);
  const mutate = (path, body, { contentType = 'application/json' } = {}) => handler(new Request(`${ADMIN_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      cookie,
      origin: ADMIN_ORIGIN,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'x-csrf-token': createdSession.csrfToken,
      'content-type': contentType,
    },
    body,
  }));

  const createResponse = await mutate('/api/articles', JSON.stringify(articleInput(harness.coverAssetId)));
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  const reviseResponse = await mutate(`/api/articles/${created.articleId}/revisions`, JSON.stringify({
    article: articleInput(harness.coverAssetId, { title: 'Handler lifecycle revision' }),
    expectedRevisionId: created.revisionId,
  }));
  assert.equal(reviseResponse.status, 201);
  const revised = await reviseResponse.json();

  const previewResponse = await mutate(`/api/revisions/${revised.revisionId}/preview`, undefined, {
    contentType: 'text/plain',
  });
  assert.equal(previewResponse.status, 201);
  const { previewUrl } = await previewResponse.json();
  for (const filename of ['', 'cover.png', 'style.css', 'logo.svg']) {
    const asset = await handler(new Request(`${ADMIN_ORIGIN}${previewUrl}${filename}`, { headers: { cookie } }));
    assert.equal(asset.status, 200, filename || 'preview HTML');
    assert.equal(asset.headers.get('cache-control'), 'no-store');
    assert.match(asset.headers.get('x-robots-tag'), /noindex/);
    if (filename === '') {
      const previewHtml = await asset.text();
      assert.match(previewHtml, /class="article-digest"/);
      assert.match(previewHtml, /https:\/\/example\.com\/source/);
      assert.match(previewHtml, /https:\/\/t\.me\/oknotika/);
      assert.match(previewHtml, /https:\/\/t\.me\/FUTU_CHAT/);
    }
  }

  const publishedResponse = await mutate(`/api/articles/${created.articleId}/publish`, JSON.stringify({
    expectedRevisionId: revised.revisionId, confirmation: 'PUBLISH',
  }));
  assert.equal(publishedResponse.status, 200);
  const published = await publishedResponse.json();
  const withdrawnResponse = await mutate(`/api/articles/${created.articleId}/withdraw`, JSON.stringify({
    expectedRevisionId: revised.revisionId, confirmation: 'WITHDRAW',
  }));
  assert.equal(withdrawnResponse.status, 200);
  const withdrawn = await withdrawnResponse.json();
  assert.notEqual(withdrawn.releaseId, published.releaseId);
  const withdrawnDashboard = await handler(new Request(`${ADMIN_ORIGIN}/`, { headers: { cookie } }));
  assert.doesNotMatch(await withdrawnDashboard.text(), /data-action="delete"/);

  const restoreResponse = await mutate(`/api/articles/${created.articleId}/restore`, JSON.stringify({
    sourceRevisionId: created.revisionId,
    expectedRevisionId: revised.revisionId,
    confirmation: 'RESTORE',
  }));
  assert.equal(restoreResponse.status, 201);
  const restoredId = (await restoreResponse.json()).revisionId;
  assert.ok(restoredId);
  const restored = harness.db.prepare(`
    SELECT title, publication_at, body_markdown, cover_alt, restored_from_id
    FROM article_revisions WHERE id = ?
  `).get(restoredId);
  assert.deepEqual({ ...restored }, {
    title: 'Светопрозрачный фасад',
    publication_at: '2026-07-09T21:00:00.000Z',
    body_markdown: '1. Первая новость.\n\n2. Вторая новость.\n\n3. Третья новость.',
    cover_alt: 'Фасад здания',
    restored_from_id: created.revisionId,
  });
  assert.deepEqual(
    harness.db.prepare(`
      SELECT url FROM article_revision_sources
      WHERE revision_id = ? ORDER BY position
    `).all(restoredId).map(source => source.url),
    ['https://example.com/source'],
  );
  const restoredPreviewResponse = await mutate(
    `/api/revisions/${restoredId}/preview`,
    undefined,
    { contentType: 'text/plain' },
  );
  assert.equal(restoredPreviewResponse.status, 201);
  const restoredPreviewUrl = (await restoredPreviewResponse.json()).previewUrl;
  const restoredPreview = await handler(new Request(
    `${ADMIN_ORIGIN}${restoredPreviewUrl}`,
    { headers: { cookie } },
  ));
  assert.equal(restoredPreview.status, 200);
  const restoredPreviewHtml = await restoredPreview.text();
  assert.match(restoredPreviewHtml, /class="article-digest"/);
  assert.match(restoredPreviewHtml, /https:\/\/example\.com\/source/);
  const rollbackResponse = await mutate('/api/releases/rollback', JSON.stringify({
    releaseId: published.releaseId, confirmation: 'ROLLBACK',
  }));
  assert.equal(rollbackResponse.status, 404);

  const uploadResponse = await mutate('/api/uploads', Buffer.from([0x89, 0x50]), { contentType: 'image/png' });
  assert.equal(uploadResponse.status, 201);
  assert.equal((await uploadResponse.json()).assetId, harness.coverAssetId);
  assert.equal((await handler(new Request(`${ADMIN_ORIGIN}/api/articles`, { headers: { cookie } }))).status, 200);
  assert.equal((await handler(new Request(`${ADMIN_ORIGIN}/admin.js`, { headers: { cookie } }))).status, 200);
  const stylesheet = await handler(new Request(`${ADMIN_ORIGIN}/admin.css`));
  assert.equal(stylesheet.status, 200);
  assert.match(await stylesheet.text(), /@media \(max-width: 560px\)/);

  const logout = await mutate('/logout', undefined, { contentType: 'text/plain' });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

async function createLocalLoginFixture(t, {
  clock = () => new Date('2026-07-14T12:00:00.000Z'),
} = {}) {
  const harness = createHarness(t);
  harness.db.prepare('DELETE FROM configured_editors').run();
  const username = 'editor';
  const password = 'correct horse battery staple';
  const passwordHash = await hashLocalPassword(password, { salt: Buffer.alloc(16, 7) });
  const credential = createLocalCredential({ username, passwordHash });
  const localAuthenticator = createLocalAuthenticator(harness.db, credential, { clock });
  const loginCsrfService = createLoginCsrfService(harness.db, { clock });
  const sessionService = createSessionService(harness.db, { clock });
  const actions = {
    listArticles: () => [],
    getSocialLinks: () => ({
      telegramUrl: 'https://t.me/oknotika',
      youtubeUrl: null,
      vkUrl: null,
      futuchatUrl: null,
    }),
  };
  const handler = createAdminHandler({
    adminOrigin: ADMIN_ORIGIN,
    localAuthenticator,
    loginCsrfService,
    sessionService,
    actions,
  });
  return { handler, localAuthenticator, loginCsrfService, sessionService, username, password };
}

async function requestLoginChallenge(handler) {
  const response = await handler(new Request(`${ADMIN_ORIGIN}/login`));
  assert.equal(response.status, 200);
  const html = await response.text();
  const csrfToken = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const setCookie = response.headers.getSetCookie()
    .find(value => value.startsWith(`${LOGIN_CSRF_COOKIE}=`));
  assert.ok(csrfToken);
  assert.ok(setCookie);
  return { csrfToken, setCookie, cookie: cookiePair(setCookie), html };
}

function submitLogin(handler, challenge, { username, password }, {
  origin = ADMIN_ORIGIN,
  site = 'same-origin',
  mode = 'navigate',
} = {}) {
  const headers = { cookie: challenge.cookie };
  if (origin !== null) headers.origin = origin;
  if (site !== null) headers['sec-fetch-site'] = site;
  if (mode !== null) headers['sec-fetch-mode'] = mode;
  return handler(new Request(`${ADMIN_ORIGIN}/login`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ csrf: challenge.csrfToken, username, password }),
  }));
}

function cookiePair(setCookie) {
  return setCookie.split(';', 1)[0];
}

function mutationRequest({
  origin = ADMIN_ORIGIN,
  site = 'same-origin',
  mode = 'cors',
  csrf,
} = {}) {
  const headers = { origin, 'sec-fetch-site': site, 'sec-fetch-mode': mode };
  if (csrf !== null && csrf !== undefined) headers['x-csrf-token'] = csrf;
  return new Request(`${ADMIN_ORIGIN}/api/articles`, { method: 'POST', headers });
}

function mutationHeaders({ contentType, contentLength }) {
  return {
    cookie: '__Host-oknotika_session=session-token-value-for-test',
    origin: ADMIN_ORIGIN,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'x-csrf-token': 'csrf-token-for-test',
    'content-type': contentType,
    'content-length': String(contentLength),
  };
}

function loginHeaders(contentLength, overrides = {}) {
  const headers = {
    origin: ADMIN_ORIGIN,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': String(contentLength),
    ...overrides,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null || value === undefined) delete headers[name];
  }
  return headers;
}

function fakeIncoming({ url, headers, body }) {
  return {
    method: 'POST',
    url,
    headers,
    iterated: false,
    resumed: false,
    resume() {
      this.resumed = true;
    },
    async *[Symbol.asyncIterator]() {
      this.iterated = true;
      yield body;
    },
  };
}
