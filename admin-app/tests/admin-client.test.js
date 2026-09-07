import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

test('mobile news editor wires weekly form, social links, preview, publish, withdraw, restore, delete and logout', async () => {
  const listeners = {};
  const formListeners = {};
  const socialListeners = {};
  const logoutListeners = {};
  const requests = [];
  const assigned = [];
  const confirmations = [];
  const storedNotices = new Map([['draftDeletionNotice', 'Предыдущее предупреждение']]);
  let reloads = 0;
  let formValues = new Map();
  const elements = Object.fromEntries([
    'title', 'publicationDate', 'lead', 'bodyMarkdown', 'coverAlt', 'sourceUrls',
    'articleId', 'expectedRevisionId', 'coverAssetId',
  ].map(name => [name, { value: '' }]));
  const articleForm = {
    elements,
    addEventListener: (name, callback) => { formListeners[name] = callback; },
    scrollIntoView: () => {},
  };
  const socialForm = {
    addEventListener: (name, callback) => { socialListeners[name] = callback; },
  };
  const logoutForm = { addEventListener: (name, callback) => { logoutListeners[name] = callback; } };
  const status = { textContent: '' };
  const articleRecord = {
    id: 5,
    title: 'Existing title',
    publication_at: '2026-07-09T21:00:00.000Z',
    lead: 'Existing lead',
    body_markdown: 'Existing body',
    cover_alt: 'Existing alt',
    source_url: 'https://example.com/source',
    source_urls: ['https://example.com/source', 'https://example.org/second-source'],
    current_revision_id: 11,
    cover_asset_id: 3,
  };
  const fetchImpl = async (path, options = {}) => {
    requests.push({ path, options });
    if (path === '/api/articles' && !options.method) return Response.json({ articles: [articleRecord] });
    if (path.includes('/preview')) return Response.json({ previewUrl: '/previews/token/' }, { status: 201 });
    if (path === '/api/uploads') return Response.json({ assetId: 19 }, { status: 201 });
    if (path === '/logout') return new Response('', { status: 200 });
    if (path.endsWith('/delete')) {
      return Response.json({
        status: 'deleted',
        articleId: 5,
        cleanup: { status: 'incomplete', failureCount: 1 },
      });
    }
    if (path.endsWith('/revisions') || path.endsWith('/restore') || path === '/api/articles') {
      return Response.json({ revisionId: 12, articleId: 5 }, { status: 201 });
    }
    return Response.json({ releaseId: 'release-1' });
  };
  const document = {
    querySelector(selector) {
      return ({
        'meta[name="csrf-token"]': { content: 'csrf-token' },
        '#status': status,
        '#article-form': articleForm,
        '#social-form': socialForm,
        '#logout': logoutForm,
      })[selector];
    },
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const source = readFileSync(resolve(import.meta.dirname, '../templates/admin/admin.js'), 'utf8');
  runInNewContext(source, {
    document,
    fetch: fetchImpl,
    FormData: class {
      constructor() { return { get: name => formValues.get(name) }; }
    },
    location: {
      reload: () => { reloads += 1; },
      assign: value => assigned.push(value),
    },
    confirm: (message) => {
      confirmations.push(message);
      return true;
    },
    sessionStorage: {
      getItem: key => storedNotices.get(key) ?? null,
      removeItem: key => storedNotices.delete(key),
      setItem: (key, value) => storedNotices.set(key, value),
    },
    Number,
    JSON,
  });

  assert.equal(status.textContent, 'Предыдущее предупреждение');
  assert.equal(storedNotices.has('draftDeletionNotice'), false);

  const click = dataset => listeners.click({
    target: { closest: () => ({ dataset }) },
  });
  await click({ action: 'edit', id: '5' });
  assert.equal(elements.title.value, articleRecord.title);
  assert.equal(elements.articleId.value, 5);
  assert.equal(elements.expectedRevisionId.value, 11);
  assert.equal(elements.sourceUrls.value, articleRecord.source_urls.join('\n'));

  await click({ action: 'preview', revision: '11' });
  assert.deepEqual(assigned, ['/previews/token/']);
  await click({ action: 'restore', id: '5', source: '7', revision: '11' });
  await click({ action: 'publish', id: '5', revision: '11' });
  await click({ action: 'withdraw', id: '5', revision: '11' });
  assert.ok(requests.some(request => request.path === '/api/articles/5/restore'));
  assert.ok(!requests.some(request => request.path === '/api/releases/rollback'));
  assert.ok(requests.some(request => request.path === '/api/articles/5/publish'));
  assert.ok(requests.some(request => request.path === '/api/articles/5/withdraw'));

  const deleteClick = {
    action: 'delete', id: '5', revision: '11', generation: 'a'.repeat(32),
  };
  await Promise.all([click(deleteClick), click(deleteClick)]);
  const deleteRequests = requests.filter(request => request.path === '/api/articles/5/delete');
  assert.equal(deleteRequests.length, 1);
  assert.deepEqual(JSON.parse(deleteRequests[0].options.body), {
    confirmation: 'DELETE_FOREVER',
    expectedRevisionId: 11,
    expectedGenerationToken: 'a'.repeat(32),
  });
  assert.match(confirmations.at(-1), /навсегда.*необратимо/i);
  assert.match(status.textContent, /очистка связанных файлов не завершена.*ошибок: 1/i);
  assert.equal(storedNotices.get('draftDeletionNotice'), status.textContent);

  formValues = new Map([
    ['title', 'New title'], ['publicationDate', '2026-07-14'], ['lead', 'Lead'],
    ['bodyMarkdown', 'Body'], ['coverAlt', 'Alt'],
    ['sourceUrls', 'https://example.com/one\n\n https://example.org/two '],
    ['articleId', ''], ['expectedRevisionId', ''], ['coverAssetId', '3'],
    ['cover', { size: 0 }],
  ]);
  await formListeners.submit({ preventDefault: () => {} });
  const createRequest = requests.find(request => request.path === '/api/articles' && request.options.method === 'POST');
  assert.deepEqual(
    JSON.parse(createRequest.options.body).sourceUrls,
    ['https://example.com/one', 'https://example.org/two'],
  );

  formValues.set('articleId', '5');
  formValues.set('expectedRevisionId', '11');
  formValues.set('cover', { size: 10, type: 'image/png' });
  await formListeners.submit({ preventDefault: () => {} });
  assert.ok(requests.some(request => request.path === '/api/uploads'));
  assert.ok(requests.some(request => request.path === '/api/articles/5/revisions'));

  formValues = new Map([
    ['telegramUrl', 'https://t.me/oknotika'],
    ['youtubeUrl', 'https://youtube.com/@oknotika'],
    ['vkUrl', 'https://vk.ru/oknotika'],
    ['futuchatUrl', 'https://t.me/FUTU_CHAT'],
  ]);
  await socialListeners.submit({ preventDefault: () => {} });
  const socialRequest = requests.find(request => request.path === '/api/social-links');
  assert.deepEqual(JSON.parse(socialRequest.options.body), {
    telegramUrl: 'https://t.me/oknotika',
    youtubeUrl: 'https://youtube.com/@oknotika',
    vkUrl: 'https://vk.ru/oknotika',
    futuchatUrl: 'https://t.me/FUTU_CHAT',
    confirmation: 'SOCIAL_LINKS',
  });
  assert.ok(reloads >= 6);

  await logoutListeners.submit({ preventDefault: () => {} });
  assert.equal(assigned.at(-1), '/login');
  assert.ok(requests.every(request => request.options.headers?.['x-csrf-token'] === 'csrf-token'));
});
