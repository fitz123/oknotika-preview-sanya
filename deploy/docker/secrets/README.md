# Compose secret files

Create three extensionless files on the deployment host, beside this README:

- `telegram-oidc-client-id`
- `telegram-oidc-client-secret`
- `weekly-ingest-token`

Each file must contain exactly one production value followed by a newline. Use
mode `0600`, do not commit the files, and do not rename any `.example` file into
place until the real value is written on the deployment host. The examples are
deliberately invalid placeholders and are never mounted by Compose.
