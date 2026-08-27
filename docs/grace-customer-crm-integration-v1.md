# GRACE Customer CRM Integration V1

## Objective

Twenty is the Demo CRM and human-maintained system of engagement. GRACE keeps
`customer_profile` as the canonical Agent Context and exposes it through the
existing `customer_context` server. Wealth and insurance Skills do not bind to
Twenty, to source-specific MCP tools, or to raw CRM objects.

```text
Wealth Customer Source ─┐
                        ├─ Customer Source Adapter ─ Twenty CRM
Insurance Customer Source ┘             │
                                        ↓
                              customer_context
                                        ↓
                    Purpose Projection / Eligibility
                         ┌──────────────┴──────────────┐
                  Wealth Manager               Insurance Advisor
```

## Frozen Boundaries

1. A Global Customer ID and an explicit Source Crosswalk define identity.
   Display name, phone number and model similarity never merge customers.
2. CRM and upstream systems keep separate field authority. The newest value
   does not automatically win.
3. Field-level provenance is required before a value can become governed
   Runtime Context.
4. `bio`, `protection_gap` and `contact_strategy` are suggestions until a human
   confirms them. They are not authoritative facts.
5. Product catalog, availability and suitability remain in the product domain.
   CRM may hold references but does not become product master data.
6. Domain-specific data is stored under a versioned `profileType` and
   `detailSchemaVersion`. Unknown schemas may be stored for review but cannot
   enter Agent Runtime.
7. Same CRM and same Binding do not imply same visibility. Runtime purpose,
   principal and Eligibility still select the wealth or insurance projection.

## CRM Objects

V1 uses a small normalized model instead of one 121-column customer record.
The deployed Shadow environment contains all six objects. Interaction and task
write-back contracts are implemented, but runtime mirroring remains disabled.

| Object                  | Responsibility                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Customer                | Stable identity, display data, ownership and lifecycle             |
| Customer Source Link    | Source system, source customer ID and Global Customer ID crosswalk |
| Customer Domain Profile | `wealth`, `auto_insurance` or `life_insurance` versioned detail    |
| Customer Interaction    | Contact and visit facts confirmed by a user or source system       |
| Follow-up Task          | Governed task state and execution result                           |
| Customer Suggestion     | Derived insight awaiting human confirmation                        |

Holdings, matured products, product availability, claims and policy facts stay
authoritative in their domain systems. Twenty can show synchronized summaries
with provenance, but cannot overwrite those systems.

## Migration and Activation

```text
Contract Verify
  → Twenty Environment Healthy
  → Demo Data Import
  → Identity/Authority Reconciliation
  → CRM Source Adapter Shadow
  → Wealth + Insurance Projection Tests
  → Browser E2E
  → Promotion Review
```

During Shadow, the current wealth and insurance providers remain Production.
The CRM result is compared on identity, normalized fields, provenance,
purpose filtering and missing-data semantics. Activation is blocked if any
customer is merged heuristically, any restricted field leaks across purpose,
or any suggestion is presented as an enterprise fact.

## Current Verification State

As of 2026-08-27, the isolated Twenty environment is deployed and verified
with 20 insurance Demo customers and is available to administrators at
`https://crm.demo.linggan.top`. No wealth customer record or 121-column flat
profile was imported; the wealth workbook is a field-definition input. The
Twenty source adapter is Shadow-only, and the existing wealth and insurance
customer providers remain the Production path. See
`grace-customer-crm-environment-acceptance-v1.md` for evidence and known gaps.

## V1 Exit Criteria

- Twenty is pinned to an immutable release and runs on an isolated host.
- All imported Demo customers have stable Global Customer IDs and source links.
- Auto and life insurance `detail` data validates against a registered schema.
- Wealth and insurance consume the same canonical `customer_profile` tools.
- Role projections return different governed fields from the same CRM source.
- Every provided field has source, record reference and business timestamp.
- CRM task creation/update produces an Execution Receipt.
- No existing Skill or Role Pack changes to a source-specific tool name.
