import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readlinkSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/content/database.js';
import {
  acquirePublisherLock,
  createPublisher,
  releasePublisherLock,
} from '../src/render/publisher.js';
import { articleInput, createHarness } from './helpers.js';

const BOUNDARIES = [
  'before-stage-render',
  'after-stage-render',
  'before-immutable-rename',
  'after-immutable-rename',
  'before-active-switch',
  'after-active-switch',
  'before-db-finalize',
  'after-db-finalize',
];

for (const boundary of BOUNDARIES) {
  test(`failure injection at ${boundary} preserves or reconciles the active release`, async (t) => {
    const harness = createHarness(t);
    const created = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
    const releasesRoot = resolve(harness.root, 'article-releases');
    const publisher = createPublisher(harness.db, {
      releasesRoot,
      publicOrigin: 'https://oknotika.ru',
      clock: () => new Date('2026-07-13T12:00:00.000Z'),
    });
    await assert.rejects(publisher.publish({
      editorId: harness.editorId,
      transition: publication(created),
      inject: async (current) => {
        if (current === boundary) throw new Error(`injected ${boundary}`);
      },
    }), new RegExp(`injected ${boundary}`));
    assert.equal(existsSync(resolve(releasesRoot, '.publisher.lock')), false);

    const switched = ['after-active-switch', 'before-db-finalize', 'after-db-finalize'].includes(boundary);
    assert.equal(existsSync(publisher.activePath), switched);
    if (switched) {
      const state = harness.db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get();
      const activeReleaseId = readlinkSync(publisher.activePath).split('/').at(-1);
      assert.equal(state.active_release_id, activeReleaseId);
      assert.equal(
        harness.db.prepare('SELECT status FROM releases WHERE id = ?').get(activeReleaseId).status,
        'complete',
      );
    } else {
      assert.equal(
        harness.db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get().active_release_id,
        null,
      );
    }
  });
}

test('publisher switches one symlink atomically and operational rollback restores a whole release', async (t) => {
  let tick = 0;
  const harness = createHarness(t, {
    clock: () => new Date(Date.parse('2026-07-13T12:00:00.000Z') + tick++ * 1000),
  });
  const created = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
  const releasesRoot = resolve(harness.root, 'article-releases');
  const publisher = createPublisher(harness.db, {
    releasesRoot,
    publicOrigin: 'https://oknotika.ru',
    clock: () => new Date(Date.parse('2026-07-14T12:00:00.000Z') + tick++ * 1000),
  });
  const first = await publisher.publish({ editorId: harness.editorId, transition: publication(created) });
  const revised = harness.service.reviseArticle(created.articleId, articleInput(harness.coverAssetId, {
    title: 'Обновлённый факт',
  }), harness.editorId);
  const second = await publisher.publish({ editorId: harness.editorId, transition: publication(revised) });
  assert.notEqual(first.releaseId, second.releaseId);
  assert.equal(readlinkSync(publisher.activePath), `releases/${second.releaseId}`);

  await publisher.rollback(first.releaseId, { editorId: harness.editorId });
  assert.equal(readlinkSync(publisher.activePath), `releases/${first.releaseId}`);
  assert.equal(
    harness.db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get().active_release_id,
    first.releaseId,
  );
  const event = harness.db.prepare("SELECT details_json FROM audit_events WHERE event_type = 'release.rolled_back'").get();
  assert.equal(JSON.parse(event.details_json).previous, second.releaseId);
});

test('draft edits keep the last published revision in unrelated releases', async (t) => {
  let tick = 0;
  const harness = createHarness(t, {
    clock: () => new Date(Date.parse('2026-07-13T12:00:00.000Z') + tick++ * 1000),
  });
  const releasesRoot = resolve(harness.root, 'draft-public-separation');
  const publisher = createPublisher(harness.db, {
    releasesRoot,
    publicOrigin: 'https://oknotika.ru',
    clock: () => new Date(Date.parse('2026-07-14T12:00:00.000Z') + tick++ * 1000),
  });
  const first = harness.service.createArticle(articleInput(harness.coverAssetId, {
    title: 'Первый опубликованный заголовок', publicationDate: '2026-07-10',
  }), harness.editorId);
  await publisher.publish({ editorId: harness.editorId, transition: publication(first) });
  const draft = harness.service.reviseArticle(first.articleId, articleInput(harness.coverAssetId, {
    title: 'Неопубликованный новый заголовок', publicationDate: '2026-07-10',
  }), harness.editorId, { expectedRevisionId: first.revisionId });
  const second = harness.service.createArticle(articleInput(harness.coverAssetId, {
    title: 'Второй опубликованный материал', publicationDate: '2026-07-11',
  }), harness.editorId);
  const release = await publisher.publish({ editorId: harness.editorId, transition: publication(second) });

  const firstRecord = release.articles.find(article => article.articleId === first.articleId);
  assert.equal(firstRecord.revisionId, first.revisionId);
  assert.equal(firstRecord.state, 'published');
  assert.ok(release.articles.some(article => article.articleId === second.articleId));
  const article = harness.service.getArticle(first.articleId);
  assert.equal(article.current_revision_id, draft.revisionId);
  assert.equal(article.published_revision_id, first.revisionId);
  assert.equal(article.public_state, 'published');
  assert.equal(article.state, 'draft');
});

test('failed publication leaves editorial and public state unchanged', async (t) => {
  const harness = createHarness(t);
  const article = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
  const publisher = createPublisher(harness.db, {
    releasesRoot: resolve(harness.root, 'failed-transition'),
    publicOrigin: 'https://oknotika.ru',
  });
  await assert.rejects(publisher.publish({
    editorId: harness.editorId,
    transition: publication(article),
    inject: async boundary => {
      if (boundary === 'before-stage-render') throw new Error('render rejected');
    },
  }), /render rejected/);
  const stored = harness.service.getArticle(article.articleId);
  assert.equal(stored.state, 'draft');
  assert.equal(stored.public_state, null);
  assert.equal(stored.published_revision_id, null);
  assert.equal(
    harness.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'article.published'").get().count,
    0,
  );
});

test('single-publisher lock rejects concurrent publication', async (t) => {
  const harness = createHarness(t);
  const created = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
  const releasesRoot = resolve(harness.root, 'article-releases');
  const publisher = createPublisher(harness.db, { releasesRoot, publicOrigin: 'https://oknotika.ru' });
  const first = publisher.publish({
    transition: publication(created),
    inject: async (boundary) => {
      if (boundary === 'before-stage-render') {
        await assert.rejects(publisher.publish({ transition: publication(created) }), /Another publisher holds the release lock/);
      }
    },
  });
  await first;
});

test('startup reconciliation participates in the shared publisher lock', (t) => {
  const harness = createHarness(t);
  const releasesRoot = resolve(harness.root, 'reconcile-lock');
  const publisher = createPublisher(harness.db, { releasesRoot, publicOrigin: 'https://oknotika.ru' });
  const lock = acquirePublisherLock(releasesRoot);
  try {
    assert.throws(() => publisher.reconcile(), /Another publisher holds the release lock/);
  } finally {
    releasePublisherLock(lock);
  }
});

test('reconciliation fails closed when an active public release loses its symlink', async (t) => {
  const harness = createHarness(t);
  const article = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
  const releasesRoot = resolve(harness.root, 'missing-active');
  const publisher = createPublisher(harness.db, { releasesRoot, publicOrigin: 'https://oknotika.ru' });
  const release = await publisher.publish({ editorId: harness.editorId, transition: publication(article) });
  unlinkSync(publisher.activePath);

  assert.throws(() => publisher.reconcile(), /symlink is missing while SQLite still records public state/);
  assert.equal(
    harness.db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get().active_release_id,
    release.releaseId,
  );
  const stored = harness.service.getArticle(article.articleId);
  assert.equal(stored.published_revision_id, article.revisionId);
  assert.equal(stored.public_state, 'published');
});

for (const boundary of ['before-active-switch', 'after-active-switch', 'before-db-finalize', 'after-db-finalize']) {
  test(`rollback failure at ${boundary} preserves or reconciles active release state`, async (t) => {
    let tick = 0;
    const harness = createHarness(t, {
      clock: () => new Date(Date.parse('2026-07-13T12:00:00.000Z') + tick++ * 1000),
    });
    const article = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
    const releasesRoot = resolve(harness.root, 'rollback-failures');
    const publisher = createPublisher(harness.db, {
      releasesRoot,
      publicOrigin: 'https://oknotika.ru',
      clock: () => new Date(Date.parse('2026-07-15T12:00:00.000Z') + tick++ * 1000),
    });
    const first = await publisher.publish({ editorId: harness.editorId, transition: publication(article) });
    const revision = harness.service.reviseArticle(article.articleId, articleInput(harness.coverAssetId, {
      title: 'Второй release для rollback',
    }), harness.editorId, { expectedRevisionId: article.revisionId });
    const second = await publisher.publish({ editorId: harness.editorId, transition: publication(revision) });

    await assert.rejects(publisher.rollback(first.releaseId, {
      editorId: harness.editorId,
      inject: async current => {
        if (current === boundary) throw new Error(`injected ${boundary}`);
      },
    }), new RegExp(`injected ${boundary}`));
    assert.equal(existsSync(resolve(releasesRoot, '.publisher.lock')), false);

    const switched = ['after-active-switch', 'before-db-finalize', 'after-db-finalize'].includes(boundary);
    assert.equal(readlinkSync(publisher.activePath), `releases/${switched ? first.releaseId : second.releaseId}`);
    assert.equal(
      harness.db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get().active_release_id,
      switched ? first.releaseId : second.releaseId,
    );
  });
}

test('publisher recovers a lock left by a killed process and publishes after restart', async (t) => {
  const harness = createHarness(t);
  const crashRoot = resolve(harness.root, 'crash-process');
  const fixture = resolve(import.meta.dirname, 'fixtures/crash-publisher.mjs');
  const child = spawn(process.execPath, [fixture, crashRoot, harness.coverPath], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const locked = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error('crash publisher did not acquire its lock')), 10_000);
    child.once('error', rejectPromise);
    child.on('message', message => {
      if (message?.locked) {
        clearTimeout(timeout);
        resolvePromise(message);
      }
    });
  });
  child.kill('SIGKILL');
  await new Promise(resolvePromise => child.once('exit', resolvePromise));

  const database = openDatabase(resolve(crashRoot, 'admin.sqlite'));
  t.after(() => database.close());
  const publisher = createPublisher(database, {
    releasesRoot: resolve(crashRoot, 'article-releases'),
    publicOrigin: 'https://oknotika.ru',
    clock: () => new Date('2026-07-16T12:00:00.000Z'),
  });
  const manifest = await publisher.publish({
    editorId: locked.editorId,
    transition: {
      type: 'publish', articleId: locked.articleId, expectedRevisionId: locked.revisionId,
    },
  });
  assert.ok(manifest.releaseId);
  assert.equal(existsSync(resolve(crashRoot, 'article-releases/.publisher.lock')), false);
});

function publication(article) {
  return {
    type: 'publish',
    articleId: article.articleId,
    expectedRevisionId: article.revisionId,
  };
}
