# Первичное подключение редактора

Доверенная identity — только точная пара проверенных OIDC claims `issuer` + `sub`. Username, телефон и display name не используются как идентификатор доступа; декодированный без проверки JWT payload также не даёт доступ.

## Поддерживаемый bootstrap

1. Создать отдельное Telegram Web Login приложение, зарегистрировать exact callback `https://admin.oknotika.ru/auth/callback`, закрепить RS256 и загрузить client ID/secret как systemd encrypted credentials.
2. Подготовить production environment file и runtime-каталоги. Admin vhost пока не включать, обычный сервис остановить. DNS/TLS callback должны быть готовы; страница callback может вернуть ошибку, потому что URL нужен локальной bootstrap-команде.
3. Запустить `npm run bootstrap-editor` через transient systemd unit с теми же environment и encrypted credentials, как показано в `deploy/README_ZHENYA.md`. Команда создаёт server-side `state`, `nonce`, browser binding и PKCE S256 verifier, выдаёт одноразовый authorization URL, принимает полный callback URL через интерактивный prompt, обменивает code и проверяет discovery, подпись, `iss`, `aud`, `exp`, `iat`, `nonce`, exact redirect и signing algorithm.
4. После успешной проверки команда показывает `sub` и SHA-256 fingerprint только в локальном root terminal. Женя сверяет identity с Саней по отдельному согласованному каналу и вводит требуемую строку `ENROLL-<fingerprint>`. Скрипт сам записывает проверенную пару в SQLite; subject не попадает в shell history.
5. В release evidence сохраняют только timestamp, approvers и fingerprint. Callback URL, authorization code, ID token, client secret и subject не сохраняют и не пересылают.

Bootstrap откажется работать, если configured editor уже существует. Обычный `/auth/callback` также не может обойти allowlist: он создаёт сессию только для заранее enrolled пары.

## Повторное обслуживание

Команда `npm run enroll -- --database /var/lib/oknotika-admin/db/admin.sqlite --issuer https://oauth.telegram.org --subject "$VERIFIED_TELEGRAM_SUBJECT"` разрешена только для повторного включения той же уже проверенной пары в локальном maintenance-сеансе. Она не является способом извлечения или проверки `sub`.

Смена identity намеренно не автоматизирована: сначала остановить admin, сделать verified backup, выполнить `npm run disable-editor -- --database /var/lib/oknotika-admin/db/admin.sqlite`, проверить немедленный отзыв сессий, затем провести отдельное reviewed bootstrap-изменение. До завершения процедуры admin vhost остаётся выключенным; editor CRUD и RBAC отсутствуют намеренно.
