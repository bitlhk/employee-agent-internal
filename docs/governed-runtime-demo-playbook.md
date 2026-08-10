# Governed Runtime Demo Playbook

This playbook defines the first-party reference demonstration for Employee Agent governance. It is intentionally labeled **Demo** everywhere and writes only to an isolated demonstration table.

## Demo connector

- Display name: `财富业务演示 MCP（Demo）`
- Server ID: `wealth_governance_demo`
- Protocol: MCP Streamable HTTP
- Endpoint: `/api/demo/mcp/wealth-business`
- Authentication: EA short-lived ES256 enterprise MCP identity token
- Role grant: `wealth-manager`
- Data boundary: `governance_demo_business_records`; no real CRM connection

Tools:

| Tool | Side effect | Approval | Purpose |
|---|---|---|---|
| `demo_get_business_record` | read | never | Read an isolated Demo record |
| `demo_create_portfolio_draft` | write | always | Create an isolated portfolio draft |
| `demo_update_customer_profile` | write | always | Governance risk-classification probe |

`demo_update_customer_profile` deliberately advertises `readOnlyHint: true` from the remote MCP. The platform administrator policy still classifies it as `write`. This proves that external tool metadata cannot lower platform-inferred or administrator-configured risk.

## Enable locally or in staging

1. Configure the Enterprise MCP identity key pair documented in `mcp-service-trusted-identity-guide.md`.
2. Apply migrations:

   ```bash
   pnpm db:migrate
   ```

3. Enable the endpoint:

   ```bash
   EA_GOVERNANCE_DEMO_MCP_ENABLED=true
   ```

4. If the public URL differs from `PUBLIC_BASE_URL`, set both values consistently:

   ```bash
   EA_GOVERNANCE_DEMO_BASE_URL=https://work.example.com
   EA_GOVERNANCE_DEMO_MCP_RESOURCE_URI=https://work.example.com/api/demo/mcp/wealth-business
   ```

5. Register the managed connection, policies, and wealth-manager role grant:

   ```bash
   pnpm mcp:demo:configure
   ```

6. Restart the EA process and verify `/api/demo/mcp/wealth-business/health` returns `demo: true`.

The feature is disabled by default. Do not enable it in an environment where database migration `0012_governance_demo_evidence` has not been applied.

## Five-minute leader demonstration

Use a wealth-manager adoption and ask:

> 为张先生（Demo）创建一份 150 万元、C3 稳健型资产配置方案草稿。配置建议为现金管理 10%、固收 55%、固收增强 20%、权益 15%。这是演示数据，请创建 Demo 方案并使用稳定的幂等键。

Expected path:

1. The model selects `demo_create_portfolio_draft` from `财富业务演示 MCP（Demo）`.
2. The Enterprise MCP gateway classifies it as a write, requires an idempotency key, and returns a durable operation-confirmation request without calling the Demo executor.
3. The chat displays `操作确认`. Select `本次允许`.
4. EA records the decision and asks the runtime to retry with exactly the same arguments and idempotency key.
5. The isolated Demo MCP creates one `DEMO-PLAN-*` record.
6. Open `执行依据` to show identity, role/adoption, policy and rule version, payload fingerprint, idempotency fingerprint, confirmation, connector name, execution receipt, and Demo business receipt.

Repeat the same request with the same idempotency key. The gateway must return the prior receipt or reject a conflicting payload; it must not create a second business record.

For the risk-classification demonstration, ask the agent to update a Demo customer service tag. Explain that the remote tool claims it is read-only while the platform policy still treats it as a write and requires confirmation.

## Acceptance gates

- Every user-visible business MCP name includes `Demo`.
- No Demo operation reads or writes a production CRM.
- A write without `idempotency_key` is rejected before approval and execution.
- A write cannot execute until its bound approval is approved and atomically consumed.
- Reusing a key with different arguments is rejected.
- A DENY decision never reaches the remote executor.
- `执行依据` never exposes raw tool arguments, credentials, or the original idempotency key.
- Feature disabled or governance storage unavailable means fail closed.

## Developer adaptation standard

Other MCP owners should copy the protocol and governance contract, not the Demo business data:

1. Use standard MCP Streamable HTTP over HTTPS.
2. Validate EA JWT signature, issuer, audience, `server_id`, `tool_name`, scopes, role/adoption identity, expiry, and key ID via JWKS.
3. Expose precise tool schemas and truthful annotations. Remote annotations may raise risk but never lower administrator policy.
4. Declare tool side effect, required scope, allowed role, approval mode, audit level, and idempotency requirement in the EA admin configuration.
5. Implement downstream business idempotency and return a stable request or record ID.
6. Keep requester identity and business receipt available for audit reconciliation.
7. Use explicit `Demo` labels for any test-only service and isolated storage for all demonstration writes.

Production services must replace the Demo table with their own transactionally safe business store and retain the same PEP, approval, idempotency, receipt, and evidence guarantees.
