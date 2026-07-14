#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importAlBahr } from '../src/content/al-bahr.js';
import { openDatabase } from '../src/content/database.js';
import { createContentService } from '../src/content/service.js';
import { createPrivatePreview } from '../src/render/preview.js';
import { createPublisher } from '../src/render/publisher.js';

const APP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(APP_ROOT, '..');

export async function runBetaRehearsal() {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-beta-editorial-'));
  let tick = 0;
  const clock = () => new Date(Date.parse('2026-07-14T00:00:00.000Z') + tick++ * 1000);
  const databasePath = resolve(root, 'db/admin.sqlite');
  const privateRoot = resolve(root, 'uploads');
  const previewsRoot = resolve(root, 'previews');
  const releasesRoot = resolve(root, 'article-releases');
  mkdirSync(resolve(root, 'db'), { recursive: true, mode: 0o700 });
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const publicCover = resolve(REPO_ROOT, 'articles/assets', readdirSync(resolve(REPO_ROOT, 'articles/assets'))[0]);
  const coverPath = resolve(privateRoot, `approved-cover${extname(publicCover)}`);
  copyFileSync(publicCover, coverPath);
  const db = openDatabase(databasePath);
  try {
    const service = createContentService(db, { clock });
    const editorId = service.configureEditor({ issuer: 'https://oauth.telegram.org', subject: 'beta-editor' });
    const coverAssetId = service.registerAsset({
      privatePath: coverPath,
      mediaType: extname(coverPath) === '.png' ? 'image/png' : 'image/jpeg',
      width: 1200,
      height: 800,
    });
    const imported = importAlBahr(service, { editorId, coverAssetId });
    const publisher = createPublisher(db, {
      releasesRoot,
      publicOrigin: 'https://oknotika.ru',
      clock,
    });
    const fallbackRelease = await publisher.publish({ editorId });

    const draft = service.createArticle({
      title: 'Beta: инженерная проверка фасада',
      publicationDate: '2026-07-13',
      lead: 'Материал проходит полный редакционный rehearsal до production.',
      bodyMarkdown: 'Черновик остаётся приватным.\n\n**Проверка:** preview, publish, edit, withdraw и rollback.',
      coverAssetId,
      coverAlt: 'Фасад на инженерной проверке',
      sourceUrl: 'https://example.com/beta-source',
    }, editorId);
    const fallbackListing = readFileSync(resolve(releasesRoot, 'active/articles/index.html'), 'utf8');
    assert.doesNotMatch(fallbackListing, /Beta: инженерная проверка фасада/);

    const preview = createPrivatePreview({
      db,
      revisionId: draft.revisionId,
      authenticatedEditorId: editorId,
      previewsRoot,
      publicOrigin: 'https://oknotika.ru',
    });
    const previewHeaders = JSON.parse(readFileSync(resolve(preview.directory, 'headers.json'), 'utf8'));
    assert.equal(previewHeaders['Cache-Control'], 'no-store');
    assert.equal(statSync(preview.directory).mode & 0o777, 0o700);

    service.publishRevision(draft.articleId, draft.revisionId, editorId, { expectedRevisionId: draft.revisionId });
    const publishedRelease = await publisher.publish({ editorId });
    const publishedLatest = JSON.parse(readFileSync(resolve(releasesRoot, 'active/articles/latest.json'), 'utf8'));
    assert.equal(publishedLatest.title, 'Beta: инженерная проверка фасада');
    assert.equal(publishedLatest.url, `https://oknotika.ru/articles/${draft.slug}/`);

    const revised = service.reviseArticle(draft.articleId, {
      title: 'Beta: проверка фасада завершена',
      publicationDate: '2026-07-13',
      lead: 'Обновлённая редакция сохраняет исходный публичный URL.',
      bodyMarkdown: 'Редакция обновлена без изменения slug.\n\n**Проверка:** optimistic revision guard.',
      coverAssetId,
      coverAlt: 'Фасад после инженерной проверки',
      sourceUrl: 'https://example.com/beta-source',
    }, editorId, { expectedRevisionId: draft.revisionId });
    assert.equal(revised.slug, draft.slug);
    service.publishRevision(draft.articleId, revised.revisionId, editorId, { expectedRevisionId: revised.revisionId });
    const editedRelease = await publisher.publish({ editorId });

    service.withdrawArticle(draft.articleId, editorId, { expectedRevisionId: revised.revisionId });
    const withdrawnRelease = await publisher.publish({ editorId });
    const withdrawnLatest = JSON.parse(readFileSync(resolve(releasesRoot, 'active/articles/latest.json'), 'utf8'));
    assert.equal(withdrawnLatest.url, `https://oknotika.ru/articles/${imported.slug}/`);
    const gone = readFileSync(resolve(releasesRoot, `active/articles/${draft.slug}/index.html`), 'utf8');
    assert.match(gone, /410 · Факт недели/);

    const restoredRevisionId = service.restoreRevision(
      draft.articleId,
      draft.revisionId,
      editorId,
      { expectedRevisionId: revised.revisionId },
    );
    service.publishRevision(draft.articleId, restoredRevisionId, editorId, { expectedRevisionId: restoredRevisionId });
    const restoredRelease = await publisher.publish({ editorId });
    await publisher.rollback(publishedRelease.releaseId, { editorId });
    const rolledBackLatest = JSON.parse(readFileSync(resolve(releasesRoot, 'active/articles/latest.json'), 'utf8'));
    assert.equal(rolledBackLatest.title, 'Beta: инженерная проверка фасада');

    const outage = await publicOutageCheck(resolve(releasesRoot, 'active'));
    const auditEvents = db.prepare('SELECT event_type, COUNT(*) AS count FROM audit_events GROUP BY event_type ORDER BY event_type').all();
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      stateRoot: 'ephemeral isolated directory (deleted after rehearsal)',
      draftInvisibility: 'pass',
      privatePreview: { status: 'pass', cacheControl: previewHeaders['Cache-Control'], mode: '0700' },
      immutableSlugAcrossEdit: 'pass',
      publish: { status: 'pass', releaseId: publishedRelease.releaseId },
      edit: { status: 'pass', releaseId: editedRelease.releaseId },
      withdraw: { status: 'pass', releaseId: withdrawnRelease.releaseId, responseContract: 'static 410' },
      latestFallback: { status: 'pass', url: withdrawnLatest.url },
      editorialRestore: { status: 'pass', releaseId: restoredRelease.releaseId, revisionId: restoredRevisionId },
      operationalRollback: { status: 'pass', from: restoredRelease.releaseId, to: publishedRelease.releaseId },
      adminOutage: outage,
      initialFallbackRelease: fallbackRelease.releaseId,
      auditEvents,
      status: 'pass',
    };
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function publicOutageCheck(publicRoot) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const relative = pathname === '/articles/latest.json'
      ? 'articles/latest.json'
      : pathname === '/articles/'
        ? 'articles/index.html'
        : null;
    if (!relative) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    response.writeHead(200).end(readFileSync(resolve(publicRoot, relative)));
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  try {
    const { port } = server.address();
    const [listing, latest] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/articles/`),
      fetch(`http://127.0.0.1:${port}/articles/latest.json`),
    ]);
    assert.equal(listing.status, 200);
    assert.equal(latest.status, 200);
    assert.equal(listing.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    return {
      status: 'pass',
      adminHttpServiceStarted: false,
      publicListingStatus: listing.status,
      publicLatestStatus: latest.status,
      contract: 'public immutable release served independently while admin HTTP service is absent',
    };
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise));
  }
}

async function cli() {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  const report = await runBetaRehearsal();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    const filename = resolve(process.cwd(), output);
    mkdirSync(resolve(filename, '..'), { recursive: true });
    writeFileSync(filename, serialized);
  }
  process.stdout.write(serialized);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
