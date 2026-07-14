import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { openDatabase } from '../src/content/database.js';
import { createContentService } from '../src/content/service.js';
import { createHarness } from './helpers.js';

test('production content bootstrap imports Al Bahr and creates one idempotent active release', async (t) => {
  const harness = createHarness(t);
  const root = resolve(harness.root, 'production-bootstrap');
  const databasePath = resolve(root, 'db/admin.sqlite');
  const releasesRoot = resolve(root, 'article-releases');
  const uploadsRoot = resolve(root, 'uploads');
  const cover = resolve(root, 'al-bahr.jpg');
  mkdirSync(resolve(root, 'db'), { recursive: true });
  writeFileSync(cover, await sharp({
    create: { width: 16, height: 12, channels: 3, background: '#abcdef' },
  }).jpeg().toBuffer());
  const setup = openDatabase(databasePath);
  createContentService(setup).configureEditor({
    issuer: 'https://oauth.telegram.org', subject: '9988776655',
  });
  setup.close();

  const script = resolve(import.meta.dirname, '../scripts/bootstrap-content.js');
  const args = [
    script,
    '--database', databasePath,
    '--releases-root', releasesRoot,
    '--uploads-root', uploadsRoot,
    '--public-origin', 'https://oknotika.ru',
    '--cover', cover,
  ];
  const firstOutput = execFileSync(process.execPath, args, { encoding: 'utf8' });
  assert.match(firstOutput, /Bootstrapped al-bahr-towers-dynamic-facade/);
  const database = openDatabase(databasePath);
  const article = database.prepare(`
    SELECT slug, state, public_state, current_revision_id, published_revision_id FROM articles
  `).get();
  assert.equal(article.slug, 'al-bahr-towers-dynamic-facade');
  assert.equal(article.state, 'published');
  assert.equal(article.public_state, 'published');
  assert.equal(article.current_revision_id, article.published_revision_id);
  const active = database.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get().active_release_id;
  database.close();

  const secondOutput = execFileSync(process.execPath, args, { encoding: 'utf8' });
  assert.match(secondOutput, new RegExp(`already complete: .* ${active}`));
  const verified = openDatabase(databasePath);
  assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 1);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM releases WHERE status = 'complete'").get().count, 1);
  verified.close();
});

test('legacy enrollment only re-enables the exact previously verified editor', (t) => {
  const harness = createHarness(t);
  const databasePath = resolve(harness.root, 'enrollment.sqlite');
  const script = resolve(import.meta.dirname, '../scripts/enroll-editor.js');
  const baseArguments = [
    script,
    '--database', databasePath,
    '--issuer', 'https://oauth.telegram.org',
    '--subject', '9988776655',
  ];

  const fresh = spawnSync(process.execPath, baseArguments, { encoding: 'utf8' });
  assert.notEqual(fresh.status, 0);
  assert.match(fresh.stderr, /first enrollment must use npm run bootstrap-editor/);

  const database = openDatabase(databasePath);
  createContentService(database).configureEditor({
    issuer: 'https://oauth.telegram.org', subject: '9988776655',
  });
  database.close();
  const exact = spawnSync(process.execPath, baseArguments, { encoding: 'utf8' });
  assert.equal(exact.status, 0, exact.stderr);

  const different = spawnSync(process.execPath, [
    ...baseArguments.slice(0, -1), '1122334455',
  ], { encoding: 'utf8' });
  assert.notEqual(different.status, 0);
  assert.match(different.stderr, /different editor is already enrolled/);
});
