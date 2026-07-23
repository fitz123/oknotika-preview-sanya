# Production rehearsal: Telegram OIDC

This gate is intentionally executed only on Zhenya's Linux host after the dedicated corporate Telegram Web Login application, exact production redirect URI, encrypted client credentials, and Sanya's independently verified subject have been installed. Never paste credentials, ID tokens, authorization codes, cookies, or the subject into this file, Git, a ticket, shell history, or Telegram.

## Preconditions

- The beta ZIP checksum and release manifest are verified.
- `https://admin.oknotika.ru/auth/callback` is the only registered redirect URI.
- TLS and DNS are valid; admin nginx remains disabled for public traffic until enrollment is complete.
- Encrypted systemd credentials are installed with `root:root 0600` permissions.
- The allowlisted `(issuer, subject)` was obtained only from a fully verified ID token and confirmed with Sanya out of band.
- A verified pre-rehearsal backup exists and the public `/articles/` active symlink is healthy.

## Evidence-safe procedure

1. Run `nginx -t`, all four `systemd-analyze verify` commands from `deploy/README_ZHENYA.md`, and the local application gates. Record only pass/fail, UTC timestamps, release SHA, and tool versions.
2. Enable the admin service and admin vhost. Confirm `/login` returns `Cache-Control: no-store`, CSP with `frame-ancestors 'none'`, HSTS and `X-Content-Type-Options: nosniff`.
3. In a fresh private browser session, start login. Confirm Telegram displays the corporate application and exact `admin.oknotika.ru` callback. Complete login as the enrolled editor and confirm the dashboard loads.
4. Log out. Confirm the old session cookie no longer authenticates and a new login requires a fresh Authorization Code Flow.
5. Attempt login with a different Telegram account. Confirm access is denied after token validation and no editor/session is created.
6. Start a login and leave it beyond the configured state TTL; confirm the callback fails. Reuse a consumed callback; confirm replay fails. Do not record the code, state, nonce, verifier or token.
7. Disable the editor with the documented maintenance command. Confirm existing sessions are revoked and a fresh valid Telegram login is denied.
8. Re-enable only through the reviewed enrollment procedure, log in once, then rotate the client secret using encrypted credentials. Confirm the old credential is revoked only after the new login/logout cycle passes.
9. Stop the admin service and disable its vhost. Confirm the public homepage, `/articles/`, the current detail page and `/articles/latest.json` remain available.
10. Re-enable the service only after all checks pass. Run `deploy/scripts/smoke-test.sh` against both canonical HTTPS origins.

## Required evidence record

Create an operator-owned record outside the ZIP containing: release SHA and ZIP checksum; start/end UTC timestamps; operator and reviewer names; browser, nginx, systemd, Node and SQLite versions; pass/fail for login, logout, replay rejection, non-allowlist rejection, revocation, rotation, admin outage and live smoke tests; rollback decision; and references to protected server logs. Redact all identifiers and authentication material.

If any step fails, keep the admin vhost disabled, preserve protected logs/audit state, follow Emergency disable and Application rollback in `deploy/README_ZHENYA.md`, and leave the static public site untouched.
