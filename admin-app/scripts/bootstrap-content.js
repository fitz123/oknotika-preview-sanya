#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { AL_BAHR_FIXTURE, importAlBahr } from '../src/content/al-bahr.js';
import { openDatabase } from '../src/content/database.js';
import { createContentService } from '../src/content/service.js';
import { createPublisher } from '../src/render/publisher.js';

const options = parseArguments(process.argv.slice(2));
const databasePath = resolve(required(options, 'database'));
const releasesRoot = resolve(required(options, 'releases-root'));
const uploadsRoot = resolve(required(options, 'uploads-root'));
const publicOrigin = required(options, 'public-origin');
const coverSource = resolve(required(options, 'cover'));

const db = openDatabase(databasePath);
try {
  const editor = db.prepare('SELECT id FROM configured_editors WHERE enabled = 1').all();
  if (editor.length !== 1) throw new Error('Exactly one enabled editor must be enrolled before content bootstrap');
  const service = createContentService(db);
  const publisher = createPublisher(db, { releasesRoot, publicOrigin });
  publisher.reconcile();

  let article = db.prepare('SELECT * FROM articles WHERE slug = ?').get(AL_BAHR_FIXTURE.slug);
  if (!article) {
    const source = readFileSync(coverSource);
    if (source.length < 3 || source[0] !== 0xff || source[1] !== 0xd8 || source[2] !== 0xff) {
      throw new Error('The reviewed Al Bahr bootstrap cover must be a JPEG');
    }
    const digest = createHash('sha256').update(source).digest('hex');
    const privateDirectory = resolve(uploadsRoot, 'bootstrap');
    const privateCover = resolve(privateDirectory, `al-bahr-${digest.slice(0, 24)}${extname(coverSource) || '.jpg'}`);
    mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    if (!existsSync(privateCover)) copyFileSync(coverSource, privateCover, 0);
    chmodSync(privateCover, 0o600);
    const coverAssetId = service.registerAsset({ privatePath: privateCover, mediaType: 'image/jpeg' });
    const created = importAlBahr(service, { editorId: Number(editor[0].id), coverAssetId });
    article = service.getArticle(created.articleId);
  }

  const active = db.prepare('SELECT active_release_id FROM site_state WHERE singleton = 1').get().active_release_id;
  if (article.public_state === 'published' && active) {
    console.log(`Content bootstrap already complete: ${AL_BAHR_FIXTURE.slug} in ${active}`);
  } else {
    const manifest = await publisher.publish({
      editorId: Number(editor[0].id),
      transition: {
        type: 'publish',
        articleId: Number(article.id),
        expectedRevisionId: Number(article.current_revision_id),
      },
    });
    console.log(`Bootstrapped ${AL_BAHR_FIXTURE.slug} in active release ${manifest.releaseId}`);
  }
} finally {
  db.close();
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.replace(/^--/, '');
    if (!name || values[index + 1] === undefined) throw new Error('Bootstrap arguments must be --name value pairs');
    parsed[name] = values[index + 1];
  }
  return parsed;
}

function required(values, name) {
  if (!values[name]) throw new Error(`--${name} is required`);
  return values[name];
}
