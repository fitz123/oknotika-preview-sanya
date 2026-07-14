import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { runInNewContext } from 'node:vm';
import { AL_BAHR_FIXTURE, importAlBahr } from '../src/content/al-bahr.js';
import { loadRevisionSnapshot, renderRelease, validateRelease } from '../src/render/renderer.js';
import { articleInput, createHarness } from './helpers.js';

function render(harness, name, snapshot) {
  const outputDirectory = resolve(harness.root, name);
  const manifest = renderRelease({
    snapshot,
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
  const imported = importAlBahr(harness.service, { editorId: harness.editorId, coverAssetId: harness.coverAssetId });
  const snapshot = [loadRevisionSnapshot(
    harness.db, imported.articleId, imported.revisionId, 'published',
  )];
  const { outputDirectory } = render(harness, 'golden', snapshot);
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
  harness.service.createArticle(articleInput(harness.coverAssetId, { title: 'Скрытый черновик' }), harness.editorId);
  const snapshot = [loadRevisionSnapshot(
    harness.db, published.articleId, published.revisionId, 'published',
  )];
  const { outputDirectory, manifest } = render(harness, 'public-release', snapshot);
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
  const second = harness.service.createArticle(articleInput(harness.coverAssetId, {
    title: 'Второй факт', publicationDate: '2026-07-12',
  }), harness.editorId);
  const snapshot = [
    loadRevisionSnapshot(harness.db, first.articleId, first.revisionId, 'published'),
    loadRevisionSnapshot(harness.db, second.articleId, second.revisionId, 'withdrawn'),
  ];
  const { outputDirectory } = render(harness, 'withdrawn-release', snapshot);
  const listing = readFileSync(resolve(outputDirectory, 'articles/index.html'), 'utf8');
  const latest = JSON.parse(readFileSync(resolve(outputDirectory, 'articles/latest.json'), 'utf8'));
  const goneHtml = readFileSync(resolve(outputDirectory, `articles/${second.slug}/index.html`), 'utf8');
  assert.equal(latest.title, 'Первый факт');
  assert.doesNotMatch(listing, /Второй факт/);
  assert.equal(readFileSync(resolve(outputDirectory, 'withdrawn', second.slug), 'utf8').trim(), '410');
  assert.match(goneHtml, /410 · Факт недели/);
  assert.match(goneHtml, /noindex,nofollow/);
});

test('HTML/JSON revalidate while only content-hashed assets are immutable', (t) => {
  const harness = createHarness(t);
  const created = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
  const snapshot = [loadRevisionSnapshot(
    harness.db, created.articleId, created.revisionId, 'published',
  )];
  const { manifest } = render(harness, 'cache-contract', snapshot);
  for (const [path, metadata] of Object.entries(manifest.files)) {
    assert.equal(
      metadata.cacheControl,
      path.startsWith('articles/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate',
    );
  }
});

test('homepage loader mutates only bounded same-origin payloads and otherwise retains fallback', async () => {
  const homepage = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');
  assert.match(homepage, /data-latest-fact-state="fallback"/);
  assert.match(homepage, /data-latest-title/);
  assert.match(homepage, /data-latest-lead/);
  assert.match(homepage, /src="js\/latest-fact\.js"/);

  const valid = {
    category: 'Факт недели',
    title: 'Проверенный факт',
    lead: 'Короткое описание',
    url: 'https://oknotika.ru/articles/proverennyi-fakt/',
  };
  const loaded = await runLatestLoader(valid);
  assert.equal(loaded.state, 'loaded');
  assert.equal(loaded.title, valid.title);
  assert.equal(loaded.lead, valid.lead);
  assert.equal(loaded.href, valid.url);

  for (const payload of [
    null,
    { ...valid, category: 'Другая рубрика' },
    { ...valid, title: 'x'.repeat(241) },
    { ...valid, lead: 'x'.repeat(1201) },
    { ...valid, url: 'https://evil.example/articles/proverennyi-fakt/' },
    { ...valid, url: 'javascript:alert(1)' },
  ]) {
    const fallback = await runLatestLoader(payload);
    assert.deepEqual(fallback, {
      state: 'fallback', title: 'Статический заголовок', lead: 'Статический текст', href: '/articles/',
    });
  }
  assert.equal((await runLatestLoader(valid, { ok: false })).state, 'fallback');
});

async function runLatestLoader(payload, { ok = true } = {}) {
  const title = { textContent: 'Статический заголовок' };
  const lead = { textContent: 'Статический текст' };
  const link = { href: '/articles/', textContent: 'Подробнее' };
  const card = {
    dataset: { latestFactState: 'fallback' },
    querySelector(selector) {
      return ({
        '[data-latest-title]': title,
        '[data-latest-lead]': lead,
        '[data-latest-link]': link,
      })[selector];
    },
  };
  const loader = readFileSync(resolve(import.meta.dirname, '../../js/latest-fact.js'), 'utf8');
  runInNewContext(loader, {
    document: { querySelector: () => card },
    window: { location: { origin: 'https://oknotika.ru' } },
    URL,
    fetch: async () => ({ ok, json: async () => payload }),
  });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  return {
    state: card.dataset.latestFactState,
    title: title.textContent,
    lead: lead.textContent,
    href: link.href,
  };
}
