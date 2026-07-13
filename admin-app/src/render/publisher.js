import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { transaction } from '../content/database.js';
import { loadPublicSnapshot, renderRelease, validateRelease } from './renderer.js';

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

  async function publish({ editorId = null, inject = async () => {} } = {}) {
    const lock = acquireLock(releasesRoot);
    try {
      const generatedAt = clock().toISOString();
      const snapshot = loadPublicSnapshot(db);
      const releaseId = createReleaseId(generatedAt, snapshot);
      const stage = resolve(stagingRoot, `${releaseId}-${randomUUID()}`);
      const final = resolve(immutableRoot, releaseId);
      const previous = db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get()?.active_release_id ?? null;
      db.prepare(`
        INSERT INTO releases (id, status, previous_release_id, created_at)
        VALUES (?, 'staging', ?, ?)
      `).run(releaseId, previous, generatedAt);

      await inject('before-stage-render');
      mkdirSync(stage, { recursive: true });
      const manifest = renderRelease({ db, outputDirectory: stage, publicOrigin, releaseId, generatedAt });
      validateRelease(stage);
      await inject('after-stage-render');

      await inject('before-immutable-rename');
      renameSync(stage, final);
      await inject('after-immutable-rename');

      await inject('before-active-switch');
      switchActive(releasesRoot, activePath, final);
      await inject('after-active-switch');

      await inject('before-db-finalize');
      finalizeRelease(db, manifest, previous, generatedAt, editorId);
      await inject('after-db-finalize');
      return manifest;
    } finally {
      releaseLock(lock);
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
      db.prepare('UPDATE site_state SET active_release_id = ?, updated_at = ? WHERE singleton = 1')
        .run(manifest.releaseId, timestamp);
      db.prepare(`
        INSERT INTO audit_events (event_type, release_id, details_json, created_at)
        VALUES ('release.reconciled', ?, ?, ?)
      `).run(manifest.releaseId, JSON.stringify({ activeTarget: basename(target) }), timestamp);
    });
    return manifest;
  }

  async function rollback(targetReleaseId, { editorId = null, inject = async () => {} } = {}) {
    const lock = acquireLock(releasesRoot);
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
      releaseLock(lock);
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
    db.prepare('UPDATE site_state SET active_release_id = ?, updated_at = ? WHERE singleton = 1')
      .run(manifest.releaseId, timestamp);
    db.prepare(`
      INSERT INTO audit_events (editor_id, event_type, release_id, details_json, created_at)
      VALUES (?, 'release.published', ?, '{}', ?)
    `).run(editorId, manifest.releaseId, timestamp);
  });
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

function acquireLock(releasesRoot) {
  const path = resolve(releasesRoot, '.publisher.lock');
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another publisher holds the release lock');
    throw error;
  }
  return { descriptor, path };
}

function releaseLock(lock) {
  closeSync(lock.descriptor);
  try {
    unlinkSync(lock.path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
