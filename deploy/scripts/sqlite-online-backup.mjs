#!/usr/bin/env node
import { chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) {
  throw new Error('Usage: sqlite-online-backup.mjs SOURCE DESTINATION');
}

const sourcePath = resolve(sourceArgument);
const destinationPath = resolve(destinationArgument);
const temporaryPath = `${destinationPath}.tmp-${process.pid}`;
if (sourcePath === destinationPath) throw new Error('Backup destination must differ from the source database');
mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
rmSync(temporaryPath, { force: true });

const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(source, temporaryPath, { rate: 100 });
} finally {
  source.close();
}

try {
  verifyDatabase(temporaryPath);
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, destinationPath);
  console.log(JSON.stringify({
    source: sourcePath,
    destination: destinationPath,
    sqliteVersion: process.versions.sqlite,
    integrity: 'ok',
  }));
} catch (error) {
  rmSync(temporaryPath, { force: true });
  throw error;
}

function verifyDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
      throw new Error(`SQLite backup integrity_check failed: ${JSON.stringify(rows)}`);
    }
  } finally {
    database.close();
  }
}
