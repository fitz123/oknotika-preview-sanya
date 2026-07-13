import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export function loadConfiguration(env = process.env) {
  const adminOrigin = exactHttpsOrigin(requireValue(env, 'OKNOTIKA_ADMIN_ORIGIN'), 'OKNOTIKA_ADMIN_ORIGIN');
  const publicOrigin = exactHttpsOrigin(requireValue(env, 'OKNOTIKA_PUBLIC_ORIGIN'), 'OKNOTIKA_PUBLIC_ORIGIN');
  const redirectUri = requireValue(env, 'TELEGRAM_OIDC_REDIRECT_URI');
  const expectedRedirect = `${adminOrigin}/auth/callback`;
  if (redirectUri !== expectedRedirect) {
    throw new Error(`TELEGRAM_OIDC_REDIRECT_URI must exactly equal ${expectedRedirect}`);
  }
  const signingAlgorithm = env.TELEGRAM_OIDC_SIGNING_ALG ?? 'RS256';
  if (signingAlgorithm !== 'RS256') throw new Error('TELEGRAM_OIDC_SIGNING_ALG must be pinned to RS256');
  const databasePath = resolve(requireValue(env, 'OKNOTIKA_DATABASE_PATH'));
  const uploadsRoot = resolve(requireValue(env, 'OKNOTIKA_UPLOADS_ROOT'));
  const previewsRoot = resolve(requireValue(env, 'OKNOTIKA_PREVIEWS_ROOT'));
  const releasesRoot = resolve(requireValue(env, 'OKNOTIKA_ARTICLE_RELEASES_ROOT'));
  const publicRoot = resolve(requireValue(env, 'OKNOTIKA_PUBLIC_ROOT'));
  for (const [name, path] of [
    ['OKNOTIKA_DATABASE_PATH', databasePath],
    ['OKNOTIKA_UPLOADS_ROOT', uploadsRoot],
    ['OKNOTIKA_PREVIEWS_ROOT', previewsRoot],
  ]) assertOutside(path, publicRoot, name);
  return Object.freeze({
    adminOrigin,
    publicOrigin,
    redirectUri,
    clientId: requireSecret(env, 'TELEGRAM_OIDC_CLIENT_ID'),
    clientSecret: requireSecret(env, 'TELEGRAM_OIDC_CLIENT_SECRET'),
    signingAlgorithm,
    databasePath,
    uploadsRoot,
    previewsRoot,
    releasesRoot,
    publicRoot,
    listenSocket: resolve(env.OKNOTIKA_LISTEN_SOCKET ?? '/run/oknotika-admin/app.sock'),
  });
}

export function assertRuntimeSeparation(config) {
  const publicRoot = realpathSync(config.publicRoot);
  for (const [name, path] of [
    ['OKNOTIKA_DATABASE_PATH', dirname(config.databasePath)],
    ['OKNOTIKA_UPLOADS_ROOT', config.uploadsRoot],
    ['OKNOTIKA_PREVIEWS_ROOT', config.previewsRoot],
  ]) assertOutside(realpathSync(path), publicRoot, name);
}

function assertOutside(path, publicRoot, name) {
  const pathFromPublic = relative(publicRoot, path);
  const publicFromPath = relative(path, publicRoot);
  const inside = (value) => value === '' || (!value.startsWith('..') && !value.startsWith('/'));
  if (inside(pathFromPublic) || inside(publicFromPath)) {
    throw new Error(`${name} must be outside the public document root`);
  }
}

function exactHttpsOrigin(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an exact HTTPS origin without path, credentials, query or fragment`);
  }
  return parsed.origin;
}

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function requireSecret(env, name) {
  const direct = env[name];
  const filename = env[`${name}_FILE`];
  if (direct && filename) throw new Error(`${name} and ${name}_FILE are mutually exclusive`);
  if (filename) {
    let value;
    try {
      value = readFileSync(filename, 'utf8').trim();
    } catch {
      throw new Error(`${name}_FILE must point to a readable systemd credential`);
    }
    if (!value) throw new Error(`${name}_FILE contains an empty credential`);
    return value;
  }
  return requireValue(env, name);
}
