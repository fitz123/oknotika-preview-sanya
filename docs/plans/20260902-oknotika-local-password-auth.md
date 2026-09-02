# Plan: ОКНОТИКА — локальный пароль для редактора новостей

## Goal

Заменить незавершённый Telegram OIDC-вход одним локальным аккаунтом для существующего редактора новостей и статей. Женя задаёт логин и пароль непосредственно на VPS; приложение хранит только стойкий хеш, сохраняет текущие защищённые сессии/CSRF/audit boundaries и не расширяет редактор на остальные разделы сайта. Итоговый handoff — небольшой incremental ZIP только с изменёнными файлами и понятная статическая HTML-инструкция, что заменить, удалить, запустить и проверить.

Approved base: `feature/oknotika-docker-compose-20260827` at `cead5dbf429cc00c77e30fbf781cd9451781800f`.

## Non-goals

- Не делать CMS для главной, товаров, команды, контактов или всего сайта.
- Не добавлять второго редактора, роли, RBAC, self-service registration, password reset UI или MFA.
- Не сохранять пароль в Git, ZIP, Compose environment, shell history, process arguments, logs, SQLite или документацию.
- Не оставлять Telegram OIDC как запасной публичный способ входа и не развивать текущий bootstrap flow.
- Не менять публичный контент/дизайн, Xray, Яндекс Метрику, MAX/WeChat transport, DNS или TLS.
- Не merge-ить ветки и не менять production автоматически в рамках Ralphex implementation run.
- Не пересобирать и не отправлять полный архив сайта: нужен incremental handoff для Жени.

## Context

- Текущий admin — Node.js 24 + `node:sqlite`; article revisions, immutable releases, session table, secure cookie, CSRF and audit history already exist.
- `configured_editors` structurally enforces one editor. Current production has no successfully enrolled editor.
- Current startup blocks on Telegram discovery and current login routes through `/auth/start` and `/auth/callback`.
- Docker production uses loopback `127.0.0.1:8000` behind host nginx. The server has a separate runtime-only bridge relay for outbound Telegram; local password auth must not depend on it.
- Credentials are mounted from root-controlled files under `/var/home/oknotika/admin-app/data/secrets/` and must remain outside images, Git and public roots.
- Sanya explicitly approved: Telegram login removed; one local password account; scope remains news/articles; Zhenya receives only changed files plus exact instructions.

## Validation Commands

```bash
cd admin-app
npm ci
npm run lint
npm test
npm run test:security
npm run build
npm run render:fixture
cd ..
python3 -m unittest discover -s tests -v
python3 scripts/check_deploy_package.py .
python3 scripts/check_final_documentation.py .
python3 scripts/build_docker_package.py --help
# Build and run the admin/public Compose stack in an isolated temp root,
# verify local credential setup, successful/failed login, logout/session revocation,
# loopback-only ports, persistence, and absence of secrets in images/artifacts.
```

## Tasks

### Task 1: Replace OIDC runtime auth with one local credential

**Goal:** Authenticate the existing singleton editor with a local username and scrypt password record without weakening current session/content boundaries.

**Serves:** Sanya's approved request to remove Telegram and use one login/password account only for news/articles.

- [ ] Add a strict versioned local-credential parser/verifier using Node's built-in cryptography, bounded scrypt parameters, constant-time comparisons and generic failed-login responses.
- [ ] Load username and password-hash records only from root-controlled credential files; reject plaintext/direct password configuration and malformed/weak records.
- [ ] Reuse the singleton `configured_editors` row and existing `admin_sessions`; initialize only the expected local identity, fail closed on a conflicting prior identity, and revoke active sessions when the stored credential fingerprint changes.
- [ ] Remove Telegram discovery/OIDC from application startup and public auth routes without changing weekly-ingestion authentication or article authorization.
- [ ] Add focused tests for valid/invalid credentials, malformed records, single-editor conflict, credential rotation/session revocation and secret non-disclosure.

### Task 2: Implement the local login surface and preserve web security

**Goal:** Provide a usable Russian login form with safe pre-auth and authenticated session behavior.

**Serves:** Sanya's requirement to sign in with a normal login/password while retaining a safe admin rather than `admin/admin`.

- [ ] Replace the Telegram button with username/password form POST handling and generic errors; keep secure `__Host-` session cookies, idle/absolute expiry and logout.
- [ ] Protect login submission with same-origin/fetch-metadata and a one-use or equivalently robust pre-auth CSRF mechanism; do not put credentials into URLs, HTML responses or logs.
- [ ] Update nginx rate limiting for the password-login endpoint and remove obsolete OIDC callback handling/log exceptions.
- [ ] Cover successful login, wrong username/password, CSRF/replay/cookie failures, session expiry/revocation and API access in security tests.

### Task 3: Make VPS credential setup and migration safe and simple

**Goal:** Let Zhenya configure or rotate the only editor directly on the server without exposing the password.

**Serves:** Sanya's explicit instruction that Zhenya sets the login/password on the VPS and receives exact operational steps.

- [ ] Replace Telegram Compose secrets with local username/password-hash secrets; keep files outside images and bind mounts/public roots.
- [ ] Add a root-run helper that prompts interactively for username/password twice, enforces a reasonable minimum, hashes through stdin without plaintext arguments/environment/history, writes files atomically with exact ownership/mode, backs up the database before identity migration, configures the local singleton editor and revokes old sessions.
- [ ] Make the helper safe for initial setup and password rotation, fail closed on conflicting identities or incomplete writes, and leave a recoverable rollback path that never restores plaintext.
- [ ] Update Docker health/smoke and deployment docs for start, login, password rotation and rollback; after successful local-login verification, explicitly remove/decommission obsolete Telegram secret files and the production-only Docker-to-Xray relay/override without changing Xray itself.

### Task 4: Produce a verified incremental handoff for Zhenya

**Goal:** Deliver only the changed files and a phone-readable exact instruction, not a full-site replacement.

**Serves:** Sanya's request to send Zhenya what changed and exactly what he must replace/remove/run.

- [ ] Produce a static JavaScript-free Russian HTML runbook covering the exact repository-relative changed files, backup, file placement, credential setup, image rebuild, safe restart, login smoke, rollback and obsolete OIDC/relay cleanup.
- [ ] Let the parent package only the reviewed changed files from the approved base, excluding secrets/runtime data and unchanged public assets; do not add a new repository packaging subsystem for this one-off handoff.
- [ ] Run focused tests plus the full repository suite and an isolated Docker Compose smoke proving public content unchanged, admin loopback-only, password login works, wrong credentials fail, rotation revokes sessions and restart preserves content.
- [ ] Re-read the final diff as a cut pass and report any production-only human steps without merging or mutating production.
