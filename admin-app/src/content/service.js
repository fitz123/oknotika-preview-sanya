import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
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
  const result = db.prepare(`
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
  return Number(result.lastInsertRowid);
}

const DEFAULT_FILE_CLEANUP = Object.freeze({
  lstat: (path) => lstatSync(path),
  rename: (source, destination) => renameSync(source, destination),
  remove: (path, options) => rmSync(path, options),
});

export function createContentService(db, {
  clock = () => new Date(),
  fileCleanup = DEFAULT_FILE_CLEANUP,
  previewsRoot = null,
} = {}) {
  const normalizedPreviewsRoot = previewsRoot === null ? null : resolve(previewsRoot);
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
          ? validateWeeklyArticleInput(restoredInput, { allowCanonicalPublicationDate: true })
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

    deleteNeverPublishedDraft(articleId, editorId, { expectedRevisionId } = {}) {
      assertEditor(db, editorId);
      const normalizedArticleId = positiveInteger(articleId, 'articleId');
      const normalizedRevisionId = positiveInteger(expectedRevisionId, 'expectedRevisionId');
      const staged = [];
      let result;
      try {
        result = transaction(db, () => {
          const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(normalizedArticleId);
          if (!article) return { status: 'not_found', articleId: normalizedArticleId };
          assertExpectedRevision(article, normalizedRevisionId);
          assertNeverPublished(db, article);

          const revisions = db.prepare(`
            SELECT id, cover_asset_id FROM article_revisions
            WHERE article_id = ? ORDER BY id
          `).all(normalizedArticleId);
          const revisionIds = revisions.map((revision) => Number(revision.id));
          const candidateAssetIds = [...new Set(
            revisions.map((revision) => Number(revision.cover_asset_id)),
          )];
          const previews = db.prepare(`
            SELECT preview_id, directory FROM private_previews
            WHERE revision_id IN (
              SELECT id FROM article_revisions WHERE article_id = ?
            )
            ORDER BY preview_id
          `).all(normalizedArticleId);
          const weeklyIssues = db.prepare(`
            SELECT issue_id FROM weekly_ingestion_issues
            WHERE article_id = ? ORDER BY issue_id
          `).all(normalizedArticleId).map((issue) => issue.issue_id);

          db.prepare('DELETE FROM weekly_ingestion_issues WHERE article_id = ?')
            .run(normalizedArticleId);
          db.prepare(`
            DELETE FROM audit_events
            WHERE article_id = ? OR revision_id IN (
              SELECT id FROM article_revisions WHERE article_id = ?
            )
          `).run(normalizedArticleId, normalizedArticleId);
          db.prepare(`
            UPDATE articles SET current_revision_id = NULL
            WHERE id = ?
          `).run(normalizedArticleId);
          db.prepare(`
            DELETE FROM private_previews
            WHERE revision_id IN (
              SELECT id FROM article_revisions WHERE article_id = ?
            )
          `).run(normalizedArticleId);
          for (const preview of previews) {
            if (isOwnedPreview(preview, normalizedPreviewsRoot)) {
              stagePath(fileCleanup, staged, {
                kind: 'preview',
                path: preview.directory,
                reference: preview.preview_id,
              });
            }
          }
          db.prepare(`
            DELETE FROM article_revision_sources
            WHERE revision_id IN (
              SELECT id FROM article_revisions WHERE article_id = ?
            )
          `).run(normalizedArticleId);
          const deleteRevision = db.prepare('DELETE FROM article_revisions WHERE id = ?');
          for (const revisionId of [...revisionIds].reverse()) {
            deleteRevision.run(revisionId);
          }

          const deletedAssetIds = [];
          const retainedAssetIds = [];
          for (const assetId of candidateAssetIds) {
            const stillReferenced = db.prepare(`
              SELECT 1 FROM article_revisions WHERE cover_asset_id = ? LIMIT 1
            `).get(assetId);
            if (stillReferenced) {
              retainedAssetIds.push(assetId);
              continue;
            }
            const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
            if (!asset) continue;
            const upload = db.prepare(`
              SELECT id, original_path FROM private_uploads
              WHERE sanitized_asset_id = ?
            `).get(assetId);
            stageUnsharedAssetPath(db, fileCleanup, staged, asset.private_path, assetId, {
              kind: 'asset',
              reference: assetId,
            });
            if (upload) {
              stageUnsharedAssetPath(db, fileCleanup, staged, upload.original_path, assetId, {
                kind: 'upload-original',
                reference: Number(upload.id),
              });
              db.prepare('DELETE FROM private_uploads WHERE id = ?').run(upload.id);
            }
            db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
            deletedAssetIds.push(assetId);
          }

          db.prepare('DELETE FROM articles WHERE id = ?').run(normalizedArticleId);
          const details = {
            articleId: normalizedArticleId,
            expectedRevisionId: normalizedRevisionId,
            revisionIds,
            weeklyIssues,
            deletedAssetIds,
            retainedAssetIds,
            previewIds: previews.map((preview) => preview.preview_id),
            preservedPreviewIds: previews
              .filter((preview) => !isOwnedPreview(preview, normalizedPreviewsRoot))
              .map((preview) => preview.preview_id),
            untrackedPreviewsPreserved: true,
            cleanup: cleanupDetails(staged, 'pending'),
          };
          const tombstoneId = insertAudit(db, {
            type: 'article.draft_deleted',
            editorId,
            details,
          }, clock);
          return {
            status: 'deleted',
            articleId: normalizedArticleId,
            revisionIds,
            deletedAssetIds,
            retainedAssetIds,
            tombstoneId,
            details,
          };
        });
      } catch (error) {
        const recoveryFailures = restoreStaged(fileCleanup, staged);
        if (recoveryFailures.length > 0) {
          throw new AggregateError(
            [error, ...recoveryFailures],
            'Draft deletion failed and one or more quarantined files could not be restored',
          );
        }
        throw error;
      }

      if (result.status === 'not_found') return result;
      const cleanupFailures = removeStaged(fileCleanup, staged);
      const cleanupStatus = cleanupFailures.length === 0 ? 'completed' : 'incomplete';
      result.details.cleanup = cleanupDetails(staged, cleanupStatus, cleanupFailures);
      db.prepare('UPDATE audit_events SET details_json = ? WHERE id = ?')
        .run(JSON.stringify(result.details), result.tombstoneId);
      return {
        status: result.status,
        articleId: result.articleId,
        revisionIds: result.revisionIds,
        deletedAssetIds: result.deletedAssetIds,
        retainedAssetIds: result.retainedAssetIds,
        cleanup: {
          status: result.details.cleanup.status,
          failureCount: result.details.cleanup.failures.length,
        },
      };
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

function positiveInteger(value, name) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return number;
}

function assertNeverPublished(db, article) {
  const hasRelease = db.prepare(`
    SELECT 1 FROM release_articles WHERE article_id = ? LIMIT 1
  `).get(article.id);
  const hasPublicTransition = db.prepare(`
    SELECT 1 FROM audit_events
    WHERE article_id = ?
      AND event_type IN ('article.published', 'article.withdrawn')
    LIMIT 1
  `).get(article.id);
  if (article.state !== 'draft'
      || article.public_state !== null
      || article.published_revision_id !== null
      || hasRelease
      || hasPublicTransition) {
    throw conflictError('Only a never-published private draft can be deleted');
  }
}

function stageUnsharedAssetPath(db, fileCleanup, staged, path, assetId, target) {
  const shared = db.prepare(`
    SELECT 1 FROM assets WHERE id <> ? AND private_path = ?
    UNION ALL
    SELECT 1 FROM private_uploads WHERE sanitized_asset_id <> ? AND original_path = ?
    LIMIT 1
  `).get(assetId, path, assetId, path);
  if (!shared) stagePath(fileCleanup, staged, { ...target, path });
}

function isOwnedPreview(preview, previewsRoot) {
  return previewsRoot !== null
    && /^[A-Za-z0-9_-]{32}$/.test(preview.preview_id)
    && preview.directory === resolve(previewsRoot, preview.preview_id);
}

function stagePath(fileCleanup, staged, target) {
  if (staged.some((item) => item.originalPath === target.path)) return;
  try {
    fileCleanup.lstat(target.path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      staged.push({
        kind: target.kind,
        reference: target.reference,
        originalPath: target.path,
        stagedPath: null,
        missing: true,
      });
      return;
    }
    throw error;
  }
  const stagedPath = `${target.path}.delete-${randomUUID()}`;
  fileCleanup.rename(target.path, stagedPath);
  staged.push({
    kind: target.kind,
    reference: target.reference,
    originalPath: target.path,
    stagedPath,
    missing: false,
  });
}

function restoreStaged(fileCleanup, staged) {
  const failures = [];
  for (const item of [...staged].reverse()) {
    if (!item.stagedPath) continue;
    try {
      fileCleanup.rename(item.stagedPath, item.originalPath);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function removeStaged(fileCleanup, staged) {
  const failures = [];
  for (const item of staged) {
    if (!item.stagedPath) continue;
    try {
      fileCleanup.remove(item.stagedPath, {
        recursive: item.kind === 'preview',
        force: false,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        failures.push({
          kind: item.kind,
          reference: item.reference,
          originalPath: item.originalPath,
          stagedPath: item.stagedPath,
          error: error.message,
        });
      }
    }
  }
  return failures;
}

function cleanupDetails(staged, status, failures = []) {
  return {
    status: staged.length === 0 ? 'not_needed' : status,
    targets: staged.map((item) => ({
      kind: item.kind,
      reference: item.reference,
      originalPath: item.originalPath,
      stagedPath: item.stagedPath,
      missing: item.missing,
    })),
    failures,
  };
}
