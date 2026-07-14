import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDetailDocument } from './renderer.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

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
  copyFileSync(resolve(REPO_ROOT, 'style.css'), resolve(directory, 'style.css'));
  copyFileSync(resolve(REPO_ROOT, 'img/logo-oknotika.svg'), resolve(directory, 'logo.svg'));
  for (const filename of [coverName, 'style.css', 'logo.svg']) chmodSync(resolve(directory, filename), 0o600);
  const origin = new URL(publicOrigin).origin;
  const html = renderDetailDocument(revision, origin, {
    robots: 'noindex,nofollow,noarchive',
    coverPath: coverName,
    stylePath: 'style.css',
    logoPath: 'logo.svg',
    homePath: `${origin}/#top`,
    sitePath: `${origin}/`,
    aluminumPath: `${origin}/aluminum/`,
    articleIndexPath: `${origin}/articles/`,
    contactsPath: `${origin}/#contacts`,
    scriptTag: '',
  });
  writePrivate(resolve(directory, 'index.html'), html);
  return { previewId, directory };
}

function writePrivate(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 });
}
