import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import { openDatabase } from '../../src/content/database.js';
import { createContentService } from '../../src/content/service.js';
import { createPublisher } from '../../src/render/publisher.js';

const [root, coverPath] = process.argv.slice(2);
mkdirSync(root, { recursive: true });
const db = openDatabase(resolve(root, 'admin.sqlite'));
const service = createContentService(db);
const editorId = service.configureEditor({ issuer: 'https://oauth.telegram.org', subject: '9988776655' });
const coverAssetId = service.registerAsset({ privatePath: coverPath, mediaType: 'image/png', width: 1, height: 1 });
const article = service.createArticle({
  title: 'Crash-lock fixture',
  publicationDate: '2026-07-14',
  lead: 'Проверка восстановления publisher lock.',
  bodyMarkdown: 'Процесс будет остановлен после захвата lock.',
  coverAssetId,
  coverAlt: 'Тестовый пиксель',
  sourceUrl: null,
}, editorId);
const publisher = createPublisher(db, {
  releasesRoot: resolve(root, 'article-releases'),
  publicOrigin: 'https://oknotika.ru',
});
const keepAlive = setInterval(() => {}, 60_000);
await publisher.publish({
  editorId,
  transition: {
    type: 'publish', articleId: article.articleId, expectedRevisionId: article.revisionId,
  },
  inject: async boundary => {
    if (boundary === 'before-stage-render') {
      process.send?.({ locked: true, articleId: article.articleId, revisionId: article.revisionId, editorId });
      await new Promise(() => {});
    }
  },
});
clearInterval(keepAlive);
