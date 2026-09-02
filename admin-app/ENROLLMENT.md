# Первичное подключение локального редактора

Доступ имеет один local identity: точный username и versioned scrypt password
record. Пароль не хранится в Git, ZIP, Compose environment, argv, shell history,
logs, SQLite или документации. Редактор по-прежнему управляет только новостями
и статьями; регистрации, второго пользователя, ролей и reset UI нет.

## Поддерживаемая настройка Docker production

1. Подготовить root-controlled runtime directories и weekly token, затем собрать
   admin image по `deploy/docker/README_ZHENYA.md`. Admin должен быть остановлен.
2. Из локального root terminal запустить только
   `deploy/docker/configure-local-credentials.sh`. Helper отдельно спрашивает
   username и пароль дважды; пароль передаётся Node hasher только через stdin.
3. Helper требует минимум 14 символов, создаёт стойкий scrypt record, проверяет
   отсутствие конфликтующей identity, делает SQLite snapshot до миграции,
   настраивает singleton editor и отзывает sessions при rotation.
4. Два credential record получают `root:1000 0640` внутри immutable generation;
   symlink `local-credentials/current` переключается атомарно. В stdout нет
   username, password или hash — только generation и snapshot names.
5. Запустить admin, выполнить local login/logout и проверить закрытый список
   новостей. Неверный username и пароль должны давать одну общую ошибку.

Точные команды initial setup, rotation, guarded rollback и вывод старого
Telegram relay/override находятся в `deploy/docker/README_ZHENYA.md`.

## Rotation и rollback

Rotation разрешена только для того же username. Helper сначала сохраняет
verified SQLite snapshot, затем меняет credential fingerprint; все действующие
sessions получают `credential-rotated`. Другой username, Telegram/OIDC identity,
несовпавшее повторение пароля или неполный generation отклоняются без promotion.

Если live login новым паролем не прошёл, использовать только точный
`snapshotName`, выданный успешным helper run. Guarded `--rollback` принимает
snapshot активного generation, проверяет SQLite integrity, возвращает прежнюю
DB/credential pair и отзывает восстановленные sessions с причиной
`credential-rollback`. Plaintext при rollback не нужен и не восстанавливается.

До pass не удалять предыдущий generation, SQLite snapshot или автоматически
созданный `rollback-safety-*` snapshot. Не править credential files, `current`
или SQLite вручную.

## Проверка редактора

После входа проверить состояния «Черновик», preview и ручной publish без
публикации тестового материала. В social form должны быть четыре точных
non-secret default: Telegram `https://t.me/oknotika`, YouTube
`https://youtube.com/@oknotika`, VK `https://vk.ru/oknotika` и FUTUCHAT
`https://t.me/FUTU_CHAT`. Telegram destination остаётся фиксированным;
очищенное optional-поле не должно создавать пустую публичную ссылку.

Weekly ingestion требует enabled singleton editor-владельца, но отдельный
bearer token не является editor session и не получает upload/list/preview/
publish/withdraw/restore/rollback authority.
