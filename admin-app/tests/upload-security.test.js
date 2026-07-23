import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
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

test('decoder failures, timeouts and database failures remove files and roll back asset rows', async (t) => {
  const harness = createHarness(t);
  const publicRoot = resolve(harness.root, 'public');
  mkdirSync(publicRoot, { recursive: true });
  const initialAssets = harness.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count;

  const malformedRoot = resolve(harness.root, 'malformed-uploads');
  const malformedStore = createUploadStore({
    db: harness.db,
    contentService: harness.service,
    uploadsRoot: malformedRoot,
    publicRoot,
  });
  await assert.rejects(malformedStore.store({
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]),
    declaredMediaType: 'image/jpeg',
    editorId: harness.editorId,
  }), /decoder|image|jpeg|corrupt|unsupported/i);
  assert.deepEqual(readdirSync(resolve(malformedRoot, 'originals')), []);
  assert.deepEqual(readdirSync(resolve(malformedRoot, 'derivatives')), []);

  const valid = await sharp({
    create: { width: 64, height: 48, channels: 3, background: 'white' },
  }).png().toBuffer();
  const timeoutRoot = resolve(harness.root, 'timeout-uploads');
  const timeoutStore = createUploadStore({
    db: harness.db,
    contentService: harness.service,
    uploadsRoot: timeoutRoot,
    publicRoot,
    timeoutMs: 0,
  });
  await assert.rejects(timeoutStore.store({
    bytes: valid, declaredMediaType: 'image/png', editorId: harness.editorId,
  }), /time limit/);
  assert.deepEqual(readdirSync(resolve(timeoutRoot, 'originals')), []);
  assert.deepEqual(readdirSync(resolve(timeoutRoot, 'derivatives')), []);

  harness.db.exec(`
    CREATE TRIGGER reject_private_upload BEFORE INSERT ON private_uploads
    BEGIN SELECT RAISE(ABORT, 'injected upload insert failure'); END;
  `);
  const databaseRoot = resolve(harness.root, 'database-failure-uploads');
  const databaseStore = createUploadStore({
    db: harness.db,
    contentService: harness.service,
    uploadsRoot: databaseRoot,
    publicRoot,
  });
  await assert.rejects(databaseStore.store({
    bytes: valid, declaredMediaType: 'image/png', editorId: harness.editorId,
  }), /injected upload insert failure/);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, initialAssets);
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM private_uploads').get().count, 0);
  assert.deepEqual(readdirSync(resolve(databaseRoot, 'originals')), []);
  assert.deepEqual(readdirSync(resolve(databaseRoot, 'derivatives')), []);
});
