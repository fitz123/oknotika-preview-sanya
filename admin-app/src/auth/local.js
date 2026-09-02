import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { transaction } from '../content/database.js';

export const LOCAL_AUTH_ISSUER = 'urn:oknotika:local-password:v1';
export const LOCAL_AUTH_FAILURE = 'Неверный логин или пароль';

const SCRYPT_VERSION = 1;
const DEFAULT_SCRYPT_PARAMETERS = Object.freeze({ N: 32768, r: 8, p: 1 });
const MIN_N = 32768;
const MAX_N = 131072;
const MIN_R = 8;
const MAX_R = 16;
const MAX_P = 2;
const MAX_MEMORY_BYTES = 128 * 1024 * 1024;
const DERIVED_KEY_BYTES = 32;
const MIN_SALT_BYTES = 16;
const MAX_SALT_BYTES = 32;
const MAX_PASSWORD_BYTES = 1024;

export function parseLocalUsername(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$/.test(value)) {
    throw new TypeError('Local username must be 3-64 printable ASCII characters');
  }
  return value;
}

export function parseScryptPasswordRecord(value) {
  if (typeof value !== 'string') throw invalidPasswordRecord();
  const match = /^scrypt\$v=(\d+)\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) throw invalidPasswordRecord();
  const [, versionText, nText, rText, pText, saltText, digestText] = match;
  const version = parseCanonicalInteger(versionText);
  const N = parseCanonicalInteger(nText);
  const r = parseCanonicalInteger(rText);
  const p = parseCanonicalInteger(pText);
  if (version !== SCRYPT_VERSION
    || !isPowerOfTwo(N) || N < MIN_N || N > MAX_N
    || r < MIN_R || r > MAX_R
    || p < 1 || p > MAX_P
    || 128 * N * r > MAX_MEMORY_BYTES
    || N * p > MAX_N * MAX_P) {
    throw invalidPasswordRecord();
  }
  const salt = decodeCanonicalBase64Url(saltText);
  const digest = decodeCanonicalBase64Url(digestText);
  if (salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES || digest.length !== DERIVED_KEY_BYTES) {
    throw invalidPasswordRecord();
  }
  return Object.freeze({
    version,
    N,
    r,
    p,
    salt,
    digest,
    serialized: value,
  });
}

export async function hashLocalPassword(password, {
  salt = randomBytes(MIN_SALT_BYTES),
  N = DEFAULT_SCRYPT_PARAMETERS.N,
  r = DEFAULT_SCRYPT_PARAMETERS.r,
  p = DEFAULT_SCRYPT_PARAMETERS.p,
} = {}) {
  if (typeof password !== 'string' || password === '' || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    throw new TypeError('Password must be a non-empty string of at most 1024 bytes');
  }
  const saltBytes = Buffer.from(salt);
  const parameterProbe = `scrypt$v=${SCRYPT_VERSION}$N=${N},r=${r},p=${p}$${saltBytes.toString('base64url')}$${Buffer.alloc(DERIVED_KEY_BYTES).toString('base64url')}`;
  const parsed = parseScryptPasswordRecord(parameterProbe);
  const digest = await deriveKey(password, parsed);
  return `scrypt$v=${SCRYPT_VERSION}$N=${N},r=${r},p=${p}$${saltBytes.toString('base64url')}$${digest.toString('base64url')}`;
}

export function createLocalCredential({ username, passwordHash }) {
  const parsedUsername = parseLocalUsername(username);
  const passwordRecord = parseScryptPasswordRecord(passwordHash);
  const fingerprint = createHash('sha256')
    .update(LOCAL_AUTH_ISSUER)
    .update('\0')
    .update(parsedUsername)
    .update('\0')
    .update(passwordRecord.serialized)
    .digest('hex');
  return Object.freeze({ username: parsedUsername, passwordRecord, fingerprint });
}

export function createLocalAuthenticator(db, credential, {
  clock = () => new Date(),
} = {}) {
  assertCredential(credential);
  const editorId = initializeLocalEditor(db, credential, { clock });

  async function authenticate({ username, password } = {}) {
    const usernameCandidate = boundedString(username, 256);
    const passwordCandidate = boundedString(password, MAX_PASSWORD_BYTES);
    const usernameMatches = safeTextEqual(usernameCandidate, credential.username);
    const derived = await deriveKey(passwordCandidate, credential.passwordRecord);
    const passwordMatches = timingSafeEqual(derived, credential.passwordRecord.digest);
    const editor = db.prepare(`
      SELECT id, issuer, subject, enabled, credential_fingerprint
      FROM configured_editors WHERE id = ?
    `).get(editorId);
    const editorMatches = editor
      && editor.enabled === 1
      && editor.issuer === LOCAL_AUTH_ISSUER
      && safeTextEqual(editor.subject, credential.username)
      && safeTextEqual(editor.credential_fingerprint ?? '', credential.fingerprint);
    if (!(usernameMatches && passwordMatches && editorMatches)) throw authenticationFailure();
    return { editorId };
  }

  return Object.freeze({ authenticate, editorId });
}

export function initializeLocalEditor(db, credential, {
  clock = () => new Date(),
  revocationReason = 'credential-rotated',
} = {}) {
  assertCredential(credential);
  return transaction(db, () => {
    const existing = db.prepare(`
      SELECT id, issuer, subject, enabled, credential_fingerprint
      FROM configured_editors ORDER BY id
    `).all();
    if (existing.length > 1) throw new Error('Local authentication requires exactly one configured editor');
    const timestamp = clock().toISOString();
    if (existing.length === 0) {
      const inserted = db.prepare(`
        INSERT INTO configured_editors
          (issuer, subject, enabled, created_at, credential_fingerprint)
        VALUES (?, ?, 1, ?, ?)
        RETURNING id
      `).get(LOCAL_AUTH_ISSUER, credential.username, timestamp, credential.fingerprint);
      return Number(inserted.id);
    }
    const editor = existing[0];
    if (editor.issuer !== LOCAL_AUTH_ISSUER || editor.subject !== credential.username) {
      throw new Error('Configured editor conflicts with the local credential identity');
    }
    const rotated = editor.credential_fingerprint !== credential.fingerprint;
    db.prepare(`
      UPDATE configured_editors
      SET credential_fingerprint = ?
      WHERE id = ?
    `).run(credential.fingerprint, editor.id);
    if (rotated) {
      db.prepare(`
        UPDATE admin_sessions
        SET revoked_at = ?, revocation_reason = ?
        WHERE editor_id = ? AND revoked_at IS NULL
      `).run(timestamp, revocationReason, editor.id);
    }
    return Number(editor.id);
  });
}

function assertCredential(credential) {
  if (!credential
    || typeof credential.username !== 'string'
    || !credential.passwordRecord
    || !/^[a-f0-9]{64}$/.test(credential.fingerprint ?? '')) {
    throw new TypeError('A parsed local credential is required');
  }
}

function deriveKey(password, record) {
  const memoryCost = 128 * record.N * record.r;
  return new Promise((resolvePromise, reject) => {
    scrypt(password, record.salt, DERIVED_KEY_BYTES, {
      N: record.N,
      r: record.r,
      p: record.p,
      maxmem: memoryCost + 16 * 1024 * 1024,
    }, (error, key) => {
      if (error) reject(error);
      else resolvePromise(key);
    });
  });
}

function boundedString(value, maximumBytes) {
  return typeof value === 'string' && Buffer.byteLength(value) <= maximumBytes ? value : '';
}

function safeTextEqual(left, right) {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function parseCanonicalInteger(value) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function decodeCanonicalBase64Url(value) {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.toString('base64url') !== value) throw invalidPasswordRecord();
  return decoded;
}

function isPowerOfTwo(value) {
  return Number.isSafeInteger(value) && value > 1 && Math.log2(value) % 1 === 0;
}

function invalidPasswordRecord() {
  return new TypeError('Local password hash record is malformed or uses weak parameters');
}

function authenticationFailure() {
  const error = new Error(LOCAL_AUTH_FAILURE);
  error.code = 'INVALID_LOCAL_CREDENTIALS';
  return error;
}
