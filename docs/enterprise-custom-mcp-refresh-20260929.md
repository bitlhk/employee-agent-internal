# Enterprise custom MCP catalog refresh

## Scope and diagnosis

- Target adoption: `lgj-lihongkun`, enterprise Runtime.
- Custom MCP connection 6 was enabled/ready with 11 selected tools.
- Installation callbacks used the standalone `agent.reload_config` endpoint,
  not the enterprise per-user provisioning path.
- Enterprise custom gateway server identity and provisioning fingerprint did
  not include the selected tool catalog. Reusing an unchanged gateway could
  retain its old model-facing tool list.
- A ready discovery result or a published asset revision alone does not prove
  that a running agent has loaded the tools.

## Changes

- Enterprise capability refresh publishes the bound enterprise asset bundle;
  it no longer reloads the standalone process for an enterprise adoption.
- Before enterprise chat, read the enabled, ready, selected custom catalog.
  Include its digest in custom gateway identity and provisioning fingerprint.
- Reuse the existing per-user `tools.add` mechanism. Unchanged catalogs remain
  stable; changed catalogs invalidate the provisioning cache and reconnect the
  custom gateway. Other gateway identities remain unchanged.
- Credentials and OAuth state are not included in the catalog digest.
- Standalone reload behavior is retained. No governance bypass or prompt change.

## Validation

- `pnpm exec tsc --noEmit --pretty false`: passed.
- 45 tests passed across enterprise-runtime-adapter,
  jiuwenswarm-runtime-refresh, jiuwenswarm-gateway-client,
  custom-mcp-gateway and enterprise-mcp-provisioning-coordinator.
- Shanghai application health returned HTTP 200 after deployment.
- Runtime logged successful registration of all 11 restaurant tools.
- Read-only enterprise chat request `ea-custom-mcp-check-1790690021332`
  called `custom_6_get_shop_basics_680afed9`, received restaurant data and
  returned a final answer. No order, reservation or queue ticket was requested.
- Runtime evidence session:
  `sess_lgj-lihongkun_mcp_readonly_check_1790690021338`.
- The direct `tools.add` probe received no completion acknowledgement and
  expired after 90 seconds. Success is established by subsequent actual
  registration logs and chat tool/result events, not by that probe.
- Enterprise provisioning still uses the existing background RPC acceptance
  mechanism. This patch does not claim to add an end-to-end readiness ACK.
- SQL custom MCP receipt table had no rows for the read-only query; use the
  Runtime tool-call/result history as evidence, not that receipt table.

## Deployment and rollback

Only these production source files were updated, after matching their original
digests against local HEAD `5706428b`:

- `server/_core/enterprise-runtime-adapter.ts`
- `server/_core/jiuwenswarm-runtime-refresh.ts`
- `server/_core/jiuwenswarm-gateway-client.ts`

Shanghai service: PM2 `employee-agent`, port 5180. Only this application was
restarted; enterprise Runtime pods and other services were not restarted.

Backup on Shanghai:
`/root/employee-agent-deploy/custom-mcp-refresh-before-20260929.tgz`.

Rollback if required:

```sh
tar -xzf /root/employee-agent-deploy/custom-mcp-refresh-before-20260929.tgz \
  -C /root/employee-agent-deploy/current
pm2 restart employee-agent
curl -fsS http://127.0.0.1:5180/health
```

Rollback restores application source, not the already loaded restaurant tools.
No database schema, credentials, business records or tool selection was changed.
