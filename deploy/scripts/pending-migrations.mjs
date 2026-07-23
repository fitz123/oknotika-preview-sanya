#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [databasePath, migrationsDirectory] = process.argv.slice(2);
if (!databasePath || !migrationsDirectory) {
  throw new Error('usage: pending-migrations.mjs DATABASE MIGRATIONS_DIRECTORY');
}

const migrations = readdirSync(migrationsDirectory)
  .filter(name => /^\d+_.+\.sql$/.test(name))
  .sort()
  .map(name => ({ name, version: Number.parseInt(name, 10) }));
const versions = new Set();
for (const migration of migrations) {
  if (versions.has(migration.version)) throw new Error(`duplicate migration version: ${migration.version}`);
  versions.add(migration.version);
}

const database = new DatabaseSync(databasePath, { readOnly: true });
let applied;
try {
  const table = database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  applied = table
    ? new Set(database.prepare('SELECT version FROM schema_migrations').all().map(row => Number(row.version)))
    : new Set();
} finally {
  database.close();
}

const pending = migrations.filter(migration => !applied.has(migration.version));
if (pending.length > 0) {
  const fingerprint = createHash('sha256');
  for (const migration of pending) {
    fingerprint.update(migration.name);
    fingerprint.update('\0');
    fingerprint.update(readFileSync(resolve(migrationsDirectory, migration.name)));
    fingerprint.update('\0');
  }
  const currentVersion = applied.size > 0 ? Math.max(...applied) : 0;
  const targetVersion = migrations.length > 0 ? Math.max(...migrations.map(item => item.version)) : 0;
  process.stdout.write(`${currentVersion}\t${targetVersion}\t${fingerprint.digest('hex').slice(0, 16)}\n`);
}
