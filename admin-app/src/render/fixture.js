import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AL_BAHR_FIXTURE, importAlBahr } from '../content/al-bahr.js';
import { openDatabase } from '../content/database.js';
import { createContentService } from '../content/service.js';
import { renderRelease, validateRelease } from './renderer.js';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(appRoot, '..');
const privateRoot = resolve(appRoot, 'var/fixture-private');
const outputDirectory = resolve(repoRoot, 'var/test-release');
const privateCover = resolve(privateRoot, 'al-bahr-cover.jpg');

rmSync(privateRoot, { recursive: true, force: true });
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
copyFileSync(resolve(repoRoot, 'img/aluminum-world/facades.jpg'), privateCover);

const db = openDatabase(':memory:');
const service = createContentService(db, { clock: () => new Date('2026-07-13T12:00:00.000Z') });
const editorId = service.configureEditor({ issuer: 'https://oauth.telegram.org', subject: 'fixture-editor' });
const coverAssetId = service.registerAsset({
  privatePath: privateCover,
  mediaType: 'image/jpeg',
});
importAlBahr(service, { editorId, coverAssetId });

const manifest = renderRelease({
  db,
  outputDirectory,
  publicOrigin: 'https://oknotika.ru',
  releaseId: 'fixture-al-bahr-v1',
  generatedAt: '2026-07-13T12:00:00.000Z',
});
validateRelease(outputDirectory);
db.close();

console.log(`Rendered ${manifest.articles.length} article fixture (${AL_BAHR_FIXTURE.slug}) to ${outputDirectory}`);
