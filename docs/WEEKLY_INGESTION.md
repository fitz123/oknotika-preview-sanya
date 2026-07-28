# Weekly-news draft ingestion

The Tuesday research job may call one capability:

```text
POST https://admin.oknotika.ru/api/ingestion/weekly-drafts
Authorization: Bearer <weekly-ingest-token>
Content-Type: application/json
```

The endpoint accepts at most 128 KiB. It can create or revise only the private
draft associated with one ISO week. The bearer token is not a Telegram editor
session and is rejected by article listing, preview, upload, publish, withdraw,
revision restore, social-link configuration, release rollback and
editor-management paths.

## Content contract

```json
{
  "issueId": "2026-W31",
  "contentVersion": 1,
  "article": {
    "title": "Дайджест недели",
    "publicationDate": "2026-07-31",
    "lead": "Главные новости оконной отрасли за неделю.",
    "bodyMarkdown": "1. Первая новость.\n\n2. Вторая новость.\n\n3. Третья новость.",
    "coverAssetId": 42,
    "coverAlt": "Обложка дайджеста недели",
    "sourceUrls": [
      "https://example.com/news/one",
      "https://example.org/news/two"
    ]
  }
}
```

Unknown fields are rejected. Text has bounded lengths, raw HTML is forbidden,
`bodyMarkdown` must be exactly one ordered list with 3–5 top-level editorial
items, the cover must already be a registered private asset, and every source
must be a unique HTTPS URL without embedded credentials. `sourceUrls` supports
1–20 entries. `publicationDate` must be a real calendar date in exact
`YYYY-MM-DD` form; permissive JavaScript date strings and timestamps are
rejected. The ingestion caller receives only identifiers for the draft it
created or updated; it cannot upload or list assets or other private content.

`contentVersion` is the explicit overwrite rule:

- `issueId` must identify a real ISO calendar week, and `contentVersion` must
  be a positive JavaScript-safe integer;
- a new `issueId` must start at version 1;
- an identical retry of the same version returns the existing revision and
  creates no content or audit row;
- different content under an already used version returns HTTP 409;
- a greater version creates a new immutable revision only while the current
  revision is still the last machine-created revision;
- any manual edit, publication or withdrawal makes later machine updates
  return HTTP 409. Publication/withdrawal history remains a permanent lock even
  if an operator later rolls back to a release from before the issue existed.
  The editor's work is never silently replaced.

All accepted machine changes remain drafts. Publication is always a separate
Telegram-authenticated editor action.

Social destinations are not part of the ingestion payload. Each immutable
publication snapshots the separately editor-controlled global values:
Telegram `https://t.me/oknotika`, YouTube
`https://youtube.com/@oknotika`, VK `https://vk.ru/oknotika` and FUTUCHAT
`https://t.me/FUTU_CHAT` are the shipped non-secret defaults. Telegram remains
fixed; YouTube, VK and FUTUCHAT are distinct optional fields, and a cleared
field is omitted from public markup. The Tuesday credential cannot read or
change this configuration.

## Response contract

A new issue returns HTTP 201:

```json
{
  "articleId": 8,
  "revisionId": 13,
  "slug": "daidzhest-nedeli-2026-w31",
  "issueId": "2026-W31",
  "contentVersion": 1,
  "created": true,
  "idempotent": false
}
```

An accepted higher version returns HTTP 200 with `created: false` and
`idempotent: false`. An identical retry returns HTTP 200 with `created: false`,
`idempotent: true` and the same article, revision, slug, issue and version
identifiers as the first accepted call.

| Status | Meaning |
| --- | --- |
| 200 | Existing draft updated, or an identical retry returned unchanged identifiers. |
| 201 | New private weekly draft created. |
| 400 | JSON or content fields are invalid. |
| 401 | Bearer token is absent or invalid. |
| 409 | Version reuse/ordering conflict, manual edit, or permanent publish/withdraw lock. |
| 413 | Request exceeds 128 KiB. |
| 415 | `Content-Type` is not `application/json`. |

No success response contains preview, public or release data.

## Reusable cover provisioning

The supported production workflow uses one approved reusable branded weekly
cover. Before enabling the Tuesday unit, Zhenya runs the root-controlled
`npm run register-weekly-cover` procedure in `deploy/README_ZHENYA.md`. The
command passes the image through the same MIME/signature, pixel-limit,
re-encoding and metadata-stripping path as an editor upload, stores it outside
the public root and prints its numeric `assetId`.

Zhenya hands that non-secret ID to the Tuesday payload generator through its
root-owned private configuration. The generator places it in `coverAssetId`;
the bearer token never receives upload or asset-list authority. Reuse the ID
until Sanya approves a replacement cover. Register a replacement through the
same command, update the private caller configuration atomically, perform an
identical-retry smoke, and only then retire the old caller-side ID. Never invent
an ID or derive it by scanning another private article.

## Encrypted credential path

Generate one high-entropy token of at least 32 printable ASCII characters
without whitespace or commas through the approved secret channel. Do not put it
in Git, an environment file, a command argument, cron text, Telegram, a ticket
or logs.

On the admin server, encrypt it as
`/etc/credstore.encrypted/weekly-ingest-token.cred` with
`systemd-creds encrypt --name=weekly-ingest-token - <path>`. The
`oknotika-admin.service` unit loads it with `LoadCredentialEncrypted` and sets
only the non-secret path
`OKNOTIKA_WEEKLY_INGEST_TOKEN_FILE=%d/weekly-ingest-token`. Node reads the
ephemeral file below the service's `/run/credentials/` directory.

The cron-side caller must receive the same token as its own encrypted systemd
credential, scoped to the research job unit. That unit should also use
`LoadCredentialEncrypted=weekly-ingest-token` and let the caller read
`%d/weekly-ingest-token` immediately before constructing the in-memory
`Authorization` header. The caller must redact that header and response bodies
from job logs. Do not export the token as an environment value or interpolate
it into `curl` arguments. Restrict both encrypted credential files to
`root:root 0600`.

Rotate by encrypting a new token under temporary server and caller credential
names, stopping both units, atomically replacing both `.cred` files, starting
the admin first, performing one draft-only ingestion smoke test, and then
reenabling the Tuesday job. Retire the old token only after the smoke test.

## Production smoke

After Sanya is enrolled and the reusable weekly cover has been registered and
its exact `assetId` placed in the private Tuesday payload configuration,
run `deploy/scripts/smoke-weekly-ingestion.mjs` inside the credential-scoped
Tuesday unit as documented in `deploy/README_ZHENYA.md`. The helper reads the
token only from a credential file, submits the real private payload twice,
requires an idempotent retry and verifies that the same bearer receives HTTP
401 from editorial listing and rollback capabilities. It prints no response
body or draft identifiers.

For an isolated local or one-shot diagnostic, `--token-file
/root-controlled/path/weekly-ingest-token` may override only the credential
file path. Keep that file outside Git and every public root as `root:root 0600`;
never place the token value itself in argv. Production runs must use the
credential-scoped unit and `CREDENTIALS_DIRECTORY` path above.

Sanya must then confirm that the result is a `Черновик` in `Новости`. The
public listing and `latest.json` must remain unchanged until his explicit
Friday publish. Never use a fabricated cover ID or replace any of the exact
YouTube, VK or FUTUCHAT destinations to make the smoke test pass.
