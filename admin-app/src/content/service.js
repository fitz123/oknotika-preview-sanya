import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { allocateSlug } from './slug.js';
import { transaction } from './database.js';
import { validateArticleInput } from './validation.js';

function now(clock) {
  return clock().toISOString();
}

function assertEditor(db, editorId) {
  const editor = db.prepare('SELECT * FROM configured_editors WHERE id = ? AND enabled = 1').get(editorId);
  if (!editor) throw new Error('A configured, enabled editor is required');
  return editor;
}

function insertAudit(db, event, clock) {
  db.prepare(`
    INSERT INTO audit_events
      (editor_id, event_type, article_id, revision_id, release_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.editorId ?? null,
    event.type,
    event.articleId ?? null,
    event.revisionId ?? null,
    event.releaseId ?? null,
    JSON.stringify(event.details ?? {}),
    now(clock),
  );
}

export function createContentService(db, { clock = () => new Date() } = {}) {
  return {
    configureEditor({ issuer, subject }) {
      if (!issuer || !subject) throw new TypeError('issuer and subject are required');
      const timestamp = now(clock);
      const result = db.prepare(`
        INSERT INTO configured_editors (issuer, subject, enabled, created_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT (issuer, subject) DO UPDATE SET enabled = 1, disabled_at = NULL
        RETURNING id
      `).get(issuer, subject, timestamp);
      return Number(result.id);
    },

    disableEditor(editorId) {
      const result = db.prepare(`
        UPDATE configured_editors SET enabled = 0, disabled_at = ?
        WHERE id = ? AND enabled = 1
      `).run(now(clock), editorId);
      if (result.changes !== 1) throw new Error('Enabled editor not found');
      db.prepare(`
        UPDATE admin_sessions SET revoked_at = ?, revocation_reason = 'editor-disabled'
        WHERE editor_id = ? AND revoked_at IS NULL
      `).run(now(clock), editorId);
      insertAudit(db, { type: 'editor.disabled', editorId }, clock);
    },

    registerAsset({ privatePath, mediaType, width = null, height = null }) {
      const bytes = readFileSync(privatePath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const storageKey = `${randomUUID()}-${basename(privatePath)}`;
      const result = db.prepare(`
        INSERT INTO assets (storage_key, private_path, sha256, media_type, width, height, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(storageKey, privatePath, sha256, mediaType, width, height, now(clock));
      return Number(result.lastInsertRowid);
    },

    createArticle(input, editorId, { initialSlug, importedMetadata = null } = {}) {
      assertEditor(db, editorId);
      const data = validateArticleInput(input);
      const timestamp = now(clock);
      return transaction(db, () => {
        const slug = initialSlug ?? allocateSlug(db, data.title);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new TypeError('initialSlug must be lowercase ASCII');
        const articleResult = db.prepare(`
          INSERT INTO articles (slug, state, created_at, updated_at)
          VALUES (?, 'draft', ?, ?)
        `).run(slug, timestamp, timestamp);
        const articleId = Number(articleResult.lastInsertRowid);
        const revisionId = insertRevision(db, articleId, data, editorId, timestamp, importedMetadata);
        db.prepare('UPDATE articles SET current_revision_id = ? WHERE id = ?').run(revisionId, articleId);
        insertAudit(db, { type: 'article.created', editorId, articleId, revisionId }, clock);
        return { articleId, revisionId, slug };
      });
    },

    reviseArticle(articleId, input, editorId, { expectedRevisionId = null } = {}) {
      assertEditor(db, editorId);
      const data = validateArticleInput(input);
      const timestamp = now(clock);
      return transaction(db, () => {
        const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
        if (!article) throw new Error('Article not found');
        assertExpectedRevision(article, expectedRevisionId);
        const revisionId = insertRevision(db, articleId, data, editorId, timestamp);
        db.prepare(`UPDATE articles SET current_revision_id = ?, state = 'draft', updated_at = ? WHERE id = ?`)
          .run(revisionId, timestamp, articleId);
        insertAudit(db, { type: 'article.revised', editorId, articleId, revisionId }, clock);
        return { articleId, revisionId, slug: article.slug };
      });
    },

    publishRevision(articleId, revisionId, editorId, { expectedRevisionId = null } = {}) {
      assertEditor(db, editorId);
      return transaction(db, () => {
        const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
        if (!article) throw new Error('Article not found');
        assertExpectedRevision(article, expectedRevisionId);
        if (Number(article.current_revision_id) !== Number(revisionId)) {
          throw new Error('Only the current revision can be published');
        }
        const revision = db.prepare('SELECT * FROM article_revisions WHERE id = ? AND article_id = ?')
          .get(revisionId, articleId);
        if (!revision) throw new Error('Revision not found for article');
        db.prepare(`UPDATE articles SET current_revision_id = ?, state = 'published', updated_at = ? WHERE id = ?`)
          .run(revisionId, now(clock), articleId);
        insertAudit(db, { type: 'article.marked_published', editorId, articleId, revisionId }, clock);
      });
    },

    withdrawArticle(articleId, editorId, { expectedRevisionId = null } = {}) {
      assertEditor(db, editorId);
      return transaction(db, () => {
        const article = db.prepare("SELECT * FROM articles WHERE id = ? AND state = 'published'").get(articleId);
        if (!article) throw new Error('Only a published article can be withdrawn');
        assertExpectedRevision(article, expectedRevisionId);
        db.prepare(`UPDATE articles SET state = 'withdrawn', updated_at = ? WHERE id = ?`)
          .run(now(clock), articleId);
        insertAudit(db, {
          type: 'article.withdrawn', editorId, articleId, revisionId: article.current_revision_id,
        }, clock);
      });
    },

    restoreRevision(articleId, sourceRevisionId, editorId, { expectedRevisionId = null } = {}) {
      assertEditor(db, editorId);
      const timestamp = now(clock);
      return transaction(db, () => {
        const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
        if (!article) throw new Error('Article not found');
        assertExpectedRevision(article, expectedRevisionId);
        const source = db.prepare('SELECT * FROM article_revisions WHERE id = ? AND article_id = ?')
          .get(sourceRevisionId, articleId);
        if (!source) throw new Error('Revision not found for article');
        const revisionNumber = nextRevisionNumber(db, articleId);
        const result = db.prepare(`
          INSERT INTO article_revisions
            (article_id, revision_number, title, publication_at, lead, body_markdown,
             legacy_eyebrow, legacy_meta_description, legacy_listing_excerpt, cover_asset_id,
             cover_alt, source_url, created_by, created_at, restored_from_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          articleId, revisionNumber, source.title, source.publication_at, source.lead,
          source.body_markdown, source.legacy_eyebrow, source.legacy_meta_description,
          source.legacy_listing_excerpt, source.cover_asset_id, source.cover_alt,
          source.source_url, editorId, timestamp, sourceRevisionId,
        );
        const revisionId = Number(result.lastInsertRowid);
        db.prepare(`UPDATE articles SET current_revision_id = ?, state = 'draft', updated_at = ? WHERE id = ?`)
          .run(revisionId, timestamp, articleId);
        insertAudit(db, {
          type: 'revision.restored', editorId, articleId, revisionId, details: { sourceRevisionId },
        }, clock);
        return revisionId;
      });
    },

    getArticle(articleId) {
      return db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
    },
  };
}

function assertExpectedRevision(article, expectedRevisionId) {
  if (expectedRevisionId === null) return;
  if (!Number.isInteger(expectedRevisionId) || Number(article.current_revision_id) !== expectedRevisionId) {
    throw new Error('Revision conflict: the article changed after the form was loaded');
  }
}

function nextRevisionNumber(db, articleId) {
  return Number(db.prepare(`
    SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM article_revisions WHERE article_id = ?
  `).get(articleId).next);
}

function insertRevision(db, articleId, data, editorId, timestamp, importedMetadata = null) {
  const result = db.prepare(`
    INSERT INTO article_revisions
      (article_id, revision_number, title, publication_at, lead, body_markdown,
       legacy_eyebrow, legacy_meta_description, legacy_listing_excerpt, cover_asset_id,
       cover_alt, source_url, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    articleId, nextRevisionNumber(db, articleId), data.title, data.publicationAt, data.lead,
    data.bodyMarkdown, importedMetadata?.eyebrow ?? null, importedMetadata?.description ?? null,
    importedMetadata?.listingExcerpt ?? null, data.coverAssetId, data.coverAlt, data.sourceUrl,
    editorId, timestamp,
  );
  return Number(result.lastInsertRowid);
}
