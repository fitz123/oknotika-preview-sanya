import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from '../src/content/database.js';
import { createContentService } from '../src/content/service.js';
import {
  acquirePublisherLock,
  createPublisher,
  releasePublisherLock,
} from '../src/render/publisher.js';
import { articleInput } from './helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

test('online deployment backup is a mode-0600 consistent SQLite snapshot', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, 'db/admin.sqlite');
  const destination = resolve(root, 'backups/admin.sqlite');
  mkdirSync(resolve(root, 'db'), { recursive: true });
  const database = new DatabaseSync(source);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY, event_type TEXT NOT NULL);
    INSERT INTO audit_events (event_type) VALUES ('release.published');
  `);
  database.close();

  const output = execFileSync(process.execPath, [
    resolve(REPO_ROOT, 'deploy/scripts/sqlite-online-backup.mjs'), source, destination,
  ], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).integrity, 'ok');
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  const restored = new DatabaseSync(destination, { readOnly: true });
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
  restored.close();
});

test('pre-migration backup runs once per pending schema and skips current databases', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-migration-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const migrations = resolve(root, 'old-migrations');
  const databasePath = resolve(root, 'db/admin.sqlite');
  mkdirSync(migrations, { recursive: true });
  mkdirSync(resolve(root, 'db/migration-backups'), { recursive: true });
  for (const name of ['001_content.sql', '002_admin_security.sql']) {
    copyFileSync(resolve(REPO_ROOT, 'admin-app/migrations', name), resolve(migrations, name));
  }
  openDatabase(databasePath, migrations).close();

  const script = resolve(REPO_ROOT, 'deploy/scripts/pre-migrate-backup.sh');
  const env = {
    ...process.env,
    OKNOTIKA_STATE_ROOT: root,
    OKNOTIKA_DATABASE_PATH: databasePath,
    OKNOTIKA_RELEASE_SHA: 'a'.repeat(40),
  };
  execFileSync('bash', [script], { env });
  execFileSync('bash', [script], { env });
  const backupRoot = resolve(root, 'db/migration-backups');
  assert.equal(readdirSync(backupRoot).filter(name => name.endsWith('.sqlite')).length, 1);

  openDatabase(databasePath).close();
  execFileSync('bash', [script], { env });
  assert.equal(readdirSync(backupRoot).filter(name => name.endsWith('.sqlite')).length, 1);
  assert.match(readFileSync(script, 'utf8'), /maximum_backups=10/);
});

test('deployment manifest pins Node 24, bundled SQLite and the exact npm lockfile', () => {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'deploy/release-manifest.json'), 'utf8'));
  assert.equal(manifest.runtime.nodeMajor, 24);
  assert.match(manifest.runtime.nodeVersion, /^24\.\d+\.\d+$/);
  assert.match(manifest.runtime.sqliteVersion, /^3\.\d+\.\d+$/);
  assert.equal(manifest.runtime.packageLockVersion, 3);
  assert.match(manifest.runtime.packageLockSha256, /^[a-f0-9]{64}$/);
});

test('restore drill rejects production roots and every descendant before restoring', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'deploy/scripts/restore-drill.sh'), 'utf8');
  for (const protectedRoot of [
    '/var/lib/oknotika-admin',
    '/srv/oknotika',
    '/opt/oknotika-admin',
  ]) {
    assert.ok(script.includes(`${protectedRoot}|${protectedRoot}/*`));
  }
});

test('production preflight pins every path shared by the app, nginx, systemd and backups', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'deploy/scripts/preflight.sh'), 'utf8');
  for (const name of [
    'OKNOTIKA_DATABASE_PATH',
    'OKNOTIKA_UPLOADS_ROOT',
    'OKNOTIKA_PREVIEWS_ROOT',
    'OKNOTIKA_ARTICLE_RELEASES_ROOT',
    'OKNOTIKA_PUBLIC_ROOT',
    'OKNOTIKA_LISTEN_SOCKET',
  ]) {
    assert.match(script, new RegExp(`require_exact ${name}`));
  }
});

test('backup reconciliation repairs public pointers while holding the publisher lock', async (t) => {
  const fixture = await createRestoreFixture(t);
  const database = new DatabaseSync(fixture.liveDatabasePath);
  database.exec('UPDATE articles SET published_revision_id = NULL, public_state = NULL;');
  database.close();

  const lock = acquirePublisherLock(fixture.releasesRoot);
  let result;
  try {
    result = spawnSync(process.execPath, [
      resolve(REPO_ROOT, 'deploy/scripts/reconcile-public-state.mjs'),
      fixture.liveDatabasePath,
      fixture.releasesRoot,
    ], {
      encoding: 'utf8',
      env: { ...process.env, OKNOTIKA_PUBLISHER_LOCK_HELD: '1' },
    });
  } finally {
    releasePublisherLock(lock);
  }
  assert.equal(result.status, 0, result.stderr);
  const reconciled = new DatabaseSync(fixture.liveDatabasePath, { readOnly: true });
  const article = reconciled.prepare('SELECT published_revision_id, public_state FROM articles').get();
  reconciled.close();
  assert.equal(Number(article.published_revision_id), fixture.revisionId);
  assert.equal(article.public_state, 'published');

  const backupScript = readFileSync(resolve(REPO_ROOT, 'deploy/scripts/backup.sh'), 'utf8');
  assert.ok(backupScript.indexOf('reconcile-public-state.mjs') < backupScript.indexOf('sqlite-online-backup.mjs'));
});

test('backup reconciliation refuses a missing active symlink with nonempty public DB state', async (t) => {
  const fixture = await createRestoreFixture(t);
  unlinkSync(resolve(fixture.releasesRoot, 'active'));
  const lock = acquirePublisherLock(fixture.releasesRoot);
  let result;
  try {
    result = spawnSync(process.execPath, [
      resolve(REPO_ROOT, 'deploy/scripts/reconcile-public-state.mjs'),
      fixture.liveDatabasePath,
      fixture.releasesRoot,
    ], {
      encoding: 'utf8',
      env: { ...process.env, OKNOTIKA_PUBLISHER_LOCK_HELD: '1' },
    });
  } finally {
    releasePublisherLock(lock);
  }
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink is missing while SQLite still records public state/);
});

test('restore verification rejects stale public article pointers', async (t) => {
  const fixture = await createRestoreFixture(t);
  const restored = new DatabaseSync(fixture.snapshotPath);
  restored.exec('UPDATE articles SET published_revision_id = NULL, public_state = NULL;');
  restored.close();
  const result = verifyRestoredState(fixture.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release article state differs/);
});

test('restore verification accepts a generation-consistent snapshot', async (t) => {
  const fixture = await createRestoreFixture(t);
  const result = verifyRestoredState(fixture.root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).activeReleaseId, fixture.releaseId);
});

test('restore verification rejects a stored release manifest mismatch', async (t) => {
  const fixture = await createRestoreFixture(t);
  const restored = new DatabaseSync(fixture.snapshotPath);
  restored.prepare("UPDATE releases SET manifest_json = '{}' WHERE id = ?").run(fixture.releaseId);
  restored.close();
  const result = verifyRestoredState(fixture.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SQLite release manifest differs/);
});

async function createRestoreFixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const liveDatabasePath = resolve(root, 'live/admin.sqlite');
  const snapshotPath = resolve(root, 'backups/online/admin.sqlite');
  const releasesRoot = resolve(root, 'article-releases');
  const coverPath = resolve(root, 'cover.png');
  mkdirSync(resolve(root, 'live'), { recursive: true });
  mkdirSync(resolve(root, 'backups/online'), { recursive: true });
  writeFileSync(coverPath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ));

  const database = openDatabase(liveDatabasePath);
  const service = createContentService(database);
  const editorId = service.configureEditor({
    issuer: 'https://oauth.telegram.org', subject: '9988776655',
  });
  const coverAssetId = service.registerAsset({
    privatePath: coverPath, mediaType: 'image/png', width: 1, height: 1,
  });
  const created = service.createArticle(articleInput(coverAssetId), editorId);
  const manifest = await createPublisher(database, {
    releasesRoot,
    publicOrigin: 'https://oknotika.ru',
    clock: () => new Date('2026-07-14T12:00:00.000Z'),
  }).publish({
    editorId,
    transition: {
      type: 'publish', articleId: created.articleId, expectedRevisionId: created.revisionId,
    },
  });
  database.close();
  copyFileSync(liveDatabasePath, snapshotPath);

  return {
    root,
    liveDatabasePath,
    snapshotPath,
    releasesRoot,
    releaseId: manifest.releaseId,
    revisionId: created.revisionId,
  };
}

function verifyRestoredState(root) {
  return spawnSync(process.execPath, [
    resolve(REPO_ROOT, 'deploy/scripts/verify-restored-state.mjs'), root,
  ], { encoding: 'utf8' });
}
