# ОКНОТИКИ v2.28.0-beta.1

Beta-пакет сохраняет утверждённую композицию V2.27 и добавляет только согласованные контуры: шесть новых командных портретов при восьми карточках, роль Евгения Жалнина «Операционный директор», самостоятельный фасадный блок Schüco и закрытый Telegram OIDC редактор «Новости» / «Дайджеста недели» со статической атомарной публикацией.

## Идентификация релиза

- Verified implementation SHA: `e30d8bf6de5ee08423903b11c8d010db8686bf67` (weekly-news ingestion, exact four-destination social contract, mobile editor, public rendering and compatibility hardening complete before regeneration).
- V2.27 baseline SHA: `5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed`.
- Archive SHA-256 and byte/file counts: `release/release-manifest-v2.28.0-beta.1.json`.
- Проверяемые checksums двух имён одного архива: `release/SHA256SUMS`.
- Полный inventory отличий payload от baseline: `release/CHANGED_FILES-v2.28.0-beta.1.txt`; та же запись находится внутри ZIP как `CHANGED_FILES.txt`.

## Проверено локально

- V2.27 path/DOM/CSS allowlist, локальные ссылки, protected desktop pixel diff и responsive protected-DOM geometry на 1440/1280/1180/768/760/390 px.
- Команда на всех шести ширинах; алюминий и Schüco на desktop/mobile.
- Mocked OIDC: valid, forged, stale, replayed, wrong issuer/audience/algorithm, unknown key and non-allowlisted subject.
- Draft invisibility, authenticated no-store preview, publish, edit, withdraw/410, latest fallback, editorial restore and root-controlled whole-release rollback CLI.
- XSS, CSRF, unsafe URL, MIME confusion, oversized and excessive-pixel/decompression-bomb image rejection.
- Canonical/Open Graph metadata and deterministic Telegram link-preview simulation.
- Crash injection at every staging/render/rename/symlink/database boundary, startup reconciliation and durable operational-rollback audit recovery.
- Encrypted local restic repository backup, integrity check and isolated restore; restored pre-migration database downgrade rehearsal.
- Static public articles remain available with the admin HTTP service absent.
- Tuesday weekly ingestion authentication with transport-safe credential validation, 128 KiB contract, idempotent retry, manual-edit conflict and proof that the machine credential cannot publish.
- Exact 3–5-item weekly validation on ingestion/editor/restore/publication, durable publish/withdraw overwrite locks across rollback and exact `https://t.me/oknotika` enforcement.
- Validated reusable-cover registration, editor-denied operational rollback, confirmed social-link release activation and fail-closed production smoke response checks.
- Mobile «Новости» editor flow, rollback-compatible legacy source preservation, multiple verified source links, exact default Telegram `https://t.me/oknotika`, YouTube `https://youtube.com/@oknotika`, VK `https://vk.ru/oknotika` and FUTUCHAT `https://t.me/FUTU_CHAT` CTA, plus manual Friday publication.
- Public weekly rendering with 3–5 digest items while preserving the imported Al Bahr URL, canonical metadata, latest fallback and withdrawn HTTP 410 behavior.
- Secret-free ZIP scanner rejects credentials, SQLite/WAL/SHM, uploads, private previews, raw shoot inputs, logs, runtime releases, unsafe paths, symlinks and manifest tampering.

## Production gates

DNS/TLS, pinned Node/SQLite runtime, encrypted OIDC/weekly-ingestion/restic credentials, verified Sanya enrollment, real Telegram login/logout/revocation, Linux `nginx -t` and systemd verification, public/auth/weekly-ingestion HTTPS smoke tests and encrypted off-host restic restore remain mandatory before activation. Follow `release-evidence/qa/PRODUCTION_OIDC_REHEARSAL.md`, `docs/WEEKLY_INGESTION.md` and `deploy/README_ZHENYA.md`; do not place secrets, Tuesday payloads or identifiers in evidence.

## Install and rollback

Verify `release/SHA256SUMS` with `(cd release && sha256sum -c SHA256SUMS)`, unpack into a new immutable application/marketing release directory and follow `deploy/README_ZHENYA.md`. Content, marketing and application rollback are deliberately separate. Stopping or rolling back the admin application must not move the active public article release.
