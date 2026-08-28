# GRACE Customer CRM Integration V1

## Objective

Twenty is the Demo CRM and human-maintained system of engagement. GRACE keeps
`customer_profile` as the canonical Agent Context and exposes it through the
existing `customer_context` server. Wealth and insurance Skills do not bind to
Twenty, to source-specific MCP tools, or to raw CRM objects.

```text
Wealth Customer Source ─┐
                        ├─ Governed Import ─ Twenty CRM
Insurance Customer Source ┘                  │
                                             ↓ REST
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
8. `CUST` means `Customer` and is only a stable enterprise identity namespace.
   It never encodes role, domain, phone number, ownership or organization.
9. Demo visibility and customer ownership remain distinct. `demo_public`
   provides a shared exercise pool; `customerAssignment` is the authoritative
   fact for dedicated ownership and CRM write preference.
10. `demo_public` does not mean visible to every role. The customer directory
    intersects public/assigned row access with an active role-eligible
    `Customer Domain Profile` before returning any customer to the Agent.
    Wealth uses `wealth`; insurance uses `auto_insurance` and
    `life_insurance`. UI filtering is not an authorization boundary.

## CRM Objects

V1 uses a small normalized model instead of one 121-column customer record.
The deployed environment contains all six objects. The local EA Runtime enables
the confirmation-gated follow-up task operation; interaction write-back remains
disabled and Shanghai activation is a separate release action.

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
with 20 insurance Demo customers plus 8 wealth customers obtained through the
governed Shanghai MCP path. All 28 customers use the same customer, source-link
and versioned domain-profile model. The 121-row wealth workbook remains a
field-definition input rather than a flat set of populated CRM columns. EA now
uses `customer_context` to read Twenty directly with row authorization and
role/purpose profile filters. Customer directory listing now applies the same
profile eligibility before Context assembly, so a wealth manager receives the
wealth Demo pool plus explicitly assigned wealth customers rather than every
public CRM row. Legacy wealth and insurance customer providers
remain hidden rollback dependencies for one release. See
`grace-customer-crm-environment-acceptance-v1.md` for evidence and known gaps.

As of 2026-08-28, the local Agent-to-CRM write path is also verified. An Agent
can create a follow-up only for a customer explicitly assigned to its current
user or role adoption. Public Demo visibility does not grant write authority.
The operation uses the platform's single governance confirmation, rechecks
assignment after confirmation, writes exactly one row for an idempotency key and
returns an `ea.customer-crm-execution-receipt.v1` receipt. Unassigned customers
are rejected before an approval is created. Shanghai deployment is not implied
by this local acceptance.

Twenty manual creation uses a database-assigned Global Customer ID. The field
is optional only in the incoming create request and read-only to users; the
database assigns a unique `CUST-9xxxxx` value before the record is persisted.
New records start as `draft` and are not Runtime-eligible without governed
source and domain-profile records.

## V1 Exit Criteria

- Twenty is pinned to an immutable release and runs on an isolated host.
- All imported Demo customers have stable Global Customer IDs and source links.
- Auto and life insurance `detail` data validates against a registered schema.
- Wealth and insurance consume the same canonical `customer_profile` tools.
- Role projections return different governed fields from the same CRM source.
- Every provided field has source, record reference and business timestamp.
- CRM task creation/update produces an Execution Receipt.
- No existing Skill or Role Pack changes to a source-specific tool name.
