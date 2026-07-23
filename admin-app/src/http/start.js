import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { setImmediate } from 'node:timers';
import { fetchTelegramDiscovery } from '../auth/conformance.js';
import { assertRuntimeSeparation, loadConfiguration } from '../auth/config.js';
import { createOidcService } from '../auth/oidc.js';
import { createSessionService } from '../auth/sessions.js';
import { openDatabase } from '../content/database.js';
import { createContentService } from '../content/service.js';
import { createPublisher } from '../render/publisher.js';
import { createAdminActions } from './admin-actions.js';
import { createAdminHandler } from './handler.js';
import { createUploadStore } from './uploads.js';
import { createProxiedRequest } from './node-adapter.js';
import { assertTrustedProxyHeaders } from './security.js';

const config = loadConfiguration();
for (const directory of [
  dirname(config.databasePath),
  config.uploadsRoot,
  config.previewsRoot,
  config.releasesRoot,
  dirname(config.listenSocket),
]) mkdirSync(directory, { recursive: true, mode: 0o700 });
assertRuntimeSeparation(config);

const discovery = await fetchTelegramDiscovery({ signingAlgorithm: config.signingAlgorithm });
const db = openDatabase(config.databasePath);
const contentService = createContentService(db);
const publisher = createPublisher(db, {
  releasesRoot: config.releasesRoot,
  publicOrigin: config.publicOrigin,
  onFatalConsistencyError: (error) => setImmediate(() => { throw error; }),
});
publisher.reconcile();
const uploadStore = createUploadStore({
  db,
  contentService,
  uploadsRoot: config.uploadsRoot,
  publicRoot: config.publicRoot,
});
const actions = createAdminActions({
  db,
  contentService,
  publisher,
  uploadStore,
  previewsRoot: config.previewsRoot,
  publicOrigin: config.publicOrigin,
});
const sessionService = createSessionService(db);
const oidcService = createOidcService(db, {
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  redirectUri: config.redirectUri,
  discovery,
  allowedAlgorithm: config.signingAlgorithm,
});
const handler = createAdminHandler({
  adminOrigin: config.adminOrigin,
  oidcService,
  sessionService,
  actions,
  previewsRoot: config.previewsRoot,
});

const server = createServer(async (incoming, outgoing) => {
  try {
    assertTrustedProxyHeaders(incoming.headers, config.adminOrigin);
    const request = await createProxiedRequest(incoming, {
      adminOrigin: config.adminOrigin,
      sessionService,
    });
    const response = await handler(request);
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers) {
      if (name !== 'set-cookie') outgoing.setHeader(name, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outgoing.setHeader('set-cookie', cookies);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const status = error.code === 'REQUEST_TOO_LARGE' ? 413 : 500;
    outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    outgoing.end(`${JSON.stringify({ error: status === 413 ? 'Request body is too large' : 'Internal server error' })}\n`);
  }
});

rmSync(config.listenSocket, { force: true });
server.listen(config.listenSocket, () => chmodSync(config.listenSocket, 0o660));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => {
    db.close();
    rmSync(config.listenSocket, { force: true });
  }));
}
