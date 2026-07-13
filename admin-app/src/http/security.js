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

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
