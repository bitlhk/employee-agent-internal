# Enterprise Governance Backlog

This document tracks governance work that is intentionally outside the current
role-based Skill/MCP MVP, but should be closed before a regulated bank or
insurance POC.

## Scope

The MVP now enforces role-based visibility and provisioning for Skills and MCP
servers. It does not yet implement enterprise IAM lifecycle controls, code
security gates for Skill publishing, model/data classification, or immutable
audit retention.

## Required Before Regulated POC

| Area | Requirement | Acceptance |
|---|---|---|
| JML leaver control | Employee disabled or departed -> Agent disabled, active sessions killed, data access revoked | Disabled user cannot chat or invoke MCP within 5 minutes; denial is audited |
| Role source of truth | Enterprise IAM / HR / AD maps user -> role | Self-service role selection can be disabled or overridden by enterprise identity data |
| Skill security review | Skill publish and role tagging require static scan plus human approval; author cannot self-approve | Unreviewed Skills cannot be approved, tagged, or installed as business Skills |
| Model/data governance | Data sensitivity maps to allowed model families | PII/internal data cannot be sent to non-approved model providers |
| Audit retention | Audit events are immutable, retained by policy, exportable, and legally holdable | Audit logs support WORM-style storage, retention windows, regulator export, legal hold |

## MCP Data Authorization Standard

EA role grants decide which MCP server an Agent can see and call. They do not
replace service-side data authorization.

Every business-data MCP must enforce all of the following:

- Trust only runtime-controlled context, such as `x-linggan-agent-id`,
  `x-jiuwen-channel-id`, `x-agent-runtime-id`, or an equivalent platform header.
- Resolve the real user / staff identity server-side from the Agent or channel.
- Apply row-level authorization in the MCP service before returning customer,
  product, policy, loan, portfolio, or document data.
- Ignore user-supplied or model-supplied identity fields in tool arguments.
- Emit central EA audit events for sensitive tool calls, preferably through
  `/api/claw/audit/mcp-tool` or an adapter-owned audit hook.

Current status:

- Wealth assistant MCP has been validated with jiuwenswarm header-based channel
  isolation.
- New business MCP servers must be checked against this standard before being
  granted to production roles.

## Deferred UI / Admin Work

- Admin view for role grants already exists for the MVP. A future governance UI
  should add review status, approver, approval time, and security scan status.
- Fine-grained sub-tool authorization remains future work. MVP grants MCP at
  server level and relies on each MCP service to block dangerous or unauthorized
  operations.
