import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
import { registerWeeklyCover } from '../scripts/register-weekly-cover.js';
import { rollbackRelease } from '../scripts/rollback-release.js';
import {
  acquirePublisherLock,
  createPublisher,
  releasePublisherLock,
} from '../src/render/publisher.js';
import { articleInput } from './helpers.js';
import { runWeeklyIngestionSmoke } from '../../deploy/scripts/smoke-weekly-ingestion.mjs';

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

test('weekly ingestion smoke retries idempotently and proves its credential has no editorial authority', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-ingestion-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenFile = resolve(root, 'weekly-ingest-token');
  const payloadFile = resolve(root, 'weekly.json');
  const token = randomBytes(32).toString('base64url');
  const payload = {
    issueId: '2026-W31',
    contentVersion: 1,
    article: { title: 'Дайджест недели' },
  };
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  writeFileSync(payloadFile, JSON.stringify(payload), { mode: 0o600 });
  const requests = [];
  const draftResult = {
    articleId: 8,
    revisionId: 13,
    slug: 'daidzhest-nedeli-2026-w31',
    issueId: payload.issueId,
    contentVersion: payload.contentVersion,
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    if (url.endsWith('/api/ingestion/weekly-drafts')) {
      const ingestionCalls = requests
        .filter(request => request.url.endsWith('/api/ingestion/weekly-drafts')).length;
      return Response.json({
        ...draftResult,
        created: ingestionCalls === 1,
        idempotent: ingestionCalls !== 1,
      }, { status: ingestionCalls === 1 ? 201 : 200 });
    }
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  };

  assert.deepEqual(await runWeeklyIngestionSmoke({
    adminUrl: 'https://admin.oknotika.ru',
    payloadFile,
    tokenFile,
    fetchImpl,
  }), {
    status: 'pass',
    initial: 'draft-created',
    retry: 'idempotent',
    editorialCapabilities: 'denied',
  });
  assert.equal(requests.length, 4);
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.deepEqual(JSON.parse(requests[0].init.body), payload);
  assert.equal(requests[2].url, 'https://admin.oknotika.ru/api/articles');
  assert.equal(requests[3].url, 'https://admin.oknotika.ru/api/releases/rollback');
});

test('weekly ingestion smoke fails closed on malformed results and capability leakage', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-ingestion-smoke-negative-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenFile = resolve(root, 'weekly-ingest-token');
  const payloadFile = resolve(root, 'weekly.json');
  writeFileSync(tokenFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  writeFileSync(payloadFile, JSON.stringify({
    issueId: '2026-W31',
    contentVersion: 1,
    article: { title: 'Дайджест недели' },
  }), { mode: 0o600 });
  const draft = {
    articleId: 8,
    revisionId: 13,
    slug: 'daidzhest-nedeli-2026-w31',
    issueId: '2026-W31',
    contentVersion: 1,
  };
  const runWith = (...responses) => {
    let index = 0;
    return runWeeklyIngestionSmoke({
      adminUrl: 'https://admin.oknotika.ru',
      payloadFile,
      tokenFile,
      fetchImpl: async () => {
        const response = responses[index++];
        if (response instanceof Error) throw response;
        return response;
      },
    });
  };

  await assert.rejects(
    runWith(Response.json({
      ...draft, created: true, idempotent: true,
    }, { status: 200 })),
    /not an identical retry/,
  );
  await assert.rejects(
    runWith(
      Response.json({ ...draft, created: true, idempotent: false }, { status: 201 }),
      Response.json({
        ...draft, revisionId: 14, created: false, idempotent: true,
      }, { status: 200 }),
    ),
    /changed revisionId/,
  );
  await assert.rejects(
    runWith(Response.json({
      ...draft,
      created: true,
      idempotent: false,
      releaseId: 'must-not-be-returned',
    }, { status: 201 })),
    /forbidden publication data/,
  );
  await assert.rejects(
    runWith(new Response('not json', {
      status: 201,
      headers: { 'content-type': 'text/plain' },
    })),
    /non-JSON/,
  );
  await assert.rejects(
    runWith(
      Response.json({ ...draft, created: true, idempotent: false }, { status: 201 }),
      Response.json({ ...draft, created: false, idempotent: true }, { status: 200 }),
      Response.json({ articles: [] }, { status: 200 }),
    ),
    /reached an editorial capability/,
  );
  await assert.rejects(
    runWith(new Error('timed out')),
    /timed out/,
  );
});

test('operator CLIs register a validated reusable cover and roll back outside the editor HTTP surface', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-operator-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = resolve(root, 'db/admin.sqlite');
  const uploadsRoot = resolve(root, 'uploads');
  const publicRoot = resolve(root, 'public');
  const releasesRoot = resolve(root, 'article-releases');
  mkdirSync(resolve(root, 'db'), { recursive: true });
  mkdirSync(publicRoot);

  let db = openDatabase(databasePath);
  let service = createContentService(db);
  const editorId = service.configureEditor({
    issuer: 'https://oauth.telegram.org',
    subject: 'operator-cli-editor',
  });
  db.close();

  const cover = await registerWeeklyCover({
    databasePath,
    uploadsRoot,
    publicRoot,
    coverPath: resolve(REPO_ROOT, 'img/aluminum-world/facades.jpg'),
  });
  assert.ok(cover.assetId > 0);
  assert.equal(cover.mediaType, 'image/webp');

  let tick = 0;
  db = openDatabase(databasePath);
  service = createContentService(db);
  const publisher = createPublisher(db, {
    releasesRoot,
    publicOrigin: 'https://oknotika.ru',
    clock: () => new Date(Date.parse('2026-07-14T12:00:00.000Z') + tick++ * 1000),
  });
  const created = service.createArticle(articleInput(cover.assetId), editorId);
  const first = await publisher.publish({
    editorId,
    transition: {
      type: 'publish',
      articleId: created.articleId,
      expectedRevisionId: created.revisionId,
    },
  });
  const revised = service.reviseArticle(
    created.articleId,
    articleInput(cover.assetId, { title: 'Operator rollback target' }),
    editorId,
    { expectedRevisionId: created.revisionId },
  );
  const second = await publisher.publish({
    editorId,
    transition: {
      type: 'publish',
      articleId: revised.articleId,
      expectedRevisionId: revised.revisionId,
    },
  });
  db.close();

  const rolledBack = await rollbackRelease({
    databasePath,
    releasesRoot,
    publicOrigin: 'https://oknotika.ru',
    releaseId: first.releaseId,
  });
  assert.equal(rolledBack.releaseId, first.releaseId);
  assert.notEqual(second.releaseId, first.releaseId);
  const checked = openDatabase(databasePath);
  assert.equal(
    checked.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1')
      .get().active_release_id,
    first.releaseId,
  );
  checked.close();
});

test('admin ingress isolates large uploads and caps their global concurrency', () => {
  const nginx = readFileSync(resolve(REPO_ROOT, 'deploy/nginx/oknotika-admin.conf'), 'utf8');
  const zones = readFileSync(resolve(REPO_ROOT, 'deploy/nginx/00-oknotika-zones.conf'), 'utf8');
  assert.match(nginx, /client_max_body_size 1m;/);
  assert.match(
    nginx,
    /location = \/api\/uploads \{[\s\S]*?client_max_body_size 10m;[\s\S]*?limit_conn oknotika_admin_uploads 2;/,
  );
  assert.match(zones, /limit_conn_zone \$server_name zone=oknotika_admin_uploads:10m;/);
});

test('initial content bootstrap publishes with the nginx-readable service group and umask', () => {
  const runbook = readFileSync(resolve(REPO_ROOT, 'deploy/README_ZHENYA.md'), 'utf8');
  const section = runbook.split('## Инициализация первой article release')[1].split('## Emergency disable')[0];
  assert.match(section, /--unit=oknotika-bootstrap-content/);
  assert.match(section, /--property=User=oknotika-admin --property=Group=www-data --property=UMask=0027/);
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
