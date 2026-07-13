import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPrivatePreview } from '../src/render/preview.js';
import { articleInput, createHarness } from './helpers.js';

test('required fields, raw HTML and unsafe source URLs fail closed', (t) => {
  const { service, editorId, coverAssetId } = createHarness(t);
  assert.throws(
    () => service.createArticle(articleInput(coverAssetId, { title: ' ' }), editorId),
    /title is required/,
  );
  assert.throws(
    () => service.createArticle(articleInput(coverAssetId, { bodyMarkdown: '<img src=x onerror=alert(1)>' }), editorId),
    /raw HTML is not allowed/,
  );
  for (const sourceUrl of ['http://example.com', 'javascript:alert(1)', 'https://user:pass@example.com/']) {
    assert.throws(() => service.createArticle(articleInput(coverAssetId, { sourceUrl }), editorId));
  }
});

test('source URL validation stores data without fetching it', (t) => {
  const { db, service, editorId, coverAssetId } = createHarness(t);
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetched = true;
    throw new Error('must not fetch');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const created = service.createArticle(articleInput(coverAssetId, {
    sourceUrl: 'https://example.com/evidence?ref=oknotika',
  }), editorId);
  const stored = db.prepare('SELECT source_url FROM article_revisions WHERE id = ?').get(created.revisionId);
  assert.equal(stored.source_url, 'https://example.com/evidence?ref=oknotika');
  assert.equal(fetched, false);
});

test('preview requires an authenticated configured editor and stays private/no-store/noindex', (t) => {
  const { root, db, service, editorId, coverAssetId } = createHarness(t);
  const created = service.createArticle(articleInput(coverAssetId), editorId);
  const previewsRoot = resolve(root, 'previews');
  assert.throws(() => createPrivatePreview({
    db,
    revisionId: created.revisionId,
    authenticatedEditorId: 999,
    previewsRoot,
    publicOrigin: 'https://oknotika.ru',
  }), /Authentication is required/);

  const preview = createPrivatePreview({
    db,
    revisionId: created.revisionId,
    authenticatedEditorId: editorId,
    previewsRoot,
    publicOrigin: 'https://oknotika.ru',
  });
  assert.match(preview.previewId, /^[A-Za-z0-9_-]{32}$/);
  const html = readFileSync(resolve(preview.directory, 'index.html'), 'utf8');
  const headers = JSON.parse(readFileSync(resolve(preview.directory, 'headers.json'), 'utf8'));
  assert.match(html, /noindex,nofollow,noarchive/);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(statSync(preview.directory).mode & 0o777, 0o700);
  assert.equal(statSync(resolve(preview.directory, 'index.html')).mode & 0o777, 0o600);
});
