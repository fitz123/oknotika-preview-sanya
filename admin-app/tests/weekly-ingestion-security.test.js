import assert from 'node:assert/strict';
import test from 'node:test';
import { WEEKLY_INGESTION_BODY_MAXIMUM } from '../src/content/validation.js';
import { createAdminHandler } from '../src/http/handler.js';
import {
  createIngestionAuthenticator,
  WEEKLY_INGESTION_PATH,
} from '../src/http/ingestion-auth.js';
import { createProxiedRequest } from '../src/http/node-adapter.js';
import { createHarness, weeklyIngestionInput } from './helpers.js';

const ADMIN_ORIGIN = 'https://admin.oknotika.ru';
const INGESTION_TOKEN = 'weekly-ingestion-test-token-12345678901234567890';

test('weekly ingestion rejects configured credentials that cannot be sent as bearer tokens', () => {
  for (const secret of [
    'weekly ingestion token with forbidden whitespace',
    'weekly,ingestion,token,with,forbidden,commas',
    'еженедельный-токен-достаточной-длины',
  ]) {
    assert.throws(() => createIngestionAuthenticator(secret), /printable ASCII/);
  }
});

test('weekly ingestion security authenticates before buffering and enforces its smaller body limit', async () => {
  const ingestionAuthenticator = createIngestionAuthenticator(INGESTION_TOKEN);
  const sessionService = { authenticate: () => null };
  const unauthenticated = fakeIncoming({
    body: Buffer.from('{}'),
    headers: {
      authorization: 'Bearer wrong-token-with-enough-bytes-1234567890',
      'content-type': 'application/json',
      'content-length': '2',
    },
  });
  const rejected = await createProxiedRequest(unauthenticated, {
    adminOrigin: ADMIN_ORIGIN,
    sessionService,
    ingestionAuthenticator,
  });
  assert.equal(rejected.body, null);
  assert.equal(unauthenticated.iterated, false);
  assert.equal(unauthenticated.resumed, true);

  const oversized = fakeIncoming({
    body: Buffer.from('{}'),
    headers: {
      authorization: `Bearer ${INGESTION_TOKEN}`,
      'content-type': 'application/json',
      'content-length': String(WEEKLY_INGESTION_BODY_MAXIMUM + 1),
    },
  });
  await assert.rejects(
    createProxiedRequest(oversized, {
      adminOrigin: ADMIN_ORIGIN,
      sessionService,
      ingestionAuthenticator,
    }),
    (error) => error.code === 'REQUEST_TOO_LARGE',
  );
  assert.equal(oversized.iterated, false);
  assert.equal(oversized.resumed, true);

  const exactLimit = fakeIncoming({
    body: [
      Buffer.alloc(WEEKLY_INGESTION_BODY_MAXIMUM - 1),
      Buffer.alloc(1),
    ],
    headers: {
      authorization: `Bearer ${INGESTION_TOKEN}`,
      'content-type': 'application/json',
    },
  });
  const exactRequest = await createProxiedRequest(exactLimit, {
    adminOrigin: ADMIN_ORIGIN,
    sessionService,
    ingestionAuthenticator,
  });
  assert.equal((await exactRequest.arrayBuffer()).byteLength, WEEKLY_INGESTION_BODY_MAXIMUM);

  const chunkedOversized = fakeIncoming({
    body: [
      Buffer.alloc(WEEKLY_INGESTION_BODY_MAXIMUM),
      Buffer.alloc(1),
    ],
    headers: {
      authorization: `Bearer ${INGESTION_TOKEN}`,
      'content-type': 'application/json',
    },
  });
  await assert.rejects(
    createProxiedRequest(chunkedOversized, {
      adminOrigin: ADMIN_ORIGIN,
      sessionService,
      ingestionAuthenticator,
    }),
    (error) => error.code === 'REQUEST_TOO_LARGE',
  );
  assert.equal(chunkedOversized.iterated, true);
  assert.equal(chunkedOversized.resumed, true);
});

test('weekly ingestion validates payload and cannot use its token for editorial capabilities', async (t) => {
  const harness = createHarness(t);
  const handler = weeklyHandler(harness);
  const payload = weeklyIngestionInput(harness.coverAssetId);

  const missingToken = await ingest(handler, payload, null);
  assert.equal(missingToken.status, 401);
  const wrongToken = await ingest(handler, payload, 'wrong-token-with-enough-bytes-1234567890');
  assert.equal(wrongToken.status, 401);
  assert.equal(
    harness.db.prepare('SELECT COUNT(*) AS count FROM weekly_ingestion_issues').get().count,
    0,
  );

  const invalidUrl = await ingest(handler, weeklyIngestionInput(harness.coverAssetId, {
    article: { sourceUrls: ['http://example.com/not-verified'] },
  }));
  assert.equal(invalidUrl.status, 400);
  assert.match((await invalidUrl.json()).error, /https/);

  const publishField = await ingest(handler, {
    ...payload,
    publish: true,
  });
  assert.equal(publishField.status, 400);
  assert.match((await publishField.json()).error, /unsupported field/);

  const createdResponse = await ingest(handler, payload);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.created, true);
  const retryResponse = await ingest(handler, payload);
  assert.equal(retryResponse.status, 200);
  assert.equal((await retryResponse.json()).idempotent, true);

  for (const path of [
    '/api/articles',
    `/api/revisions/${created.revisionId}/preview`,
    `/api/articles/${created.articleId}/publish`,
    `/api/articles/${created.articleId}/withdraw`,
    '/api/releases/rollback',
  ]) {
    const response = await handler(new Request(`${ADMIN_ORIGIN}${path}`, {
      method: path === '/api/articles' ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${INGESTION_TOKEN}`,
        'content-type': 'application/json',
      },
      body: path === '/api/articles' ? undefined : '{}',
    }));
    assert.equal(response.status, 401, path);
  }
  assert.equal(harness.service.getArticle(created.articleId).state, 'draft');
  assert.equal(harness.service.getArticle(created.articleId).public_state, null);
});

test('weekly ingestion handler rejects oversized and malformed JSON without a write', async (t) => {
  const harness = createHarness(t);
  const handler = weeklyHandler(harness);
  const oversized = await handler(new Request(`${ADMIN_ORIGIN}${WEEKLY_INGESTION_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${INGESTION_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ padding: 'x'.repeat(WEEKLY_INGESTION_BODY_MAXIMUM) }),
  }));
  assert.equal(oversized.status, 413);

  const malformed = await handler(new Request(`${ADMIN_ORIGIN}${WEEKLY_INGESTION_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${INGESTION_TOKEN}`,
      'content-type': 'application/json',
    },
    body: '{"issueId":',
  }));
  assert.equal(malformed.status, 400);
  assert.equal(
    harness.db.prepare('SELECT COUNT(*) AS count FROM weekly_ingestion_issues').get().count,
    0,
  );
});

function weeklyHandler(harness) {
  const ingestionAuthenticator = createIngestionAuthenticator(INGESTION_TOKEN);
  return createAdminHandler({
    adminOrigin: ADMIN_ORIGIN,
    oidcService: {},
    sessionService: { authenticate: () => null },
    actions: {},
    weeklyIngestion: {
      upsertDraft: (input) => harness.service.ingestWeeklyDraft(input),
    },
    ingestionAuthenticator,
    previewsRoot: `${harness.root}/previews`,
  });
}

function ingest(handler, payload, token = INGESTION_TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return handler(new Request(`${ADMIN_ORIGIN}${WEEKLY_INGESTION_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }));
}

function fakeIncoming({ body, headers }) {
  return {
    method: 'POST',
    url: WEEKLY_INGESTION_PATH,
    headers,
    iterated: false,
    resumed: false,
    resume() {
      this.resumed = true;
    },
    async *[Symbol.asyncIterator]() {
      this.iterated = true;
      for (const chunk of Array.isArray(body) ? body : [body]) yield chunk;
    },
  };
}
