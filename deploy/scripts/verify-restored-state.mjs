#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [rootArgument] = process.argv.slice(2);
if (!rootArgument) throw new Error('Usage: verify-restored-state.mjs RESTORE_ROOT');
const root = resolve(rootArgument);
const databasePath = resolve(root, 'backups/online/admin.sqlite');
const database = new DatabaseSync(databasePath, { readOnly: true });
let activeReleaseId;
try {
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new Error(`Restored SQLite integrity check failed: ${JSON.stringify(integrity)}`);
  }
  database.prepare('SELECT COUNT(*) AS count FROM audit_events').get();
  activeReleaseId = database.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get().active_release_id;
} finally {
  database.close();
}

const manifests = walk(resolve(root, 'article-releases/releases'))
  .filter((path) => path.endsWith('/manifest.json'));
for (const manifestPath of manifests) verifyManifest(manifestPath);
const activePath = resolve(root, 'article-releases/active');
const activeTarget = readActiveTarget(activePath);
if ((activeTarget === null) !== (activeReleaseId === null)) {
  throw new Error('Restored SQLite active state and active symlink presence differ');
}
if (activeTarget !== null) {
  const targetReleaseId = basename(activeTarget);
  if (targetReleaseId !== activeReleaseId) throw new Error('Restored active symlink and SQLite release ID differ');
  const manifest = verifyManifest(resolve(root, 'article-releases', activeTarget, 'manifest.json'));
  if (manifest.releaseId !== activeReleaseId) throw new Error('Restored active manifest release ID differs');
  const stateDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const release = stateDb.prepare("SELECT id FROM releases WHERE id = ? AND status = 'complete'").get(activeReleaseId);
    if (!release) throw new Error('Restored active release is not complete in SQLite');
    const releaseArticleCount = stateDb.prepare(
      'SELECT COUNT(*) AS count FROM release_articles WHERE release_id = ?',
    ).get(activeReleaseId).count;
    if (releaseArticleCount !== (manifest.articles ?? []).length) {
      throw new Error('Restored release article count differs from the active manifest');
    }
    for (const article of manifest.articles ?? []) {
      const row = stateDb.prepare(`
        SELECT ra.public_state
        FROM release_articles ra
        JOIN articles a ON a.id = ra.article_id
        JOIN article_revisions r ON r.id = ra.revision_id AND r.article_id = a.id
        WHERE ra.release_id = ? AND ra.article_id = ? AND ra.revision_id = ?
      `).get(activeReleaseId, article.articleId, article.revisionId);
      if (!row || row.public_state !== article.state) {
        throw new Error(`Restored release article state differs for article ${article.articleId}`);
      }
    }
  } finally {
    stateDb.close();
  }
}
console.log(JSON.stringify({
  database: relative(root, databasePath),
  auditState: 'readable',
  releaseManifests: manifests.length,
  activeReleaseId,
  integrity: 'ok',
}));

function verifyManifest(manifestPath) {
  const releaseRoot = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const [path, metadata] of Object.entries(manifest.files ?? {})) {
    const file = resolve(releaseRoot, path);
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (digest !== metadata.sha256) throw new Error(`Release hash mismatch: ${file}`);
  }
  return manifest;
}

function readActiveTarget(path) {
  try {
    const target = readlinkSync(path);
    if (!/^releases\/[a-zA-Z0-9._-]+$/.test(target)) throw new Error('Restored active symlink target is invalid');
    return target;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function walk(directory) {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
