import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { assertWeeklyIngestionToken } from '../http/ingestion-auth.js';
import { createLocalCredential } from './local.js';

export function loadConfiguration(env = process.env, {
  requireLocalCredential = true,
  requireWeeklyIngestionToken = true,
} = {}) {
  const adminOrigin = exactHttpsOrigin(requireValue(env, 'OKNOTIKA_ADMIN_ORIGIN'), 'OKNOTIKA_ADMIN_ORIGIN');
  const publicOrigin = exactHttpsOrigin(requireValue(env, 'OKNOTIKA_PUBLIC_ORIGIN'), 'OKNOTIKA_PUBLIC_ORIGIN');
  rejectPlaintextPasswordConfiguration(env);
  const usernameFile = requireLocalCredential
    ? requireCredentialFilename(env, 'OKNOTIKA_LOCAL_USERNAME')
    : null;
  const passwordHashFile = requireLocalCredential
    ? requireCredentialFilename(env, 'OKNOTIKA_LOCAL_PASSWORD_HASH')
    : null;
  const localCredential = requireLocalCredential
    ? createLocalCredential({
      username: readCredentialFile(usernameFile, 'OKNOTIKA_LOCAL_USERNAME_FILE'),
      passwordHash: readCredentialFile(passwordHashFile, 'OKNOTIKA_LOCAL_PASSWORD_HASH_FILE'),
    })
    : null;
  const weeklyIngestionToken = requireWeeklyIngestionToken
    ? requireSecret(env, 'OKNOTIKA_WEEKLY_INGEST_TOKEN')
    : null;
  if (weeklyIngestionToken !== null) assertWeeklyIngestionToken(weeklyIngestionToken);
  const databasePath = resolve(requireValue(env, 'OKNOTIKA_DATABASE_PATH'));
  const uploadsRoot = resolve(requireValue(env, 'OKNOTIKA_UPLOADS_ROOT'));
  const previewsRoot = resolve(requireValue(env, 'OKNOTIKA_PREVIEWS_ROOT'));
  const releasesRoot = resolve(requireValue(env, 'OKNOTIKA_ARTICLE_RELEASES_ROOT'));
  const publicRoot = resolve(requireValue(env, 'OKNOTIKA_PUBLIC_ROOT'));
  for (const [name, path] of [
    ['OKNOTIKA_DATABASE_PATH', databasePath],
    ['OKNOTIKA_UPLOADS_ROOT', uploadsRoot],
    ['OKNOTIKA_PREVIEWS_ROOT', previewsRoot],
    ['OKNOTIKA_ARTICLE_RELEASES_ROOT', releasesRoot],
  ]) assertOutside(path, publicRoot, name);
  if (requireLocalCredential) {
    assertOutside(usernameFile, publicRoot, 'OKNOTIKA_LOCAL_USERNAME_FILE');
    assertOutside(passwordHashFile, publicRoot, 'OKNOTIKA_LOCAL_PASSWORD_HASH_FILE');
  }
  return Object.freeze({
    adminOrigin,
    publicOrigin,
    localCredential,
    localCredentialFiles: requireLocalCredential
      ? Object.freeze({ username: usernameFile, passwordHash: passwordHashFile })
      : null,
    weeklyIngestionToken,
    databasePath,
    uploadsRoot,
    previewsRoot,
    releasesRoot,
    publicRoot,
    listener: loadListenerConfiguration(env),
  });
}

export function loadLegacyOidcBootstrapConfiguration(env = process.env) {
  const config = loadConfiguration(env, {
    requireLocalCredential: false,
    requireWeeklyIngestionToken: false,
  });
  const redirectUri = requireValue(env, 'TELEGRAM_OIDC_REDIRECT_URI');
  const expectedRedirect = `${config.adminOrigin}/auth/callback`;
  if (redirectUri !== expectedRedirect) {
    throw new Error(`TELEGRAM_OIDC_REDIRECT_URI must exactly equal ${expectedRedirect}`);
  }
  const signingAlgorithm = env.TELEGRAM_OIDC_SIGNING_ALG ?? 'RS256';
  if (signingAlgorithm !== 'RS256') throw new Error('TELEGRAM_OIDC_SIGNING_ALG must be pinned to RS256');
  return Object.freeze({
    ...config,
    redirectUri,
    clientId: requireSecret(env, 'TELEGRAM_OIDC_CLIENT_ID'),
    clientSecret: requireSecret(env, 'TELEGRAM_OIDC_CLIENT_SECRET'),
    signingAlgorithm,
  });
}

function loadListenerConfiguration(env = process.env) {
  const hasSocket = env.OKNOTIKA_LISTEN_SOCKET !== undefined;
  const hasHost = env.OKNOTIKA_LISTEN_HOST !== undefined;
  const hasPort = env.OKNOTIKA_LISTEN_PORT !== undefined;
  if (hasSocket && (hasHost || hasPort)) {
    throw new Error('OKNOTIKA_LISTEN_SOCKET is mutually exclusive with TCP host/port settings');
  }
  if (hasHost !== hasPort) {
    throw new Error('OKNOTIKA_LISTEN_HOST and OKNOTIKA_LISTEN_PORT must be set together');
  }
  if (hasHost) {
    const host = requireValue(env, 'OKNOTIKA_LISTEN_HOST');
    if (isIP(host) === 0) throw new Error('OKNOTIKA_LISTEN_HOST must be a valid IP address');
    const portValue = requireValue(env, 'OKNOTIKA_LISTEN_PORT');
    if (!/^[1-9]\d{0,4}$/.test(portValue)) {
      throw new Error('OKNOTIKA_LISTEN_PORT must be an integer from 1 to 65535');
    }
    const port = Number(portValue);
    if (port > 65535) throw new Error('OKNOTIKA_LISTEN_PORT must be an integer from 1 to 65535');
    return Object.freeze({ mode: 'tcp', host, port });
  }
  const path = hasSocket
    ? resolve(requireValue(env, 'OKNOTIKA_LISTEN_SOCKET'))
    : '/run/oknotika-admin/app.sock';
  return Object.freeze({ mode: 'unix', path });
}

export function assertRuntimeSeparation(config) {
  const publicRoot = realpathSync(config.publicRoot);
  for (const [name, path] of [
    ['OKNOTIKA_DATABASE_PATH', dirname(config.databasePath)],
    ['OKNOTIKA_UPLOADS_ROOT', config.uploadsRoot],
    ['OKNOTIKA_PREVIEWS_ROOT', config.previewsRoot],
    ['OKNOTIKA_ARTICLE_RELEASES_ROOT', config.releasesRoot],
  ]) assertOutside(realpathSync(path), publicRoot, name);
  if (config.localCredentialFiles) {
    assertOutside(realpathSync(config.localCredentialFiles.username), publicRoot, 'OKNOTIKA_LOCAL_USERNAME_FILE');
    assertOutside(realpathSync(config.localCredentialFiles.passwordHash), publicRoot, 'OKNOTIKA_LOCAL_PASSWORD_HASH_FILE');
  }
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

function rejectPlaintextPasswordConfiguration(env) {
  for (const name of [
    'OKNOTIKA_LOCAL_PASSWORD',
    'OKNOTIKA_LOCAL_PASSWORD_FILE',
  ]) {
    if (env[name] !== undefined) throw new Error(`${name} plaintext password configuration is prohibited`);
  }
}

function requireCredentialFilename(env, name) {
  if (env[name] !== undefined) throw new Error(`${name} direct credential configuration is prohibited; use ${name}_FILE`);
  const filename = requireValue(env, `${name}_FILE`);
  if (!isAbsolute(filename)) throw new Error(`${name}_FILE must be an absolute path to a protected credential file`);
  return filename;
}

function readCredentialFile(filename, name) {
  let metadata;
  let value;
  try {
    metadata = lstatSync(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 4096) throw new Error();
    if ((metadata.mode & 0o022) !== 0) throw new Error();
    value = readFileSync(filename, 'utf8');
  } catch {
    throw new Error(`${name} must point to a protected, readable regular file`);
  }
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value === '' || value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error(`${name} must contain exactly one credential record`);
  }
  return value;
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
