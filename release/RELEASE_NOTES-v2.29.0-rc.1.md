# ОКНОТИКА v2.29.0-rc.1 — пакет для Жени

Production-candidate handoff актуального многостраничного сайта ОКНОТИКИ и закрытого Telegram OIDC-редактора раздела «Новости» / «Дайджеста недели». Сам архив production не активирует: DNS/TLS, encrypted credentials, verified enrollment Сани, Linux gates, live smoke и backup/restore остаются обязательными.

## Идентификация

- Verified implementation SHA: `0d7f2b5032b62ef373388dce62a063a43f4fb685`.
- V2.27 baseline SHA: `5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed`.
- Архив и стабильная копия проверяются через `SHA256SUMS`.
- Полный inventory: `CHANGED_FILES-v2.29.0-rc.1.txt`; внутри архива — `CHANGED_FILES.txt`.

## Что входит

- актуальная главная и отдельные страницы алюминия, ПВХ, Stoller, Carbon Glass, стекла, Protectapeel и умного окна;
- отдельная презентация сравнения двух редакций раздела АР с пробным форматом 10 000 ₽ и тарифной сеткой;
- финальная команда 3×3 из девяти человек;
- новые реальные портреты Александра Золотухина и Дмитрия Благочевского, переданные Саней 4 августа 2026 года;
- фотоматериалы RALUMA, обновлённые кейсы, блок «Рубикона», Яндекс.Карты и отзывы с отдельным consent;
- публичный раздел «Новости» и закрытый мобильный редактор «Дайджеста недели»;
- Tuesday weekly ingestion: draft-only создание/обновление еженедельного черновика;
- ручная проверка, редактирование, preview и публикация Саней через Telegram OIDC;
- точные CTA: `https://t.me/oknotika`, `https://youtube.com/@oknotika`, `https://vk.ru/oknotika`, `https://t.me/FUTU_CHAT`;
- nginx/systemd, миграции, backup/restore, rollback и weekly-ingestion HTTPS smoke scripts;
- обновлённые `sanitize-html` 2.17.6 и PostCSS 8.5.25; полный и production-only `npm audit` не находят известных уязвимостей.

## Критическая граница установки

Полный технический архив нельзя целиком копировать в nginx document root. Публичный marketing release устанавливается только через `deploy/scripts/install-marketing.sh` или из отдельно подготовленного public-only архива. `admin-app/`, `deploy/`, `docs/`, tests и runtime evidence остаются вне публичного webroot.

## Обязательные production gates

- DNS/TLS для `oknotika.ru` и `admin.oknotika.ru`;
- Node.js `24.18.0` и bundled SQLite `3.53.1`;
- encrypted Telegram OIDC, weekly-ingestion и restic credentials через systemd;
- verified enrollment Сани без сохранения subject/token в пакет или логи;
- `nginx -t`, `systemd-analyze verify`, live Telegram login/logout/revocation;
- draft-only weekly-ingestion HTTPS smoke;
- public smoke главной, продуктов и опубликованного дайджеста;
- encrypted off-host backup и isolated restore drill.

Подробный порядок: `deploy/README_ZHENYA.md`, `admin-app/ENROLLMENT.md`, `docs/WEEKLY_INGESTION.md`.
