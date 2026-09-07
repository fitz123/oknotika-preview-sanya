import { LOGIN_BODY_MAXIMUM } from '../auth/login.js';
import { WEEKLY_INGESTION_BODY_MAXIMUM } from '../content/validation.js';
import { WEEKLY_INGESTION_PATH } from './ingestion-auth.js';
import { assertLoginRequest, assertMutationRequest } from './security.js';

const JSON_BODY_MAXIMUM = 1024 * 1024;
const UPLOAD_BODY_MAXIMUM = 10 * 1024 * 1024;
const JSON_MUTATION_PATHS = [
  /^\/api\/articles$/,
  /^\/api\/social-links$/,
  /^\/api\/articles\/\d+\/revisions$/,
  /^\/api\/articles\/\d+\/(?:publish|withdraw|restore|delete)$/,
];

export async function createProxiedRequest(incoming, {
  adminOrigin,
  sessionService,
  ingestionAuthenticator,
}) {
  const method = String(incoming.method ?? 'GET').toUpperCase();
  const target = new URL(incoming.url ?? '/', adminOrigin);
  const init = { method, headers: incoming.headers };
  const headerOnlyRequest = new Request(target, init);
  if (['GET', 'HEAD'].includes(method)) return headerOnlyRequest;

  if (method === 'POST' && target.pathname === WEEKLY_INGESTION_PATH) {
    if (!ingestionAuthenticator?.authenticate(headerOnlyRequest.headers.get('authorization'))) {
      discardBody(incoming);
      return headerOnlyRequest;
    }
  } else if (method === 'POST' && target.pathname === '/login') {
    try {
      assertLoginRequest(headerOnlyRequest, adminOrigin);
    } catch {
      discardBody(incoming);
      return headerOnlyRequest;
    }
  } else {
    const session = sessionService.authenticate(headerOnlyRequest.headers.get('cookie'));
    if (!session || !hasValidMutationHeaders(headerOnlyRequest, adminOrigin, session, sessionService)) {
      discardBody(incoming);
      return headerOnlyRequest;
    }
  }

  const maximum = requestBodyMaximum(headerOnlyRequest);
  if (maximum === 0) {
    discardBody(incoming);
    return headerOnlyRequest;
  }
  const body = await readRequestBody(incoming, maximum);
  return new Request(target, { ...init, body });
}

export function requestBodyMaximum(request) {
  const url = new URL(request.url);
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (request.method === 'POST' && url.pathname === '/login'
      && mediaType === 'application/x-www-form-urlencoded') {
    return LOGIN_BODY_MAXIMUM;
  }
  if (request.method === 'POST' && url.pathname === WEEKLY_INGESTION_PATH
      && mediaType === 'application/json') {
    return WEEKLY_INGESTION_BODY_MAXIMUM;
  }
  if (request.method === 'POST' && url.pathname === '/api/uploads') return UPLOAD_BODY_MAXIMUM;
  if (request.method === 'POST'
      && mediaType === 'application/json'
      && JSON_MUTATION_PATHS.some((pattern) => pattern.test(url.pathname))) {
    return JSON_BODY_MAXIMUM;
  }
  return 0;
}

export async function readRequestBody(request, maximum) {
  const declaredValue = request.headers['content-length'];
  const declared = declaredValue === undefined ? 0 : Number(declaredValue);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximum) {
    discardBody(request);
    throw requestTooLarge();
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      length += chunk.length;
      if (length > maximum) throw requestTooLarge();
      chunks.push(chunk);
    }
  } catch (error) {
    discardBody(request);
    throw error;
  }
  return Buffer.concat(chunks, length);
}

function hasValidMutationHeaders(request, adminOrigin, session, sessionService) {
  try {
    assertMutationRequest(request, { adminOrigin, session, sessionService });
    return true;
  } catch {
    return false;
  }
}

function discardBody(request) {
  if (typeof request.resume === 'function') request.resume();
}

function requestTooLarge() {
  const error = new Error('Request too large');
  error.code = 'REQUEST_TOO_LARGE';
  return error;
}
