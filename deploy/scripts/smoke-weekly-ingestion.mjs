#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INGESTION_PATH = '/api/ingestion/weekly-drafts';
const MAXIMUM_PAYLOAD_BYTES = 128 * 1024;
const SAFE_RESULT_FIELDS = ['articleId', 'revisionId', 'slug', 'issueId', 'contentVersion'];
const RESULT_FIELDS = new Set([...SAFE_RESULT_FIELDS, 'created', 'idempotent']);

export async function runWeeklyIngestionSmoke({
  adminUrl,
  payloadFile,
  tokenFile,
  fetchImpl = fetch,
}) {
  const origin = exactHttpsOrigin(adminUrl);
  const credentialPath = tokenFile ?? credentialPathFromEnvironment();
  const token = (await readFile(credentialPath, 'utf8')).trim();
  if (Buffer.byteLength(token) < 32 || /\s/.test(token)) {
    throw new Error('weekly-ingest-token credential is malformed');
  }

  const payloadBytes = await readFile(payloadFile);
  if (payloadBytes.length === 0 || payloadBytes.length > MAXIMUM_PAYLOAD_BYTES) {
    throw new Error('weekly ingestion smoke payload must contain 1-131072 bytes');
  }
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new Error('weekly ingestion smoke payload is not valid JSON');
  }

  const first = await ingest(fetchImpl, origin, token, payload);
  if (![200, 201].includes(first.status)) {
    throw new Error(`initial weekly ingestion returned HTTP ${first.status}`);
  }
  assertSafeDraftResult(first.body, 'initial weekly ingestion');
  if (first.body.issueId !== payload.issueId
      || first.body.contentVersion !== payload.contentVersion) {
    throw new Error('initial weekly ingestion identifiers differ from the submitted payload');
  }
  if (first.status === 201 && (first.body.created !== true || first.body.idempotent !== false)) {
    throw new Error('new weekly ingestion did not report a newly created draft');
  }
  if (first.status === 200
      && (first.body.created !== false || first.body.idempotent !== true)) {
    throw new Error('existing weekly ingestion smoke payload is not an identical retry');
  }

  const retry = await ingest(fetchImpl, origin, token, payload);
  assertSafeDraftResult(retry.body, 'weekly ingestion retry');
  if (retry.status !== 200 || retry.body.idempotent !== true || retry.body.created !== false) {
    throw new Error('weekly ingestion retry is not idempotent');
  }
  for (const field of SAFE_RESULT_FIELDS) {
    if (retry.body[field] !== first.body[field]) {
      throw new Error(`weekly ingestion retry changed ${field}`);
    }
  }

  await assertDenied(fetchImpl, `${origin}/api/articles`, token, { method: 'GET' });
  await assertDenied(fetchImpl, `${origin}/api/releases/rollback`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return Object.freeze({
    status: 'pass',
    initial: first.status === 201 ? 'draft-created' : 'identical-draft-found',
    retry: 'idempotent',
    editorialCapabilities: 'denied',
  });
}

async function ingest(fetchImpl, origin, token, payload) {
  const response = await fetchImpl(`${origin}${INGESTION_PATH}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`weekly ingestion returned non-JSON HTTP ${response.status}`);
  }
  return { status: response.status, body };
}

async function assertDenied(fetchImpl, url, token, init) {
  const headers = {
    authorization: `Bearer ${token}`,
    ...(init.headers ?? {}),
  };
  const response = await fetchImpl(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 401) {
    throw new Error(`weekly ingestion credential reached an editorial capability: HTTP ${response.status}`);
  }
}

function assertSafeDraftResult(body, label) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${label} returned an invalid result`);
  }
  if (!Number.isSafeInteger(body.articleId) || body.articleId < 1) {
    throw new Error(`${label} returned an invalid articleId`);
  }
  if (!Number.isSafeInteger(body.revisionId) || body.revisionId < 1) {
    throw new Error(`${label} returned an invalid revisionId`);
  }
  if (typeof body.slug !== 'string'
      || body.slug.length > 200
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) {
    throw new Error(`${label} returned an invalid slug`);
  }
  if (!validIsoWeek(body.issueId)) {
    throw new Error(`${label} returned an invalid issueId`);
  }
  if (!Number.isSafeInteger(body.contentVersion) || body.contentVersion < 1) {
    throw new Error(`${label} returned an invalid contentVersion`);
  }
  if (typeof body.created !== 'boolean' || typeof body.idempotent !== 'boolean') {
    throw new Error(`${label} returned invalid draft status flags`);
  }
  for (const forbidden of ['releaseId', 'previewUrl', 'publicUrl', 'published']) {
    if (Object.hasOwn(body, forbidden)) {
      throw new Error(`${label} returned forbidden publication data`);
    }
  }
  const unexpected = Object.keys(body).find(field => !RESULT_FIELDS.has(field));
  if (unexpected) throw new Error(`${label} returned unexpected field ${unexpected}`);
}

function validIsoWeek(value) {
  const match = typeof value === 'string'
    ? /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/.exec(value)
    : null;
  if (!match) return false;
  const year = Number(match[1]);
  const januaryFirst = new Date(0);
  januaryFirst.setUTCHours(0, 0, 0, 0);
  januaryFirst.setUTCFullYear(year, 0, 1);
  const weekday = januaryFirst.getUTCDay();
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const weeks = weekday === 4 || (weekday === 3 && leapYear) ? 53 : 52;
  return Number(match[2]) <= weeks;
}

function exactHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('--admin-url must be an exact HTTPS origin');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('--admin-url must be an exact HTTPS origin');
  }
  return parsed.origin;
}

function credentialPathFromEnvironment() {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) {
    throw new Error('use --token-file or run under systemd with CREDENTIALS_DIRECTORY');
  }
  return resolve(directory, 'weekly-ingest-token');
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !['--admin-url', '--payload-file', '--token-file'].includes(flag)) {
      throw new Error(
        'usage: smoke-weekly-ingestion.mjs --admin-url HTTPS_ORIGIN '
        + '--payload-file PRIVATE_JSON [--token-file CREDENTIAL_FILE]',
      );
    }
    values[flag.slice(2).replaceAll('-', '')] = value;
  }
  if (!values.adminurl || !values.payloadfile) {
    throw new Error(
      'usage: smoke-weekly-ingestion.mjs --admin-url HTTPS_ORIGIN '
      + '--payload-file PRIVATE_JSON [--token-file CREDENTIAL_FILE]',
    );
  }
  return {
    adminUrl: values.adminurl,
    payloadFile: resolve(values.payloadfile),
    tokenFile: values.tokenfile ? resolve(values.tokenfile) : undefined,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await runWeeklyIngestionSmoke(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`weekly ingestion smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
