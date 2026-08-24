# GRACE Customer Profile Contract V1

## Status

> **Engineering Complete / Domain Validation Pending**

This phase defines a governed customer-data contract. It does not deploy a new
Customer MCP, change Runtime Binding, grant new Role permissions, or alter the
local and Shanghai environments.

## Why this contract exists

The current Wealth and Insurance Customer MCPs describe the same individual
customer with different schemas and different business depth:

- the Wealth MCP exposes broad customer, activity, asset, holding and
  recommendation data;
- the Insurance demo MCP exposes basic customer, vehicle, driving, preference
  and protection-gap data;
- neither Provider currently enforces a versioned, purpose-aware field
  projection suitable for enterprise-shared Runtime use.

GRACE must not solve this by copying either payload into a new universal MCP.
The stable design is:

```text
Existing Customer Sources
        ↓
Source Mapping / Stable Subject Identity
        ↓
Canonical Customer Profile Contract
        ↓
Purpose-aware Governed Projection
        ↓
Role Agent Context
```

The canonical contract defines shared semantics. A purpose projection defines
what one Role may receive. Provider access and field visibility remain separate
decisions.

## Contract assets

| Artifact                      | Responsibility                                                              |
| ----------------------------- | --------------------------------------------------------------------------- |
| `contract.v1.json`            | Canonical fields, identity, provenance, conflict and missing-data semantics |
| `purpose-projections.v1.json` | Five Role-specific access and field projections                             |
| `source-mappings.v1.json`     | Current Wealth and Insurance MCP field mappings and explicit Provider gaps  |

All three artifacts bind the existing canonical Logical Context:
`customer_profile`. They do not introduce a second customer Logical Context.
The business contract fingerprint covers the Catalog, canonical contract and
Role projections. Source mappings have a separate Provider mapping fingerprint,
so a Provider change cannot silently redefine business Ground Truth.

## Canonical rules

- A stable subject ID is required. Name matching is not identity proof.
- Every provided field requires source, record reference, `asOf`, observation
  time and mapping-rule provenance.
- A model cannot decide conflicting enterprise facts.
- The newest value does not automatically win a conflict.
- An unresolved conflict is `BLOCKED`.
- A missing task-required field is `BLOCKED`; a missing optional field is
  `DEGRADED`.
- A model cannot invent a missing customer fact.
- Detailed balances, holdings and recommendations remain outside
  `customer_profile`; they continue to use dedicated Logical Context such as
  `customer_portfolio`.

## Five-role decision matrix

| Role                   | Decision    | V1 boundary                                                             |
| ---------------------- | ----------- | ----------------------------------------------------------------------- |
| Wealth Manager         | Allow       | Minimized identity, relationship, preference and suitability projection |
| Insurance Advisor      | Allow       | Insurance-purpose projection; no Wealth balances or recommendations     |
| Investment Research    | Deny        | Research Role has no customer-level business purpose                    |
| Post-loan Risk Control | Deny        | Current Role works on enterprise borrowers; use `enterprise_profile`    |
| Smart Audit            | Conditional | Only case-bound subject identity, service scope and compliance flags    |

These decisions are engineering proposals until the responsible domain owners
confirm them. A similar field name is not sufficient evidence for reuse.

### Role coverage boundary

The current repository contains an `investment-researcher` Role Pack, not a
customer-facing investment-advisor Role Pack. This V1 therefore denies customer
profile access to Investment Research. That decision must not be reused as the
policy for a future Investment Advisor. A real Investment Advisor requires its
own Context Need, purpose, minimum-field and authorization review.

The Risk projection also applies specifically to the current post-loan
enterprise-risk Role. It does not define the policy for every future risk Role.

## Source assessment

Both current source contracts are intentionally marked `productionReady=false`.

### Wealth Customer MCP

It has a stable customer identifier and enough fields to derive a minimized
Wealth projection. It currently lacks Runtime purpose enforcement, versioned
field projection, authoritative field-level `asOf`, Insurance fields and
field-denial evidence.

### Insurance Customer MCP

It provides Insurance-domain demo fields but currently lacks tenant, principal,
purpose and row-level authorization. It also lacks authoritative `asOf`, renewal,
current coverage, claims summary and structured vehicle identity.

Therefore neither source is certified as an enterprise-shared Customer Provider
by this phase.

## Verification

Engineering validation:

```bash
pnpm customer-profile:verify
```

Domain freeze gate:

```bash
pnpm customer-profile:freeze
```

The freeze command must fail while any canonical or Role projection review is
not `domain_confirmed`, or while the business contract and projection set are
not promoted to that status. Review confirmation must include reviewer identity,
role, time, comment and Ground Truth version. Source mappings remain separate
Provider evidence and are not promoted by a domain reviewer.

## Next gate

Domain owners review the canonical contract and five Role projections. Only
after that review may the next phase implement a local Customer Profile Provider
facade and its purpose-aware field projection. Existing Wealth and Insurance MCPs
remain independent source systems during that implementation.

The six required reviews are:

1. Customer data owner: canonical identity, provenance, conflict and
   missing-data rules.
2. Wealth domain owner: `WealthCustomerProfileV1`.
3. Insurance domain owner: `InsuranceCustomerProfileV1`.
4. Investment Research owner: explicit denial for the current research Role.
5. Post-loan Risk owner: explicit denial and `enterprise_profile` alternative.
6. Smart Audit owner: case-bound conditional projection.
