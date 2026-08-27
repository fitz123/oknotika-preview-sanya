# Compose secret files

Create three extensionless files on the deployment host, beside this README:

- `telegram-oidc-client-id`
- `telegram-oidc-client-secret`
- `weekly-ingest-token`

Each file must contain exactly one production value followed by a newline. On
the Linux deployment host, use owner/group `root:1000` and mode `0640` so the
non-root admin container (`1000:1000`) can read the bind-mounted Compose secret.
Do not commit the files, and do not rename any `.example` file into place until
the real value is written on the deployment host. The examples are deliberately
invalid placeholders and are never mounted by Compose.
