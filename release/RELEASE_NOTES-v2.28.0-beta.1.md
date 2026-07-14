# ОКНОТИКИ v2.28.0-beta.1

Beta-пакет сохраняет утверждённую композицию V2.27 и добавляет только согласованные контуры: шесть новых командных портретов при восьми карточках, роль Евгения Жалнина «Операционный директор», самостоятельный фасадный блок Schüco и закрытый Telegram OIDC редактор «Факта недели» со статической атомарной публикацией.

## Идентификация релиза

- Verified implementation SHA: `13463c6c64a5ff4ddacc0cd6cb8db6f2f35f67d3` (acceptance criteria complete before final documentation/package regeneration).
- V2.27 baseline SHA: `5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed`.
- Archive SHA-256 and byte/file counts: `release/release-manifest-v2.28.0-beta.1.json`.
- Проверяемые checksums двух имён одного архива: `release/SHA256SUMS`.
- Полный inventory отличий payload от baseline: `release/CHANGED_FILES-v2.28.0-beta.1.txt`; та же запись находится внутри ZIP как `CHANGED_FILES.txt`.

## Проверено локально

- V2.27 path/DOM/CSS allowlist, локальные ссылки, protected desktop pixel diff и responsive protected-DOM geometry на 1440/1280/1180/768/760/390 px.
- Команда на всех шести ширинах; алюминий и Schüco на desktop/mobile.
- Mocked OIDC: valid, forged, stale, replayed, wrong issuer/audience/algorithm, unknown key and non-allowlisted subject.
- Draft invisibility, authenticated no-store preview, publish, edit, withdraw/410, latest fallback, editorial restore and whole-release rollback.
- XSS, CSRF, unsafe URL, MIME confusion, oversized and excessive-pixel/decompression-bomb image rejection.
- Canonical/Open Graph metadata and deterministic Telegram link-preview simulation.
- Crash injection at every staging/render/rename/symlink/database boundary and startup reconciliation.
- Encrypted local restic repository backup, integrity check and isolated restore; restored pre-migration database downgrade rehearsal.
- Static public articles remain available with the admin HTTP service absent.
- Secret-free ZIP scanner rejects credentials, SQLite/WAL/SHM, uploads, private previews, raw shoot inputs, logs, runtime releases, unsafe paths, symlinks and manifest tampering.

## Production gates

Real Telegram login/logout/revocation and live Telegram link preview require the dedicated production application and credentials. Linux `nginx -t`, systemd verification, live HTTPS smoke tests and the encrypted off-host restic restore remain mandatory before activation. Follow `release-evidence/qa/PRODUCTION_OIDC_REHEARSAL.md` and `deploy/README_ZHENYA.md`; do not place secrets or identifiers in evidence.

## Install and rollback

Verify `release/SHA256SUMS` with `(cd release && sha256sum -c SHA256SUMS)`, unpack into a new immutable application/marketing release directory and follow `deploy/README_ZHENYA.md`. Content, marketing and application rollback are deliberately separate. Stopping or rolling back the admin application must not move the active public article release.
