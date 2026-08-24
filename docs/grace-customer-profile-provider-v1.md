# GRACE Customer Profile Provider V1

## Status

**Engineering Complete / Local Shadow Pending**

The Provider is an internal, shadow-only MCP boundary. It is registered inside EA but is not included in the Jiuwen managed MCP server set, is not referenced by a Role Pack or Skill, and does not change any Production Binding.

## Purpose

The Provider proves this runtime contract:

```text
Existing customer sources
        ↓
Canonical normalization
        ↓
Trusted Runtime Principal
        ↓
Purpose-aware field projection
        ↓
Governed customer_profile ContextItem
        ↓
Context Receipt
```

One canonical `customer_profile` can serve different roles without returning the same fields. Role and purpose come from the signed Runtime Principal; tool arguments cannot select or override them.

## V1 projections

- Wealth Manager: `WealthCustomerProfileV1` / `wealth_advisory`
- Insurance Advisor: `InsuranceCustomerProfileV1` / `insurance_advisory`
- Investment Research: denied
- Post-loan Risk Control: denied; use `enterprise_profile`
- Smart Audit: conditional, case-bound minimum projection

## Fail-closed boundaries

- A blocked result contains no customer field values.
- Stable subject identity is required; display name is not identity proof.
- Conflicting enterprise facts are blocked rather than model-resolved.
- Task-required fields must be present with field-level provenance.
- A source marked `productionReady=false` cannot produce Provided Context.
- Same Binding or source identity never implies the same data visibility.

The current Wealth and Insurance demo sources remain `productionReady=false` because they do not yet provide all required authorization, authoritative as-of, field projection and provenance semantics. The Shadow Provider therefore exposes their governance gaps without promoting their payloads.

## Runtime surface

```text
GET  /api/internal/customer-profile/health
POST /api/internal/customer-profile/mcp
GET  /api/internal/customer-profile/mcp
```

The MCP tool is visible only when:

```text
EA_CUSTOMER_PROFILE_PROVIDER_SHADOW_ENABLED=true
```

Tool:

```text
get_governed_customer_profile
```

Accepted arguments are customer subject id, optional legacy source locator and optional task contract. Role and purpose are never accepted as authority inputs.

## Evidence

Each result records:

- projection id and version;
- purpose id;
- field-level provenance;
- source contract and result fingerprint;
- business contract fingerprint;
- Runtime Principal fingerprint;
- applied purpose filter and filtered field count;
- reason codes and required-field gaps;
- a Context Receipt separating Provided from Excluded business data.

## Verification

```bash
pnpm customer-profile:provider:verify
pnpm check
```

The business contract remains frozen at:

```text
fcc21f0aca43858cecb8b141982d82880511fa32092ab4e4973c141286774fd0
```

## Promotion gate

Shadow availability is not Production activation. Promotion remains prohibited until a real enterprise Customer Provider demonstrates:

- purpose-aware and field-level projection;
- row/subject authorization;
- authoritative source as-of and field provenance;
- Wealth and Insurance Candidate Provided;
- zero cross-role leakage;
- dual-role Golden Task PASS under one immutable validation snapshot.
