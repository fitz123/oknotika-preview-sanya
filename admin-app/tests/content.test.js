import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/content/database.js';
import { renderMarkdown } from '../src/content/markdown.js';
import { formatMoscowDate, normalizePublicationDate } from '../src/content/validation.js';
import { articleInput, createHarness, weeklyIngestionInput } from './helpers.js';

test('schema models editor, immutable revisions, assets, releases and audit events', (t) => {
  const { db } = createHarness(t);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
  for (const expected of [
    'configured_editors', 'articles', 'article_revisions', 'assets', 'releases',
    'release_articles', 'site_state', 'audit_events', 'article_revision_sources',
    'weekly_ingestion_issues', 'site_social_links',
  ]) {
    assert.ok(tables.has(expected), `${expected} table is missing`);
  }
});

test('multiple source URLs are stored immutably with the legacy first-source column', (t) => {
  const { db, service, editorId, coverAssetId } = createHarness(t);
  const sourceUrls = [
    'https://example.com/first',
    'https://example.org/second',
    'https://example.net/third',
  ];
  const created = service.createArticle(articleInput(coverAssetId, {
    sourceUrl: undefined,
    sourceUrls,
  }), editorId);
  const stored = db.prepare(`
    SELECT position, url FROM article_revision_sources
    WHERE revision_id = ? ORDER BY position
  `).all(created.revisionId);
  assert.deepEqual(stored.map((source) => source.url), sourceUrls);
  assert.equal(
    db.prepare('SELECT source_url FROM article_revisions WHERE id = ?').get(created.revisionId).source_url,
    sourceUrls[0],
  );
  assert.throws(
    () => db.prepare('UPDATE article_revision_sources SET url = ? WHERE revision_id = ? AND position = 0')
      .run('https://example.com/changed', created.revisionId),
    /immutable/,
  );

  const restoredId = service.restoreRevision(created.articleId, created.revisionId, editorId);
  assert.deepEqual(
    db.prepare('SELECT url FROM article_revision_sources WHERE revision_id = ? ORDER BY position')
      .all(restoredId).map((source) => source.url),
    sourceUrls,
  );
});

test('global social links validate platform hosts and retain nullable destinations', (t) => {
  const { db, service, editorId } = createHarness(t);
  assert.deepEqual(service.getSocialLinks(), {
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: 'https://youtube.com/@oknotika',
    vkUrl: 'https://vk.ru/oknotika',
    futuchatUrl: 'https://t.me/FUTU_CHAT',
    updatedAt: '1970-01-01T00:00:00.000Z',
  });
  const prepared = service.prepareSocialLinks({
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: 'https://www.youtube.com/@oknotika',
    vkUrl: 'https://vk.ru/oknotika',
    futuchatUrl: 'https://t.me/FUTU_CHAT',
  }, editorId);
  assert.equal(prepared.youtubeUrl, 'https://www.youtube.com/@oknotika');
  assert.equal(prepared.vkUrl, 'https://vk.ru/oknotika');
  assert.equal(prepared.futuchatUrl, 'https://t.me/FUTU_CHAT');
  assert.equal(service.getSocialLinks().youtubeUrl, 'https://youtube.com/@oknotika');
  assert.deepEqual(service.prepareSocialLinks({
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: null,
    vkUrl: null,
    futuchatUrl: null,
  }, editorId), {
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: null,
    vkUrl: null,
    futuchatUrl: null,
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'social_links.updated'").get().count,
    0,
  );
  assert.throws(() => service.prepareSocialLinks({
    telegramUrl: 'https://evil.example/oknotika',
    youtubeUrl: null,
    vkUrl: null,
    futuchatUrl: null,
  }, editorId), /approved telegram host/);
  for (const telegramUrl of [
    'https://t.me/not-oknotika',
    'https://t.me/oknotika/',
    'https://t.me/oknotika?start=redirect',
  ]) {
    assert.throws(() => service.prepareSocialLinks({
      telegramUrl,
      youtubeUrl: null,
      vkUrl: null,
      futuchatUrl: null,
    }, editorId), /must be exactly/);
  }
  for (const futuchatUrl of [
    'https://telegram.me/FUTU_CHAT',
    'https://t.me/',
    'https://t.me/FUTU_CHAT/extra',
    'https://t.me/FUTU_CHAT?start=redirect',
  ]) {
    assert.throws(() => service.prepareSocialLinks({
      telegramUrl: 'https://t.me/oknotika',
      youtubeUrl: null,
      vkUrl: null,
      futuchatUrl,
    }, editorId), /approved futuchat host|one Telegram channel path/);
  }
  const legacyCompatible = service.prepareSocialLinks({
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: null,
    vkUrl: 'https://vk.com/legacy-oknotika',
    futuchatUrl: null,
  }, editorId);
  assert.equal(legacyCompatible.vkUrl, 'https://vk.com/legacy-oknotika');
});

test('weekly editor and ingestion require one ordered list of 3–5 items and verified sources', (t) => {
  const { service, editorId, coverAssetId } = createHarness(t);
  const valid = weeklyIngestionInput(coverAssetId).article;
  const created = service.createArticle(valid, editorId, { contentKind: 'weekly_digest' });
  assert.ok(created.revisionId);

  for (const bodyMarkdown of [
    'Обычный абзац без списка.',
    '1. Первая новость.\n2. Вторая новость.',
    '1. Первая.\n2. Вторая.\n3. Третья.\n4. Четвёртая.\n5. Пятая.\n6. Шестая.',
    'Вступление.\n\n1. Первая.\n2. Вторая.\n3. Третья.',
    '1.\n2.\n3.',
    [
      '1. ![Первая](https://example.com/one.png)',
      '2. ![Вторая](https://example.com/two.png)',
      '3. ![Третья](https://example.com/three.png)',
    ].join('\n'),
    '1. Первая.\n2. ` `\n3. Третья.',
  ]) {
    assert.throws(
      () => service.createArticle(
        { ...valid, bodyMarkdown },
        editorId,
        { contentKind: 'weekly_digest' },
      ),
      /ordered list with 3–5/,
    );
  }
  assert.throws(
    () => service.reviseArticle(
      created.articleId,
      { ...valid, sourceUrls: [] },
      editorId,
      { expectedRevisionId: created.revisionId },
    ),
    /at least one verified source/,
  );
  assert.throws(
    () => service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId, {
      issueId: '2026-W32',
      article: { bodyMarkdown: '1. Только одна новость.' },
    })),
    /ordered list with 3–5/,
  );
});

test('weekly ingestion rejects nonexistent ISO weeks and unsafe content versions', (t) => {
  const { db, service, coverAssetId } = createHarness(t);
  assert.throws(
    () => service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId, {
      issueId: '2025-W53',
    })),
    /valid ISO week/,
  );
  for (const contentVersion of [Number.MAX_SAFE_INTEGER + 1, 1e100]) {
    assert.throws(
      () => service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId, {
        contentVersion,
      })),
      /safe integer/,
    );
  }
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM weekly_ingestion_issues').get().count,
    0,
  );
});

test('weekly migration backfills legacy source rows and marks pre-existing articles as legacy', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-migration-'));
  const migrations = resolve(root, 'migrations');
  const databasePath = resolve(root, 'admin.sqlite');
  mkdirSync(migrations);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of [
    '001_content.sql',
    '002_admin_security.sql',
    '003_public_revision_state.sql',
  ]) {
    copyFileSync(resolve(import.meta.dirname, '../migrations', name), resolve(migrations, name));
  }

  const old = openDatabase(databasePath, migrations);
  old.prepare(`
    INSERT INTO configured_editors (issuer, subject, enabled, created_at)
    VALUES ('https://oauth.telegram.org', 'legacy-editor', 1, '2026-07-01T00:00:00.000Z')
  `).run();
  old.prepare(`
    INSERT INTO assets
      (storage_key, private_path, sha256, media_type, width, height, created_at)
    VALUES ('legacy-cover', '/private/legacy.png', ?, 'image/png', 1, 1, '2026-07-01T00:00:00.000Z')
  `).run('a'.repeat(64));
  const articleId = Number(old.prepare(`
    INSERT INTO articles (slug, state, created_at, updated_at)
    VALUES ('legacy-article', 'draft', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run().lastInsertRowid);
  const revisionId = Number(old.prepare(`
    INSERT INTO article_revisions
      (article_id, revision_number, title, publication_at, lead, body_markdown,
       legacy_eyebrow, cover_asset_id, cover_alt, source_url, created_by, created_at)
    VALUES (?, 1, 'Legacy', '2026-07-01T00:00:00.000Z', 'Lead', 'Body',
            'Факт недели · legacy', 1, 'Cover', 'https://example.com/legacy', 1,
            '2026-07-01T00:00:00.000Z')
  `).run(articleId).lastInsertRowid);
  old.prepare('UPDATE articles SET current_revision_id = ? WHERE id = ?').run(revisionId, articleId);
  old.close();

  copyFileSync(
    resolve(import.meta.dirname, '../migrations/004_weekly_news.sql'),
    resolve(migrations, '004_weekly_news.sql'),
  );
  const versionFour = openDatabase(databasePath, migrations);
  const weeklyArticleId = Number(versionFour.prepare(`
    INSERT INTO articles (slug, state, created_at, updated_at)
    VALUES ('existing-weekly', 'draft', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')
  `).run().lastInsertRowid);
  const weeklyRevisionId = Number(versionFour.prepare(`
    INSERT INTO article_revisions
      (article_id, revision_number, title, publication_at, lead, body_markdown,
       cover_asset_id, cover_alt, source_url, created_by, created_at)
    VALUES (?, 1, 'Weekly', '2026-07-02T00:00:00.000Z', 'Lead',
            '1. One\n2. Two\n3. Three', 1, 'Cover', 'https://example.com/weekly', 1,
            '2026-07-02T00:00:00.000Z')
  `).run(weeklyArticleId).lastInsertRowid);
  versionFour.prepare('UPDATE articles SET current_revision_id = ? WHERE id = ?')
    .run(weeklyRevisionId, weeklyArticleId);
  versionFour.prepare(`
    INSERT INTO weekly_ingestion_issues
      (issue_id, article_id, content_version, last_ingestion_revision_id,
       payload_sha256, created_at, updated_at)
    VALUES ('2026-W27', ?, 1, ?, ?, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')
  `).run(weeklyArticleId, weeklyRevisionId, 'b'.repeat(64));
  versionFour.prepare(`
    UPDATE site_social_links
    SET youtube_url = 'https://youtube.com/@existing-channel'
    WHERE singleton = 1
  `).run();
  versionFour.close();

  const upgraded = openDatabase(databasePath);
  t.after(() => upgraded.close());
  assert.deepEqual(
    upgraded.prepare(`
      SELECT position, url FROM article_revision_sources
      WHERE revision_id = ? ORDER BY position
    `).all(revisionId).map((row) => ({ ...row })),
    [{ position: 0, url: 'https://example.com/legacy' }],
  );
  assert.equal(
    upgraded.prepare('SELECT content_kind FROM articles WHERE id = ?').get(articleId).content_kind,
    'legacy',
  );
  assert.equal(
    upgraded.prepare('SELECT content_kind FROM articles WHERE id = ?')
      .get(weeklyArticleId).content_kind,
    'weekly_digest',
  );
  assert.deepEqual(
    { ...upgraded.prepare(`
      SELECT telegram_url, youtube_url, vk_url, futuchat_url
      FROM site_social_links WHERE singleton = 1
    `).get() },
    {
      telegram_url: 'https://t.me/oknotika',
      youtube_url: 'https://youtube.com/@existing-channel',
      vk_url: 'https://vk.ru/oknotika',
      futuchat_url: 'https://t.me/FUTU_CHAT',
    },
  );
  upgraded.prepare(`
    UPDATE site_social_links
    SET youtube_url = NULL, vk_url = NULL
    WHERE singleton = 1
  `).run();
  assert.equal(
    upgraded.prepare('SELECT futuchat_url FROM site_social_links WHERE singleton = 1').get()
      .futuchat_url,
    'https://t.me/FUTU_CHAT',
  );
});

test('weekly ingestion is versioned, idempotent and refuses silent manual overwrite', (t) => {
  const { db, service, editorId, coverAssetId } = createHarness(t);
  const payload = weeklyIngestionInput(coverAssetId);
  const created = service.ingestWeeklyDraft(payload);
  assert.equal(created.created, true);
  assert.equal(service.getArticle(created.articleId).state, 'draft');

  const retry = service.ingestWeeklyDraft(payload);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.revisionId, created.revisionId);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM article_revisions WHERE article_id = ?')
      .get(created.articleId).count,
    1,
  );

  assert.throws(
    () => service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId, {
      article: { lead: 'Different content under a reused version.' },
    })),
    (error) => error.status === 409 && /already used/.test(error.message),
  );

  const updated = service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId, {
    contentVersion: 2,
    article: { lead: 'A corrected weekly lead.' },
  }));
  assert.equal(updated.created, false);
  assert.equal(updated.idempotent, false);
  assert.notEqual(updated.revisionId, created.revisionId);

  service.reviseArticle(
    created.articleId,
    weeklyIngestionInput(coverAssetId, {
      article: { lead: 'Manual editor correction.' },
    }).article,
    editorId,
    { expectedRevisionId: updated.revisionId },
  );
  assert.throws(
    () => service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId, {
      contentVersion: 3,
      article: { lead: 'Machine correction after a manual edit.' },
    })),
    (error) => error.status === 409 && /manual edits/.test(error.message),
  );
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

test('transliterated slugs and collision suffixes stay within filesystem component limits', (t) => {
  const { service, editorId, coverAssetId } = createHarness(t);
  const title = 'Щ'.repeat(240);
  const first = service.createArticle(articleInput(coverAssetId, { title }), editorId);
  const second = service.createArticle(articleInput(coverAssetId, { title }), editorId);
  assert.ok(Buffer.byteLength(first.slug) <= 200);
  assert.ok(Buffer.byteLength(second.slug) <= 200);
  assert.notEqual(first.slug, second.slug);
  assert.match(second.slug, /-2$/);
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
