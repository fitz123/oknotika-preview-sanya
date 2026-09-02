import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { loadConfiguration } from '../src/auth/config.js';
import { startListener, stopListener } from '../src/http/listener.js';

const BASE_ENV = Object.freeze({
  OKNOTIKA_ADMIN_ORIGIN: 'https://admin.oknotika.ru',
  OKNOTIKA_PUBLIC_ORIGIN: 'https://oknotika.ru',
  OKNOTIKA_WEEKLY_INGEST_TOKEN: 'weekly-ingestion-token-for-tests-1234567890',
  OKNOTIKA_DATABASE_PATH: '/var/lib/oknotika-admin/db/admin.sqlite',
  OKNOTIKA_UPLOADS_ROOT: '/var/lib/oknotika-admin/uploads',
  OKNOTIKA_PREVIEWS_ROOT: '/var/lib/oknotika-admin/previews',
  OKNOTIKA_ARTICLE_RELEASES_ROOT: '/var/lib/oknotika-admin/article-releases',
  OKNOTIKA_PUBLIC_ROOT: '/srv/oknotika/current',
});

test('listener configuration keeps Unix sockets as the default and accepts explicit TCP mode', () => {
  assert.deepEqual(loadListenerTestConfiguration(BASE_ENV).listener, {
    mode: 'unix',
    path: '/run/oknotika-admin/app.sock',
  });
  assert.deepEqual(loadListenerTestConfiguration({
    ...BASE_ENV,
    OKNOTIKA_LISTEN_SOCKET: './var/admin.sock',
  }).listener, {
    mode: 'unix',
    path: resolve('./var/admin.sock'),
  });
  assert.deepEqual(loadListenerTestConfiguration({
    ...BASE_ENV,
    OKNOTIKA_LISTEN_HOST: '0.0.0.0',
    OKNOTIKA_LISTEN_PORT: '8000',
  }).listener, {
    mode: 'tcp',
    host: '0.0.0.0',
    port: 8000,
  });
});

test('listener configuration rejects mixed, partial and invalid TCP settings', () => {
  for (const overrides of [
    { OKNOTIKA_LISTEN_SOCKET: '/run/admin.sock', OKNOTIKA_LISTEN_HOST: '0.0.0.0', OKNOTIKA_LISTEN_PORT: '8000' },
    { OKNOTIKA_LISTEN_HOST: '0.0.0.0' },
    { OKNOTIKA_LISTEN_PORT: '8000' },
  ]) {
    assert.throws(() => loadListenerTestConfiguration({ ...BASE_ENV, ...overrides }), /mutually exclusive|set together/);
  }
  for (const host of ['', 'localhost', 'http://127.0.0.1', '999.0.0.1']) {
    assert.throws(() => loadListenerTestConfiguration({
      ...BASE_ENV,
      OKNOTIKA_LISTEN_HOST: host,
      OKNOTIKA_LISTEN_PORT: '8000',
    }), /LISTEN_HOST/);
  }
  for (const port of ['', '0', '-1', '8000.5', 'eight-thousand', '65536']) {
    assert.throws(() => loadListenerTestConfiguration({
      ...BASE_ENV,
      OKNOTIKA_LISTEN_HOST: '0.0.0.0',
      OKNOTIKA_LISTEN_PORT: port,
    }), /LISTEN_PORT/);
  }
  assert.throws(() => loadListenerTestConfiguration({
    ...BASE_ENV,
    OKNOTIKA_LISTEN_SOCKET: '',
  }), /LISTEN_SOCKET/);
});

function loadListenerTestConfiguration(env) {
  return loadConfiguration(env, { requireLocalCredential: false });
}

test('Unix listener replaces a stale socket target, applies permissions and cleans up on close', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-listener-'));
  const socketPath = resolve(root, 'admin.sock');
  const listener = { mode: 'unix', path: socketPath };
  const server = createServer((_request, response) => response.end('ok'));
  t.after(() => {
    if (server.listening) server.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(socketPath, 'stale');

  await startAndWait(server, listener);
  assert.equal(statSync(socketPath).mode & 0o777, 0o660);
  await stopAndWait(server, listener);
  assert.equal(existsSync(socketPath), false);
});

test('TCP listener binds the configured host and port without a socket target', async (t) => {
  const server = createServer((_request, response) => response.end('ok'));
  const listener = { mode: 'tcp', host: '127.0.0.1', port: 0 };
  t.after(() => {
    if (server.listening) server.close();
  });

  await startAndWait(server, listener);
  const address = server.address();
  assert.equal(address.address, listener.host);
  assert.ok(address.port > 0);
  await stopAndWait(server, listener);
});

function startAndWait(server, listener) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    startListener(server, listener, resolvePromise);
  });
}

function stopAndWait(server, listener) {
  return new Promise(resolvePromise => stopListener(server, listener, resolvePromise));
}
