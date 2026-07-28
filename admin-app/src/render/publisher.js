import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { transaction } from '../content/database.js';
import {
  loadPublicSnapshot,
  loadRevisionSnapshot,
  loadSocialLinks,
  renderRelease,
  validateRelease,
} from './renderer.js';
import { FIXED_TELEGRAM_URL, validateSocialLinks } from '../content/validation.js';

const LEGACY_SOCIAL_LINKS = Object.freeze({
  telegramUrl: FIXED_TELEGRAM_URL,
  youtubeUrl: null,
  vkUrl: null,
  futuchatUrl: null,
});
const SCHEMA_THREE_SOCIAL_FIELDS = Object.freeze([
  'telegramUrl',
  'vkUrl',
  'youtubeUrl',
]);
const SCHEMA_THREE_VK_HOSTS = new Set(['vk.com', 'www.vk.com']);

export function createPublisher(db, {
  releasesRoot,
  publicOrigin,
  clock = () => new Date(),
  onFatalConsistencyError = () => {},
} = {}) {
  if (!releasesRoot) throw new TypeError('releasesRoot is required');
  const immutableRoot = resolve(releasesRoot, 'releases');
  const stagingRoot = resolve(releasesRoot, 'staging');
  const activePath = resolve(releasesRoot, 'active');
  mkdirSync(immutableRoot, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });
  const filesystemDevices = new Set([
    statSync(releasesRoot).dev,
    statSync(immutableRoot).dev,
    statSync(stagingRoot).dev,
  ]);
  if (filesystemDevices.size !== 1) {
    throw new Error('Staging, immutable releases and active symlink must share one filesystem');
  }
  let quarantineError = null;

  async function publish({ editorId = null, transition = null, inject = async () => {} } = {}) {
    assertPublisherIsWritable(quarantineError);
    const lock = acquirePublisherLock(releasesRoot);
    let stage = null;
    let activeSwitched = false;
    try {
      const generatedAt = clock().toISOString();
      const prospective = buildProspectiveSnapshot(db, transition);
      const snapshot = prospective.snapshot;
      const releaseId = createReleaseId(generatedAt, snapshot, prospective.socialLinks);
      stage = resolve(stagingRoot, `${releaseId}-${randomUUID()}`);
      const final = resolve(immutableRoot, releaseId);
      const previous = db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get()?.active_release_id ?? null;
      db.prepare(`
        INSERT INTO releases (id, status, previous_release_id, created_at)
        VALUES (?, 'staging', ?, ?)
      `).run(releaseId, previous, generatedAt);

      await inject('before-stage-render');
      mkdirSync(stage, { recursive: true });
      const manifest = renderRelease({
        snapshot,
        outputDirectory: stage,
        publicOrigin,
        releaseId,
        generatedAt,
        transition: prospective.transition,
        socialLinks: prospective.socialLinks,
      });
      validateRelease(stage);
      await inject('after-stage-render');

      await inject('before-immutable-rename');
      renameSync(stage, final);
      stage = null;
      await inject('after-immutable-rename');

      await inject('before-active-switch');
      switchActive(releasesRoot, activePath, final);
      activeSwitched = true;
      await inject('after-active-switch');

      await inject('before-db-finalize');
      finalizeRelease(db, manifest, previous, generatedAt, editorId);
      await inject('after-db-finalize');
      return manifest;
    } catch (error) {
      if (activeSwitched) {
        try {
          reconcileUnderLock();
          quarantineError = null;
        } catch (reconciliationError) {
          quarantineError = new AggregateError(
            [error, reconciliationError],
            'Publication switched the active release but database reconciliation failed; publisher is quarantined',
          );
          onFatalConsistencyError(quarantineError);
          throw quarantineError;
        }
      }
      throw error;
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
      releasePublisherLock(lock);
    }
  }

  function reconcile({ publisherLockHeld = false } = {}) {
    if (publisherLockHeld && process.env.OKNOTIKA_PUBLISHER_LOCK_HELD !== '1') {
      throw new Error('publisherLockHeld requires the deployment lock wrapper');
    }
    const lock = publisherLockHeld ? null : acquirePublisherLock(releasesRoot);
    try {
      const manifest = reconcileUnderLock();
      quarantineError = null;
      return manifest;
    } catch (error) {
      quarantineError = error;
      throw error;
    } finally {
      if (lock) releasePublisherLock(lock);
    }
  }

  async function activatePendingSocialDefaults(activeManifest) {
    const pending = loadPendingSocialDefaults(db);
    if (!pending) return activeManifest;
    if (activeManifest === null) {
      transaction(db, () => {
        synchronizePendingSocialDefaults(db, pending);
        clearPendingSocialDefaults(db);
      });
      return null;
    }
    if (activeManifest.schemaVersion >= 4) {
      transaction(db, () => clearPendingSocialDefaults(db));
      return activeManifest;
    }
    const activeSocialLinks = activeManifest.schemaVersion >= 3
      ? validateSocialLinks(activeManifest.socialLinks)
      : LEGACY_SOCIAL_LINKS;
    return publish({
      transition: {
        type: 'social_links',
        socialLinks: {
          telegramUrl: activeSocialLinks.telegramUrl,
          youtubeUrl: activeSocialLinks.youtubeUrl ?? pending.youtubeUrl,
          vkUrl: activeSocialLinks.vkUrl ?? pending.vkUrl,
          futuchatUrl: activeSocialLinks.futuchatUrl ?? pending.futuchatUrl,
        },
      },
    });
  }

  function reconcileUnderLock() {
    let target;
    try {
      const activeTarget = readlinkSync(activePath);
      if (!/^releases\/[a-zA-Z0-9._-]+$/.test(activeTarget)) {
        throw new Error('Active release symlink has an invalid target');
      }
      target = resolve(releasesRoot, activeTarget);
    } catch (error) {
      if (error.code === 'ENOENT') {
        const publicState = db.prepare(`
          SELECT active_release_id,
            (SELECT COUNT(*) FROM articles
             WHERE published_revision_id IS NOT NULL OR public_state IS NOT NULL) AS public_article_count
          FROM site_state WHERE singleton = 1
        `).get();
        if (!publicState?.active_release_id && Number(publicState?.public_article_count ?? 0) === 0) return null;
        throw new Error('Active release symlink is missing while SQLite still records public state', { cause: error });
      }
      throw error;
    }
    const manifest = validateRelease(target);
    const timestamp = clock().toISOString();
    const current = db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get()?.active_release_id ?? null;
    const pendingRollback = findPendingRollback(db, manifest.releaseId, current);
    transaction(db, () => {
      db.prepare(`
        INSERT INTO releases (id, status, manifest_json, previous_release_id, created_at, activated_at)
        VALUES (?, 'complete', ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          status = 'complete', manifest_json = excluded.manifest_json, activated_at = excluded.activated_at
      `).run(manifest.releaseId, JSON.stringify(manifest), current, manifest.generatedAt, timestamp);
      recordReleaseArticles(db, manifest);
      synchronizePublicState(db, manifest, timestamp);
      synchronizeSocialLinks(db, manifest, timestamp);
      db.prepare('UPDATE site_state SET active_release_id = ?, updated_at = ? WHERE singleton = 1')
        .run(manifest.releaseId, timestamp);
      db.prepare(`
        INSERT INTO audit_events (event_type, release_id, details_json, created_at)
        VALUES ('release.reconciled', ?, ?, ?)
      `).run(manifest.releaseId, JSON.stringify({ activeTarget: basename(target) }), timestamp);
      reconcileTransitionAudit(db, manifest, timestamp);
      if (pendingRollback) insertRollbackAudit(db, pendingRollback, timestamp);
      if (manifest.schemaVersion >= 4) {
        const pending = loadPendingSocialDefaults(db);
        if (pending
            && isDeepStrictEqual(validateSocialLinks(manifest.socialLinks), pending)) {
          clearPendingSocialDefaults(db);
        }
      }
    });
    return manifest;
  }

  async function rollback(targetReleaseId, {
    editorId = null,
    inject = async () => {},
    applicationSchemaVersion = null,
  } = {}) {
    assertPublisherIsWritable(quarantineError);
    const lock = acquirePublisherLock(releasesRoot);
    let activeSwitched = false;
    try {
      const release = db.prepare("SELECT * FROM releases WHERE id = ? AND status = 'complete'").get(targetReleaseId);
      if (!release) throw new Error('Completed release not found');
      const target = resolve(immutableRoot, targetReleaseId);
      const manifest = validateRelease(target);
      assertApplicationRollbackCompatibility(manifest, applicationSchemaVersion);
      assertRollbackTargetIntegrity(db, release, manifest, targetReleaseId);
      const previous = db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get().active_release_id;
      const operationId = randomUUID();
      const startedAt = clock().toISOString();
      db.prepare(`
        INSERT INTO audit_events (editor_id, event_type, release_id, details_json, created_at)
        VALUES (?, 'release.rollback_started', ?, ?, ?)
      `).run(editorId, targetReleaseId, JSON.stringify({ operationId, previous }), startedAt);
      await inject('before-active-switch');
      switchActive(releasesRoot, activePath, target);
      activeSwitched = true;
      await inject('after-active-switch');
      await inject('before-db-finalize');
      const timestamp = clock().toISOString();
      transaction(db, () => {
        synchronizePublicState(db, manifest, timestamp);
        synchronizeSocialLinks(db, manifest, timestamp);
        db.prepare('UPDATE site_state SET active_release_id = ?, updated_at = ? WHERE singleton = 1')
          .run(targetReleaseId, timestamp);
        insertRollbackAudit(db, {
          editorId,
          operationId,
          previous,
          targetReleaseId,
        }, timestamp);
      });
      await inject('after-db-finalize');
      return manifest;
    } catch (error) {
      if (activeSwitched) {
        try {
          reconcileUnderLock();
          quarantineError = null;
        } catch (reconciliationError) {
          quarantineError = new AggregateError(
            [error, reconciliationError],
            'Rollback switched the active release but database reconciliation failed; publisher is quarantined',
          );
          onFatalConsistencyError(quarantineError);
          throw quarantineError;
        }
      }
      throw error;
    } finally {
      releasePublisherLock(lock);
    }
  }

  return {
    publish,
    reconcile,
    activatePendingSocialDefaults,
    rollback,
    activePath,
  };
}

function assertPublisherIsWritable(quarantineError) {
  if (quarantineError) {
    throw new Error('Publisher is quarantined until active-release reconciliation succeeds', {
      cause: quarantineError,
    });
  }
}

function assertApplicationRollbackCompatibility(manifest, applicationSchemaVersion) {
  if (applicationSchemaVersion === null) return;
  if (applicationSchemaVersion !== 3) {
    throw new TypeError('Only application schema version 3 rollback preparation is supported');
  }
  if (![2, 3].includes(manifest.schemaVersion)) {
    throw new Error('Application schema version 3 requires a schema-2 or schema-3 article release');
  }
  if (manifest.schemaVersion === 2) return;

  const fields = Object.keys(manifest.socialLinks ?? {}).sort();
  if (!isDeepStrictEqual(fields, SCHEMA_THREE_SOCIAL_FIELDS)) {
    throw new Error('Schema-3 application rollback requires the legacy Telegram/YouTube/VK social contract');
  }
  const vkUrl = manifest.socialLinks.vkUrl;
  if (vkUrl !== null && !SCHEMA_THREE_VK_HOSTS.has(new URL(vkUrl).hostname.toLowerCase())) {
    throw new Error('Schema-3 application rollback requires a legacy vk.com destination');
  }
}

function assertRollbackTargetIntegrity(db, release, manifest, targetReleaseId) {
  if (manifest.releaseId !== targetReleaseId) {
    throw new Error('Rollback manifest release ID does not match its target');
  }
  let storedManifest;
  try {
    storedManifest = JSON.parse(release.manifest_json);
  } catch {
    throw new Error('Completed release has no valid stored manifest');
  }
  if (!isDeepStrictEqual(manifest, storedManifest)) {
    throw new Error('Rollback release does not match its stored manifest');
  }
  const storedArticles = db.prepare(`
    SELECT article_id AS articleId, revision_id AS revisionId, public_state AS state
    FROM release_articles
    WHERE release_id = ?
    ORDER BY article_id
  `).all(targetReleaseId).map(({ articleId, revisionId, state }) => ({
    articleId,
    revisionId,
    state,
  }));
  const manifestArticles = manifest.articles
    .map(({ articleId, revisionId, state }) => ({ articleId, revisionId, state }))
    .sort((left, right) => left.articleId - right.articleId);
  if (!isDeepStrictEqual(manifestArticles, storedArticles)) {
    throw new Error('Rollback manifest does not match the stored release article ledger');
  }
}

function finalizeRelease(db, manifest, previous, timestamp, editorId) {
  transaction(db, () => {
    db.prepare(`
      UPDATE releases
      SET status = 'complete', manifest_json = ?, previous_release_id = ?, activated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(manifest), previous, timestamp, manifest.releaseId);
    recordReleaseArticles(db, manifest);
    synchronizePublicState(db, manifest, timestamp);
    synchronizeSocialLinks(db, manifest, timestamp, editorId);
    db.prepare('UPDATE site_state SET active_release_id = ?, updated_at = ? WHERE singleton = 1')
      .run(manifest.releaseId, timestamp);
    db.prepare(`
      INSERT INTO audit_events (editor_id, event_type, release_id, details_json, created_at)
      VALUES (?, 'release.published', ?, '{}', ?)
    `).run(editorId, manifest.releaseId, timestamp);
    if (manifest.transition?.type === 'publish') {
      insertTransitionAudit(db, editorId, 'article.published', manifest.transition, manifest.releaseId, timestamp);
    } else if (manifest.transition?.type === 'withdraw') {
      insertTransitionAudit(db, editorId, 'article.withdrawn', manifest.transition, manifest.releaseId, timestamp);
    } else if (manifest.transition?.type === 'social_links') {
      insertSocialTransitionAudit(db, editorId, manifest, timestamp);
    }
    if (manifest.schemaVersion >= 4) clearPendingSocialDefaults(db);
  });
}

function insertTransitionAudit(db, editorId, type, transition, releaseId, timestamp) {
  db.prepare(`
    INSERT INTO audit_events
      (editor_id, event_type, article_id, revision_id, release_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?)
  `).run(editorId, type, transition.articleId, transition.revisionId, releaseId, timestamp);
}

function reconcileTransitionAudit(db, manifest, timestamp) {
  const transition = manifest.transition;
  if (transition?.type === 'social_links') {
    const existing = db.prepare(`
      SELECT 1 FROM audit_events
      WHERE event_type = 'social_links.updated' AND release_id = ?
    `).get(manifest.releaseId);
    if (!existing) insertSocialTransitionAudit(db, null, manifest, timestamp);
    return;
  }
  if (!transition || !['publish', 'withdraw'].includes(transition.type)) return;
  const type = transition.type === 'publish' ? 'article.published' : 'article.withdrawn';
  const existing = db.prepare(`
    SELECT 1 FROM audit_events
    WHERE event_type = ? AND article_id = ? AND revision_id = ? AND release_id = ?
  `).get(type, transition.articleId, transition.revisionId, manifest.releaseId);
  if (!existing) insertTransitionAudit(db, null, type, transition, manifest.releaseId, timestamp);
}

function insertSocialTransitionAudit(db, editorId, manifest, timestamp) {
  const socialLinks = validateSocialLinks(
    manifest.schemaVersion >= 3 ? manifest.socialLinks : LEGACY_SOCIAL_LINKS,
  );
  db.prepare(`
    INSERT INTO audit_events (editor_id, event_type, release_id, details_json, created_at)
    VALUES (?, 'social_links.updated', ?, ?, ?)
  `).run(editorId, manifest.releaseId, JSON.stringify({
    telegramConfigured: true,
    youtubeConfigured: socialLinks.youtubeUrl !== null,
    vkConfigured: socialLinks.vkUrl !== null,
    futuchatConfigured: socialLinks.futuchatUrl !== null,
  }), timestamp);
}

function insertRollbackAudit(db, {
  editorId,
  operationId,
  previous,
  targetReleaseId,
}, timestamp) {
  db.prepare(`
    INSERT INTO audit_events (editor_id, event_type, release_id, details_json, created_at)
    VALUES (?, 'release.rolled_back', ?, ?, ?)
  `).run(
    editorId,
    targetReleaseId,
    JSON.stringify({ operationId, previous }),
    timestamp,
  );
}

function findPendingRollback(db, targetReleaseId, previous) {
  const completedOperationIds = new Set(db.prepare(`
    SELECT details_json FROM audit_events
    WHERE event_type = 'release.rolled_back' AND release_id = ?
  `).all(targetReleaseId).map((event) => JSON.parse(event.details_json).operationId).filter(Boolean));
  const starts = db.prepare(`
    SELECT editor_id, details_json FROM audit_events
    WHERE event_type = 'release.rollback_started' AND release_id = ?
    ORDER BY id DESC
  `).all(targetReleaseId);
  for (const start of starts) {
    const details = JSON.parse(start.details_json);
    if (details.previous === previous
        && typeof details.operationId === 'string'
        && !completedOperationIds.has(details.operationId)) {
      return {
        editorId: start.editor_id,
        operationId: details.operationId,
        previous,
        targetReleaseId,
      };
    }
  }
  return null;
}

function synchronizePublicState(db, manifest, timestamp) {
  db.prepare(`
    UPDATE articles
    SET published_revision_id = NULL, public_state = NULL, state = 'draft', updated_at = ?
    WHERE public_state IS NOT NULL
  `).run(timestamp);
  const update = db.prepare(`
    UPDATE articles
    SET published_revision_id = ?, public_state = ?,
        state = CASE WHEN current_revision_id = ? THEN ? ELSE 'draft' END,
        updated_at = ?
    WHERE id = ?
  `);
  for (const article of manifest.articles) {
    const result = update.run(
      article.revisionId,
      article.state,
      article.revisionId,
      article.state,
      timestamp,
      article.articleId,
    );
    if (result.changes !== 1) throw new Error(`Release references missing article ${article.articleId}`);
  }
}

function synchronizeSocialLinks(db, manifest, timestamp, editorId = null) {
  const socialLinks = validateSocialLinks(
    manifest.schemaVersion >= 3 ? manifest.socialLinks : LEGACY_SOCIAL_LINKS,
  );
  const current = loadSocialLinks(db);
  if (JSON.stringify(current) === JSON.stringify(socialLinks)) return;
  const result = db.prepare(`
    UPDATE site_social_links
    SET telegram_url = ?, youtube_url = ?, vk_url = ?, futuchat_url = ?,
        updated_by = ?, updated_at = ?
    WHERE singleton = 1
  `).run(
    socialLinks.telegramUrl,
    socialLinks.youtubeUrl,
    socialLinks.vkUrl,
    socialLinks.futuchatUrl,
    editorId,
    timestamp,
  );
  if (result.changes !== 1) throw new Error('Social-link state is missing');
}

function loadPendingSocialDefaults(db) {
  const row = db.prepare(`
    SELECT telegram_url, youtube_url, vk_url, futuchat_url
    FROM pending_social_link_defaults WHERE singleton = 1
  `).get();
  if (!row) return null;
  return validateSocialLinks({
    telegramUrl: row.telegram_url,
    youtubeUrl: row.youtube_url,
    vkUrl: row.vk_url,
    futuchatUrl: row.futuchat_url,
  });
}

function synchronizePendingSocialDefaults(db, socialLinks) {
  const result = db.prepare(`
    UPDATE site_social_links
    SET telegram_url = ?, youtube_url = ?, vk_url = ?, futuchat_url = ?
    WHERE singleton = 1
  `).run(
    socialLinks.telegramUrl,
    socialLinks.youtubeUrl,
    socialLinks.vkUrl,
    socialLinks.futuchatUrl,
  );
  if (result.changes !== 1) throw new Error('Social-link state is missing');
}

function clearPendingSocialDefaults(db) {
  db.prepare('DELETE FROM pending_social_link_defaults WHERE singleton = 1').run();
}

function buildProspectiveSnapshot(db, transition) {
  const socialLinks = transition?.type === 'social_links'
    ? validateSocialLinks(transition.socialLinks)
    : loadSocialLinks(db);
  const snapshot = loadPublicSnapshot(db).map((article) => ({
    ...article,
    social_links: socialLinks,
  }));
  if (transition === null) return { snapshot, transition: null, socialLinks };
  if (transition?.type === 'social_links') {
    return { snapshot, transition: { type: 'social_links' }, socialLinks };
  }
  if (!transition || !['publish', 'withdraw'].includes(transition.type)) {
    throw new TypeError('A valid publication transition is required');
  }
  const articleId = positiveInteger(transition.articleId, 'articleId');
  const expectedRevisionId = positiveInteger(transition.expectedRevisionId, 'expectedRevisionId');
  const article = db.prepare(`
    SELECT id, current_revision_id, published_revision_id, public_state
    FROM articles WHERE id = ?
  `).get(articleId);
  if (!article) throw new Error('Article not found');
  if (Number(article.current_revision_id) !== expectedRevisionId) {
    throw new Error('Revision conflict: the article changed after the form was loaded');
  }

  let row;
  let normalized;
  if (transition.type === 'publish') {
    row = loadRevisionSnapshot(db, articleId, expectedRevisionId, 'published');
    normalized = { type: 'publish', articleId, revisionId: expectedRevisionId };
  } else {
    if (article.public_state !== 'published' || !article.published_revision_id) {
      throw new Error('Only a publicly published article can be withdrawn');
    }
    const revisionId = Number(article.published_revision_id);
    row = loadRevisionSnapshot(db, articleId, revisionId, 'withdrawn');
    normalized = { type: 'withdraw', articleId, revisionId };
  }
  const filtered = snapshot.filter((item) => Number(item.article_id) !== articleId);
  filtered.push(row);
  filtered.sort((left, right) => right.publication_at.localeCompare(left.publication_at)
    || Number(right.article_id) - Number(left.article_id));
  return { snapshot: filtered, transition: normalized, socialLinks };
}

function positiveInteger(value, name) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function recordReleaseArticles(db, manifest) {
  db.prepare('DELETE FROM release_articles WHERE release_id = ?').run(manifest.releaseId);
  const insert = db.prepare(`
    INSERT INTO release_articles (release_id, article_id, revision_id, public_state)
    VALUES (?, ?, ?, ?)
  `);
  for (const article of manifest.articles) {
    insert.run(manifest.releaseId, article.articleId, article.revisionId, article.state);
  }
}

function switchActive(releasesRoot, activePath, target) {
  const temporary = resolve(releasesRoot, `.active-${randomUUID()}`);
  const relativeTarget = `releases/${basename(target)}`;
  symlinkSync(relativeTarget, temporary);
  try {
    renameSync(temporary, activePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function createReleaseId(generatedAt, snapshot, socialLinks) {
  const timestamp = generatedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const digest = createHash('sha256')
    .update(JSON.stringify({ snapshot, socialLinks }))
    .update(generatedAt)
    .digest('hex')
    .slice(0, 16);
  return `${timestamp}-${digest}`;
}

export function acquirePublisherLock(releasesRoot) {
  const path = resolve(releasesRoot, '.publisher.lock');
  mkdirSync(releasesRoot, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = randomUUID();
    let descriptor;
    try {
      descriptor = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify({
          pid: process.pid,
          processIdentity: processIdentity(process.pid),
          owner,
          acquiredAt: new Date().toISOString(),
        })}\n`);
      } catch (error) {
        closeSync(descriptor);
        unlinkSync(path);
        throw error;
      }
      return { descriptor, owner, path };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lockOwnerIsLive(path)) throw new Error('Another publisher holds the release lock');
      const stale = `${path}.stale-${randomUUID()}`;
      try {
        renameSync(path, stale);
        unlinkSync(stale);
      } catch (takeoverError) {
        if (!['ENOENT', 'EEXIST'].includes(takeoverError.code)) throw takeoverError;
      }
    }
  }
  throw new Error('Unable to recover the stale publisher lock');
}

export function releasePublisherLock(lock) {
  closeSync(lock.descriptor);
  try {
    const current = JSON.parse(readFileSync(lock.path, 'utf8'));
    if (current.owner !== lock.owner) return;
    unlinkSync(lock.path);
  } catch (error) {
    if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error;
  }
}

function lockOwnerIsLive(path) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    try {
      return Date.now() - statSync(path).mtimeMs < 30_000;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  if (!Number.isInteger(metadata.pid) || metadata.pid < 1) return false;
  try {
    process.kill(metadata.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
  const identity = processIdentity(metadata.pid);
  return !identity || !metadata.processIdentity || identity === metadata.processIdentity;
}

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}
