import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { runInNewContext } from 'node:vm';
import { AL_BAHR_FIXTURE, importAlBahr } from '../src/content/al-bahr.js';
import { loadRevisionSnapshot, renderRelease, validateRelease } from '../src/render/renderer.js';
import {
  articleInput,
  createHarness,
  weeklyIngestionInput,
} from './helpers.js';

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
  assert.match(goneHtml, /410 · Новости/);
  assert.match(goneHtml, /noindex,nofollow/);
});

test('weekly digests render three-to-five items, verified sources and only configured social links', (t) => {
  const harness = createHarness(t);
  const threeItems = harness.service.ingestWeeklyDraft(weeklyIngestionInput(harness.coverAssetId, {
    article: {
      sourceUrls: [
        'https://example.com/news/one',
        'https://example.org/news/two',
        'https://example.net/news/three',
      ],
    },
  }));
  const fiveItems = harness.service.ingestWeeklyDraft(weeklyIngestionInput(harness.coverAssetId, {
    issueId: '2026-W32',
    article: {
      publicationDate: '2026-08-07',
      bodyMarkdown: [
        '1. Первая новость.',
        '2. Вторая новость.',
        '3. Третья новость.',
        '4. Четвёртая новость.',
        '5. Пятая новость.',
      ].join('\n'),
    },
  }));
  harness.service.configureSocialLinks({
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: 'https://youtube.com/@oknotika',
    vkUrl: null,
  }, harness.editorId);

  const snapshot = [
    loadRevisionSnapshot(harness.db, threeItems.articleId, threeItems.revisionId, 'published'),
    loadRevisionSnapshot(harness.db, fiveItems.articleId, fiveItems.revisionId, 'published'),
  ];
  const { outputDirectory } = render(harness, 'weekly-digests', snapshot);
  const threeItemDetail = readFileSync(
    resolve(outputDirectory, `articles/${threeItems.slug}/index.html`),
    'utf8',
  );
  const fiveItemDetail = readFileSync(
    resolve(outputDirectory, `articles/${fiveItems.slug}/index.html`),
    'utf8',
  );
  const listing = readFileSync(resolve(outputDirectory, 'articles/index.html'), 'utf8');
  const latest = JSON.parse(readFileSync(resolve(outputDirectory, 'articles/latest.json'), 'utf8'));
  const publicStyles = readFileSync(resolve(import.meta.dirname, '../../style.css'), 'utf8');

  assert.match(listing, /<h1>Новости<\/h1>/);
  assert.match(listing, /Дайджест недели/);
  assert.match(threeItemDetail, /name="viewport"/);
  assert.match(publicStyles, /\.article-social__links \{ display: flex/);
  assert.match(
    publicStyles,
    /@media \(max-width: 760px\) \{[\s\S]*\.article-social__links \{ display: grid; \}/,
  );
  assert.match(threeItemDetail, /Дайджест недели · 31 июля 2026 г\./);
  assert.equal(digestItemCount(threeItemDetail), 3);
  assert.equal(digestItemCount(fiveItemDetail), 5);
  for (const sourceUrl of [
    'https://example.com/news/one',
    'https://example.org/news/two',
    'https://example.net/news/three',
  ]) {
    assert.match(threeItemDetail, new RegExp(`href="${sourceUrl}"`));
  }
  assert.match(threeItemDetail, /class="article-sources"/);
  assert.match(threeItemDetail, /href="https:\/\/t\.me\/oknotika"/);
  assert.match(threeItemDetail, /href="https:\/\/youtube\.com\/@oknotika"/);
  assert.doesNotMatch(threeItemDetail, /vk\.com|VK:|не настроен/);
  assert.equal(latest.category, 'Новости');
});

test('weekly social CTA omits missing YouTube and VK destinations without inventing links', (t) => {
  const harness = createHarness(t);
  const created = harness.service.ingestWeeklyDraft(weeklyIngestionInput(harness.coverAssetId));
  const article = loadRevisionSnapshot(
    harness.db, created.articleId, created.revisionId, 'published',
  );
  const { outputDirectory } = render(harness, 'telegram-only-digest', [article]);
  const detail = readFileSync(
    resolve(outputDirectory, `articles/${created.slug}/index.html`),
    'utf8',
  );
  assert.match(detail, /href="https:\/\/t\.me\/oknotika"/);
  assert.doesNotMatch(detail, /youtube\.com|youtu\.be|vk\.com|YouTube|>VK</);
});

test('public release rejects a weekly snapshot that violates the digest contract', (t) => {
  const harness = createHarness(t);
  const created = harness.service.ingestWeeklyDraft(weeklyIngestionInput(harness.coverAssetId));
  const article = loadRevisionSnapshot(
    harness.db,
    created.articleId,
    created.revisionId,
    'published',
  );
  assert.throws(
    () => render(harness, 'invalid-weekly-contract', [{
      ...article,
      body_markdown: '1. Недостаточно пунктов.',
    }]),
    /ordered list with 3–5/,
  );
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

test('release validation enforces the homepage latest-card text contract', (t) => {
  const harness = createHarness(t);
  const created = harness.service.createArticle(articleInput(harness.coverAssetId), harness.editorId);
  const article = loadRevisionSnapshot(harness.db, created.articleId, created.revisionId, 'published');
  assert.throws(
    () => render(harness, 'oversized-latest', [{ ...article, title: 'x'.repeat(241) }]),
    /latest.json contract is invalid/,
  );
});

test('homepage loader mutates only bounded same-origin payloads and otherwise retains fallback', async () => {
  const homepage = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');
  assert.match(homepage, /data-latest-fact-state="fallback"/);
  assert.match(homepage, /aria-label="Новости"/);
  assert.match(homepage, /data-latest-title/);
  assert.match(homepage, /data-latest-lead/);
  assert.match(homepage, /src="js\/latest-fact\.js"/);

  const valid = {
    category: 'Новости',
    title: 'Проверенный факт',
    lead: 'Короткое описание',
    url: 'https://oknotika.ru/articles/proverennyi-fakt/',
  };
  const loaded = await runLatestLoader(valid);
  assert.equal(loaded.state, 'loaded');
  assert.equal(loaded.title, valid.title);
  assert.equal(loaded.lead, valid.lead);
  assert.equal(loaded.href, valid.url);
  assert.equal((await runLatestLoader({ ...valid, category: 'Факт недели' })).state, 'loaded');

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

test('public navigation consistently names the article section Новости', () => {
  for (const relativePath of [
    'index.html',
    'aluminum/index.html',
    'carbon-glass/index.html',
    'glass/index.html',
    'oknotika-smart-window/index.html',
    'protectapeel/index.html',
    'pvc/index.html',
    'wood-stoller/index.html',
  ]) {
    const html = readFileSync(resolve(import.meta.dirname, '../..', relativePath), 'utf8');
    assert.match(html, /href="(?:\.\.\/)?articles\/">Новости<\/a>/, relativePath);
    assert.doesNotMatch(html, />Факт недели<\/a>/, relativePath);
  }
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

function digestItemCount(html) {
  const digest = html.match(/<div class="article-digest">([\s\S]*?)<\/div>/);
  assert.ok(digest);
  return digest[1].match(/<li>/g)?.length ?? 0;
}
