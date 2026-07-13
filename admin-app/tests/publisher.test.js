import assert from 'node:assert/strict';
import { existsSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPublisher } from '../src/render/publisher.js';
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
    harness.service.publishRevision(created.articleId, created.revisionId, harness.editorId);
    const releasesRoot = resolve(harness.root, 'article-releases');
    const publisher = createPublisher(harness.db, {
      releasesRoot,
      publicOrigin: 'https://oknotika.ru',
      clock: () => new Date('2026-07-13T12:00:00.000Z'),
    });
    await assert.rejects(publisher.publish({
      editorId: harness.editorId,
      inject: async (current) => {
        if (current === boundary) throw new Error(`injected ${boundary}`);
      },
    }), new RegExp(`injected ${boundary}`));
    assert.equal(existsSync(resolve(releasesRoot, '.publisher.lock')), false);

    const switched = ['after-active-switch', 'before-db-finalize', 'after-db-finalize'].includes(boundary);
    assert.equal(existsSync(publisher.activePath), switched);
    if (switched) {
      const manifest = publisher.reconcile();
      assert.ok(manifest.releaseId);
      const state = harness.db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get();
      assert.equal(state.active_release_id, manifest.releaseId);
      assert.equal(
        harness.db.prepare('SELECT status FROM releases WHERE id = ?').get(manifest.releaseId).status,
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
  harness.service.publishRevision(created.articleId, created.revisionId, harness.editorId);
  const releasesRoot = resolve(harness.root, 'article-releases');
  const publisher = createPublisher(harness.db, {
    releasesRoot,
    publicOrigin: 'https://oknotika.ru',
    clock: () => new Date(Date.parse('2026-07-14T12:00:00.000Z') + tick++ * 1000),
  });
  const first = await publisher.publish({ editorId: harness.editorId });
  const revised = harness.service.reviseArticle(created.articleId, articleInput(harness.coverAssetId, {
    title: 'Обновлённый факт',
  }), harness.editorId);
  harness.service.publishRevision(created.articleId, revised.revisionId, harness.editorId);
  const second = await publisher.publish({ editorId: harness.editorId });
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

test('single-publisher lock rejects concurrent publication', async (t) => {
  const harness = createHarness(t);
  const created = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
  harness.service.publishRevision(created.articleId, created.revisionId, harness.editorId);
  const releasesRoot = resolve(harness.root, 'article-releases');
  const publisher = createPublisher(harness.db, { releasesRoot, publicOrigin: 'https://oknotika.ru' });
  const first = publisher.publish({
    inject: async (boundary) => {
      if (boundary === 'before-stage-render') {
        await assert.rejects(publisher.publish(), /Another publisher holds the release lock/);
      }
    },
  });
  await first;
});
