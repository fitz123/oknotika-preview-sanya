import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { AL_BAHR_FIXTURE, importAlBahr } from '../src/content/al-bahr.js';
import { renderRelease, validateRelease } from '../src/render/renderer.js';
import { articleInput, createHarness } from './helpers.js';

function render(harness, name) {
  const outputDirectory = resolve(harness.root, name);
  const manifest = renderRelease({
    db: harness.db,
    outputDirectory,
    publicOrigin: 'https://oknotika.ru',
    releaseId: name,
    generatedAt: '2026-07-13T12:00:00.000Z',
  });
  validateRelease(outputDirectory);
  return { outputDirectory, manifest };
}

test('Al Bahr import retains URL, visible content, metadata and page style as a golden render', (t) => {
  const harness = createHarness(t);
  importAlBahr(harness.service, { editorId: harness.editorId, coverAssetId: harness.coverAssetId });
  const { outputDirectory } = render(harness, 'golden');
  const generated = readFileSync(
    resolve(outputDirectory, 'articles', AL_BAHR_FIXTURE.slug, 'index.html'),
    'utf8',
  );
  const checkedGolden = readFileSync(
    resolve(import.meta.dirname, '../../articles', AL_BAHR_FIXTURE.slug, 'index.html'),
    'utf8',
  );
  const normalizeAsset = (html) => html.replace(/[a-f0-9]{24}\.(?:png|jpg|webp)/g, 'GOLDEN-ASSET');
  assert.equal(normalizeAsset(generated), normalizeAsset(checkedGolden));
  assert.match(generated, /Факт недели ОКНОТИКИ: Al Bahr Towers/);
  assert.match(generated, /class="container article-body reveal"/);
  const listing = readFileSync(resolve(outputDirectory, 'articles/index.html'), 'utf8');
  assert.match(listing, /современный фасад — активная инженерная система/);
});

test('one release contains listing, latest, canonical/OG, detail and only published assets', (t) => {
  const harness = createHarness(t);
  const published = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
  harness.service.publishRevision(published.articleId, published.revisionId, harness.editorId);
  harness.service.createArticle(articleInput(harness.coverAssetId, { title: 'Скрытый черновик' }), harness.editorId);
  const { outputDirectory, manifest } = render(harness, 'public-release');
  const listing = readFileSync(resolve(outputDirectory, 'articles/index.html'), 'utf8');
  const detail = readFileSync(resolve(outputDirectory, `articles/${published.slug}/index.html`), 'utf8');
  const latest = JSON.parse(readFileSync(resolve(outputDirectory, 'articles/latest.json'), 'utf8'));
  assert.match(listing, /Светопрозрачный фасад/);
  assert.doesNotMatch(listing, /Скрытый черновик/);
  assert.equal(latest.url, `https://oknotika.ru/articles/${published.slug}/`);
  assert.match(detail, new RegExp(`<link rel="canonical" href="${latest.url}"`));
  assert.match(detail, /property="og:title"/);
  assert.equal(manifest.articles.length, 1);
  const publicAsset = Object.keys(manifest.files)
    .find((path) => /^articles\/assets\/[a-f0-9]{24}\.png$/.test(path));
  assert.ok(publicAsset);
  assert.equal(statSync(resolve(outputDirectory, publicAsset)).mode & 0o777, 0o640);
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(harness.privateRoot));
});

test('withdrawal generates a 410 page and latest falls back to the previous publication', (t) => {
  const harness = createHarness(t);
  const first = harness.service.createArticle(articleInput(harness.coverAssetId, {
    title: 'Первый факт', publicationDate: '2026-07-01',
  }), harness.editorId);
  harness.service.publishRevision(first.articleId, first.revisionId, harness.editorId);
  const second = harness.service.createArticle(articleInput(harness.coverAssetId, {
    title: 'Второй факт', publicationDate: '2026-07-12',
  }), harness.editorId);
  harness.service.publishRevision(second.articleId, second.revisionId, harness.editorId);
  harness.service.withdrawArticle(second.articleId, harness.editorId);

  const { outputDirectory } = render(harness, 'withdrawn-release');
  const listing = readFileSync(resolve(outputDirectory, 'articles/index.html'), 'utf8');
  const latest = JSON.parse(readFileSync(resolve(outputDirectory, 'articles/latest.json'), 'utf8'));
  const goneMap = JSON.parse(readFileSync(resolve(outputDirectory, '410-map.json'), 'utf8'));
  const goneHtml = readFileSync(resolve(outputDirectory, `articles/${second.slug}/index.html`), 'utf8');
  assert.equal(latest.title, 'Первый факт');
  assert.doesNotMatch(listing, /Второй факт/);
  assert.deepEqual(goneMap.paths, [`/articles/${second.slug}/`]);
  assert.match(goneHtml, /410 · Факт недели/);
  assert.match(goneHtml, /noindex,nofollow/);
});

test('HTML/JSON revalidate while only content-hashed assets are immutable', (t) => {
  const harness = createHarness(t);
  const created = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
  harness.service.publishRevision(created.articleId, created.revisionId, harness.editorId);
  const { manifest } = render(harness, 'cache-contract');
  for (const [path, metadata] of Object.entries(manifest.files)) {
    assert.equal(
      metadata.cacheControl,
      path.startsWith('articles/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate',
    );
  }
});

test('homepage loads latest.json into bounded text fields and retains static fallback', () => {
  const homepage = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');
  const loader = readFileSync(resolve(import.meta.dirname, '../../js/latest-fact.js'), 'utf8');
  assert.match(homepage, /data-latest-fact-state="fallback"/);
  assert.match(homepage, /data-latest-title/);
  assert.match(homepage, /data-latest-lead/);
  assert.match(homepage, /src="js\/latest-fact\.js"/);
  assert.match(loader, /fetch\('\/articles\/latest\.json'/);
  assert.match(loader, /\.textContent = fact\.title/);
  assert.doesNotMatch(loader, /innerHTML/);
});
