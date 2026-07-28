#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/content/database.js';
import { createContentService } from '../src/content/service.js';
import { createUploadStore, detectImage } from '../src/http/uploads.js';

export async function registerWeeklyCover({
  databasePath,
  uploadsRoot,
  publicRoot,
  coverPath,
}) {
  const bytes = await readFile(coverPath);
  const detected = detectImage(bytes);
  if (!detected) throw new Error('Weekly cover must be a JPEG, PNG or WebP image');
  const db = openDatabase(databasePath);
  try {
    const editors = db.prepare(
      'SELECT id FROM configured_editors WHERE enabled = 1 ORDER BY id',
    ).all();
    if (editors.length !== 1) {
      throw new Error('Exactly one enabled editor must be enrolled before registering the weekly cover');
    }
    const contentService = createContentService(db);
    const uploadStore = createUploadStore({
      db,
      contentService,
      uploadsRoot,
      publicRoot,
    });
    return await uploadStore.store({
      bytes,
      declaredMediaType: detected.mediaType,
      editorId: Number(editors[0].id),
    });
  } finally {
    db.close();
  }
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/, '');
    if (!name || values[index + 1] === undefined) {
      throw new Error('Arguments must be --name value pairs');
    }
    parsed[name] = values[index + 1];
  }
  return {
    databasePath: resolve(required(parsed, 'database')),
    uploadsRoot: resolve(required(parsed, 'uploads-root')),
    publicRoot: resolve(required(parsed, 'public-root')),
    coverPath: resolve(required(parsed, 'cover')),
  };
}

function required(values, name) {
  if (!values[name]) throw new Error(`--${name} is required`);
  return values[name];
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await registerWeeklyCover(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      assetId: result.assetId,
      mediaType: result.mediaType,
      width: result.width,
      height: result.height,
    })}\n`);
  } catch (error) {
    process.stderr.write(`weekly cover registration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
