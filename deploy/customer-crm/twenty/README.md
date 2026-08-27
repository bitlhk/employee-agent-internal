# Twenty CRM Deployment

This deployment pins Twenty to `v2.35.0`. It is the human-maintained customer
system of record behind the EA `customer_context` service. Skills never access
Twenty or raw CRM records directly.

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
verified against the frozen model and records use unique-key upsert. Reimporting
unchanged profile content preserves its Runtime status; changed content is
written as `candidate` and must pass the explicit Promotion gate again.

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
  --api-key-output /secure/path/linggan-customer-integration.env
```

The output credential file must remain server-side with mode `0600`. Do not
put the API key in Asset metadata, Binding metadata, Receipts or Git.
The accepted import actor name is `灵感数据管理员`; technical architecture
names are not shown as the business creator or updater.

The deployed Twenty metadata uses the neutral API field `globalCustomerId` and
the user-facing label `全局客户编号`. The customer object is
`enterpriseCustomer`; product or architecture names do not enter business
object names. `CUST` is the stable `Customer` namespace prefix. It carries no
role, product, phone or organization semantics and therefore remains stable
when the same person is served by multiple business roles.

Current Demo customers use `demo_public`. New manually-created customers
default to `restricted` and require an active `customerAssignment` before a
user can discover or retrieve them. Role and purpose projections are applied
by `customer_context` after row-scope authorization.

The governed directory distinguishes the shared Demo pool from dedicated
customer ownership without duplicating customer rows:

- `scope=all` returns dedicated customers first, followed by the shared Demo
  pool;
- `scope=assigned` returns only customers with an active assignment for the
  current Runtime Principal;
- `scope=demo_public` returns only the shared Demo pool.

Every directory item exposes `accessScope`, `relationshipRole`,
`businessDomain` and `preferredForWrite`. Shared Demo customers remain useful
for read-only scenarios and principal-scoped activity records, but they are
not presented as exclusive ownership. Dedicated customers are the preferred
target for confirmed CRM work. Customer master-profile mutation remains a
separate governed capability and is not enabled by directory access.

`customer_context` pushes the authorized `globalCustomerId` and role-specific
profile types into the Twenty REST filter. Returned records are checked again
inside EA before they can become Runtime Context.

Customer assignments support `user`, `team`, and `role_adoption` principals.
The last form is reserved for stable Demo role instances such as
`lgj-lihongkun`; production employee ownership should use the enterprise
identity-backed `user` or `team` principal.

After profile Promotion, configure EA with `TWENTY_BASE_URL`, the server-side
`TWENTY_API_KEY` secret, the canonical CRM tenant, and an explicit Runtime
organization allowlist. Verify the real deployment identities before exposing
the path to users:

```bash
EA_CUSTOMER_CONTEXT_TWENTY_ENABLED=true \
EA_CUSTOMER_CONTEXT_TWENTY_PRODUCTION_READY=true \
pnpm customer-context:twenty:runtime:verify
```

The old wealth and insurance customer MCPs may remain available for one
rollback release, but Skills and Agent tool catalogs must expose only the
governed `customer_context` entry.

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
