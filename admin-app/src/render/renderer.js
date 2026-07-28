import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../content/markdown.js';
import { MAX_SLUG_LENGTH } from '../content/slug.js';
import {
  ARTICLE_TEXT_LIMITS,
  formatMoscowDate,
  validateSocialLinks,
  validateWeeklyArticleInput,
} from '../content/validation.js';

const TEMPLATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../templates/public');
const CACHE_REVALIDATE = 'public, max-age=0, must-revalidate';
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

export function loadPublicSnapshot(db) {
  const rows = db.prepare(`
    SELECT
      a.id AS article_id, a.slug, a.content_kind, a.public_state AS state,
      r.id AS revision_id, r.title,
      r.publication_at, r.lead, r.body_markdown, r.legacy_eyebrow,
      r.legacy_meta_description, r.legacy_listing_excerpt, r.cover_alt, r.source_url,
      s.id AS asset_id, s.private_path, s.sha256 AS asset_sha256, s.media_type,
      w.issue_id AS weekly_issue_id
    FROM articles a
    JOIN article_revisions r ON r.id = a.published_revision_id
    JOIN assets s ON s.id = r.cover_asset_id
    LEFT JOIN weekly_ingestion_issues w ON w.article_id = a.id
    WHERE a.public_state IN ('published', 'withdrawn')
    ORDER BY r.publication_at DESC, a.id DESC
  `).all();
  return hydratePublicRows(db, rows);
}

export function loadRevisionSnapshot(db, articleId, revisionId, state) {
  if (!['published', 'withdrawn'].includes(state)) throw new TypeError('A public state is required');
  const row = db.prepare(`
    SELECT
      a.id AS article_id, a.slug, a.content_kind, ? AS state, r.id AS revision_id, r.title,
      r.publication_at, r.lead, r.body_markdown, r.legacy_eyebrow,
      r.legacy_meta_description, r.legacy_listing_excerpt, r.cover_alt, r.source_url,
      s.id AS asset_id, s.private_path, s.sha256 AS asset_sha256, s.media_type,
      w.issue_id AS weekly_issue_id
    FROM articles a
    JOIN article_revisions r ON r.article_id = a.id AND r.id = ?
    JOIN assets s ON s.id = r.cover_asset_id
    LEFT JOIN weekly_ingestion_issues w ON w.article_id = a.id
    WHERE a.id = ?
  `).get(state, revisionId, articleId);
  if (!row) throw new Error('Revision not found for article');
  return hydratePublicRows(db, [row])[0];
}

export function loadPreviewSnapshot(db, revisionId) {
  const revision = db.prepare(
    'SELECT article_id FROM article_revisions WHERE id = ?',
  ).get(revisionId);
  if (!revision) throw new Error('Revision not found');
  return loadRevisionSnapshot(db, Number(revision.article_id), revisionId, 'published');
}

export function renderRelease({
  db,
  snapshot = null,
  socialLinks = null,
  outputDirectory,
  publicOrigin,
  releaseId,
  generatedAt = new Date().toISOString(),
  transition = null,
}) {
  const origin = normalizeOrigin(publicOrigin);
  if (!releaseId || !/^[a-zA-Z0-9._-]+$/.test(releaseId)) throw new TypeError('A safe releaseId is required');
  const sourceArticles = snapshot ?? loadPublicSnapshot(db);
  const releaseSocialLinks = validateSocialLinks(
    socialLinks ?? sourceArticles[0]?.social_links ?? loadSocialLinks(db),
  );
  const articles = sourceArticles
    .map((article) => ({ ...article, social_links: releaseSocialLinks }))
    .sort((left, right) => right.publication_at.localeCompare(left.publication_at)
      || Number(right.article_id) - Number(left.article_id));
  const publicArticles = articles.filter((article) => article.state === 'published');
  const withdrawn = articles.filter((article) => article.state === 'withdrawn');
  const articleRoot = resolve(outputDirectory, 'articles');
  mkdirSync(articleRoot, { recursive: true });

  const assets = new Map();
  for (const article of articles) {
    if (isWeeklyDigest(article)) assertWeeklyPublicArticle(article);
    const actualHash = hashFile(article.private_path);
    if (actualHash !== article.asset_sha256) throw new Error(`Private asset hash mismatch for article ${article.slug}`);
    const extension = mediaExtension(article.media_type);
    const filename = `${actualHash.slice(0, 24)}${extension}`;
    const destination = resolve(articleRoot, 'assets', filename);
    mkdirSync(dirname(destination), { recursive: true });
    if (!assets.has(filename)) {
      copyFileSync(article.private_path, destination);
      chmodSync(destination, 0o640);
    }
    assets.set(filename, { sha256: actualHash, sourceAssetId: article.asset_id });
    article.cover_filename = filename;
  }

  const listing = interpolate(readTemplate('index.html'), {
    canonical: escapeHtml(`${origin}/articles/`),
    cards: publicArticles.length > 0
      ? publicArticles.map(renderCard).join('\n')
      : '        <p>Новые материалы готовятся к публикации.</p>',
  });
  writeText(resolve(articleRoot, 'index.html'), listing);

  for (const article of publicArticles) {
    writeText(resolve(articleRoot, article.slug, 'index.html'), renderDetailDocument(article, origin));
  }

  for (const article of withdrawn) {
    writeText(resolve(articleRoot, article.slug, 'index.html'), interpolate(readTemplate('gone.html'), {
      canonical: escapeHtml(`${origin}/articles/${article.slug}/`),
    }));
    writeText(resolve(outputDirectory, 'withdrawn', article.slug), '410');
  }

  const latest = publicArticles[0] ? latestPayload(publicArticles[0], origin) : null;
  writeJson(resolve(articleRoot, 'latest.json'), latest);
  const manifest = buildManifest(outputDirectory, {
    releaseId,
    generatedAt,
    transition,
    socialLinks: releaseSocialLinks,
    articles: articles.map((article) => ({
      articleId: article.article_id,
      revisionId: article.revision_id,
      slug: article.slug,
      state: article.state,
    })),
    assets: Object.fromEntries([...assets.entries()].sort(([left], [right]) => left.localeCompare(right))),
  });
  writeJson(resolve(outputDirectory, 'manifest.json'), manifest);
  return manifest;
}

export function renderDetailDocument(article, origin, {
  robots = 'index,follow',
  coverPath,
  stylePath = '../../style.css',
  logoPath = '../../img/logo-oknotika.svg',
  homePath = '../../#top',
  sitePath = '../../',
  aluminumPath = '../../aluminum/',
  articleIndexPath = '../',
  contactsPath = '../../#contacts',
  scriptTag = '<script src="../../script.js"></script>',
} = {}) {
  const canonical = `${origin}/articles/${article.slug}/`;
  const publicCoverPath = coverPath ?? `../assets/${article.cover_filename}`;
  const absoluteCover = new URL(publicCoverPath, canonical).href;
  const weekly = isWeeklyDigest(article);
  const sourceUrls = article.source_urls
    ?? (article.source_url ? [article.source_url] : []);
  const sources = weekly
    ? renderSourceList(sourceUrls)
    : renderLegacySource(article.source_url);
  const socialCta = weekly ? renderSocialCta(article.social_links) : '';
  const renderedBody = renderMarkdown(article.body_markdown).trim();
  const body = weekly
    ? `        <div class="article-digest">
${indent(renderedBody, 10)}
        </div>`
    : indent(renderedBody, 8);
  return interpolate(readTemplate('detail.html'), {
    title: escapeHtml(article.title),
    description: escapeAttribute(article.legacy_meta_description ?? article.lead),
    robots: escapeAttribute(robots),
    canonical: escapeAttribute(canonical),
    ogImage: escapeAttribute(absoluteCover),
    publicationAt: escapeAttribute(article.publication_at),
    coverPath: escapeAttribute(publicCoverPath),
    stylePath: escapeAttribute(stylePath),
    logoPath: escapeAttribute(logoPath),
    homePath: escapeAttribute(homePath),
    sitePath: escapeAttribute(sitePath),
    aluminumPath: escapeAttribute(aluminumPath),
    articleIndexPath: escapeAttribute(articleIndexPath),
    contactsPath: escapeAttribute(contactsPath),
    scriptTag,
    materialEyebrow: escapeHtml(
      article.legacy_eyebrow
        ?? `Дайджест недели · ${formatMoscowDate(article.publication_at)}`,
    ),
    lead: escapeHtml(article.lead),
    body,
    afterBody: [sources, socialCta].filter(Boolean).join('\n'),
  });
}

export function validateRelease(outputDirectory) {
  const manifestPath = resolve(outputDirectory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const actualPaths = listFiles(outputDirectory)
    .map((path) => relative(outputDirectory, path))
    .filter((path) => path !== 'manifest.json')
    .sort();
  const expectedPaths = Object.keys(manifest.files).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('Release manifest file list does not match the release tree');
  }
  for (const [path, metadata] of Object.entries(manifest.files)) {
    const actual = hashFile(resolve(outputDirectory, path));
    if (actual !== metadata.sha256) throw new Error(`Release hash mismatch: ${path}`);
    const expectedCache = path.startsWith('articles/assets/') ? CACHE_IMMUTABLE : CACHE_REVALIDATE;
    if (metadata.cacheControl !== expectedCache) throw new Error(`Invalid cache policy: ${path}`);
  }
  const latest = JSON.parse(readFileSync(resolve(outputDirectory, 'articles/latest.json'), 'utf8'));
  if (latest !== null && !isValidLatestPayload(latest, manifest.schemaVersion)) {
    throw new Error('latest.json contract is invalid');
  }
  for (const article of manifest.articles) {
    if (typeof article.slug !== 'string'
      || article.slug.length > MAX_SLUG_LENGTH
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) {
      throw new Error('Release manifest contains an invalid article slug');
    }
  }
  if (manifest.schemaVersion >= 3) validateSocialLinks(manifest.socialLinks);
  return manifest;
}

function isValidLatestPayload(latest, schemaVersion) {
  const expectedCategory = schemaVersion >= 3 ? 'Новости' : 'Факт недели';
  return latest.category === expectedCategory
    && typeof latest.title === 'string'
    && latest.title.length > 0
    && latest.title.length <= ARTICLE_TEXT_LIMITS.title
    && typeof latest.lead === 'string'
    && latest.lead.length > 0
    && latest.lead.length <= ARTICLE_TEXT_LIMITS.lead
    && typeof latest.url === 'string'
    && latest.url.startsWith('https://');
}

function renderCard(article) {
  return `        <article class="article-card reveal" data-article-slug="${escapeAttribute(article.slug)}">
          <p class="eyebrow">${escapeHtml(article.legacy_eyebrow ?? `Дайджест недели · ${formatMoscowDate(article.publication_at)}`)}</p>
          <h2>${escapeHtml(article.title)}</h2>
          <p>${escapeHtml(article.legacy_listing_excerpt ?? article.lead)}</p>
          <a class="text-link" href="${escapeAttribute(article.slug)}/">Читать →</a>
        </article>`;
}

function latestPayload(article, origin) {
  return {
    category: 'Новости',
    title: article.title,
    lead: article.lead,
    url: `${origin}/articles/${article.slug}/`,
    publicationAt: article.publication_at,
    displayDate: formatMoscowDate(article.publication_at),
    cover: `${origin}/articles/assets/${article.cover_filename}`,
    coverAlt: article.cover_alt,
  };
}

function hydratePublicRows(db, rows) {
  const sourceQuery = db.prepare(`
    SELECT url FROM article_revision_sources
    WHERE revision_id = ? ORDER BY position
  `);
  const socialLinks = loadSocialLinks(db);
  return rows.map((row) => {
    const sourceUrls = sourceQuery.all(row.revision_id).map((source) => source.url);
    return {
      ...row,
      source_urls: sourceUrls.length > 0
        ? sourceUrls
        : (row.source_url ? [row.source_url] : []),
      social_links: socialLinks,
    };
  });
}

export function loadSocialLinks(db) {
  const social = db.prepare(`
    SELECT telegram_url, youtube_url, vk_url
    FROM site_social_links WHERE singleton = 1
  `).get();
  return validateSocialLinks({
    telegramUrl: social.telegram_url,
    youtubeUrl: social.youtube_url,
    vkUrl: social.vk_url,
  });
}

function isWeeklyDigest(article) {
  return article.content_kind === 'weekly_digest';
}

function assertWeeklyPublicArticle(article) {
  validateWeeklyArticleInput({
    title: article.title,
    publicationDate: article.publication_at,
    lead: article.lead,
    bodyMarkdown: article.body_markdown,
    coverAssetId: Number(article.asset_id),
    coverAlt: article.cover_alt,
    sourceUrls: article.source_urls,
  });
}

function renderLegacySource(sourceUrl) {
  return sourceUrl
    ? `        <p><a class="text-link" href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noreferrer noopener">Источник: ${escapeHtml(sourceLabel(sourceUrl))} →</a></p>`
    : '';
}

function renderSourceList(sourceUrls) {
  if (sourceUrls.length === 0) return '';
  const items = sourceUrls.map((url) => `            <li><a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(sourceLabel(url))} →</a></li>`).join('\n');
  return `        <section class="article-sources" aria-labelledby="article-sources-title">
          <p class="eyebrow">Проверено редакцией</p>
          <h2 id="article-sources-title">Источники</h2>
          <ol>
${items}
          </ol>
        </section>`;
}

function renderSocialCta(value) {
  if (!value) return '';
  const links = validateSocialLinks(value);
  const destinations = [
    ['Telegram', links.telegramUrl],
    ['YouTube', links.youtubeUrl],
    ['VK', links.vkUrl],
  ].filter((destination) => destination[1] !== null);
  const items = destinations.map(([name, url]) => `            <li><a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer noopener">${name}</a></li>`).join('\n');
  return `        <section class="article-social" aria-labelledby="article-social-title">
          <p class="eyebrow">Полная версия</p>
          <h2 id="article-social-title">Слушайте и смотрите выпуск</h2>
          <p>Полный озвученный дайджест доступен на площадках ОКНОТИКИ.</p>
          <ul class="article-social__links">
${items}
          </ul>
        </section>`;
}

function buildManifest(outputDirectory, base) {
  const files = {};
  for (const absolutePath of listFiles(outputDirectory).sort()) {
    const path = relative(outputDirectory, absolutePath);
    files[path] = {
      sha256: hashFile(absolutePath),
      bytes: statSync(absolutePath).size,
      cacheControl: path.startsWith('articles/assets/') ? CACHE_IMMUTABLE : CACHE_REVALIDATE,
    };
  }
  return {
    schemaVersion: 3,
    ...base,
    files,
  };
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release contains a symbolic link: ${path}`);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Release contains an unsupported filesystem entry: ${path}`);
  }
  return files;
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
    throw new TypeError('publicOrigin must be an HTTPS origin without a path or credentials');
  }
  return url.origin;
}

function mediaExtension(mediaType) {
  return ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' })[mediaType];
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readTemplate(name) {
  return readFileSync(resolve(TEMPLATE_ROOT, name), 'utf8');
}

function interpolate(template, values) {
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`Missing template value: ${key}`);
    return values[key];
  });
}

function sourceLabel(value) {
  const hostname = new URL(value).hostname.replace(/^www\./, '');
  if (hostname === 'archdaily.com') return 'ArchDaily';
  return hostname;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const escapeAttribute = escapeHtml;

function indent(value, spaces) {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function writeText(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents.endsWith('\n') ? contents : `${contents}\n`, { encoding: 'utf8', mode: 0o644 });
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}
