# GRACE Customer Profile Provider V1

## Status

**Engineering Complete / Local Shadow Verified / Production Binding Unchanged**

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

## Local environment verification

Verified on 2026-08-24 against:

```text
work.linggan.top
release: 20260824T072610Z-a9a862770633-local2
source commit: a9a862770633fc70d5331a7f76ed60ae6e4407e1
```

The internal health endpoint reported `mode=shadow`. A real active Wealth Manager Runtime Principal selected one customer from the existing authorized Wealth Customer MCP and called the Shadow Provider. The Provider returned:

```text
projection: WealthCustomerProfileV1
purpose: wealth_advisory
status: BLOCKED
reason: CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING
reason: CUSTOMER_PROFILE_PROVIDER_NOT_PRODUCTION_READY
projected field count: 0
source evidence count: 1
Provided Business Data: 0
Excluded Business Data: 1
Context Receipt fingerprint: present
```

This is the expected fail-closed result for the current legacy source contract. It verifies the environment wiring and governance boundary; it does not pass Gate B and does not certify the legacy Wealth Customer MCP.

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

The executable source-readiness assessment and the current local environment
gaps are recorded in `docs/grace-customer-profile-source-readiness-v1.md`.

The deployed legacy Insurance MCP compatibility path and its fail-closed local
Shadow evidence are recorded in
`docs/grace-customer-profile-compatibility-adapter-v1.md`.
