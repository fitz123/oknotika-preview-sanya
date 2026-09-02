import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../content/database.js';
import {
  createLocalCredential,
  hashLocalPassword,
  initializeLocalEditor,
  LOCAL_AUTH_ISSUER,
  parseLocalUsername,
} from './local.js';

export const MINIMUM_LOCAL_PASSWORD_CHARACTERS = 14;

const GENERATION_PATTERN = /^credential-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const SNAPSHOT_PATTERN = /^(?:local-credential|rollback-safety)-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const METADATA_VERSION = 1;

export async function configureLocalCredentials({
  databasePath,
  credentialsRoot,
  backupsRoot,
  username,
  password,
  passwordConfirmation,
  credentialOwner = 0,
  credentialGroup = 1000,
  databaseOwner = 1000,
  databaseGroup = 1000,
  backupOwner = 0,
  backupGroup = 0,
  clock = () => new Date(),
  random = randomBytes,
}) {
  const paths = resolvePaths({ databasePath, credentialsRoot, backupsRoot });
  assertDirectory(paths.credentialsRoot, 'Credential generation root');
  assertDirectory(paths.backupsRoot, 'Credential backup root');
  const parsedUsername = parseLocalUsername(username);
  assertPassword(password, passwordConfirmation, parsedUsername);
  const previousGeneration = readCurrentGeneration(paths.credentialsRoot);
  if (previousGeneration) validateGeneration(paths.credentialsRoot, previousGeneration);
  assertCompatibleIdentity(paths.databasePath, parsedUsername);

  const createdAt = clock().toISOString();
  const suffix = random(6).toString('hex');
  const generation = generationName(createdAt, suffix);
  const snapshotName = `local-${generation}`;
  const passwordHash = await hashLocalPassword(password);
  const credential = createLocalCredential({ username: parsedUsername, passwordHash });
  const databaseWasPresent = existsSync(paths.databasePath);
  await createSnapshot(paths, {
    snapshotName,
    operation: 'configure',
    createdAt,
    databaseWasPresent,
    previousGeneration,
    appliedGeneration: generation,
  }, { backupOwner, backupGroup });

  const stagingGeneration = resolve(paths.credentialsRoot, `.staging-${generation}-${process.pid}`);
  const finalGeneration = resolve(paths.credentialsRoot, generation);
  let databaseChanged = false;
  try {
    mkdirSync(stagingGeneration, { mode: 0o750 });
    chownSync(stagingGeneration, credentialOwner, credentialGroup);
    writeCredentialFile(
      resolve(stagingGeneration, 'username'),
      parsedUsername,
      credentialOwner,
      credentialGroup,
    );
    writeCredentialFile(
      resolve(stagingGeneration, 'password-hash'),
      passwordHash,
      credentialOwner,
      credentialGroup,
    );

    databaseChanged = true;
    const database = openDatabase(paths.databasePath);
    try {
      initializeLocalEditor(database, credential, { clock });
    } finally {
      database.close();
    }
    setDatabaseOwnership(paths.databasePath, databaseOwner, databaseGroup);

    renameSync(stagingGeneration, finalGeneration);
    switchGeneration(paths.credentialsRoot, generation);
    return Object.freeze({ operation: 'configure', generation, snapshotName });
  } catch (error) {
    rmSync(stagingGeneration, { recursive: true, force: true });
    if (readCurrentGeneration(paths.credentialsRoot) !== generation) {
      rmSync(finalGeneration, { recursive: true, force: true });
    }
    if (databaseChanged) {
      restoreDatabase(paths.databasePath, resolve(paths.backupsRoot, snapshotName), {
        databaseWasPresent,
        databaseOwner,
        databaseGroup,
      });
    }
    throw error;
  }
}

export async function rollbackLocalCredentials({
  databasePath,
  credentialsRoot,
  backupsRoot,
  snapshotName,
  databaseOwner = 1000,
  databaseGroup = 1000,
  backupOwner = 0,
  backupGroup = 0,
  clock = () => new Date(),
  random = randomBytes,
}) {
  const paths = resolvePaths({ databasePath, credentialsRoot, backupsRoot });
  if (!SNAPSHOT_PATTERN.test(snapshotName ?? '')) throw new Error('Credential rollback snapshot name is invalid');
  const targetSnapshot = resolve(paths.backupsRoot, snapshotName);
  const metadata = readSnapshotMetadata(targetSnapshot);
  const currentGeneration = readCurrentGeneration(paths.credentialsRoot);
  if (metadata.appliedGeneration !== currentGeneration) {
    throw new Error('Credential rollback snapshot does not match the active generation');
  }
  if (metadata.previousGeneration) validateGeneration(paths.credentialsRoot, metadata.previousGeneration);

  const createdAt = clock().toISOString();
  const safetySnapshotName = `rollback-safety-${timestamp(createdAt)}-${random(6).toString('hex')}`;
  const databaseWasPresent = existsSync(paths.databasePath);
  await createSnapshot(paths, {
    snapshotName: safetySnapshotName,
    operation: 'rollback-safety',
    createdAt,
    databaseWasPresent,
    previousGeneration: currentGeneration,
    appliedGeneration: metadata.previousGeneration,
  }, { backupOwner, backupGroup });

  try {
    restoreDatabase(paths.databasePath, targetSnapshot, {
      databaseWasPresent: metadata.databaseWasPresent,
      databaseOwner,
      databaseGroup,
    });
    revokeRestoredSessions(paths.databasePath, createdAt, databaseOwner, databaseGroup);
    switchGeneration(paths.credentialsRoot, metadata.previousGeneration);
    return Object.freeze({
      operation: 'rollback',
      restoredSnapshot: snapshotName,
      safetySnapshotName,
      generation: metadata.previousGeneration,
    });
  } catch (error) {
    restoreDatabase(paths.databasePath, resolve(paths.backupsRoot, safetySnapshotName), {
      databaseWasPresent,
      databaseOwner,
      databaseGroup,
    });
    switchGeneration(paths.credentialsRoot, currentGeneration);
    throw error;
  }
}

function resolvePaths({ databasePath, credentialsRoot, backupsRoot }) {
  for (const [name, value] of Object.entries({ databasePath, credentialsRoot, backupsRoot })) {
    if (typeof value !== 'string' || value === '') throw new TypeError(`${name} is required`);
  }
  return Object.freeze({
    databasePath: resolve(databasePath),
    credentialsRoot: resolve(credentialsRoot),
    backupsRoot: resolve(backupsRoot),
  });
}

function assertDirectory(path, label) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`${label} must already exist`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function assertPassword(password, confirmation, username) {
  if (typeof password !== 'string'
    || Array.from(password).length < MINIMUM_LOCAL_PASSWORD_CHARACTERS
    || Buffer.byteLength(password) > 1024
    || Array.from(password).some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    })) {
    throw new Error(`Password must contain at least ${MINIMUM_LOCAL_PASSWORD_CHARACTERS} characters and no control characters`);
  }
  if (password.toLocaleLowerCase('en-US') === username.toLocaleLowerCase('en-US')) {
    throw new Error('Password must differ from the username');
  }
  const left = Buffer.from(password);
  const right = Buffer.from(typeof confirmation === 'string' ? confirmation : '');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error('Password confirmation does not match');
  }
}

function assertCompatibleIdentity(databasePath, username) {
  if (!existsSync(databasePath)) return;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = database.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'configured_editors'
    `).get();
    if (!table) return;
    const editors = database.prepare('SELECT issuer, subject FROM configured_editors ORDER BY id').all();
    if (editors.length > 1) throw new Error('Local authentication requires exactly one configured editor');
    if (editors.length === 1
      && (editors[0].issuer !== LOCAL_AUTH_ISSUER || editors[0].subject !== username)) {
      throw new Error('Configured editor conflicts with the requested local identity');
    }
  } finally {
    database.close();
  }
}

async function createSnapshot(paths, metadata, { backupOwner, backupGroup }) {
  const finalSnapshot = resolve(paths.backupsRoot, metadata.snapshotName);
  const stagingSnapshot = resolve(paths.backupsRoot, `.staging-${metadata.snapshotName}-${process.pid}`);
  if (existsSync(finalSnapshot) || existsSync(stagingSnapshot)) throw new Error('Credential snapshot already exists');
  mkdirSync(stagingSnapshot, { mode: 0o700 });
  chmodSync(stagingSnapshot, 0o700);
  chownSync(stagingSnapshot, backupOwner, backupGroup);
  try {
    if (metadata.databaseWasPresent) {
      const source = new DatabaseSync(paths.databasePath, { readOnly: true });
      try {
        await backup(source, resolve(stagingSnapshot, 'admin.sqlite'), { rate: -1 });
      } finally {
        source.close();
      }
      verifyDatabase(resolve(stagingSnapshot, 'admin.sqlite'));
      chmodSync(resolve(stagingSnapshot, 'admin.sqlite'), 0o600);
      chownSync(resolve(stagingSnapshot, 'admin.sqlite'), backupOwner, backupGroup);
    }
    atomicWrite(
      resolve(stagingSnapshot, 'metadata.json'),
      `${JSON.stringify({ version: METADATA_VERSION, ...metadata }, null, 2)}\n`,
      0o600,
      backupOwner,
      backupGroup,
    );
    renameSync(stagingSnapshot, finalSnapshot);
  } catch (error) {
    rmSync(stagingSnapshot, { recursive: true, force: true });
    throw error;
  }
}

function readSnapshotMetadata(snapshotPath) {
  assertDirectory(snapshotPath, 'Credential rollback snapshot');
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(resolve(snapshotPath, 'metadata.json'), 'utf8'));
  } catch {
    throw new Error('Credential rollback metadata is invalid');
  }
  if (metadata.version !== METADATA_VERSION
    || typeof metadata.databaseWasPresent !== 'boolean'
    || (metadata.appliedGeneration !== null && !GENERATION_PATTERN.test(metadata.appliedGeneration ?? ''))
    || (metadata.previousGeneration !== null && !GENERATION_PATTERN.test(metadata.previousGeneration ?? ''))) {
    throw new Error('Credential rollback metadata is invalid');
  }
  if (metadata.databaseWasPresent) verifyDatabase(resolve(snapshotPath, 'admin.sqlite'));
  return metadata;
}

function readCurrentGeneration(credentialsRoot) {
  const current = resolve(credentialsRoot, 'current');
  let metadata;
  try {
    metadata = lstatSync(current);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!metadata.isSymbolicLink()) throw new Error('Active credential generation must be a symbolic link');
  const target = readlinkSync(current);
  if (!GENERATION_PATTERN.test(target)) throw new Error('Active credential generation target is invalid');
  return target;
}

function validateGeneration(credentialsRoot, generation) {
  if (!GENERATION_PATTERN.test(generation)) throw new Error('Credential generation name is invalid');
  const directory = resolve(credentialsRoot, generation);
  assertDirectory(directory, 'Credential generation');
  const username = readCredentialRecord(resolve(directory, 'username'));
  const passwordHash = readCredentialRecord(resolve(directory, 'password-hash'));
  createLocalCredential({ username, passwordHash });
}

function readCredentialRecord(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o640) {
    throw new Error('Credential generation file mode is invalid');
  }
  const value = readFileSync(path, 'utf8');
  if (!value.endsWith('\n') || value.slice(0, -1).includes('\n')) {
    throw new Error('Credential generation record is invalid');
  }
  return value.slice(0, -1);
}

function generationName(isoTimestamp, suffix) {
  return `credential-${timestamp(isoTimestamp)}-${suffix}`;
}

function timestamp(isoTimestamp) {
  return isoTimestamp.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function writeCredentialFile(path, value, owner, group) {
  atomicWrite(path, `${value}\n`, 0o640, owner, group);
}

function atomicWrite(path, value, mode, owner, group) {
  const handle = openSync(path, 'wx', mode);
  try {
    writeFileSync(handle, value, { encoding: 'utf8' });
    fchownSync(handle, owner, group);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  chmodSync(path, mode);
}

function switchGeneration(credentialsRoot, generation) {
  const current = resolve(credentialsRoot, 'current');
  const next = resolve(credentialsRoot, `.current-${process.pid}-${randomBytes(4).toString('hex')}`);
  rmSync(next, { force: true });
  if (generation === null) {
    rmSync(current, { force: true });
    return;
  }
  validateGeneration(credentialsRoot, generation);
  try {
    symlinkSync(generation, next);
    renameSync(next, current);
  } finally {
    rmSync(next, { force: true });
  }
}

function restoreDatabase(databasePath, snapshotPath, {
  databaseWasPresent,
  databaseOwner,
  databaseGroup,
}) {
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  if (!databaseWasPresent) {
    rmSync(databasePath, { force: true });
    return;
  }
  const source = resolve(snapshotPath, 'admin.sqlite');
  verifyDatabase(source);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const temporary = `${databasePath}.restore-${process.pid}`;
  rmSync(temporary, { force: true });
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o600);
    chownSync(temporary, databaseOwner, databaseGroup);
    verifyDatabase(temporary);
    renameSync(temporary, databasePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function revokeRestoredSessions(databasePath, timestampValue, owner, group) {
  if (!existsSync(databasePath)) return;
  const database = openDatabase(databasePath);
  try {
    database.prepare(`
      UPDATE admin_sessions
      SET revoked_at = ?, revocation_reason = 'credential-rollback'
      WHERE revoked_at IS NULL
    `).run(timestampValue);
  } finally {
    database.close();
  }
  setDatabaseOwnership(databasePath, owner, group);
}

function setDatabaseOwnership(databasePath, owner, group) {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chownSync(path, owner, group);
  }
  chmodSync(databasePath, 0o600);
}

function verifyDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const result = database.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok') {
      throw new Error('Credential database backup failed integrity_check');
    }
  } finally {
    database.close();
  }
}
