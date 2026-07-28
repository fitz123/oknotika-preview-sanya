import { assertWeeklyDigestMarkdown } from './markdown.js';

const REQUIRED_TEXT = ['title', 'lead', 'bodyMarkdown', 'coverAlt'];
const RAW_HTML = /<\/?[a-z][^>]*>/i;
const WEEKLY_ARTICLE_FIELDS = new Set([
  'title',
  'publicationDate',
  'lead',
  'bodyMarkdown',
  'coverAssetId',
  'coverAlt',
  'sourceUrls',
]);
const SOCIAL_FIELDS = new Set(['telegramUrl', 'youtubeUrl', 'vkUrl', 'futuchatUrl']);
export const FIXED_TELEGRAM_URL = 'https://t.me/oknotika';
const SOCIAL_HOSTS = Object.freeze({
  telegramUrl: new Set(['t.me']),
  youtubeUrl: new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']),
  vkUrl: new Set(['vk.ru', 'www.vk.ru', 'vk.com', 'www.vk.com']),
  futuchatUrl: new Set(['t.me']),
});
const WEEKLY_TEXT_LIMITS = Object.freeze({ bodyMarkdown: 100_000, coverAlt: 500 });
export const ARTICLE_TEXT_LIMITS = Object.freeze({ title: 240, lead: 1200 });
export const WEEKLY_INGESTION_BODY_MAXIMUM = 128 * 1024;

export function normalizePublicationDate(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('publicationDate is required');
  }
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
      throw new TypeError('publicationDate must be a valid calendar date');
    }
  }
  const date = dateOnly
    ? new Date(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00+03:00`)
    : new Date(trimmed);
  if (Number.isNaN(date.valueOf())) throw new TypeError('publicationDate must be a valid date');
  return date.toISOString();
}

export function formatMoscowDate(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value));
}

export function validateSourceUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('sourceUrl must be a string');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('sourceUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new TypeError('sourceUrl must use https:');
  if (parsed.username || parsed.password) throw new TypeError('sourceUrl must not contain credentials');
  return parsed.href;
}

export function validateSourceUrls(value, fallbackSourceUrl = undefined) {
  if (value === undefined) {
    const fallback = validateSourceUrl(fallbackSourceUrl);
    return fallback ? [fallback] : [];
  }
  if (!Array.isArray(value)) throw new TypeError('sourceUrls must be an array');
  if (value.length > 20) throw new TypeError('sourceUrls must not contain more than 20 URLs');
  const normalized = value.map((url, index) => {
    if (typeof url === 'string' && url.length > 2048) {
      throw new TypeError(`sourceUrls[${index}]: sourceUrl must not exceed 2048 characters`);
    }
    try {
      return validateSourceUrl(url);
    } catch (error) {
      throw new TypeError(`sourceUrls[${index}]: ${error.message}`);
    }
  });
  if (normalized.some((url) => url === null)) {
    throw new TypeError('sourceUrls must not contain empty URLs');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError('sourceUrls must not contain duplicate URLs');
  }
  return normalized;
}

export function validateSocialLinks(input) {
  assertObject(input, 'social links');
  assertKnownFields(input, SOCIAL_FIELDS, 'social links');
  return {
    telegramUrl: validatePlatformUrl(input.telegramUrl, 'telegramUrl', { required: true }),
    youtubeUrl: validatePlatformUrl(input.youtubeUrl, 'youtubeUrl'),
    vkUrl: validatePlatformUrl(input.vkUrl, 'vkUrl'),
    futuchatUrl: validatePlatformUrl(input.futuchatUrl, 'futuchatUrl'),
  };
}

export function validateArticleInput(input) {
  assertObject(input, 'article input');
  const normalized = {};
  for (const field of REQUIRED_TEXT) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new TypeError(`${field} is required`);
    }
    normalized[field] = input[field].trim();
    const maximum = ARTICLE_TEXT_LIMITS[field];
    if (maximum && normalized[field].length > maximum) {
      throw new TypeError(`${field} must not exceed ${maximum} characters`);
    }
  }
  if (RAW_HTML.test(normalized.bodyMarkdown)) {
    throw new TypeError('raw HTML is not allowed in Markdown');
  }
  if (!Number.isInteger(input.coverAssetId) || input.coverAssetId < 1) {
    throw new TypeError('coverAssetId is required');
  }
  const sourceUrls = validateSourceUrls(input.sourceUrls, input.sourceUrl);
  return {
    ...normalized,
    coverAssetId: input.coverAssetId,
    publicationAt: normalizePublicationDate(input.publicationDate),
    sourceUrl: sourceUrls[0] ?? null,
    sourceUrls,
  };
}

export function validateWeeklyArticleInput(input) {
  const article = validateArticleInput(input);
  for (const [field, maximum] of Object.entries(WEEKLY_TEXT_LIMITS)) {
    if (article[field].length > maximum) {
      throw new TypeError(`${field} must not exceed ${maximum} characters`);
    }
  }
  if (article.sourceUrls.length === 0) {
    throw new TypeError('sourceUrls must contain at least one verified source URL');
  }
  assertWeeklyDigestMarkdown(article.bodyMarkdown);
  return article;
}

export function validateWeeklyIngestionInput(input) {
  assertObject(input, 'weekly ingestion payload');
  assertKnownFields(input, new Set(['issueId', 'contentVersion', 'article']), 'weekly ingestion payload');
  const issue = typeof input.issueId === 'string'
    ? /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/.exec(input.issueId)
    : null;
  if (!issue || Number(issue[2]) > isoWeeksInYear(Number(issue[1]))) {
    throw new TypeError('issueId must identify a valid ISO week using YYYY-Www');
  }
  if (!Number.isSafeInteger(input.contentVersion) || input.contentVersion < 1) {
    throw new TypeError('contentVersion must be a positive safe integer');
  }
  assertObject(input.article, 'article');
  assertKnownFields(input.article, WEEKLY_ARTICLE_FIELDS, 'article');
  const article = validateWeeklyArticleInput(input.article);
  return {
    issueId: input.issueId,
    contentVersion: input.contentVersion,
    article,
  };
}

function isoWeeksInYear(year) {
  const januaryFirst = new Date(0);
  januaryFirst.setUTCHours(0, 0, 0, 0);
  januaryFirst.setUTCFullYear(year, 0, 1);
  const weekday = januaryFirst.getUTCDay();
  return weekday === 4 || (weekday === 3 && isLeapYear(year)) ? 53 : 52;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validatePlatformUrl(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new TypeError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  if (value.length > 2048) throw new TypeError(`${field} must not exceed 2048 characters`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new TypeError(`${field} must be an HTTPS URL without credentials`);
  }
  if (!SOCIAL_HOSTS[field].has(parsed.hostname.toLowerCase())) {
    throw new TypeError(`${field} must use an approved ${field.replace('Url', '')} host`);
  }
  if (field === 'telegramUrl' && parsed.href !== FIXED_TELEGRAM_URL) {
    throw new TypeError(`telegramUrl must be exactly ${FIXED_TELEGRAM_URL}`);
  }
  if (field === 'futuchatUrl'
      && (!/^\/[A-Za-z0-9_]{5,32}$/.test(parsed.pathname) || parsed.search || parsed.hash)) {
    throw new TypeError('futuchatUrl must identify one Telegram channel path without query or fragment');
  }
  return parsed.href;
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} is required`);
  }
}

function assertKnownFields(value, allowed, name) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new TypeError(`${name} contains unsupported field: ${unknown[0]}`);
}
