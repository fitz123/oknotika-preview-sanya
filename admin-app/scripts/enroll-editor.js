import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { TELEGRAM_ISSUER } from '../src/auth/conformance.js';
import { openDatabase } from '../src/content/database.js';
import { createContentService } from '../src/content/service.js';

const argumentsMap = parseArguments(process.argv.slice(2));
const databasePath = resolve(required(argumentsMap, 'database'));
const issuer = required(argumentsMap, 'issuer');
const subject = required(argumentsMap, 'subject');
if (issuer !== TELEGRAM_ISSUER) throw new Error(`Issuer must exactly equal ${TELEGRAM_ISSUER}`);
if (!/^\d{5,32}$/.test(subject)) throw new Error('Subject must be the verified numeric Telegram OIDC sub claim');

const db = openDatabase(databasePath);
try {
  const existing = db.prepare('SELECT issuer, subject FROM configured_editors').get();
  if (!existing) {
    throw new Error('No verified editor exists; first enrollment must use npm run bootstrap-editor');
  }
  if (existing.issuer !== issuer || existing.subject !== subject) {
    throw new Error('A different editor is already enrolled; editor CRUD and replacement are intentionally unavailable');
  }
  const id = createContentService(db).configureEditor({ issuer, subject });
  const fingerprint = createHash('sha256').update(`${issuer}\0${subject}`).digest('hex').slice(0, 16);
  console.log(`Editor ${id} enrolled; identity fingerprint ${fingerprint}`);
} finally {
  db.close();
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/, '');
    if (!name || values[index + 1] === undefined) throw new Error('Arguments must be --database, --issuer and --subject');
    parsed[name] = values[index + 1];
  }
  return parsed;
}

function required(values, name) {
  if (!values[name]) throw new Error(`--${name} is required`);
  return values[name];
}
