# Twenty CRM Deployment

This deployment pins Twenty to `v2.35.0`. It is the human-maintained Demo CRM
for GRACE customer data; it does not replace `customer_context` or expose raw
CRM records directly to Skills.

## Deploy

1. Copy this directory to `/opt/twenty` on the isolated CRM host.
2. Create `.env` from `.env.example`. Generate unique database and encryption
   secrets on the host; never commit them.
3. Preload the pinned images when the host cannot reach Docker Hub.
4. Run `docker compose config`, then `docker compose up -d`.
5. Verify `curl --fail http://127.0.0.1:3000/healthz`.

## Initialize the Customer Model

Generate the governed import bundle first, then initialize the CRM through the
Twenty metadata and REST APIs. The command is idempotent: custom fields are
verified against the frozen model and records use unique-key upsert.

```bash
TWENTY_BASE_URL=http://crm-host:3000 \
TWENTY_ADMIN_EMAIL=grace-admin@example.internal \
TWENTY_ADMIN_PASSWORD='...' \
pnpm customer-crm:bootstrap-twenty -- \
  --bundle /secure/path/customer-crm-import-bundle.v1.json \
  --api-key-output /secure/path/grace-integration.env
```

The output credential file must remain server-side with mode `0600`. Do not
put the API key in Asset metadata, Binding metadata, Receipts or Git.

The server port may be exposed for initial Demo setup. Production-like access
must use a dedicated HTTPS hostname and a reverse proxy before any non-Demo
data is imported.

## Backup

The minimum recoverable unit is the PostgreSQL dump plus the
`server-local-data` volume. CRM backup does not replace GRACE Asset, Binding,
Context Receipt or Execution Receipt backups.
