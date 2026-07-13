import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

test('online deployment backup is a mode-0600 consistent SQLite snapshot', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oknotika-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, 'db/admin.sqlite');
  const destination = resolve(root, 'backups/admin.sqlite');
  mkdirSync(resolve(root, 'db'), { recursive: true });
  const database = new DatabaseSync(source);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY, event_type TEXT NOT NULL);
    INSERT INTO audit_events (event_type) VALUES ('release.published');
  `);
  database.close();

  const output = execFileSync(process.execPath, [
    resolve(REPO_ROOT, 'deploy/scripts/sqlite-online-backup.mjs'), source, destination,
  ], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).integrity, 'ok');
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  const restored = new DatabaseSync(destination, { readOnly: true });
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
  restored.close();
});

test('deployment manifest pins Node 24, bundled SQLite and the exact npm lockfile', () => {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'deploy/release-manifest.json'), 'utf8'));
  assert.equal(manifest.runtime.nodeMajor, 24);
  assert.match(manifest.runtime.nodeVersion, /^24\.\d+\.\d+$/);
  assert.match(manifest.runtime.sqliteVersion, /^3\.\d+\.\d+$/);
  assert.equal(manifest.runtime.packageLockVersion, 3);
  assert.match(manifest.runtime.packageLockSha256, /^[a-f0-9]{64}$/);
});
