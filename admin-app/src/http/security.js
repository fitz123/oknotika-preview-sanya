export function assertMutationRequest(request, {
  adminOrigin,
  session,
  sessionService,
}) {
  const method = request.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
  if (request.headers.get('origin') !== adminOrigin) throw httpError(403, 'Origin check failed');
  if (request.headers.get('sec-fetch-site') !== 'same-origin') throw httpError(403, 'Fetch Metadata check failed');
  const mode = request.headers.get('sec-fetch-mode');
  if (!['same-origin', 'cors', 'navigate'].includes(mode)) throw httpError(403, 'Fetch mode is not allowed');
  if (!sessionService.verifyCsrf(session, request.headers.get('x-csrf-token'))) {
    throw httpError(403, 'CSRF token is invalid');
  }
}

export function assertSameOriginNavigation(request, adminOrigin) {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== adminOrigin) throw httpError(403, 'Origin check failed');
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && !['same-origin', 'none'].includes(site)) throw httpError(403, 'Fetch Metadata check failed');
}

export function assertTrustedProxyHeaders(headers, adminOrigin) {
  const canonical = new URL(adminOrigin);
  const expected = {
    host: canonical.host,
    'x-forwarded-host': canonical.host,
    'x-forwarded-proto': 'https',
  };
  for (const [name, value] of Object.entries(expected)) {
    const actual = readHeader(headers, name);
    if (actual !== value || actual.includes(',')) {
      throw httpError(400, `Trusted proxy header ${name} does not match the canonical admin origin`);
    }
  }
  const forwardedFor = readHeader(headers, 'x-forwarded-for');
  if (!forwardedFor || forwardedFor.includes(',')) {
    throw httpError(400, 'Trusted proxy must replace X-Forwarded-For with one client address');
  }
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readHeader(headers, name) {
  const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  if (Array.isArray(value) || typeof value !== 'string') return '';
  return value.trim();
}
