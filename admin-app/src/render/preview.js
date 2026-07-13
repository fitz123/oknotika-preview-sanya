import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderDetailDocument } from './renderer.js';

export function createPrivatePreview({ db, revisionId, authenticatedEditorId, previewsRoot, publicOrigin }) {
  const editor = db.prepare('SELECT id FROM configured_editors WHERE id = ? AND enabled = 1')
    .get(authenticatedEditorId);
  if (!editor) throw new Error('Authentication is required for preview');
  const revision = db.prepare(`
    SELECT a.slug, r.*, s.private_path, s.media_type
    FROM article_revisions r
    JOIN articles a ON a.id = r.article_id
    JOIN assets s ON s.id = r.cover_asset_id
    WHERE r.id = ?
  `).get(revisionId);
  if (!revision) throw new Error('Revision not found');

  const previewId = randomBytes(24).toString('base64url');
  const directory = resolve(previewsRoot, previewId);
  const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' })[revision.media_type];
  const coverName = `cover${extension}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  copyFileSync(revision.private_path, resolve(directory, coverName));
  const html = renderDetailDocument(revision, new URL(publicOrigin).origin, {
    robots: 'noindex,nofollow,noarchive',
    coverPath: coverName,
  });
  writePrivate(resolve(directory, 'index.html'), html);
  writePrivate(resolve(directory, 'headers.json'), `${JSON.stringify({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  }, null, 2)}\n`);
  return { previewId, directory };
}

function writePrivate(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 });
}
