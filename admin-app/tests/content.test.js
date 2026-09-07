import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/content/database.js';
import { createContentService } from '../src/content/service.js';
import { renderMarkdown } from '../src/content/markdown.js';
import { formatMoscowDate, normalizePublicationDate } from '../src/content/validation.js';
import { createPrivatePreview } from '../src/render/preview.js';
import { articleInput, createHarness, weeklyIngestionInput } from './helpers.js';

test('schema models editor, immutable revisions, assets, releases and audit events', (t) => {
  const { db } = createHarness(t);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
  for (const expected of [
    'configured_editors', 'articles', 'article_revisions', 'assets', 'releases',
    'release_articles', 'site_state', 'audit_events', 'article_revision_sources',
    'weekly_ingestion_issues', 'site_social_links', 'private_previews',
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
  assert.equal(service.prepareSocialLinks({
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: 'https://youtube.com/@legacy-client',
    vkUrl: 'https://vk.ru/legacy-client',
  }, editorId).futuchatUrl, 'https://t.me/FUTU_CHAT');
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
    'https://t.me/abcd',
    'https://t.me/FUTU_CHAT/extra',
    'https://t.me/FUTU_CHAT?start=redirect',
    'https://t.me/FUTU_CHAT#fragment',
    `https://t.me/${'a'.repeat(33)}`,
  ]) {
    assert.throws(() => service.prepareSocialLinks({
      telegramUrl: 'https://t.me/oknotika',
      youtubeUrl: null,
      vkUrl: null,
      futuchatUrl,
    }, editorId), /approved futuchat host|one Telegram channel path/);
  }
  for (const futuchatUrl of [
    'https://t.me/abcde',
    `https://t.me/${'a'.repeat(32)}`,
  ]) {
    assert.equal(service.prepareSocialLinks({
      telegramUrl: 'https://t.me/oknotika',
      youtubeUrl: null,
      vkUrl: null,
      futuchatUrl,
    }, editorId).futuchatUrl, futuchatUrl);
  }
  const legacyCompatible = service.prepareSocialLinks({
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: null,
    vkUrl: 'https://vk.com/legacy-oknotika',
    futuchatUrl: null,
  }, editorId);
  assert.equal(legacyCompatible.vkUrl, 'https://vk.com/legacy-oknotika');
});

test('social-link validation rejects insecure credentials and enforces URL length', (t) => {
  const { service, editorId } = createHarness(t);
  const valid = {
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: 'https://youtube.com/@oknotika',
    vkUrl: 'https://vk.ru/oknotika',
    futuchatUrl: 'https://t.me/FUTU_CHAT',
  };
  const insecure = {
    telegramUrl: ['http://t.me/oknotika', 'https://user:password@t.me/oknotika'],
    youtubeUrl: ['http://youtube.com/@oknotika', 'https://user:password@youtube.com/@oknotika'],
    vkUrl: ['http://vk.ru/oknotika', 'https://user:password@vk.ru/oknotika'],
    futuchatUrl: ['http://t.me/FUTU_CHAT', 'https://user:password@t.me/FUTU_CHAT'],
  };
  for (const [field, values] of Object.entries(insecure)) {
    for (const value of values) {
      assert.throws(
        () => service.prepareSocialLinks({ ...valid, [field]: value }, editorId),
        /HTTPS URL without credentials/,
      );
    }
  }

  const youtubePrefix = 'https://youtube.com/';
  const exact = `${youtubePrefix}${'a'.repeat(2048 - youtubePrefix.length)}`;
  assert.equal(
    service.prepareSocialLinks({ ...valid, youtubeUrl: exact }, editorId).youtubeUrl,
    exact,
  );
  assert.throws(
    () => service.prepareSocialLinks({ ...valid, youtubeUrl: `${exact}a` }, editorId),
    /2048 characters/,
  );
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

test('weekly text and source boundaries apply to create, revise and ingestion paths', (t) => {
  const { db, service, editorId, coverAssetId } = createHarness(t);
  const base = weeklyIngestionInput(coverAssetId).article;
  const exactUrl = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
  const exactBody = `1. ${'a'.repeat(100_000 - '1. \n\n2. b\n\n3. c'.length)}\n\n2. b\n\n3. c`;
  const exactSources = [
    exactUrl,
    ...Array.from({ length: 19 }, (_, index) => `https://example.com/source-${index}`),
  ];
  const exact = {
    ...base,
    bodyMarkdown: exactBody,
    coverAlt: 'a'.repeat(500),
    sourceUrls: exactSources,
  };

  const created = service.createArticle(exact, editorId, { contentKind: 'weekly_digest' });
  const revised = service.reviseArticle(created.articleId, exact, editorId, {
    expectedRevisionId: created.revisionId,
  });
  const ingested = service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId, {
    article: exact,
  }));
  assert.ok(revised.revisionId);
  assert.ok(ingested.revisionId);

  const invalidArticles = [
    [{ sourceUrls: Array.from({ length: 21 }, (_, index) => `https://example.com/${index}`) }, /20 URLs/],
    [{ sourceUrls: ['https://example.com/duplicate', 'https://example.com/duplicate'] }, /duplicate/],
    [{ sourceUrls: [''] }, /empty URLs/],
    [{
      sourceUrls: [
        `https://example.com/${'a'.repeat(2049 - 'https://example.com/'.length)}`,
      ],
    }, /2048 characters/],
    [{ bodyMarkdown: `${exactBody}a` }, /100000 characters/],
    [{ coverAlt: 'a'.repeat(501) }, /500 characters/],
    [{ publicationDate: '0' }, /YYYY-MM-DD/],
  ];
  const revisionCount = () => db.prepare(
    'SELECT COUNT(*) AS count FROM article_revisions',
  ).get().count;
  const before = revisionCount();
  const oversizedLegacySource = {
    ...base,
    sourceUrls: undefined,
    sourceUrl: `https://example.com/${'a'.repeat(2049 - 'https://example.com/'.length)}`,
  };
  assert.throws(
    () => service.createArticle(oversizedLegacySource, editorId, { contentKind: 'weekly_digest' }),
    /2048 characters/,
  );
  assert.throws(
    () => service.reviseArticle(created.articleId, oversizedLegacySource, editorId, {
      expectedRevisionId: revised.revisionId,
    }),
    /2048 characters/,
  );
  for (const [override, expectedError] of invalidArticles) {
    const invalid = { ...base, ...override };
    assert.throws(
      () => service.createArticle(invalid, editorId, { contentKind: 'weekly_digest' }),
      expectedError,
    );
    assert.throws(
      () => service.reviseArticle(created.articleId, invalid, editorId, {
        expectedRevisionId: revised.revisionId,
      }),
      expectedError,
    );
    assert.throws(
      () => service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId, {
        issueId: '2026-W32',
        article: override,
      })),
      expectedError,
    );
  }
  assert.equal(revisionCount(), before);
  assert.equal(
    service.getArticle(created.articleId).current_revision_id,
    revised.revisionId,
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
    SET youtube_url = 'https://youtube.com/@existing-channel',
        vk_url = 'https://vk.ru/existing-channel'
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
      vk_url: 'https://vk.ru/existing-channel',
      futuchat_url: 'https://t.me/FUTU_CHAT',
    },
  );
  assert.deepEqual(
    { ...upgraded.prepare(`
      SELECT telegram_url, youtube_url, vk_url, futuchat_url
      FROM pending_social_link_defaults WHERE singleton = 1
    `).get() },
    {
      telegram_url: 'https://t.me/oknotika',
      youtube_url: 'https://youtube.com/@existing-channel',
      vk_url: 'https://vk.ru/existing-channel',
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

test('draft deletion migration upgrades schema nine and remains readable by its rollback migrator', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-deletion-migration-'));
  const migrations = resolve(root, 'upgrade-migrations');
  const rollbackMigrations = resolve(root, 'rollback-migrations');
  const databasePath = resolve(root, 'admin.sqlite');
  const coverPath = resolve(root, 'cover.png');
  mkdirSync(migrations);
  mkdirSync(rollbackMigrations);
  writeFileSync(coverPath, 'private cover');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const schemaNineMigrations = [
    '001_content.sql',
    '002_admin_security.sql',
    '003_public_revision_state.sql',
    '004_weekly_news.sql',
    '005_article_content_kind.sql',
    '006_futuchat_social_destination.sql',
    '007_pending_social_defaults.sql',
    '008_local_credentials.sql',
    '009_local_login_csrf.sql',
  ];
  for (const name of schemaNineMigrations) {
    const source = resolve(import.meta.dirname, '../migrations', name);
    copyFileSync(source, resolve(migrations, name));
    copyFileSync(source, resolve(rollbackMigrations, name));
  }

  let db = openDatabase(databasePath, migrations);
  let service = createContentService(db);
  const editorId = service.configureEditor({
    issuer: 'local-password',
    subject: 'schema-nine-editor',
  });
  const coverAssetId = service.registerAsset({
    privatePath: coverPath,
    mediaType: 'image/png',
    width: 1,
    height: 1,
  });
  const privateDraft = service.createArticle(articleInput(coverAssetId, {
    title: 'Schema nine private draft',
  }), editorId);
  const publicArticle = service.createArticle(articleInput(coverAssetId, {
    title: 'Schema nine public history',
  }), editorId);
  db.prepare(`
    UPDATE articles
    SET state = 'published', public_state = 'published', published_revision_id = ?
    WHERE id = ?
  `).run(publicArticle.revisionId, publicArticle.articleId);
  db.prepare(`
    INSERT INTO audit_events
      (editor_id, event_type, article_id, revision_id, details_json, created_at)
    VALUES (?, 'article.published', ?, ?, '{}', '2026-09-07T12:00:00.000Z')
  `).run(editorId, publicArticle.articleId, publicArticle.revisionId);
  db.close();

  copyFileSync(
    resolve(import.meta.dirname, '../migrations/010_never_published_draft_deletion.sql'),
    resolve(migrations, '010_never_published_draft_deletion.sql'),
  );
  db = openDatabase(databasePath, migrations);
  service = createContentService(db);
  assert.equal(
    db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    10,
  );
  assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'private_previews'").get());
  assert.throws(
    () => db.prepare('DELETE FROM article_revision_sources WHERE revision_id = ?')
      .run(publicArticle.revisionId),
    /article revision sources are immutable/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM articles WHERE id = ?').run(publicArticle.articleId),
    /articles with public history are immutable/,
  );
  assert.equal(
    service.deleteNeverPublishedDraft(privateDraft.articleId, editorId, {
      expectedRevisionId: privateDraft.revisionId,
    }).status,
    'deleted',
  );
  assert.ok(service.getArticle(publicArticle.articleId));
  db.close();

  const rollbackDb = openDatabase(databasePath, rollbackMigrations);
  const rollbackService = createContentService(rollbackDb);
  assert.equal(
    rollbackDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    10,
  );
  assert.equal(rollbackDb.prepare(`
    SELECT r.title
    FROM articles a
    JOIN article_revisions r ON r.id = a.current_revision_id
    WHERE a.id = ?
  `).get(publicArticle.articleId).title, 'Schema nine public history');
  const rollbackDraft = rollbackService.createArticle(articleInput(coverAssetId, {
    title: 'Draft created by rollback application',
  }), editorId);
  assert.equal(rollbackService.getArticle(rollbackDraft.articleId).state, 'draft');
  rollbackDb.close();
});

test('weekly ingestion is versioned, idempotent and refuses silent manual overwrite', (t) => {
  const { db, service, editorId, coverAssetId } = createHarness(t);
  const payload = weeklyIngestionInput(coverAssetId);
  assert.throws(
    () => service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId, {
      issueId: '2026-W32',
      contentVersion: 2,
    })),
    (error) => error.status === 409 && /start at contentVersion 1/.test(error.message),
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM weekly_ingestion_issues').get().count,
    0,
  );
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

  const countsBeforeOlderVersion = {
    revisions: db.prepare(
      'SELECT COUNT(*) AS count FROM article_revisions WHERE article_id = ?',
    ).get(created.articleId).count,
    audits: db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'weekly_draft.ingested'",
    ).get().count,
  };
  assert.throws(
    () => service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId, {
      contentVersion: 1,
    })),
    (error) => error.status === 409 && /older than/.test(error.message),
  );
  assert.deepEqual({
    revisions: db.prepare(
      'SELECT COUNT(*) AS count FROM article_revisions WHERE article_id = ?',
    ).get(created.articleId).count,
    audits: db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'weekly_draft.ingested'",
    ).get().count,
  }, countsBeforeOlderVersion);
  assert.equal(
    service.getArticle(created.articleId).current_revision_id,
    updated.revisionId,
  );

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

test('never-published weekly draft deletion removes owned records, files and tracked previews', (t) => {
  const {
    root, privateRoot, coverPath, db, service, editorId, coverAssetId,
  } = createHarness(t);
  const originalPath = resolve(privateRoot, 'cover.source');
  copyFileSync(coverPath, originalPath);
  db.prepare(`
    INSERT INTO private_uploads
      (original_path, sanitized_asset_id, original_media_type, source_bytes,
       width, height, created_by, created_at)
    VALUES (?, ?, 'image/png', 1, 1, 1, ?, '2026-07-13T12:00:00.000Z')
  `).run(originalPath, coverAssetId, editorId);
  const created = service.ingestWeeklyDraft(weeklyIngestionInput(coverAssetId));
  const revised = service.reviseArticle(
    created.articleId,
    weeklyIngestionInput(coverAssetId, {
      article: { lead: 'Редакторская правка перед удалением.' },
    }).article,
    editorId,
    { expectedRevisionId: created.revisionId },
  );
  const previewsRoot = resolve(root, 'previews');
  const preview = createPrivatePreview({
    db,
    revisionId: revised.revisionId,
    authenticatedEditorId: editorId,
    previewsRoot,
    publicOrigin: 'https://oknotika.ru',
  });
  const unknownPreview = resolve(previewsRoot, 'untracked-preview');
  mkdirSync(unknownPreview, { recursive: true });
  writeFileSync(resolve(unknownPreview, 'index.html'), 'untracked');
  const unrelatedDirectory = resolve(root, 'unrelated-preview');
  const unrelatedPreviewId = 'a'.repeat(32);
  mkdirSync(unrelatedDirectory);
  writeFileSync(resolve(unrelatedDirectory, 'index.html'), 'unrelated');
  db.prepare(`
    INSERT INTO private_previews (preview_id, revision_id, directory, created_at)
    VALUES (?, ?, ?, '2026-07-13T12:00:00.000Z')
  `).run(unrelatedPreviewId, revised.revisionId, unrelatedDirectory);

  const result = service.deleteNeverPublishedDraft(created.articleId, editorId, {
    expectedRevisionId: revised.revisionId,
  });

  assert.equal(result.status, 'deleted');
  assert.deepEqual(result.revisionIds, [created.revisionId, revised.revisionId]);
  assert.deepEqual(result.deletedAssetIds, [coverAssetId]);
  assert.deepEqual(result.retainedAssetIds, []);
  assert.equal(result.cleanup.status, 'completed');
  assert.equal(result.cleanup.failureCount, 0);
  assert.equal(existsSync(coverPath), false);
  assert.equal(existsSync(originalPath), false);
  assert.equal(existsSync(preview.directory), false);
  assert.equal(existsSync(unknownPreview), true);
  assert.equal(existsSync(unrelatedDirectory), true);
  for (const table of [
    'articles',
    'article_revisions',
    'article_revision_sources',
    'weekly_ingestion_issues',
    'private_uploads',
    'private_previews',
    'assets',
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
  const audits = db.prepare('SELECT * FROM audit_events ORDER BY id').all();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].event_type, 'article.draft_deleted');
  assert.equal(audits[0].article_id, null);
  assert.equal(audits[0].revision_id, null);
  const details = JSON.parse(audits[0].details_json);
  assert.equal(details.articleId, created.articleId);
  assert.deepEqual(details.weeklyIssues, ['2026-W31']);
  assert.deepEqual(new Set(details.previewIds), new Set([preview.previewId, unrelatedPreviewId]));
  assert.deepEqual(details.preservedPreviewIds, [unrelatedPreviewId]);
  assert.equal(details.untrackedPreviewsPreserved, true);
  assert.equal(details.cleanup.status, 'completed');
  assert.doesNotMatch(audits[0].details_json, /Редакторская|Дайджест недели/);

  assert.deepEqual(
    service.deleteNeverPublishedDraft(created.articleId, editorId, {
      expectedRevisionId: revised.revisionId,
    }),
    { status: 'not_found', articleId: created.articleId },
  );
});

test('draft deletion requires an enabled editor and the exact current revision', (t) => {
  const { db, service, editorId, coverAssetId, coverPath } = createHarness(t);
  const created = service.createArticle(articleInput(coverAssetId), editorId);
  const revised = service.reviseArticle(created.articleId, articleInput(coverAssetId, {
    title: 'Новая текущая редакция',
  }), editorId, { expectedRevisionId: created.revisionId });

  assert.throws(
    () => service.deleteNeverPublishedDraft(created.articleId, editorId, {
      expectedRevisionId: created.revisionId,
    }),
    /Revision conflict/,
  );
  assert.throws(
    () => service.deleteNeverPublishedDraft(created.articleId, editorId),
    /expectedRevisionId must be a positive integer/,
  );
  service.disableEditor(editorId);
  assert.throws(
    () => service.deleteNeverPublishedDraft(created.articleId, editorId, {
      expectedRevisionId: revised.revisionId,
    }),
    /enabled editor/,
  );
  assert.ok(service.getArticle(created.articleId));
  assert.equal(existsSync(coverPath), true);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM article_revisions WHERE article_id = ?
  `).get(created.articleId).count, 2);
});

test('draft deletion preserves a cover asset and upload still used by another article', (t) => {
  const {
    privateRoot, coverPath, db, service, editorId, coverAssetId,
  } = createHarness(t);
  const originalPath = resolve(privateRoot, 'shared.source');
  copyFileSync(coverPath, originalPath);
  db.prepare(`
    INSERT INTO private_uploads
      (original_path, sanitized_asset_id, original_media_type, source_bytes,
       width, height, created_by, created_at)
    VALUES (?, ?, 'image/png', 1, 1, 1, ?, '2026-07-13T12:00:00.000Z')
  `).run(originalPath, coverAssetId, editorId);
  const deleted = service.createArticle(articleInput(coverAssetId), editorId);
  const remaining = service.createArticle(articleInput(coverAssetId, {
    title: 'Черновик с общей обложкой',
  }), editorId);

  const result = service.deleteNeverPublishedDraft(deleted.articleId, editorId, {
    expectedRevisionId: deleted.revisionId,
  });

  assert.deepEqual(result.deletedAssetIds, []);
  assert.deepEqual(result.retainedAssetIds, [coverAssetId]);
  assert.equal(existsSync(coverPath), true);
  assert.equal(existsSync(originalPath), true);
  assert.ok(db.prepare('SELECT 1 FROM assets WHERE id = ?').get(coverAssetId));
  assert.ok(db.prepare('SELECT 1 FROM private_uploads WHERE sanitized_asset_id = ?').get(coverAssetId));
  assert.ok(service.getArticle(remaining.articleId));
});

test('current and historical public evidence all reject draft deletion', (t) => {
  const { db, service, editorId, coverAssetId } = createHarness(t);
  const published = service.createArticle(articleInput(coverAssetId, {
    title: 'Опубликованная статья',
  }), editorId);
  db.prepare(`
    UPDATE articles
    SET state = 'published', public_state = 'published', published_revision_id = ?
    WHERE id = ?
  `).run(published.revisionId, published.articleId);

  const withdrawn = service.createArticle(articleInput(coverAssetId, {
    title: 'Отозванная статья',
  }), editorId);
  db.prepare(`
    UPDATE articles
    SET state = 'withdrawn', public_state = 'withdrawn', published_revision_id = ?
    WHERE id = ?
  `).run(withdrawn.revisionId, withdrawn.articleId);

  const releaseLinked = service.createArticle(articleInput(coverAssetId, {
    title: 'Статья из старого релиза',
  }), editorId);
  db.prepare(`
    INSERT INTO releases (id, status, created_at)
    VALUES ('historical-release', 'complete', '2026-07-13T12:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO release_articles (release_id, article_id, revision_id, public_state)
    VALUES ('historical-release', ?, ?, 'published')
  `).run(releaseLinked.articleId, releaseLinked.revisionId);

  const audited = service.createArticle(articleInput(coverAssetId, {
    title: 'Статья с историей публикации',
  }), editorId);
  db.prepare(`
    INSERT INTO audit_events
      (editor_id, event_type, article_id, revision_id, details_json, created_at)
    VALUES (?, 'article.published', ?, ?, '{}', '2026-07-13T12:00:00.000Z')
  `).run(editorId, audited.articleId, audited.revisionId);

  for (const article of [published, withdrawn, releaseLinked, audited]) {
    assert.throws(
      () => service.deleteNeverPublishedDraft(article.articleId, editorId, {
        expectedRevisionId: article.revisionId,
      }),
      (error) => error.status === 409 && /never-published/.test(error.message),
    );
    assert.ok(service.getArticle(article.articleId));
  }

  assert.throws(
    () => db.prepare('DELETE FROM article_revision_sources WHERE revision_id = ?')
      .run(published.revisionId),
    /article revision sources are immutable/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM article_revisions WHERE id = ?').run(audited.revisionId),
    /article revisions are immutable/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM articles WHERE id = ?').run(withdrawn.articleId),
    /articles with public history are immutable/,
  );
  assert.throws(
    () => db.prepare(`
      DELETE FROM audit_events
      WHERE article_id = ? AND event_type = 'article.published'
    `).run(audited.articleId),
    /public transition audit events are immutable/,
  );
});

test('partial file staging failure restores quarantined files and database state', (t) => {
  let renameCalls = 0;
  const cleanup = {
    lstat: (path) => lstatSync(path),
    rename: (source, destination) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error('injected quarantine failure');
      renameSync(source, destination);
    },
    remove: (path, options) => rmSync(path, options),
  };
  const {
    root, db, service, editorId, coverAssetId, coverPath,
  } = createHarness(t, { serviceOptions: { fileCleanup: cleanup } });
  const created = service.createArticle(articleInput(coverAssetId), editorId);
  const preview = createPrivatePreview({
    db,
    revisionId: created.revisionId,
    authenticatedEditorId: editorId,
    previewsRoot: resolve(root, 'previews'),
    publicOrigin: 'https://oknotika.ru',
  });

  assert.throws(
    () => service.deleteNeverPublishedDraft(created.articleId, editorId, {
      expectedRevisionId: created.revisionId,
    }),
    /injected quarantine failure/,
  );
  assert.ok(service.getArticle(created.articleId));
  assert.ok(db.prepare('SELECT 1 FROM article_revisions WHERE id = ?').get(created.revisionId));
  assert.ok(db.prepare('SELECT 1 FROM assets WHERE id = ?').get(coverAssetId));
  assert.ok(db.prepare('SELECT 1 FROM private_previews WHERE preview_id = ?').get(preview.previewId));
  assert.equal(existsSync(preview.directory), true);
  assert.equal(existsSync(coverPath), true);
  assert.equal(renameCalls, 3);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'article.draft_deleted'")
      .get().count,
    0,
  );
});

test('post-commit file cleanup failure is retained in the deletion tombstone', (t) => {
  const cleanup = {
    lstat: (path) => lstatSync(path),
    rename: (source, destination) => renameSync(source, destination),
    remove: () => { throw new Error('injected final cleanup failure'); },
  };
  const {
    db, service, editorId, coverAssetId, coverPath,
  } = createHarness(t, { serviceOptions: { fileCleanup: cleanup } });
  const created = service.createArticle(articleInput(coverAssetId), editorId);

  const result = service.deleteNeverPublishedDraft(created.articleId, editorId, {
    expectedRevisionId: created.revisionId,
  });

  assert.equal(result.status, 'deleted');
  assert.equal(result.cleanup.status, 'incomplete');
  assert.equal(result.cleanup.failureCount, 1);
  assert.equal(existsSync(coverPath), false);
  assert.equal(service.getArticle(created.articleId), undefined);
  const tombstone = db.prepare(`
    SELECT details_json FROM audit_events WHERE event_type = 'article.draft_deleted'
  `).get();
  const details = JSON.parse(tombstone.details_json);
  assert.equal(details.cleanup.status, 'incomplete');
  assert.equal(details.cleanup.failures.length, 1);
  assert.match(details.cleanup.failures[0].error, /injected final cleanup failure/);
  assert.equal(existsSync(details.cleanup.failures[0].stagedPath), true);
});

test('database enforces one configured editor plus immutable slugs and revision updates', (t) => {
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
    /FOREIGN KEY constraint failed/,
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
  for (const malformed of ['0', '07/10/2026', '2026-07-10T00:00:00.000Z']) {
    assert.throws(() => normalizePublicationDate(malformed), /YYYY-MM-DD/);
  }
  assert.equal(
    normalizePublicationDate('2026-07-09T21:00:00.000Z', { allowCanonicalTimestamp: true }),
    '2026-07-09T21:00:00.000Z',
  );
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
