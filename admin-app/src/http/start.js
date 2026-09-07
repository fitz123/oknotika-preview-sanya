import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { setImmediate } from 'node:timers';
import { assertRuntimeSeparation, loadConfiguration } from '../auth/config.js';
import { createLoginCsrfService } from '../auth/login.js';
import { createLocalAuthenticator } from '../auth/local.js';
import { createSessionService } from '../auth/sessions.js';
import { openDatabase } from '../content/database.js';
import { createContentService } from '../content/service.js';
import { createPublisher } from '../render/publisher.js';
import { createAdminActions } from './admin-actions.js';
import { createAdminHandler } from './handler.js';
import { createIngestionAuthenticator } from './ingestion-auth.js';
import { startListener, stopListener } from './listener.js';
import { createUploadStore } from './uploads.js';
import { createProxiedRequest } from './node-adapter.js';
import { assertTrustedProxyHeaders } from './security.js';
import { createWeeklyIngestion } from './weekly-ingestion.js';

const config = loadConfiguration();
for (const directory of [
  dirname(config.databasePath),
  config.uploadsRoot,
  config.previewsRoot,
  config.releasesRoot,
]) mkdirSync(directory, { recursive: true, mode: 0o700 });
assertRuntimeSeparation(config);

const db = openDatabase(config.databasePath);
const localAuthenticator = createLocalAuthenticator(db, config.localCredential);
const loginCsrfService = createLoginCsrfService(db);
const contentService = createContentService(db, { previewsRoot: config.previewsRoot });
const publisher = createPublisher(db, {
  releasesRoot: config.releasesRoot,
  publicOrigin: config.publicOrigin,
  onFatalConsistencyError: (error) => setImmediate(() => { throw error; }),
});
const activeManifest = publisher.reconcile();
await publisher.activatePendingSocialDefaults(activeManifest);
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
const weeklyIngestion = createWeeklyIngestion({
  contentService,
  releasesRoot: config.releasesRoot,
});
const ingestionAuthenticator = createIngestionAuthenticator(config.weeklyIngestionToken);
const sessionService = createSessionService(db);
const handler = createAdminHandler({
  adminOrigin: config.adminOrigin,
  localAuthenticator,
  loginCsrfService,
  sessionService,
  actions,
  weeklyIngestion,
  ingestionAuthenticator,
  previewsRoot: config.previewsRoot,
});

const server = createServer(async (incoming, outgoing) => {
  try {
    assertTrustedProxyHeaders(incoming.headers, config.adminOrigin);
    const request = await createProxiedRequest(incoming, {
      adminOrigin: config.adminOrigin,
      sessionService,
      ingestionAuthenticator,
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

startListener(server, config.listener);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => stopListener(server, config.listener, () => {
    db.close();
  }));
}
