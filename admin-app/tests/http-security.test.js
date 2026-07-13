import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionService, sessionCookie } from '../src/auth/sessions.js';
import { createAdminActions } from '../src/http/admin-actions.js';
import { createAdminHandler } from '../src/http/handler.js';
import { assertMutationRequest, assertTrustedProxyHeaders } from '../src/http/security.js';
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
  const publisher = {
    publish: async () => ({ releaseId: 'release-published' }),
    rollback: async (releaseId) => ({ releaseId }),
  };
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
  assert.equal((await actions.publish(
    created.articleId, revised.revisionId, harness.editorId, 'PUBLISH',
  )).releaseId, 'release-published');
  assert.equal(harness.service.getArticle(created.articleId).state, 'published');
  assert.equal(
    harness.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'article.marked_published'").get().count,
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
