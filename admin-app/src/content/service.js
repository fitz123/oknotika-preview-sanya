import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { allocateSlug } from './slug.js';
import { transaction } from './database.js';
import {
  validateArticleInput,
  validateSocialLinks,
  validateWeeklyArticleInput,
  validateWeeklyIngestionInput,
} from './validation.js';

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

    createArticle(input, editorId, {
      initialSlug,
      importedMetadata = null,
      contentKind = 'legacy',
    } = {}) {
      assertEditor(db, editorId);
      const data = contentKind === 'weekly_digest'
        ? validateWeeklyArticleInput(input)
        : validateArticleInput(input);
      if (!['legacy', 'weekly_digest'].includes(contentKind)) {
        throw new TypeError('contentKind is invalid');
      }
      const timestamp = now(clock);
      return transaction(db, () => {
        const slug = initialSlug ?? allocateSlug(db, data.title);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new TypeError('initialSlug must be lowercase ASCII');
        const articleResult = db.prepare(`
          INSERT INTO articles (slug, state, content_kind, created_at, updated_at)
          VALUES (?, 'draft', ?, ?, ?)
        `).run(slug, contentKind, timestamp, timestamp);
        const articleId = Number(articleResult.lastInsertRowid);
        const revisionId = insertRevision(db, articleId, data, editorId, timestamp, { importedMetadata });
        db.prepare('UPDATE articles SET current_revision_id = ? WHERE id = ?').run(revisionId, articleId);
        insertAudit(db, { type: 'article.created', editorId, articleId, revisionId }, clock);
        return { articleId, revisionId, slug };
      });
    },

    reviseArticle(articleId, input, editorId, { expectedRevisionId = null } = {}) {
      assertEditor(db, editorId);
      const timestamp = now(clock);
      return transaction(db, () => {
        const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
        if (!article) throw new Error('Article not found');
        assertExpectedRevision(article, expectedRevisionId);
        const data = article.content_kind === 'weekly_digest'
          ? validateWeeklyArticleInput(input)
          : validateArticleInput(input);
        const current = article.content_kind === 'legacy'
          ? db.prepare('SELECT * FROM article_revisions WHERE id = ?').get(article.current_revision_id)
          : null;
        const revisionId = insertRevision(db, articleId, data, editorId, timestamp, {
          importedMetadata: current ? importedMetadataFromRevision(current) : null,
        });
        db.prepare(`UPDATE articles SET current_revision_id = ?, state = 'draft', updated_at = ? WHERE id = ?`)
          .run(revisionId, timestamp, articleId);
        insertAudit(db, { type: 'article.revised', editorId, articleId, revisionId }, clock);
        return { articleId, revisionId, slug: article.slug };
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
        const sourceUrls = readRevisionSourceUrls(db, sourceRevisionId, source.source_url);
        const restoredInput = {
          title: source.title,
          publicationDate: source.publication_at,
          lead: source.lead,
          bodyMarkdown: source.body_markdown,
          coverAssetId: Number(source.cover_asset_id),
          coverAlt: source.cover_alt,
          sourceUrl: sourceUrls[0] ?? null,
          sourceUrls,
        };
        const restoredData = article.content_kind === 'weekly_digest'
          ? validateWeeklyArticleInput(restoredInput)
          : {
            ...restoredInput,
            publicationAt: source.publication_at,
          };
        const revisionId = insertRevision(db, articleId, restoredData, editorId, timestamp, {
          importedMetadata: importedMetadataFromRevision(source),
          restoredFromId: sourceRevisionId,
        });
        db.prepare(`UPDATE articles SET current_revision_id = ?, state = 'draft', updated_at = ? WHERE id = ?`)
          .run(revisionId, timestamp, articleId);
        insertAudit(db, {
          type: 'revision.restored', editorId, articleId, revisionId, details: { sourceRevisionId },
        }, clock);
        return revisionId;
      });
    },

    ingestWeeklyDraft(input) {
      const data = validateWeeklyIngestionInput(input);
      const payloadSha256 = weeklyPayloadHash(data);
      const timestamp = now(clock);
      return transaction(db, () => {
        const owner = db.prepare(
          'SELECT * FROM configured_editors WHERE enabled = 1 ORDER BY id LIMIT 1',
        ).get();
        if (!owner) throw new Error('A configured, enabled editor is required');
        if (!db.prepare('SELECT 1 FROM assets WHERE id = ?').get(data.article.coverAssetId)) {
          throw new TypeError('coverAssetId does not identify a registered private asset');
        }
        const existing = db.prepare(`
          SELECT w.*, a.slug, a.state, a.current_revision_id
          FROM weekly_ingestion_issues w
          JOIN articles a ON a.id = w.article_id
          WHERE w.issue_id = ?
        `).get(data.issueId);
        if (!existing) {
          if (data.contentVersion !== 1) {
            throw conflictError('A new weekly issue must start at contentVersion 1');
          }
          const slug = allocateSlug(db, `${data.article.title} ${data.issueId}`);
          const articleResult = db.prepare(`
            INSERT INTO articles (slug, state, content_kind, created_at, updated_at)
            VALUES (?, 'draft', 'weekly_digest', ?, ?)
          `).run(slug, timestamp, timestamp);
          const articleId = Number(articleResult.lastInsertRowid);
          const revisionId = insertRevision(
            db,
            articleId,
            data.article,
            Number(owner.id),
            timestamp,
          );
          db.prepare('UPDATE articles SET current_revision_id = ? WHERE id = ?')
            .run(revisionId, articleId);
          db.prepare(`
            INSERT INTO weekly_ingestion_issues
              (issue_id, article_id, content_version, last_ingestion_revision_id,
               payload_sha256, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            data.issueId,
            articleId,
            data.contentVersion,
            revisionId,
            payloadSha256,
            timestamp,
            timestamp,
          );
          insertAudit(db, {
            type: 'weekly_draft.ingested',
            articleId,
            revisionId,
            details: { issueId: data.issueId, contentVersion: data.contentVersion },
          }, clock);
          return {
            articleId,
            revisionId,
            slug,
            issueId: data.issueId,
            contentVersion: data.contentVersion,
            created: true,
            idempotent: false,
          };
        }
        const editoriallyLocked = db.prepare(`
          SELECT 1 FROM audit_events
          WHERE article_id = ?
            AND event_type IN ('article.published', 'article.withdrawn')
          LIMIT 1
        `).get(existing.article_id);
        if (editoriallyLocked || existing.state !== 'draft') {
          throw conflictError('Weekly ingestion cannot change an article that is no longer a private draft');
        }
        if (Number(existing.current_revision_id) !== Number(existing.last_ingestion_revision_id)) {
          throw conflictError('Weekly draft has manual edits; submit changes through the editor');
        }
        if (data.contentVersion < Number(existing.content_version)) {
          throw conflictError('contentVersion is older than the stored weekly issue version');
        }
        if (data.contentVersion === Number(existing.content_version)) {
          if (payloadSha256 !== existing.payload_sha256) {
            throw conflictError('contentVersion was already used for different weekly content');
          }
          return {
            articleId: Number(existing.article_id),
            revisionId: Number(existing.last_ingestion_revision_id),
            slug: existing.slug,
            issueId: data.issueId,
            contentVersion: data.contentVersion,
            created: false,
            idempotent: true,
          };
        }
        const articleId = Number(existing.article_id);
        const revisionId = insertRevision(
          db,
          articleId,
          data.article,
          Number(owner.id),
          timestamp,
        );
        db.prepare(`
          UPDATE articles
          SET current_revision_id = ?, state = 'draft', updated_at = ?
          WHERE id = ?
        `).run(revisionId, timestamp, articleId);
        db.prepare(`
          UPDATE weekly_ingestion_issues
          SET content_version = ?, last_ingestion_revision_id = ?,
              payload_sha256 = ?, updated_at = ?
          WHERE issue_id = ?
        `).run(data.contentVersion, revisionId, payloadSha256, timestamp, data.issueId);
        insertAudit(db, {
          type: 'weekly_draft.ingested',
          articleId,
          revisionId,
          details: { issueId: data.issueId, contentVersion: data.contentVersion },
        }, clock);
        return {
          articleId,
          revisionId,
          slug: existing.slug,
          issueId: data.issueId,
          contentVersion: data.contentVersion,
          created: false,
          idempotent: false,
        };
      });
    },

    getSocialLinks() {
      return readSocialLinks(db);
    },

    prepareSocialLinks(input, editorId) {
      assertEditor(db, editorId);
      const socialLinks = validateSocialLinks(input);
      if (!Object.hasOwn(input, 'futuchatUrl')) {
        socialLinks.futuchatUrl = readSocialLinks(db).futuchatUrl;
      }
      return socialLinks;
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

function insertRevision(db, articleId, data, editorId, timestamp, {
  importedMetadata = null,
  restoredFromId = null,
} = {}) {
  const result = db.prepare(`
    INSERT INTO article_revisions
      (article_id, revision_number, title, publication_at, lead, body_markdown,
       legacy_eyebrow, legacy_meta_description, legacy_listing_excerpt, cover_asset_id,
       cover_alt, source_url, created_by, created_at, restored_from_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    articleId, nextRevisionNumber(db, articleId), data.title, data.publicationAt, data.lead,
    data.bodyMarkdown, importedMetadata?.eyebrow ?? null, importedMetadata?.description ?? null,
    importedMetadata?.listingExcerpt ?? null, data.coverAssetId, data.coverAlt, data.sourceUrl,
    editorId, timestamp, restoredFromId,
  );
  const revisionId = Number(result.lastInsertRowid);
  const insertSource = db.prepare(`
    INSERT INTO article_revision_sources (revision_id, position, url)
    VALUES (?, ?, ?)
  `);
  data.sourceUrls.forEach((url, position) => insertSource.run(revisionId, position, url));
  return revisionId;
}

function readRevisionSourceUrls(db, revisionId, fallbackSourceUrl) {
  const sourceUrls = db.prepare(`
    SELECT url FROM article_revision_sources
    WHERE revision_id = ? ORDER BY position
  `).all(revisionId).map((row) => row.url);
  if (sourceUrls.length > 0) return sourceUrls;
  return fallbackSourceUrl ? [fallbackSourceUrl] : [];
}

function readSocialLinks(db) {
  const links = db.prepare(`
    SELECT telegram_url, youtube_url, vk_url, futuchat_url, updated_at
    FROM site_social_links WHERE singleton = 1
  `).get();
  return {
    telegramUrl: links.telegram_url,
    youtubeUrl: links.youtube_url,
    vkUrl: links.vk_url,
    futuchatUrl: links.futuchat_url,
    updatedAt: links.updated_at,
  };
}

function importedMetadataFromRevision(revision) {
  return {
    eyebrow: revision.legacy_eyebrow,
    description: revision.legacy_meta_description,
    listingExcerpt: revision.legacy_listing_excerpt,
  };
}

function weeklyPayloadHash(data) {
  return createHash('sha256').update(JSON.stringify({
    issueId: data.issueId,
    contentVersion: data.contentVersion,
    article: data.article,
  })).digest('hex');
}

function conflictError(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}
