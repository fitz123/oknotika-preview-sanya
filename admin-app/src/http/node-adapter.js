import { assertMutationRequest } from './security.js';

const JSON_BODY_MAXIMUM = 1024 * 1024;
const UPLOAD_BODY_MAXIMUM = 10 * 1024 * 1024;
const JSON_MUTATION_PATHS = [
  /^\/api\/articles$/,
  /^\/api\/articles\/\d+\/revisions$/,
  /^\/api\/articles\/\d+\/(?:publish|withdraw|restore)$/,
  /^\/api\/releases\/rollback$/,
];

export async function createProxiedRequest(incoming, { adminOrigin, sessionService }) {
  const method = String(incoming.method ?? 'GET').toUpperCase();
  const target = new URL(incoming.url ?? '/', adminOrigin);
  const init = { method, headers: incoming.headers };
  const headerOnlyRequest = new Request(target, init);
  if (['GET', 'HEAD'].includes(method)) return headerOnlyRequest;

  const session = sessionService.authenticate(headerOnlyRequest.headers.get('cookie'));
  if (!session || !hasValidMutationHeaders(headerOnlyRequest, adminOrigin, session, sessionService)) {
    discardBody(incoming);
    return headerOnlyRequest;
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
  if (request.method === 'POST' && url.pathname === '/api/uploads') return UPLOAD_BODY_MAXIMUM;
  if (request.method === 'POST'
      && request.headers.get('content-type')?.toLowerCase().startsWith('application/json')
      && JSON_MUTATION_PATHS.some((pattern) => pattern.test(url.pathname))) {
    return JSON_BODY_MAXIMUM;
  }
  return 0;
}

export async function readRequestBody(request, maximum) {
  const declaredValue = request.headers['content-length'];
  const declared = declaredValue === undefined ? 0 : Number(declaredValue);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximum) throw requestTooLarge();
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
