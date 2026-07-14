#!/usr/bin/env node
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPublisher } from '../../admin-app/src/render/publisher.js';

const [databaseArgument, releasesRootArgument] = process.argv.slice(2);
if (!databaseArgument || !releasesRootArgument) {
  throw new Error('Usage: reconcile-public-state.mjs DATABASE RELEASES_ROOT');
}
if (process.env.OKNOTIKA_PUBLISHER_LOCK_HELD !== '1') {
  throw new Error('Public-state reconciliation must run under the deployment publisher lock wrapper');
}

const database = new DatabaseSync(resolve(databaseArgument));
try {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);
  const manifest = createPublisher(database, {
    releasesRoot: resolve(releasesRootArgument),
  }).reconcile({ publisherLockHeld: true });
  process.stdout.write(`${JSON.stringify({ reconciledReleaseId: manifest?.releaseId ?? null })}\n`);
} finally {
  database.close();
}
