#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [rootArgument] = process.argv.slice(2);
if (!rootArgument) throw new Error('Usage: verify-restored-state.mjs RESTORE_ROOT');
const root = resolve(rootArgument);
const databasePath = resolve(root, 'backups/online/admin.sqlite');
const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new Error(`Restored SQLite integrity check failed: ${JSON.stringify(integrity)}`);
  }
  database.prepare('SELECT COUNT(*) AS count FROM audit_events').get();
} finally {
  database.close();
}

const manifests = walk(resolve(root, 'article-releases/releases'))
  .filter((path) => path.endsWith('/manifest.json'));
for (const manifestPath of manifests) verifyManifest(manifestPath);
console.log(JSON.stringify({
  database: relative(root, databasePath),
  auditState: 'readable',
  releaseManifests: manifests.length,
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
}

function walk(directory) {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
