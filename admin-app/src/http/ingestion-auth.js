import { createHash, timingSafeEqual } from 'node:crypto';

export const WEEKLY_INGESTION_PATH = '/api/ingestion/weekly-drafts';

export function createIngestionAuthenticator(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new TypeError('Weekly ingestion token must contain at least 32 bytes');
  }
  const expected = digest(secret);
  return Object.freeze({
    authenticate(authorization) {
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
      const candidate = authorization.slice('Bearer '.length);
      if (candidate === '' || /[\s,]/.test(candidate)
          || [...candidate].some((character) => {
            const code = character.codePointAt(0);
            return code <= 31 || code === 127;
          })) return false;
      return timingSafeEqual(digest(candidate), expected);
    },
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}
