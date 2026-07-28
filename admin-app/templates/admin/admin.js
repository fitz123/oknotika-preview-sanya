const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
const statusNode = document.querySelector('#status');
const articleForm = document.querySelector('#article-form');
const socialForm = document.querySelector('#social-form');

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'x-csrf-token': csrf, ...(options.headers ?? {}) },
  });
  const payload = response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : null;
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
  return payload;
}

function report(message) {
  statusNode.textContent = message;
}

articleForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const fields = new FormData(articleForm);
    let coverAssetId = Number(fields.get('coverAssetId'));
    const cover = fields.get('cover');
    if (cover?.size) {
      const uploaded = await api('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': cover.type },
        body: cover,
      });
      coverAssetId = uploaded.assetId;
    }
    const article = {
      title: fields.get('title'),
      publicationDate: fields.get('publicationDate'),
      lead: fields.get('lead'),
      bodyMarkdown: fields.get('bodyMarkdown'),
      coverAssetId,
      coverAlt: fields.get('coverAlt'),
      sourceUrls: String(fields.get('sourceUrls'))
        .split(/\r?\n/)
        .map(value => value.trim())
        .filter(Boolean),
    };
    const articleId = fields.get('articleId');
    if (articleId) {
      await api(`/api/articles/${articleId}/revisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ article, expectedRevisionId: Number(fields.get('expectedRevisionId')) }),
      });
    } else {
      await api('/api/articles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(article),
      });
    }
    location.reload();
  } catch (error) {
    report(error.message);
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  try {
    if (button.dataset.action === 'edit') {
      const { articles } = await api('/api/articles');
      const article = articles.find((item) => String(item.id) === button.dataset.id);
      for (const field of ['title', 'lead', 'bodyMarkdown', 'coverAlt']) {
        articleForm.elements[field].value = article[field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] ?? '';
      }
      articleForm.elements.sourceUrls.value = article.source_urls.join('\n');
      articleForm.elements.publicationDate.value = new Date(article.publication_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
      articleForm.elements.articleId.value = article.id;
      articleForm.elements.expectedRevisionId.value = article.current_revision_id;
      articleForm.elements.coverAssetId.value = article.cover_asset_id;
      articleForm.scrollIntoView();
      return;
    }
    if (button.dataset.action === 'preview') {
      const result = await api(`/api/revisions/${button.dataset.revision}/preview`, { method: 'POST' });
      location.assign(result.previewUrl);
      return;
    }
    if (button.dataset.action === 'restore') {
      if (!confirm('RESTORE: вернуть выбранную редакцию как новый черновик?')) return;
      await api(`/api/articles/${button.dataset.id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceRevisionId: Number(button.dataset.source),
          expectedRevisionId: Number(button.dataset.revision),
          confirmation: 'RESTORE',
        }),
      });
      location.reload();
      return;
    }
    const confirmation = button.dataset.action === 'publish' ? 'PUBLISH' : 'WITHDRAW';
    const prompt = button.dataset.action === 'publish'
      ? 'Опубликовать текущую редакцию на сайте?'
      : 'Снять материал с публикации?';
    if (!confirm(prompt)) return;
    await api(`/api/articles/${button.dataset.id}/${button.dataset.action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation, expectedRevisionId: Number(button.dataset.revision) }),
    });
    report(button.dataset.action === 'publish'
      ? 'Дайджест опубликован.'
      : 'Дайджест снят с публикации.');
    location.reload();
  } catch (error) {
    report(error.message);
  }
});

socialForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    if (!confirm('Обновить ссылки во всех опубликованных дайджестах?')) return;
    const fields = new FormData(socialForm);
    await api('/api/social-links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        telegramUrl: fields.get('telegramUrl'),
        youtubeUrl: fields.get('youtubeUrl'),
        vkUrl: fields.get('vkUrl'),
        confirmation: 'SOCIAL_LINKS',
      }),
    });
    report('Ссылки социальных сетей опубликованы.');
    location.reload();
  } catch (error) {
    report(error.message);
  }
});

document.querySelector('#logout').addEventListener('submit', async (event) => {
  event.preventDefault();
  await api('/logout', { method: 'POST' });
  location.assign('/login');
});
