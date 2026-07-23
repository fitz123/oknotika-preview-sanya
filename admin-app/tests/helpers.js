import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase } from '../src/content/database.js';
import { createContentService } from '../src/content/service.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

export function createHarness(t, { clock = () => new Date('2026-07-13T12:00:00.000Z') } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-content-'));
  const privateRoot = resolve(root, 'private');
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const coverPath = resolve(privateRoot, 'cover.png');
  writeFileSync(coverPath, TINY_PNG, { mode: 0o600 });
  const db = openDatabase(':memory:');
  const service = createContentService(db, { clock });
  const editorId = service.configureEditor({
    issuer: 'https://oauth.telegram.org',
    subject: 'editor-123',
  });
  const coverAssetId = service.registerAsset({ privatePath: coverPath, mediaType: 'image/png', width: 1, height: 1 });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, privateRoot, coverPath, db, service, editorId, coverAssetId };
}

export function articleInput(coverAssetId, overrides = {}) {
  return {
    title: 'Светопрозрачный фасад',
    publicationDate: '2026-07-10',
    lead: 'Короткий инженерный факт о фасаде.',
    bodyMarkdown: 'Первый абзац.\n\n**Почему важно:** второй абзац.',
    coverAssetId,
    coverAlt: 'Фасад здания',
    sourceUrl: 'https://example.com/source',
    ...overrides,
  };
}
