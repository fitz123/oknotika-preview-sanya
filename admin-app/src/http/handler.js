import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expireCookie,
  OIDC_BINDING_COOKIE,
  oidcBindingCookie,
  readUniqueCookie,
  SESSION_COOKIE,
  sessionCookie,
} from '../auth/sessions.js';
import { assertMutationRequest, assertSameOriginNavigation, httpError } from './security.js';

const TEMPLATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../templates/admin');

export function createAdminHandler({
  adminOrigin,
  oidcService,
  sessionService,
  actions,
  previewsRoot,
} = {}) {
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (url.origin !== adminOrigin) throw httpError(400, 'Request origin is not canonical');

      if (request.method === 'GET' && url.pathname === '/login') {
        return html(readTemplate('login.html'));
      }
      if (request.method === 'GET' && url.pathname === '/auth/start') {
        assertSameOriginNavigation(request, adminOrigin);
        const login = oidcService.beginAuthorization();
        return redirect(login.authorizationUrl, [oidcBindingCookie(login.browserBinding)]);
      }
      if (request.method === 'GET' && url.pathname === '/auth/callback') {
        const binding = readUniqueCookie(request.headers.get('cookie'), OIDC_BINDING_COOKIE);
        const result = await oidcService.finishAuthorization({ callbackUrl: request.url, browserBinding: binding });
        const session = sessionService.create(result.editorId);
        return redirect('/', [
          sessionCookie(session.token),
          expireCookie(OIDC_BINDING_COOKIE),
        ]);
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
      if (request.method === 'POST' && url.pathname === '/api/articles') {
        const body = await readJson(request);
        return json(actions.createDraft(body, Number(session.editor_id)), 201);
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
      if (request.method === 'POST' && url.pathname === '/api/releases/rollback') {
        const body = await readJson(request);
        const manifest = await actions.rollbackRelease(body.releaseId, Number(session.editor_id), body.confirmation);
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
    ? '<tr><td colspan="4">Пока нет черновиков.</td></tr>'
    : articles.map((article) => `
      <tr>
        <td>${escapeHtml(article.title)}</td>
        <td>${escapeHtml(article.state)}</td>
        <td>${escapeHtml(article.slug)}</td>
        <td>
          <button type="button" data-action="edit" data-id="${article.id}">Редактировать</button>
          <button type="button" data-action="preview" data-revision="${article.current_revision_id}">Preview</button>
          ${article.state !== 'published'
            ? `<button type="button" data-action="publish" data-id="${article.id}" data-revision="${article.current_revision_id}">Опубликовать</button>`
            : ''}
          ${article.public_state === 'published'
            ? `<button type="button" data-action="withdraw" data-id="${article.id}" data-revision="${article.current_revision_id}">Снять</button>`
            : ''}
          ${renderRevisions(actions.listRevisions(article.id), article)}
        </td>
      </tr>`).join('');
  const releases = actions.listReleases().map((release) => `
    <li>${escapeHtml(release.id)}${release.active ? ' · active' : ` · <button type="button" data-action="rollback" data-release="${escapeAttribute(release.id)}">Переключить</button>`}</li>
  `).join('') || '<li>Пока нет завершённых releases.</li>';
  return interpolate(readTemplate('dashboard.html'), {
    csrfToken: escapeAttribute(session.csrf_token ?? ''),
    rows,
    releases,
  });
}

function renderRevisions(revisions, article) {
  if (revisions.length < 2) return '';
  const items = revisions.map((revision) => revision.id === article.current_revision_id
    ? `<li>№ ${revision.revision_number} · текущая</li>`
    : `<li>№ ${revision.revision_number} · ${escapeHtml(revision.title)} · <button type="button" data-action="restore" data-id="${article.id}" data-source="${revision.id}" data-revision="${article.current_revision_id}">Вернуть как новый черновик</button></li>`).join('');
  return `<details><summary>История редакций</summary><ul>${items}</ul></details>`;
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw httpError(415, 'Content-Type must be application/json');
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw httpError(413, 'JSON request is too large');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw httpError(400, 'JSON request is invalid');
  }
}

function html(body) {
  return response(body, 200, 'text/html; charset=utf-8');
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
