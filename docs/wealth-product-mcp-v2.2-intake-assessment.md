# Wealth Product MCP V2.2 Intake Assessment

## Decision

The `wealth-assistant-product` V2.2 service is suitable as a better Demo
product source after HTTPS gateway onboarding, but it is not a certified bank
product master and must not be described as one.

Current state:

```text
Protocol and stable tool names: PASS
Demo product catalog: PASS WITH DISCLOSURE
Real fund facts: PARTIAL
Bank sales eligibility: DEMO ONLY
EA suitability summary contract: REMEDIATION REQUIRED
HTTPS / source network path: BLOCKED
Trusted source identity: SHADOW ONLY
```

## Verified Capabilities

- Streamable HTTP `2025-11-25`, stateless operation.
- Stable tools retain the `wealth_assistant_*` names expected by existing
  Skills and Context Bindings.
- Stable product IDs: `P001-P008` and `F{fundCode}`.
- Product facts and enterprise sales eligibility are represented separately.
- Product envelopes distinguish business `asOf` from request `updatedAt`.
- Eight wealth products are explicitly marked `demo`.
- Seven fund records can obtain real public fund facts from qieman.com.

## Blocking Gaps

1. The source is currently plain HTTP on its origin. The canonical public
   route must be `https://mcp.demo.linggan.top/wealth/product-data/mcp`, with
   the origin port reachable only from the controlled proxy/gateway.
2. The product search summary does not include all deterministic suitability
   inputs. It must include at least `channels`, `termDays` or `termMonths`,
   `minPurchaseAmount`, `salesStatus`, and sales-eligibility `asOf` for every
   candidate.
3. Fund facts may be real while the bank sales eligibility remains Demo. A
   public-data trade status cannot be presented as the bank's sellable set,
   and the Demo sellable set must stay explicitly labelled.
4. Some Demo wealth product dates are historically inconsistent with their
   2026 sales windows. These records must be corrected before being used in a
   leadership recommendation story.
5. The source does not yet enforce EA short-lived resource tokens. It may be
   registered only as `none_shadow`; `enforced` is blocked until issuer,
   audience, scope and server-side verification pass.

## Stable Onboarding Target

Keep the existing stable server ID and tool names:

```text
serverId: wealth_assistant_product
endpoint: https://mcp.demo.linggan.top/wealth/product-data/mcp
role: wealth-manager
identity mode: tenant
lifecycle: shadow
```

The existing local `18007` adapter remains the rollback path until HTTPS
reachability, tool discovery, suitability contract checks and browser E2E all
pass. Registration must not create a second role-visible product server.

## Promotion Gate

- HTTPS endpoint and tool discovery pass from local and Shanghai EA.
- Origin access is restricted to the controlled gateway.
- Search summary contains every deterministic suitability input.
- Demo versus real facts and Demo sales eligibility remain visible in output.
- `prepare_wealth_allocation_context` consumes the new source and returns
  correct eligible/excluded candidates for the frozen wealth scenarios.
- Product Context Receipt records source, business `asOf`, product set
  fingerprint and Binding identity.
- Existing Skill tool names remain unchanged.
- Rollback to the local adapter is verified.
