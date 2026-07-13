import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createUploadStore } from '../src/http/uploads.js';
import { createHarness } from './helpers.js';

test('upload verifies actual MIME, re-encodes to WebP, strips EXIF and uses random private paths', async (t) => {
  const harness = createHarness(t);
  const publicRoot = resolve(harness.root, 'public');
  mkdirSync(publicRoot, { recursive: true });
  const store = createUploadStore({
    db: harness.db,
    contentService: harness.service,
    uploadsRoot: resolve(harness.root, 'private-uploads'),
    publicRoot,
  });
  const input = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#d2b48c' },
  }).withExif({ IFD0: { Artist: 'must-be-stripped' } }).jpeg().toBuffer();
  const result = await store.store({
    bytes: input,
    declaredMediaType: 'image/jpeg',
    editorId: harness.editorId,
  });
  assert.equal(result.mediaType, 'image/webp');
  assert.deepEqual([result.width, result.height], [64, 48]);
  const upload = harness.db.prepare(`
    SELECT u.*, a.private_path, a.media_type FROM private_uploads u
    JOIN assets a ON a.id = u.sanitized_asset_id WHERE u.id = ?
  `).get(result.uploadId);
  assert.equal(upload.media_type, 'image/webp');
  assert.match(upload.original_path, /private-uploads\/originals\/[0-9a-f-]+\.source$/);
  assert.match(upload.private_path, /private-uploads\/derivatives\/[0-9a-f-]+\.webp$/);
  assert.notEqual(upload.original_path, upload.private_path);
  assert.equal(readFileSync(upload.original_path).equals(input), true);
  const metadata = await sharp(readFileSync(upload.private_path)).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.format, 'webp');

  for (const [format, mediaType] of [['png', 'image/png'], ['webp', 'image/webp']]) {
    const encoded = await sharp({
      create: { width: 3, height: 2, channels: 3, background: '#ffffff' },
    })[format]().toBuffer();
    const accepted = await store.store({ bytes: encoded, declaredMediaType: mediaType, editorId: harness.editorId });
    assert.equal(accepted.mediaType, 'image/webp');
  }
});

test('upload rejects MIME confusion, GIF/SVG, oversized bytes, excessive pixels and public-root storage', async (t) => {
  const harness = createHarness(t);
  const root = resolve(harness.root, 'private-uploads');
  const publicRoot = resolve(harness.root, 'public');
  mkdirSync(publicRoot, { recursive: true });
  const store = createUploadStore({
    db: harness.db,
    contentService: harness.service,
    uploadsRoot: root,
    publicRoot,
  });
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'white' },
  }).png().toBuffer();
  await assert.rejects(store.store({
    bytes: png, declaredMediaType: 'image/jpeg', editorId: harness.editorId,
  }), /MIME does not match/);
  for (const [bytes, mediaType] of [
    [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'],
  ]) {
    await assert.rejects(store.store({ bytes, declaredMediaType: mediaType, editorId: harness.editorId }), /Only JPEG/);
  }
  await assert.rejects(store.store({
    bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
    declaredMediaType: 'image/png',
    editorId: harness.editorId,
  }), /10 MB/);
  const tooManyPixels = await sharp({
    create: { width: 8000, height: 5001, channels: 3, background: 'white' },
  }).png({ compressionLevel: 9 }).toBuffer();
  await assert.rejects(store.store({
    bytes: tooManyPixels,
    declaredMediaType: 'image/png',
    editorId: harness.editorId,
  }), /pixel limit|limitInputPixels|exceeds/);
  assert.throws(() => createUploadStore({
    db: harness.db,
    contentService: harness.service,
    uploadsRoot: resolve(publicRoot, 'uploads'),
    publicRoot,
  }), /outside/);
});
