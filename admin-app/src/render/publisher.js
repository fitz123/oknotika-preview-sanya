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
import { transaction } from '../content/database.js';
import { loadPublicSnapshot, loadRevisionSnapshot, renderRelease, validateRelease } from './renderer.js';

export function createPublisher(db, {
  releasesRoot,
  publicOrigin,
  clock = () => new Date(),
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

  async function publish({ editorId = null, transition = null, inject = async () => {} } = {}) {
    const lock = acquirePublisherLock(releasesRoot);
    let stage = null;
    try {
      const generatedAt = clock().toISOString();
      const prospective = buildProspectiveSnapshot(db, transition);
      const snapshot = prospective.snapshot;
      const releaseId = createReleaseId(generatedAt, snapshot);
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
      });
      validateRelease(stage);
      await inject('after-stage-render');

      await inject('before-immutable-rename');
      renameSync(stage, final);
      stage = null;
      await inject('after-immutable-rename');

      await inject('before-active-switch');
      switchActive(releasesRoot, activePath, final);
      await inject('after-active-switch');

      await inject('before-db-finalize');
      finalizeRelease(db, manifest, previous, generatedAt, editorId);
      await inject('after-db-finalize');
      return manifest;
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
      releasePublisherLock(lock);
    }
  }

  function reconcile() {
    let target;
    try {
      const activeTarget = readlinkSync(activePath);
      if (!/^releases\/[a-zA-Z0-9._-]+$/.test(activeTarget)) {
        throw new Error('Active release symlink has an invalid target');
      }
      target = resolve(releasesRoot, activeTarget);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const manifest = validateRelease(target);
    const timestamp = clock().toISOString();
    const current = db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get()?.active_release_id ?? null;
    transaction(db, () => {
      db.prepare(`
        INSERT INTO releases (id, status, manifest_json, previous_release_id, created_at, activated_at)
        VALUES (?, 'complete', ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          status = 'complete', manifest_json = excluded.manifest_json, activated_at = excluded.activated_at
      `).run(manifest.releaseId, JSON.stringify(manifest), current, manifest.generatedAt, timestamp);
      recordReleaseArticles(db, manifest);
      synchronizePublicState(db, manifest, timestamp);
      db.prepare('UPDATE site_state SET active_release_id = ?, updated_at = ? WHERE singleton = 1')
        .run(manifest.releaseId, timestamp);
      db.prepare(`
        INSERT INTO audit_events (event_type, release_id, details_json, created_at)
        VALUES ('release.reconciled', ?, ?, ?)
      `).run(manifest.releaseId, JSON.stringify({ activeTarget: basename(target) }), timestamp);
      reconcileTransitionAudit(db, manifest, timestamp);
    });
    return manifest;
  }

  async function rollback(targetReleaseId, { editorId = null, inject = async () => {} } = {}) {
    const lock = acquirePublisherLock(releasesRoot);
    try {
      const release = db.prepare("SELECT * FROM releases WHERE id = ? AND status = 'complete'").get(targetReleaseId);
      if (!release) throw new Error('Completed release not found');
      const target = resolve(immutableRoot, targetReleaseId);
      const manifest = validateRelease(target);
      const previous = db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get().active_release_id;
      await inject('before-active-switch');
      switchActive(releasesRoot, activePath, target);
      await inject('after-active-switch');
      await inject('before-db-finalize');
      const timestamp = clock().toISOString();
      transaction(db, () => {
        synchronizePublicState(db, manifest, timestamp);
        db.prepare('UPDATE site_state SET active_release_id = ?, updated_at = ? WHERE singleton = 1')
          .run(targetReleaseId, timestamp);
        db.prepare(`
          INSERT INTO audit_events (editor_id, event_type, release_id, details_json, created_at)
          VALUES (?, 'release.rolled_back', ?, ?, ?)
        `).run(editorId, targetReleaseId, JSON.stringify({ previous }), timestamp);
      });
      await inject('after-db-finalize');
      return manifest;
    } finally {
      releasePublisherLock(lock);
    }
  }

  return { publish, reconcile, rollback, activePath };
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
    }
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
  if (!transition || !['publish', 'withdraw'].includes(transition.type)) return;
  const type = transition.type === 'publish' ? 'article.published' : 'article.withdrawn';
  const existing = db.prepare(`
    SELECT 1 FROM audit_events
    WHERE event_type = ? AND article_id = ? AND revision_id = ? AND release_id = ?
  `).get(type, transition.articleId, transition.revisionId, manifest.releaseId);
  if (!existing) insertTransitionAudit(db, null, type, transition, manifest.releaseId, timestamp);
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

function buildProspectiveSnapshot(db, transition) {
  const snapshot = loadPublicSnapshot(db);
  if (transition === null) return { snapshot, transition: null };
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
  return { snapshot: filtered, transition: normalized };
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

function createReleaseId(generatedAt, snapshot) {
  const timestamp = generatedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).update(generatedAt).digest('hex').slice(0, 16);
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
