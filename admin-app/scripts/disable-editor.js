import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase } from '../src/content/database.js';
import { createContentService } from '../src/content/service.js';

const databasePath = resolve(parseDatabase(process.argv.slice(2)));
const db = openDatabase(databasePath);
try {
  const editor = db.prepare('SELECT id, issuer, subject, enabled FROM configured_editors').get();
  if (!editor) throw new Error('No configured editor exists');
  if (!editor.enabled) throw new Error('The configured editor is already disabled');
  createContentService(db).disableEditor(Number(editor.id));
  const fingerprint = createHash('sha256')
    .update(`${editor.issuer}\0${editor.subject}`)
    .digest('hex')
    .slice(0, 16);
  console.log(`Editor ${editor.id} disabled and sessions revoked; identity fingerprint ${fingerprint}`);
} finally {
  db.close();
}

function parseDatabase(values) {
  if (values.length !== 2 || values[0] !== '--database' || !values[1]) {
    throw new Error('Usage: disable-editor.js --database PATH');
  }
  return values[1];
}
