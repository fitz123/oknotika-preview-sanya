import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { transaction } from '../content/database.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function createUploadStore({
  db,
  contentService,
  uploadsRoot,
  publicRoot,
  clock = () => new Date(),
  timeoutMs = 8_000,
} = {}) {
  const privateRoot = resolve(uploadsRoot);
  if (pathsOverlap(privateRoot, resolve(publicRoot))) {
    throw new Error('Private uploads root must be outside the nginx public document root');
  }
  const originalsRoot = resolve(privateRoot, 'originals');
  const derivativesRoot = resolve(privateRoot, 'derivatives');
  mkdirSync(originalsRoot, { recursive: true, mode: 0o700 });
  mkdirSync(derivativesRoot, { recursive: true, mode: 0o700 });
  if (pathsOverlap(realpathSync(privateRoot), realpathSync(publicRoot))) {
    throw new Error('Private uploads root must be outside the nginx public document root');
  }

  async function store({ bytes, declaredMediaType, editorId }) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError('Upload body must be a Buffer');
    if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error('Upload must be between 1 byte and 10 MB');
    if (!ALLOWED_TYPES.has(declaredMediaType)) throw new Error('Only JPEG, PNG and WebP uploads are allowed');
    const detected = detectImage(bytes);
    if (!detected || detected.mediaType !== declaredMediaType) {
      throw new Error('Declared MIME does not match the actual JPEG/PNG/WebP signature');
    }
    const editor = db.prepare('SELECT id FROM configured_editors WHERE id = ? AND enabled = 1').get(editorId);
    if (!editor) throw new Error('An enabled editor is required for upload');

    const originalPath = resolve(originalsRoot, `${randomUUID()}.source`);
    const derivativePath = resolve(derivativesRoot, `${randomUUID()}.webp`);
    writeFileSync(originalPath, bytes, { mode: 0o600, flag: 'wx' });
    try {
      const processed = await processInWorker(bytes, detected.format, { timeoutMs });
      writeFileSync(derivativePath, processed.data, { mode: 0o600, flag: 'wx' });
      return transaction(db, () => {
        const assetId = contentService.registerAsset({
          privatePath: derivativePath,
          mediaType: processed.mediaType,
          width: processed.width,
          height: processed.height,
        });
        const result = db.prepare(`
          INSERT INTO private_uploads
            (original_path, sanitized_asset_id, original_media_type, source_bytes,
             width, height, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          originalPath, assetId, detected.mediaType, bytes.length,
          processed.width, processed.height, editorId, clock().toISOString(),
        );
        return {
          uploadId: Number(result.lastInsertRowid),
          assetId,
          mediaType: processed.mediaType,
          width: processed.width,
          height: processed.height,
        };
      });
    } catch (error) {
      rmSync(originalPath, { force: true });
      rmSync(derivativePath, { force: true });
      throw error;
    }
  }

  return { store };
}

export function detectImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: 'jpeg', mediaType: 'image/jpeg' };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { format: 'png', mediaType: 'image/png' };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { format: 'webp', mediaType: 'image/webp' };
  }
  return null;
}

function processInWorker(bytes, expectedFormat, { timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL('./image-worker.js', import.meta.url), {
      workerData: { input: bytes, expectedFormat, maxPixels: MAX_PIXELS },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      worker.terminate();
      rejectPromise(new Error('Image decoder exceeded its time limit'));
    }, timeoutMs);
    worker.once('message', (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      if (!message?.ok) rejectPromise(new Error(message?.error ?? 'Image processing failed'));
      else resolvePromise({ ...message, data: Buffer.from(message.data) });
    });
    worker.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new Error(`Image decoder failed: ${error.message}`));
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new Error(`Image decoder exited unexpectedly (${code})`));
    });
  });
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(candidate, parent) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}
