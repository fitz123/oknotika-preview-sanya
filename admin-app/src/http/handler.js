import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_AUTH_FAILURE } from '../auth/local.js';
import {
  LOGIN_BODY_MAXIMUM,
  LOGIN_CSRF_COOKIE,
  loginCsrfCookie,
} from '../auth/login.js';
import {
  expireCookie,
  readUniqueCookie,
  SESSION_COOKIE,
  sessionCookie,
} from '../auth/sessions.js';
import { WEEKLY_INGESTION_BODY_MAXIMUM } from '../content/validation.js';
import { WEEKLY_INGESTION_PATH } from './ingestion-auth.js';
import { assertLoginRequest, assertMutationRequest, httpError } from './security.js';

const TEMPLATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../templates/admin');

export function createAdminHandler({
  adminOrigin,
  localAuthenticator,
  loginCsrfService,
  sessionService,
  actions,
  weeklyIngestion,
  ingestionAuthenticator,
  previewsRoot,
} = {}) {
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (url.origin !== adminOrigin) throw httpError(400, 'Request origin is not canonical');

      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        return new Response(null, {
          status: 204,
          headers: {
            'cache-control': 'public, max-age=86400',
            'x-content-type-options': 'nosniff',
            'x-robots-tag': 'noindex, nofollow, noarchive',
          },
        });
      }
      if (request.method === 'GET' && url.pathname === '/login') {
        if (sessionService.authenticate(request.headers.get('cookie'))) return redirect('/');
        return renderLogin(loginCsrfService);
      }
      if (request.method === 'POST' && url.pathname === '/login') {
        try {
          assertLoginRequest(request, adminOrigin);
          const form = await readLoginForm(request);
          loginCsrfService.consume({
            token: form.csrfToken,
            browserBinding: readUniqueCookie(request.headers.get('cookie'), LOGIN_CSRF_COOKIE),
          });
          const authenticated = await localAuthenticator.authenticate(form);
          const session = sessionService.create(authenticated.editorId);
          return redirect('/', [
            sessionCookie(session.token),
            expireCookie(LOGIN_CSRF_COOKIE),
          ]);
        } catch (error) {
          if (error.code === 'INVALID_LOCAL_CREDENTIALS') {
            return renderLogin(loginCsrfService, { status: 401, error: LOCAL_AUTH_FAILURE });
          }
          if (error.code === 'INVALID_LOGIN_CSRF' || Number.isInteger(error.status)) {
            const status = error.code === 'INVALID_LOGIN_CSRF' ? 403 : error.status;
            return renderLogin(loginCsrfService, {
              status,
              error: 'Запрос на вход недействителен. Обновите страницу и попробуйте снова.',
            });
          }
          throw error;
        }
      }
      if (request.method === 'GET' && url.pathname === '/admin.css') {
        return response(readTemplate('admin.css'), 200, 'text/css; charset=utf-8');
      }
      if (request.method === 'POST' && url.pathname === WEEKLY_INGESTION_PATH) {
        if (!ingestionAuthenticator?.authenticate(request.headers.get('authorization'))) {
          throw httpError(401, 'Authentication required');
        }
        const body = await readJson(request, WEEKLY_INGESTION_BODY_MAXIMUM);
        const result = weeklyIngestion.upsertDraft(body);
        return json(result, result.created ? 201 : 200);
      }

      const session = sessionService.authenticate(request.headers.get('cookie'));
      if (!session) {
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/previews/')) {
          throw httpError(401, 'Authentication required');
        }
        return redirect('/login');
      }
      assertMutationRequest(request, { adminOrigin, session, sessionService });

      if (request.method === 'POST' && url.pathname === '/logout') {
        sessionService.revoke(request.headers.get('cookie'));
        return redirect('/login', [expireCookie(SESSION_COOKIE)]);
      }
      if (request.method === 'GET' && url.pathname === '/') {
        return html(renderDashboard(actions, session));
      }
      if (request.method === 'GET' && url.pathname === '/admin.js') {
        return response(readTemplate('admin.js'), 200, 'text/javascript; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/api/articles') {
        return json({ articles: actions.listArticles() });
      }
      if (request.method === 'GET' && url.pathname === '/api/social-links') {
        return json(actions.getSocialLinks());
      }
      if (request.method === 'POST' && url.pathname === '/api/articles') {
        const body = await readJson(request);
        return json(actions.createDraft(body, Number(session.editor_id)), 201);
      }
      if (request.method === 'POST' && url.pathname === '/api/social-links') {
        const body = await readJson(request);
        const { confirmation, ...links } = body;
        return json(await actions.configureSocialLinks(
          links,
          Number(session.editor_id),
          confirmation,
        ));
      }
      const reviseMatch = /^\/api\/articles\/(\d+)\/revisions$/.exec(url.pathname);
      if (request.method === 'POST' && reviseMatch) {
        const body = await readJson(request);
        return json(actions.reviseDraft(
          reviseMatch[1], body.article, Number(session.editor_id), body.expectedRevisionId,
        ), 201);
      }
      const previewMatch = /^\/api\/revisions\/(\d+)\/preview$/.exec(url.pathname);
      if (request.method === 'POST' && previewMatch) {
        const preview = actions.preview(previewMatch[1], Number(session.editor_id));
        return json({ previewUrl: `/previews/${preview.previewId}/` }, 201);
      }
      const publishMatch = /^\/api\/articles\/(\d+)\/publish$/.exec(url.pathname);
      if (request.method === 'POST' && publishMatch) {
        const body = await readJson(request);
        const manifest = await actions.publish(
          publishMatch[1], body.expectedRevisionId, Number(session.editor_id), body.confirmation,
        );
        return json({ releaseId: manifest.releaseId });
      }
      const withdrawMatch = /^\/api\/articles\/(\d+)\/withdraw$/.exec(url.pathname);
      if (request.method === 'POST' && withdrawMatch) {
        const body = await readJson(request);
        const manifest = await actions.withdraw(
          withdrawMatch[1], body.expectedRevisionId, Number(session.editor_id), body.confirmation,
        );
        return json({ releaseId: manifest.releaseId });
      }
      const restoreMatch = /^\/api\/articles\/(\d+)\/restore$/.exec(url.pathname);
      if (request.method === 'POST' && restoreMatch) {
        const body = await readJson(request);
        const revisionId = actions.restoreRevision(
          restoreMatch[1], body.sourceRevisionId, body.expectedRevisionId,
          Number(session.editor_id), body.confirmation,
        );
        return json({ revisionId }, 201);
      }
      const deleteMatch = /^\/api\/articles\/(\d+)\/delete$/.exec(url.pathname);
      if (request.method === 'POST' && deleteMatch) {
        const body = await readJson(request);
        const result = actions.deleteDraft(
          deleteMatch[1], body.expectedRevisionId,
          Number(session.editor_id), body.confirmation,
        );
        return result.status === 'not_found'
          ? json({ ...result, error: 'Draft not found' }, 404)
          : json(result);
      }
      if (request.method === 'POST' && url.pathname === '/api/uploads') {
        const length = Number(request.headers.get('content-length') ?? 0);
        if (length > 10 * 1024 * 1024) throw httpError(413, 'Upload is larger than 10 MB');
        const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        const bytes = Buffer.from(await request.arrayBuffer());
        return json(await actions.upload(bytes, mediaType, Number(session.editor_id)), 201);
      }
      const privatePreview = /^\/previews\/([A-Za-z0-9_-]{32})\/(|cover\.(?:jpg|png|webp)|style\.css|logo\.svg)$/.exec(url.pathname);
      if (request.method === 'GET' && privatePreview) {
        const filename = privatePreview[2] || 'index.html';
        const path = resolve(previewsRoot, privatePreview[1], filename);
        const mediaType = filename.endsWith('.html') ? 'text/html; charset=utf-8'
          : filename.endsWith('.css') ? 'text/css; charset=utf-8'
            : filename.endsWith('.svg') ? 'image/svg+xml'
              : filename.endsWith('.png') ? 'image/png'
                : filename.endsWith('.jpg') ? 'image/jpeg' : 'image/webp';
        return response(readFileSync(path), 200, mediaType, {
          'x-robots-tag': 'noindex, nofollow, noarchive',
        });
      }
      throw httpError(404, 'Not found');
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : clientError(error) ? 400 : 500;
      const message = status === 500 ? 'Internal server error' : error.message;
      return json({ error: message }, status);
    }
  };
}

function renderDashboard(actions, session) {
  const articles = actions.listArticles();
  const rows = articles.length === 0
    ? '<div class="empty-state">Пока нет черновиков. Новый дайджест можно создать в форме выше.</div>'
    : articles.map((article) => `
      <article class="material-card">
        <div class="material-card__top">
          <div>
            <p class="eyebrow">Дайджест недели${article.weekly_issue_id ? ` · ${escapeHtml(article.weekly_issue_id)}` : ''}</p>
            <h3>${escapeHtml(article.title)}</h3>
          </div>
          ${renderState(article)}
        </div>
        <p class="material-card__meta">
          Последнее изменение: <time datetime="${escapeAttribute(article.updated_at)}">${escapeHtml(formatMoscowDateTime(article.updated_at))}</time>
          · редакция № ${article.revision_number}
          · ${article.source_urls.length} ${pluralSources(article.source_urls.length)}
        </p>
        ${renderPublicStatus(article)}
        <div class="material-card__actions">
          <button type="button" class="button button--quiet" data-action="edit" data-id="${article.id}">Редактировать</button>
          <button type="button" class="button button--quiet" data-action="preview" data-revision="${article.current_revision_id}">Предпросмотр</button>
          ${article.state !== 'published'
            ? `<button type="button" class="button button--primary" data-action="publish" data-id="${article.id}" data-revision="${article.current_revision_id}">Опубликовать</button>`
            : ''}
          ${article.public_state === 'published'
            ? `<button type="button" class="button button--danger" data-action="withdraw" data-id="${article.id}" data-revision="${article.current_revision_id}">Снять с публикации</button>`
            : ''}
          ${article.deletion_eligible
            ? `<button type="button" class="button button--danger" data-action="delete" data-id="${article.id}" data-revision="${article.current_revision_id}">Удалить навсегда</button>`
            : ''}
        </div>
        ${renderRevisions(actions.listRevisions(article.id), article)}
      </article>`).join('');
  const social = actions.getSocialLinks();
  return interpolate(readTemplate('dashboard.html'), {
    csrfToken: escapeAttribute(session.csrf_token ?? ''),
    rows,
    telegramUrl: escapeAttribute(social.telegramUrl),
    youtubeUrl: escapeAttribute(social.youtubeUrl ?? ''),
    vkUrl: escapeAttribute(social.vkUrl ?? ''),
    futuchatUrl: escapeAttribute(social.futuchatUrl ?? ''),
    telegramStatus: renderSocialStatus('Telegram', social.telegramUrl),
    youtubeStatus: renderSocialStatus('YouTube', social.youtubeUrl),
    vkStatus: renderSocialStatus('VK', social.vkUrl),
    futuchatStatus: renderSocialStatus('FUTUCHAT', social.futuchatUrl),
  });
}

function renderRevisions(revisions, article) {
  if (revisions.length < 2) return '';
  const items = revisions.map((revision) => revision.id === article.current_revision_id
    ? `<li><span>№ ${revision.revision_number} · текущая · ${escapeHtml(formatMoscowDateTime(revision.created_at))}</span></li>`
    : `<li><span>№ ${revision.revision_number} · ${escapeHtml(revision.title)} · ${escapeHtml(formatMoscowDateTime(revision.created_at))}</span><button type="button" class="text-button" data-action="restore" data-id="${article.id}" data-source="${revision.id}" data-revision="${article.current_revision_id}">Вернуть как новый черновик</button></li>`).join('');
  return `<details class="revisions"><summary>История редакций</summary><ul>${items}</ul></details>`;
}

function renderState(article) {
  const published = article.public_state === 'published'
    && Number(article.current_revision_id) === Number(article.published_revision_id);
  const label = published ? 'Опубликовано' : 'Черновик';
  const modifier = published ? 'published' : 'draft';
  return `<span class="state state--${modifier}">${label}</span>`;
}

function renderPublicStatus(article) {
  if (!article.public_url) {
    return article.public_state === 'withdrawn'
      ? '<p class="public-status">Материал снят с публикации. Текущая редакция остаётся черновиком.</p>'
      : '<p class="public-status">На сайте ещё не опубликован.</p>';
  }
  const draftNote = Number(article.current_revision_id) === Number(article.published_revision_id)
    ? ''
    : ' На сайте пока видна предыдущая редакция.';
  return `<p class="public-status public-status--live">Опубликовано: <a href="${escapeAttribute(article.public_url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(article.public_url)}</a>.${draftNote}</p>`;
}

function renderSocialStatus(name, url) {
  const modifier = url ? 'ready' : 'missing';
  const label = url ? 'настроен' : 'не настроен';
  return `<span class="social-status social-status--${modifier}">${escapeHtml(name)}: ${label}</span>`;
}

function formatMoscowDateTime(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value));
}

function pluralSources(count) {
  const remainder100 = count % 100;
  const remainder10 = count % 10;
  if (remainder100 >= 11 && remainder100 <= 14) return 'источников';
  if (remainder10 === 1) return 'источник';
  if (remainder10 >= 2 && remainder10 <= 4) return 'источника';
  return 'источников';
}

async function readJson(request, maximum = 1024 * 1024) {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw httpError(415, 'Content-Type must be application/json');
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > maximum) throw httpError(413, 'JSON request is too large');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw httpError(400, 'JSON request is invalid');
  }
}

async function readLoginForm(request) {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') {
    throw httpError(415, 'Login form Content-Type is invalid');
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > LOGIN_BODY_MAXIMUM) {
    throw httpError(413, 'Login form is too large');
  }
  const parameters = new URLSearchParams(text);
  for (const name of ['csrf', 'username', 'password']) {
    if (parameters.getAll(name).length !== 1) throw httpError(400, 'Login form is invalid');
  }
  return {
    csrfToken: parameters.get('csrf'),
    username: parameters.get('username'),
    password: parameters.get('password'),
  };
}

function renderLogin(loginCsrfService, { status = 200, error = '' } = {}) {
  const challenge = loginCsrfService.issue();
  const body = interpolate(readTemplate('login.html'), {
    csrfToken: escapeAttribute(challenge.token),
    loginError: error
      ? `<p class="login-card__error" role="alert">${escapeHtml(error)}</p>`
      : '',
  });
  return html(body, status, [loginCsrfCookie(challenge.browserBinding, challenge)]);
}

function html(body, status = 200, cookies = []) {
  return response(body, status, 'text/html; charset=utf-8', {}, cookies);
}

function json(body, status = 200) {
  return response(`${JSON.stringify(body)}\n`, status, 'application/json; charset=utf-8');
}

function redirect(location, cookies = []) {
  return response('', 303, 'text/plain; charset=utf-8', { location }, cookies);
}

function response(body, status, contentType, extraHeaders = {}, cookies = []) {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    ...extraHeaders,
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(body, { status, headers });
}

function readTemplate(name) {
  return readFileSync(resolve(TEMPLATE_ROOT, name), 'utf8');
}

function interpolate(template, values) {
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`Missing admin template value: ${key}`);
    return values[key];
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const escapeAttribute = escapeHtml;

function clientError(error) {
  return error instanceof TypeError
    || /required|invalid|allowed|conflict|confirmation|changed|found|published|withdrawn|revision|upload|mime|jpeg|png|webp|image|pixel|decoder/i.test(error.message);
}
