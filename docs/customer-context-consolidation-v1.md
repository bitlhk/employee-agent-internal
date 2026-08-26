# Customer Context Consolidation V1

## Product identity

- User-facing name: `客户洞察`
- User-facing description: `整合当前岗位获授权的客户信息，为客户分析、服务和业务决策提供依据。`
- Admin name: `统一客户数据服务`
- Runtime MCP id: `customer_context`
- Contract: `ea.customer-context.v1`

## Canonical tools

| Tool | Logical Context | Scope |
|---|---|---|
| `search_customers` | `customer_directory` | Wealth manager and insurance advisor |
| `get_customer_profile` | `customer_profile` | Wealth manager and insurance advisor; fields are projected by trusted runtime purpose |
| `get_customer_portfolio` | `customer_portfolio` | Wealth manager only |

The runtime supplies organization, principal, role and purpose. Tool arguments cannot select or override them.

## Source boundary

`wealth_assistant_customer` and `insurance_customer_profile` remain server-side source providers. They are removed from Role Asset grants and are not discoverable by the Agent or user connector UI. The Customer Context adapter can call the insurance source through a narrowly scoped internal gateway origin; normal Agent calls still require explicit role grants.

Shared source identity does not imply shared visibility. The Customer Profile projection continues to enforce role, purpose, subject and field-level scope before returning a `ContextItem` and Receipt.

## Compatibility

Existing published Skills are not rewritten by the platform. The following names remain available as compatibility aliases on `customer_context`:

- `get_governed_customer_profile`
- `wealth_assistant_context_probe`
- `wealth_assistant_customer_list`
- `wealth_assistant_customer_detail`
- `list_customer_profiles`
- `get_customer_profile_by_name`

Aliases return minimized governed projections, never raw upstream payloads. New Skill versions must use canonical tools. Aliases can be retired only after runtime usage reaches zero and developer-owned Skills have released compatible versions.

## Deployment and rollback

Run `pnpm customer-context:consolidate -- --apply` with `ROLE_SKILL_MCP_BASELINE_PATH` set to the deployment baseline. This replaces raw customer MCP role grants with `customer_context`, migrates Skill readiness requirements, synchronizes seed grants and disables raw-source admin grants.

Rollback restores the backed-up role baseline and previous code release, reruns the role seed sync, then reconciles affected JiuwenSwarm adoptions. No source data or Context Binding is deleted by this change.
