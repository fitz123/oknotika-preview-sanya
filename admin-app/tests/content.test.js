import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../src/content/markdown.js';
import { formatMoscowDate, normalizePublicationDate } from '../src/content/validation.js';
import { articleInput, createHarness } from './helpers.js';

test('schema models editor, immutable revisions, assets, releases and audit events', (t) => {
  const { db } = createHarness(t);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
  for (const expected of [
    'configured_editors', 'articles', 'article_revisions', 'assets', 'releases',
    'release_articles', 'site_state', 'audit_events',
  ]) {
    assert.ok(tables.has(expected), `${expected} table is missing`);
  }
});

test('database enforces one configured editor plus immutable slugs and revisions', (t) => {
  const { db, service, editorId, coverAssetId } = createHarness(t);
  assert.throws(
    () => service.configureEditor({ issuer: 'https://oauth.telegram.org', subject: 'another-editor' }),
    /UNIQUE constraint failed/,
  );
  const created = service.createArticle(articleInput(coverAssetId), editorId);
  assert.throws(
    () => db.prepare('UPDATE articles SET slug = ? WHERE id = ?').run('changed', created.articleId),
    /article slug is immutable/,
  );
  assert.throws(
    () => db.prepare('UPDATE article_revisions SET title = ? WHERE id = ?').run('changed', created.revisionId),
    /article revisions are immutable/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM article_revisions WHERE id = ?').run(created.revisionId),
    /article revisions are immutable/,
  );
});

test('publication dates are stored in UTC and displayed in Europe/Moscow', () => {
  const stored = normalizePublicationDate('2026-07-10');
  assert.equal(stored, '2026-07-09T21:00:00.000Z');
  assert.equal(formatMoscowDate(stored), '10 июля 2026 г.');
  for (const impossible of ['2026-02-29', '2024-02-30', '2026-04-31', '2026-13-01', '2026-00-10']) {
    assert.throws(() => normalizePublicationDate(impossible), /valid calendar date/);
  }
  assert.equal(normalizePublicationDate('2024-02-29'), '2024-02-28T21:00:00.000Z');
});

test('slug collision suffix is stable and title edits never change the URL', (t) => {
  const { db, service, editorId, coverAssetId } = createHarness(t);
  const first = service.createArticle(articleInput(coverAssetId), editorId);
  const second = service.createArticle(articleInput(coverAssetId), editorId);
  assert.equal(first.slug, 'svetoprozrachnyi-fasad');
  assert.equal(second.slug, 'svetoprozrachnyi-fasad-2');

  service.reviseArticle(first.articleId, articleInput(coverAssetId, { title: 'Полностью новое название' }), editorId);
  assert.equal(service.getArticle(first.articleId).slug, first.slug);
  const oldRevision = db.prepare('SELECT title FROM article_revisions WHERE id = ?').get(first.revisionId);
  assert.equal(oldRevision.title, 'Светопрозрачный фасад');
});

test('editorial restore creates a new immutable draft revision', (t) => {
  const { db, service, editorId, coverAssetId } = createHarness(t);
  const created = service.createArticle(articleInput(coverAssetId), editorId);
  const revised = service.reviseArticle(
    created.articleId,
    articleInput(coverAssetId, { title: 'Вторая редакция' }),
    editorId,
  );
  const restoredId = service.restoreRevision(created.articleId, created.revisionId, editorId);
  const revisions = db.prepare(`
    SELECT id, revision_number, title, restored_from_id FROM article_revisions
    WHERE article_id = ? ORDER BY revision_number
  `).all(created.articleId);
  assert.deepEqual(revisions.map((row) => row.title), [
    'Светопрозрачный фасад', 'Вторая редакция', 'Светопрозрачный фасад',
  ]);
  assert.equal(Number(revisions[2].restored_from_id), created.revisionId);
  assert.equal(restoredId, Number(revisions[2].id));
  assert.equal(service.getArticle(created.articleId).state, 'draft');
  assert.notEqual(restoredId, revised.revisionId);
});

test('Markdown is limited and sanitized after rendering', () => {
  const html = renderMarkdown('[safe](https://example.com) [unsafe](javascript:alert(1)) **strong**');
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<strong>strong<\/strong>/);
  assert.match(html, /rel="noreferrer noopener"/);
});
