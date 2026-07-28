import { createPrivatePreview } from '../render/preview.js';

export function createAdminActions({
  db,
  contentService,
  publisher,
  uploadStore,
  previewsRoot,
  publicOrigin,
  clock = () => new Date(),
} = {}) {
  function listArticles() {
    const articles = db.prepare(`
      SELECT a.id, a.slug, a.state, a.public_state, a.current_revision_id,
             a.published_revision_id, a.updated_at, r.revision_number,
             r.title, r.publication_at, r.lead, r.body_markdown, r.cover_asset_id,
             r.cover_alt, r.source_url, w.issue_id AS weekly_issue_id
      FROM articles a
      JOIN article_revisions r ON r.id = a.current_revision_id
      LEFT JOIN weekly_ingestion_issues w ON w.article_id = a.id
      ORDER BY a.updated_at DESC, a.id DESC
    `).all();
    const sources = db.prepare(`
      SELECT url FROM article_revision_sources
      WHERE revision_id = ? ORDER BY position
    `);
    return articles.map((article) => ({
      ...article,
      source_urls: sources.all(article.current_revision_id).map((source) => source.url),
      public_url: article.public_state === 'published'
        ? new URL(`/articles/${article.slug}/`, publicOrigin).href
        : null,
    }));
  }

  function listRevisions(articleId) {
    return db.prepare(`
      SELECT id, revision_number, title, created_at, restored_from_id
      FROM article_revisions WHERE article_id = ? ORDER BY revision_number DESC
    `).all(integer(articleId, 'articleId'));
  }

  function listReleases() {
    return db.prepare(`
      SELECT r.id, r.created_at, r.activated_at,
             CASE WHEN s.active_release_id = r.id THEN 1 ELSE 0 END AS active
      FROM releases r CROSS JOIN site_state s
      WHERE r.status = 'complete'
      ORDER BY r.activated_at DESC, r.created_at DESC LIMIT 20
    `).all();
  }

  function createDraft(input, editorId) {
    return contentService.createArticle(input, editorId);
  }

  function getSocialLinks() {
    return contentService.getSocialLinks();
  }

  function configureSocialLinks(input, editorId) {
    return contentService.configureSocialLinks(input, editorId);
  }

  function reviseDraft(articleId, input, editorId, expectedRevisionId) {
    return contentService.reviseArticle(
      integer(articleId, 'articleId'),
      input,
      editorId,
      { expectedRevisionId: integer(expectedRevisionId, 'expectedRevisionId') },
    );
  }

  function preview(revisionId, editorId) {
    const normalizedRevisionId = integer(revisionId, 'revisionId');
    const result = createPrivatePreview({
      db,
      revisionId: normalizedRevisionId,
      authenticatedEditorId: editorId,
      previewsRoot,
      publicOrigin,
    });
    audit('preview.created', editorId, { revisionId: normalizedRevisionId });
    return result;
  }

  async function publish(articleId, revisionId, editorId, confirmation) {
    requireConfirmation(confirmation, 'PUBLISH');
    const normalizedArticleId = integer(articleId, 'articleId');
    const normalizedRevisionId = integer(revisionId, 'revisionId');
    return publisher.publish({
      editorId,
      transition: {
        type: 'publish',
        articleId: normalizedArticleId,
        expectedRevisionId: normalizedRevisionId,
      },
    });
  }

  async function withdraw(articleId, expectedRevisionId, editorId, confirmation) {
    requireConfirmation(confirmation, 'WITHDRAW');
    return publisher.publish({
      editorId,
      transition: {
        type: 'withdraw',
        articleId: integer(articleId, 'articleId'),
        expectedRevisionId: integer(expectedRevisionId, 'expectedRevisionId'),
      },
    });
  }

  async function rollbackRelease(releaseId, editorId, confirmation) {
    requireConfirmation(confirmation, 'ROLLBACK');
    if (typeof releaseId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(releaseId)) {
      throw new TypeError('releaseId is invalid');
    }
    return publisher.rollback(releaseId, { editorId });
  }

  function restoreRevision(articleId, sourceRevisionId, expectedRevisionId, editorId, confirmation) {
    requireConfirmation(confirmation, 'RESTORE');
    return contentService.restoreRevision(
      integer(articleId, 'articleId'),
      integer(sourceRevisionId, 'sourceRevisionId'),
      editorId,
      { expectedRevisionId: integer(expectedRevisionId, 'expectedRevisionId') },
    );
  }

  async function upload(bytes, declaredMediaType, editorId) {
    const result = await uploadStore.store({ bytes, declaredMediaType, editorId });
    audit('asset.uploaded', editorId, { details: { assetId: result.assetId, uploadId: result.uploadId } });
    return result;
  }

  function audit(eventType, editorId, { revisionId = null, details = {} } = {}) {
    db.prepare(`
      INSERT INTO audit_events (editor_id, event_type, revision_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(editorId, eventType, revisionId, JSON.stringify(details), clock().toISOString());
  }

  return {
    listArticles,
    listRevisions,
    listReleases,
    createDraft,
    getSocialLinks,
    configureSocialLinks,
    reviseDraft,
    preview,
    publish,
    withdraw,
    rollbackRelease,
    restoreRevision,
    upload,
  };
}

function integer(value, name) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function requireConfirmation(actual, expected) {
  if (actual !== expected) throw new Error(`Explicit ${expected} confirmation is required`);
}
