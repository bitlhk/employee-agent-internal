# GRACE Governed Memory Purpose Isolation V1

Status: Engineering Complete / Environment Shadow Verified / Promotion Gate Pending

## Decision

An `enterprise_shared` Context Source Binding shares a Provider access path. It does not share record visibility.
Relationship Memory and Governed Work State must apply all of these runtime constraints before returning Context:

```text
Organization
+ Runtime Principal / Adoption or Role boundary
+ Purpose Scope
+ Subject boundary, when the record is subject-specific
```

`purpose_filter` is a Provider capability. It may only be declared when the Provider applies the record-level filter and emits filter evidence. A Purpose string that is only copied into a Receipt does not satisfy this capability.

## Record Contract

Purpose-aware records carry:

- `visibilityClass`: `principal_private`, `role_private`, or `enterprise_shared`
- `purposeScopeJson`: one or more stable Purpose IDs
- `purposeScopeVersion`
- optional `subjectId`
- `scopeProvenanceJson`

Existing records migrate as `principal_private` with no Purpose Scope. They remain available through existing role-specific retrieval, but fail closed through an enterprise-shared Purpose-aware Provider until explicitly governed.

The first frozen Purpose IDs are:

- `wealth_advisory`
- `insurance_advisory`

## Access Semantics

- `principal_private`: exact organization, user, adoption, Purpose, and subject boundary.
- `role_private`: exact organization, role, Purpose, and subject boundary.
- `enterprise_shared`: exact organization, Purpose, and subject boundary. Principal and role authorization remain external governance facts.
- A subject-specific record is not returned when the request omits the subject or requests another subject.

Bindings do not contain allowed roles or allowed Purposes.

## Receipt Evidence

Purpose-aware Providers record:

- requested Purpose ID and description
- `appliedPurposeFilter=true`
- candidate, filtered, eligible, and returned counts
- Purpose Scope version
- filter fingerprint

Raw excluded records are not copied into the Receipt.

## Environment Evidence

Isolated organization: `org_role_scale_shadow_20260824`

The environment verifier is:

```bash
pnpm context:memory-purpose:environment
```

It verifies the same three Shared Shadow Bindings for Wealth Manager and Insurance Advisor, then executes the relationship-memory and governed-work Providers against a cross-role matrix.

Current verified result:

- Shared Binding identity: `3/3`
- Purpose filters applied: `4/4`
- expected shared record recall: `4/4`
- cross-role leakage: `0`
- Production promotion: not performed

## Remaining Promotion Gate

The immutable Gate B snapshot and dual-role environment verifier are now implemented. Memory and Work State are present in each role's aggregate `Provided Memory`, but `customer_profile` remains unavailable: the Wealth Provider cannot reach its configured upstream API and the Insurance role is not authorized for that MCP source. Gate B therefore remains blocked at Candidate Provided `2/3`, and Promotion Review must not start. See `docs/grace-enterprise-shared-binding-gate-b.md`.
