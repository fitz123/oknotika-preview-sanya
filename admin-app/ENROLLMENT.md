# Первичное подключение редактора

Вход разрешается только по точной паре OIDC `issuer` + `sub`. Username, номер телефона, Telegram display name и числовое поле `id` из profile scope не используются как идентификатор доступа.

1. Женя создаёт отдельный Telegram Web Login для `admin.oknotika.ru` в BotFather и регистрирует ровно production origin и `https://admin.oknotika.ru/auth/callback`.
2. В обслуживаемом окне на VPS он получает `sub` Сани из серверно проверенного ID token: подпись по official JWKS, `RS256`, issuer, audience, expiry, issue time и nonce должны пройти те же проверки, что production callback. Значение нельзя брать из непроверенного JWT payload, сообщения, username или телефона.
3. Саня подтверждает вход, а Женя сверяет полученный `sub` с Саней по отдельному каналу. В release-evidence сохраняют только timestamp, подтверждающих лиц и SHA-256 fingerprint пары; сам ID token и секреты не сохраняют.
4. На остановленном сервисе Женя выполняет локально, не пересылая команду или вывод в Telegram:

   `npm run enroll -- --database /var/lib/oknotika-admin/db/admin.sqlite --issuer https://oauth.telegram.org --subject "$VERIFIED_TELEGRAM_SUBJECT"`

5. Команда откажется заменить другого редактора. Смена identity на другой `sub` намеренно не автоматизирована в MVP: сначала отключают текущего редактора (это немедленно отзывает все его сессии), затем проводят отдельное reviewed maintenance-изменение с backup/restore gate. Повторный enrollment разрешён только для той же пары.

До этой процедуры production admin vhost оставляют выключенным. В базе поддерживается ровно один configured editor; editor CRUD и RBAC отсутствуют намеренно.
