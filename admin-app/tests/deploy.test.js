import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
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

  const releaseSha = 'd'.repeat(40);
  const releaseRoot = resolve(root, 'application/releases', releaseSha);
  const releaseScriptRoot = resolve(releaseRoot, 'deploy/scripts');
  const releaseMigrations = resolve(releaseRoot, 'admin-app/migrations');
  mkdirSync(releaseScriptRoot, { recursive: true });
  mkdirSync(releaseMigrations, { recursive: true });
  for (const name of [
    'pre-migrate-backup.sh',
    'pending-migrations.mjs',
    'sqlite-online-backup.mjs',
  ]) {
    copyFileSync(
      resolve(REPO_ROOT, 'deploy/scripts', name),
      resolve(releaseScriptRoot, name),
    );
  }
  for (const name of readdirSync(resolve(REPO_ROOT, 'admin-app/migrations'))) {
    if (name.endsWith('.sql')) {
      copyFileSync(
        resolve(REPO_ROOT, 'admin-app/migrations', name),
        resolve(releaseMigrations, name),
      );
    }
  }
  const script = resolve(releaseScriptRoot, 'pre-migrate-backup.sh');
  const env = {
    ...process.env,
    OKNOTIKA_STATE_ROOT: root,
    OKNOTIKA_DATABASE_PATH: databasePath,
    OKNOTIKA_RELEASE_SHA: 'a'.repeat(40),
  };
  execFileSync('bash', [script], { env });
  execFileSync('bash', [script], { env });
  const backupRoot = resolve(root, 'db/migration-backups');
  const migrationBackups = readdirSync(backupRoot).filter(name => name.endsWith('.sqlite'));
  assert.equal(migrationBackups.length, 1);
  assert.match(migrationBackups[0], new RegExp(`${releaseSha.slice(0, 16)}\\.sqlite$`));

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
  assert.deepEqual(manifest.editorial.socialDestinations, {
    telegram: 'https://t.me/oknotika',
    youtube: 'https://youtube.com/@oknotika',
    vk: 'https://vk.ru/oknotika',
    futuchat: 'https://t.me/FUTU_CHAT',
    configuration: 'confirmed editor action atomically activates validated values in a new immutable article release; null destinations are not rendered',
  });
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
  for (const [field, value] of [
    ['articleId', '8'],
    ['revisionId', 0],
    ['slug', '../private'],
    ['issueId', '2025-W53'],
    ['contentVersion', 1.5],
  ]) {
    await assert.rejects(
      runWith(Response.json({
        ...draft,
        [field]: value,
        created: true,
        idempotent: false,
      }, { status: 201 })),
      new RegExp(`invalid ${field}`),
    );
  }
  await assert.rejects(
    runWith(Response.json({
      ...draft,
      created: true,
      idempotent: false,
      debug: 'must-not-be-returned',
    }, { status: 201 })),
    /unexpected field debug/,
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

  const unconfiguredDatabasePath = resolve(root, 'db/unconfigured.sqlite');
  openDatabase(unconfiguredDatabasePath).close();
  const noEditorResult = spawnSync(process.execPath, [
    resolve(REPO_ROOT, 'admin-app/scripts/register-weekly-cover.js'),
    '--database', unconfiguredDatabasePath,
    '--uploads-root', uploadsRoot,
    '--public-root', publicRoot,
    '--cover', resolve(REPO_ROOT, 'img/aluminum-world/facades.jpg'),
  ], { encoding: 'utf8' });
  assert.equal(noEditorResult.status, 1);
  assert.match(noEditorResult.stderr, /Exactly one enabled editor/);

  let db = openDatabase(databasePath);
  let service = createContentService(db);
  const editorId = service.configureEditor({
    issuer: 'https://oauth.telegram.org',
    subject: 'operator-cli-editor',
  });
  db.close();

  const coverResult = spawnSync(process.execPath, [
    resolve(REPO_ROOT, 'admin-app/scripts/register-weekly-cover.js'),
    '--database', databasePath,
    '--uploads-root', uploadsRoot,
    '--public-root', publicRoot,
    '--cover', resolve(REPO_ROOT, 'img/aluminum-world/facades.jpg'),
  ], { encoding: 'utf8' });
  assert.equal(coverResult.status, 0, coverResult.stderr);
  const cover = JSON.parse(coverResult.stdout);
  assert.ok(cover.assetId > 0);
  assert.equal(cover.mediaType, 'image/webp');
  const missingCoverArgument = spawnSync(process.execPath, [
    resolve(REPO_ROOT, 'admin-app/scripts/register-weekly-cover.js'),
  ], { encoding: 'utf8' });
  assert.equal(missingCoverArgument.status, 1);
  assert.match(missingCoverArgument.stderr, /--database is required/);

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
  rewriteAsSchemaTwoRelease(db, releasesRoot, first.releaseId);
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

  const rejectedApplicationRollback = spawnSync(process.execPath, [
    resolve(REPO_ROOT, 'admin-app/scripts/rollback-release.js'),
    '--database', databasePath,
    '--releases-root', releasesRoot,
    '--public-origin', 'https://oknotika.ru',
    '--release-id', second.releaseId,
    '--application-schema', '3',
  ], { encoding: 'utf8' });
  assert.equal(rejectedApplicationRollback.status, 1);
  assert.match(
    rejectedApplicationRollback.stderr,
    /requires a schema-2 or schema-3 article release/,
  );
  const rollbackResult = spawnSync(process.execPath, [
    resolve(REPO_ROOT, 'admin-app/scripts/rollback-release.js'),
    '--database', databasePath,
    '--releases-root', releasesRoot,
    '--public-origin', 'https://oknotika.ru',
    '--release-id', first.releaseId,
    '--application-schema', '3',
  ], { encoding: 'utf8' });
  assert.equal(rollbackResult.status, 0, rollbackResult.stderr);
  const rolledBack = JSON.parse(rollbackResult.stdout);
  assert.equal(rolledBack.releaseId, first.releaseId);
  assert.notEqual(second.releaseId, first.releaseId);
  const invalidRollback = spawnSync(process.execPath, [
    resolve(REPO_ROOT, 'admin-app/scripts/rollback-release.js'),
    '--database', databasePath,
    '--releases-root', releasesRoot,
    '--public-origin', 'https://oknotika.ru',
    '--release-id', '../invalid',
  ], { encoding: 'utf8' });
  assert.equal(invalidRollback.status, 1);
  assert.match(invalidRollback.stderr, /releaseId is invalid/);
  const checked = openDatabase(databasePath);
  assert.equal(
    checked.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1')
      .get().active_release_id,
    first.releaseId,
  );
  assert.deepEqual(
    { ...checked.prepare(`
      SELECT telegram_url, youtube_url, vk_url
      FROM site_social_links WHERE singleton = 1
    `).get() },
    {
      telegram_url: 'https://t.me/oknotika',
      youtube_url: null,
      vk_url: null,
    },
  );
  checked.close();
});

test('public smoke compares weekly CTAs with the active manifest', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-public-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shimRoot = resolve(root, 'bin');
  const weeklyBodyPath = resolve(root, 'weekly.html');
  const socialManifestPath = resolve(root, 'manifest.json');
  mkdirSync(shimRoot);
  const curlShim = resolve(shimRoot, 'curl');
  writeFileSync(curlShim, `#!/usr/bin/env bash
set -euo pipefail
headers_path=""
output_path=""
write_out=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump-header|--output|--write-out|--proto)
      name="$1"
      value="$2"
      shift 2
      case "$name" in
        --dump-header) headers_path="$value" ;;
        --output) output_path="$value" ;;
        --write-out) write_out="$value" ;;
      esac
      ;;
    --fail|--silent|--show-error|--location|--tlsv1.2) shift ;;
    *) url="$1"; shift ;;
  esac
done
headers="HTTP/1.1 200 OK\\r\\n"
body=""
case "$url" in
  https://public.test/)
    headers+="strict-transport-security: max-age=31536000\\r\\n"
    body="ОКНОТИКА"
    ;;
  https://public.test/articles/)
    headers+="cache-control: public, max-age=0, must-revalidate\\r\\n"
    body="Новости"
    ;;
  https://public.test/articles/latest.json) body="{}" ;;
  https://public.test/articles/digest/) body="$(<"$SMOKE_WEEKLY_BODY_PATH")" ;;
  https://admin.test/login)
    headers+="cache-control: no-store\\r\\n"
    headers+="content-security-policy: frame-ancestors 'none'\\r\\n"
    headers+="x-content-type-options: nosniff\\r\\n"
    body="Новости Дайджеста недели"
    ;;
  *) echo "unexpected URL: $url" >&2; exit 9 ;;
esac
printf '%b\\r\\n' "$headers" > "$headers_path"
printf '%s' "$body" > "$output_path"
if [[ -n "$write_out" ]]; then printf '200'; fi
`);
  chmodSync(curlShim, 0o755);
  const destinations = [
    ['telegramUrl', 'https://t.me/oknotika', 'Telegram'],
    ['youtubeUrl', 'https://youtube.com/@oknotika', 'YouTube'],
    ['vkUrl', 'https://vk.ru/oknotika', 'VK'],
    ['futuchatUrl', 'https://t.me/FUTU_CHAT', 'FUTUCHAT'],
  ];
  const completeBody = destinations
    .map(([, url, label]) => `<a href="${url}">${label}</a>`)
    .join('\n');
  const configuredSocial = Object.fromEntries(
    destinations.map(([field, url]) => [field, url]),
  );
  const runSmoke = (
    body,
    weeklyPath = '/articles/digest/',
    socialLinks = configuredSocial,
  ) => {
    writeFileSync(weeklyBodyPath, body);
    writeFileSync(socialManifestPath, JSON.stringify({ schemaVersion: 4, socialLinks }));
    return spawnSync('bash', [
      resolve(REPO_ROOT, 'deploy/scripts/smoke-test.sh'),
      '--base-url', 'https://public.test',
      '--admin-url', 'https://admin.test',
      '--weekly-path', weeklyPath,
      '--social-manifest', socialManifestPath,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${shimRoot}:${process.env.PATH}`,
        SMOKE_WEEKLY_BODY_PATH: weeklyBodyPath,
      },
    });
  };

  const passed = runSmoke(completeBody);
  assert.equal(passed.status, 0, passed.stderr);
  const invalidPath = runSmoke(completeBody, '/../invalid/');
  assert.equal(invalidPath.status, 2);
  assert.match(invalidPath.stderr, /--weekly-path must be an article detail path/);
  for (const [, url, label] of destinations) {
    const missingDestination = runSmoke(
      completeBody.replace(`href="${url}"`, 'href="https://missing.example/"'),
    );
    assert.equal(missingDestination.status, 1);
    assert.match(missingDestination.stderr, new RegExp(`${label} destination is missing`));
    const missingLabel = runSmoke(
      completeBody.replace(`>${label}</a>`, '>missing</a>'),
    );
    assert.equal(missingLabel.status, 1);
    assert.match(missingLabel.stderr, new RegExp(`${label} CTA label is missing`));
  }
  const partialSocial = {
    ...configuredSocial,
    vkUrl: null,
    futuchatUrl: null,
  };
  const partialBody = destinations.slice(0, 2)
    .map(([, url, label]) => `<a href="${url}">${label}</a>`)
    .join('\n');
  const partial = runSmoke(partialBody, '/articles/digest/', partialSocial);
  assert.equal(partial.status, 0, partial.stderr);
  const unexpectedOptional = runSmoke(
    `${partialBody}\n<a href="https://vk.ru/oknotika">VK</a>`,
    '/articles/digest/',
    partialSocial,
  );
  assert.equal(unexpectedOptional.status, 1);
  assert.match(unexpectedOptional.stderr, /VK destination must be absent/);
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
  assert.match(backupScript, /installed_release=.*pwd -P/);
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

test('restore verification rejects social links that differ from the active release', async (t) => {
  const fixture = await createRestoreFixture(t);
  const restored = new DatabaseSync(fixture.snapshotPath);
  restored.prepare(`
    UPDATE site_social_links
    SET youtube_url = 'https://youtube.com/@stale-restored-value'
    WHERE singleton = 1
  `).run();
  restored.close();
  const result = verifyRestoredState(fixture.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /social-link state differs/);
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

function rewriteAsSchemaTwoRelease(db, releasesRoot, releaseId) {
  const releaseDirectory = resolve(releasesRoot, 'releases', releaseId);
  const latestPath = resolve(releaseDirectory, 'articles/latest.json');
  const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
  const latestText = `${JSON.stringify({ ...latest, category: 'Факт недели' }, null, 2)}\n`;
  writeFileSync(latestPath, latestText);

  const manifestPath = resolve(releaseDirectory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.schemaVersion = 2;
  delete manifest.socialLinks;
  manifest.files['articles/latest.json'] = {
    ...manifest.files['articles/latest.json'],
    sha256: createHash('sha256').update(latestText).digest('hex'),
    bytes: Buffer.byteLength(latestText),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  db.prepare('UPDATE releases SET manifest_json = ? WHERE id = ?')
    .run(JSON.stringify(manifest), releaseId);
}
