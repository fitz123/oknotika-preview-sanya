#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/content/database.js';
import { createPublisher } from '../src/render/publisher.js';

export async function rollbackRelease({
  databasePath,
  releasesRoot,
  publicOrigin,
  releaseId,
  applicationSchemaVersion = null,
}) {
  if (typeof releaseId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(releaseId)) {
    throw new TypeError('releaseId is invalid');
  }
  if (applicationSchemaVersion !== null && applicationSchemaVersion !== 3) {
    throw new TypeError('applicationSchemaVersion must be 3 when provided');
  }
  const db = openDatabase(databasePath);
  try {
    const publisher = createPublisher(db, { releasesRoot, publicOrigin });
    publisher.reconcile();
    return await publisher.rollback(releaseId, { applicationSchemaVersion });
  } finally {
    db.close();
  }
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/, '');
    if (!name || values[index + 1] === undefined) {
      throw new Error('Arguments must be --name value pairs');
    }
    parsed[name] = values[index + 1];
  }
  return {
    databasePath: resolve(required(parsed, 'database')),
    releasesRoot: resolve(required(parsed, 'releases-root')),
    publicOrigin: required(parsed, 'public-origin'),
    releaseId: required(parsed, 'release-id'),
    applicationSchemaVersion: optionalApplicationSchema(parsed['application-schema']),
  };
}

function optionalApplicationSchema(value) {
  if (value === undefined) return null;
  if (value !== '3') throw new Error('--application-schema must be 3');
  return 3;
}

function required(values, name) {
  if (!values[name]) throw new Error(`--${name} is required`);
  return values[name];
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await rollbackRelease(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: 'rolled-back',
      releaseId: manifest.releaseId,
    })}\n`);
  } catch (error) {
    process.stderr.write(`operational rollback failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
