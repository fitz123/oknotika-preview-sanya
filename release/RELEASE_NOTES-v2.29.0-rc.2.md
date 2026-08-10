# ОКНОТИКА v2.29.0-rc.2 — CI/CD candidate для Жени

Новый deterministic secret-free candidate актуального многостраничного сайта ОКНОТИКИ и закрытого Telegram OIDC-редактора раздела «Новости» / «Дайджеста недели». Он добавляет reviewed CI/CD deploy sources, но ничего не активирует: current default branch остаётся `master`, production credentials/server facts не созданы, merge/deploy/DNS/TLS остаются внешними gates Жени. `v2.29.0-rc.1` сохранён как исторический handoff и не изменён.

## Идентификация

- Verified implementation SHA: `f0480c5f5bada2280cc318aa18842fa0b48b278f`.
- V2.27 baseline SHA: `5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed`.
- Архив, stable copy и historical rc.1 проверяются через `SHA256SUMS`.
- Полный inventory: `CHANGED_FILES-v2.29.0-rc.2.txt`; внутри архива — `CHANGED_FILES.txt`.

## Что добавлено в rc.2

- secret-free pull request CI и reusable gate с exact Node.js `24.18.0` и pinned GitHub Actions;
- deterministic SHA-addressed deploy bundle с internal file/checksum manifest и secret/runtime boundary;
- root-controlled server primitive для immutable application/marketing releases, unprivileged preflight/smoke, bounded readiness healthcheck и retry-safe automatic rollback обоих symlink без content rollback;
- production workflow только для будущего protected `main`, с ручным допуском GitHub Environment `production`;
- restricted SSH upload helper с local artifact checksum, pinned known-host identity и fixed remote primitive;
- activation runbook для deploy account/root script, protected-main migration, first bootstrap, routine evidence и emergency rollback.

Пакет по-прежнему содержит Tuesday weekly ingestion, ручную проверку/публикацию Саней, weekly-ingestion HTTPS smoke, точные CTA `https://t.me/oknotika`, `https://youtube.com/@oknotika`, `https://vk.ru/oknotika`, `https://t.me/FUTU_CHAT`, nginx/systemd, backup/restore и отдельные content/application/marketing rollback procedures.

## Критическая граница установки

Полный technical ZIP нельзя копировать в nginx document root. Production deploy строит отдельный public/application bundle по exact protected-main commit, а marketing release устанавливает только public allowlist. GitHub получает лишь restricted SSH deploy credential и pinned host identity; Telegram OIDC, weekly-ingestion, restic credentials, editor identity, DB/uploads/previews и private payloads остаются вне GitHub и release artifacts.

## Обязательные external gates

- создать protected `main` только из утверждённого commit и оставить feature branch/tag/manual deploy запрещёнными;
- создать GitHub Environment `production`, назначить Женю required reviewer и ограничить deployment branch до `main`;
- вручную установить root-owned `/usr/local/sbin/oknotika-deploy` и `/usr/local/sbin/oknotika-install-marketing`, restricted deploy account/key и независимо сверенный SSH host key;
- выполнить первый application/marketing bootstrap до включения workflow, потому что primitive fail-closed требует оба previous symlink;
- завершить DNS/TLS, encrypted credentials, verified enrollment, live auth/public/weekly smoke и encrypted off-host restore drill.

Подробный порядок и exact GitHub secret names: `deploy/README_ZHENYA.md`. Этот candidate не выполняет merge, default-branch migration, Environment creation, server installation или deployment.
