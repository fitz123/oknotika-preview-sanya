const REQUIRED_TEXT = ['title', 'lead', 'bodyMarkdown', 'coverAlt'];
const RAW_HTML = /<\/?[a-z][^>]*>/i;

export function normalizePublicationDate(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('publicationDate is required');
  }
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
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

export function validateArticleInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('article input is required');
  const normalized = {};
  for (const field of REQUIRED_TEXT) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new TypeError(`${field} is required`);
    }
    normalized[field] = input[field].trim();
  }
  if (RAW_HTML.test(normalized.bodyMarkdown)) {
    throw new TypeError('raw HTML is not allowed in Markdown');
  }
  if (!Number.isInteger(input.coverAssetId) || input.coverAssetId < 1) {
    throw new TypeError('coverAssetId is required');
  }
  return {
    ...normalized,
    coverAssetId: input.coverAssetId,
    publicationAt: normalizePublicationDate(input.publicationDate),
    sourceUrl: validateSourceUrl(input.sourceUrl),
  };
}
