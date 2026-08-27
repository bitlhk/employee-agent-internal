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
5. Verify `curl --fail http://192.168.0.102:3000/healthz` on the CRM host.

## Initialize the Customer Model

Generate the governed import bundle first, then initialize the CRM through the
Twenty metadata and REST APIs. The command is idempotent: custom fields are
verified against the frozen model and records use unique-key upsert.

The Demo bundle may compose insurance source records and a governed wealth MCP
export. Both enter the same customer and domain-profile model. Missing source
facts remain missing; the importer never fills a role's field set with inferred
or fabricated values.

```bash
pnpm customer-crm:prepare-demo -- \
  --insurance-input /secure/path/insurance-customers.json \
  --wealth-input /secure/path/wealth-customer-mcp-export.v1.json \
  --tenant-id tn_linggan_finance \
  --output-dir /secure/path/customer-crm-import
```

```bash
TWENTY_BASE_URL=http://crm-host:3000 \
TWENTY_ADMIN_EMAIL=linggan-admin@linggan.demo \
TWENTY_ADMIN_PASSWORD='...' \
pnpm customer-crm:bootstrap-twenty -- \
  --bundle /secure/path/customer-crm-import-bundle.v1.json \
  --api-key-output /secure/path/grace-integration.env
```

The output credential file must remain server-side with mode `0600`. Do not
put the API key in Asset metadata, Binding metadata, Receipts or Git.
The accepted import actor name is `灵感数据管理员`; technical architecture
names are not shown as the business creator or updater.

The deployed Twenty metadata keeps the internal API field name
`graceCustomerId` for migration compatibility. Its user-facing label and value
are the neutral `全局客户编号` and `CUST-xxxxxx`; Skills and users do not consume
the internal field name.

## Manual Customer Creation

Twenty creates records before users fill the remaining fields. Therefore the
Global Customer ID is nullable only at the API boundary and read-only in the
UI. A database trigger assigns it atomically before persistence; persisted
customer records still require a unique Global Customer ID.

Install the allocator before making the customer object available to users:

```bash
docker compose exec -T db sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < deploy/customer-crm/twenty/customer-id-allocation.sql

set -a
. /secure/path/linggan-customer-integration.env
set +a
pnpm customer-crm:manual-create:configure
```

Manual IDs use the reserved `CUST-900001` and above range. The same trigger
sets new UI-created customers to `draft`, assigns the canonical tenant and
records the creation time. A draft customer does not enter Runtime until a
governed source mapping and eligible domain profile are added.

The server port may be exposed for initial Demo setup. Production-like access
must use a dedicated HTTPS hostname and a reverse proxy before any non-Demo
data is imported.

The accepted administrator hostname is `crm.demo.linggan.top`. Its DNS A
record points to the shared ingress host. The ingress Nginx connects to Twenty
at `192.168.0.102:3000` over the private VPC. The CRM security group accepts
that port only from the ingress private address `192.168.0.210/32`; port `3000`
is never exposed as a public CRM entry point.

## Backup

The minimum recoverable unit is the PostgreSQL dump plus the
`server-local-data` volume. CRM backup does not replace GRACE Asset, Binding,
Context Receipt or Execution Receipt backups.
