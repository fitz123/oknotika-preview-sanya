import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createSessionService, sessionCookie } from '../src/auth/sessions.js';
import { createAdminActions } from '../src/http/admin-actions.js';
import { createAdminHandler } from '../src/http/handler.js';
import { assertMutationRequest, assertTrustedProxyHeaders } from '../src/http/security.js';
import { createPublisher } from '../src/render/publisher.js';
import { articleInput, createHarness } from './helpers.js';

const ADMIN_ORIGIN = 'https://admin.oknotika.ru';

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
    oidcService: {},
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

test('admin handler wires login, editor lifecycle, preview assets, upload, rollback and logout routes', async (t) => {
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
  let callbackSeen = false;
  const handler = createAdminHandler({
    adminOrigin: ADMIN_ORIGIN,
    oidcService: {
      beginAuthorization: () => ({
        authorizationUrl: 'https://oauth.telegram.org/auth?state=test',
        browserBinding: 'b'.repeat(43),
      }),
      finishAuthorization: async () => {
        callbackSeen = true;
        return { editorId: harness.editorId };
      },
    },
    sessionService: sessions,
    actions,
    previewsRoot,
  });

  const start = await handler(new Request(`${ADMIN_ORIGIN}/auth/start`, {
    headers: { 'sec-fetch-site': 'same-origin' },
  }));
  assert.equal(start.status, 303);
  assert.equal(start.headers.get('location'), 'https://oauth.telegram.org/auth?state=test');
  assert.match(start.headers.get('set-cookie'), /__Host-oknotika_oidc=/);
  const callback = await handler(new Request(`${ADMIN_ORIGIN}/auth/callback?code=one&state=test`, {
    headers: { cookie: `__Host-oknotika_oidc=${'b'.repeat(43)}` },
  }));
  assert.equal(callback.status, 303);
  assert.equal(callbackSeen, true);
  assert.match(callback.headers.get('set-cookie'), /__Host-oknotika_session=/);

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

  const restoreResponse = await mutate(`/api/articles/${created.articleId}/restore`, JSON.stringify({
    sourceRevisionId: created.revisionId,
    expectedRevisionId: revised.revisionId,
    confirmation: 'RESTORE',
  }));
  assert.equal(restoreResponse.status, 201);
  assert.ok((await restoreResponse.json()).revisionId);
  const rollbackResponse = await mutate('/api/releases/rollback', JSON.stringify({
    releaseId: published.releaseId, confirmation: 'ROLLBACK',
  }));
  assert.equal(rollbackResponse.status, 200);
  assert.equal((await rollbackResponse.json()).releaseId, published.releaseId);

  const uploadResponse = await mutate('/api/uploads', Buffer.from([0x89, 0x50]), { contentType: 'image/png' });
  assert.equal(uploadResponse.status, 201);
  assert.equal((await uploadResponse.json()).assetId, harness.coverAssetId);
  assert.equal((await handler(new Request(`${ADMIN_ORIGIN}/api/articles`, { headers: { cookie } }))).status, 200);
  assert.equal((await handler(new Request(`${ADMIN_ORIGIN}/admin.js`, { headers: { cookie } }))).status, 200);

  const logout = await mutate('/logout', undefined, { contentType: 'text/plain' });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

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
