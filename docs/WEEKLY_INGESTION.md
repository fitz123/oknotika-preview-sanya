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
revision restore, release rollback and editor-management paths.

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
the cover must already be a registered private asset, and every source must be
a unique HTTPS URL without embedded credentials. `sourceUrls` supports 1–20
entries. The ingestion caller receives only identifiers for the draft it
created or updated; it cannot list assets or other private content.

`contentVersion` is the explicit overwrite rule:

- a new `issueId` must start at version 1;
- an identical retry of the same version returns the existing revision and
  creates no content or audit row;
- different content under an already used version returns HTTP 409;
- a greater version creates a new immutable revision only while the current
  revision is still the last machine-created revision;
- any manual edit, publication or withdrawal makes later machine updates
  return HTTP 409. The editor's work is never silently replaced.

All accepted machine changes remain drafts. Publication is always a separate
Telegram-authenticated editor action.

## Encrypted credential path

Generate one high-entropy token of at least 32 bytes through the approved
secret channel. Do not put it in Git, an environment file, a command argument,
cron text, Telegram, a ticket or logs.

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
