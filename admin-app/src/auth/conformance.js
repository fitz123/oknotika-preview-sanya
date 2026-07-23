const OFFICIAL_ISSUER = 'https://oauth.telegram.org';
const OFFICIAL_ENDPOINTS = Object.freeze({
  authorization_endpoint: `${OFFICIAL_ISSUER}/auth`,
  token_endpoint: `${OFFICIAL_ISSUER}/token`,
  jwks_uri: `${OFFICIAL_ISSUER}/.well-known/jwks.json`,
});

export const TELEGRAM_DISCOVERY_URL = `${OFFICIAL_ISSUER}/.well-known/openid-configuration`;
export const TELEGRAM_ISSUER = OFFICIAL_ISSUER;

export function assertTelegramConformance(metadata, {
  signingAlgorithm = 'RS256',
  tokenEndpointAuthMethod = 'client_secret_basic',
} = {}) {
  if (!metadata || typeof metadata !== 'object') throw new TypeError('OIDC discovery metadata is required');
  if (metadata.issuer !== OFFICIAL_ISSUER) throw new Error('Telegram issuer does not match the pinned issuer');
  for (const [field, expected] of Object.entries(OFFICIAL_ENDPOINTS)) {
    if (metadata[field] !== expected) throw new Error(`Telegram ${field} does not match the pinned endpoint`);
  }
  requireSupported(metadata.response_types_supported, 'code', 'response type');
  requireSupported(metadata.grant_types_supported, 'authorization_code', 'grant type');
  requireSupported(metadata.code_challenge_methods_supported, 'S256', 'PKCE method');
  requireSupported(metadata.token_endpoint_auth_methods_supported, tokenEndpointAuthMethod, 'token auth method');
  requireSupported(metadata.id_token_signing_alg_values_supported, signingAlgorithm, 'signing algorithm');
  requireSupported(metadata.scopes_supported, 'openid', 'scope');
  return Object.freeze({ ...metadata });
}

export async function fetchTelegramDiscovery({
  fetchImpl = fetch,
  timeoutMs = 5_000,
  signingAlgorithm = 'RS256',
} = {}) {
  const response = await fetchImpl(TELEGRAM_DISCOVERY_URL, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Telegram discovery failed with HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error('Telegram discovery response is too large');
  return assertTelegramConformance(JSON.parse(text), { signingAlgorithm });
}

function requireSupported(values, expected, label) {
  if (!Array.isArray(values) || !values.includes(expected)) {
    throw new Error(`Telegram discovery does not support required ${label}: ${expected}`);
  }
}
