import { createHash, timingSafeEqual } from 'node:crypto';

export const WEEKLY_INGESTION_PATH = '/api/ingestion/weekly-drafts';
const BEARER_TOKEN = /^[\x21-\x2B\x2D-\x7E]+$/;

export function assertWeeklyIngestionToken(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new TypeError('Weekly ingestion token must contain at least 32 bytes');
  }
  if (!BEARER_TOKEN.test(secret)) {
    throw new TypeError('Weekly ingestion token must use printable ASCII without commas');
  }
  return secret;
}

export function createIngestionAuthenticator(secret) {
  assertWeeklyIngestionToken(secret);
  const expected = digest(secret);
  return Object.freeze({
    authenticate(authorization) {
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
      const candidate = authorization.slice('Bearer '.length);
      if (!BEARER_TOKEN.test(candidate)) return false;
      return timingSafeEqual(digest(candidate), expected);
    },
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}
