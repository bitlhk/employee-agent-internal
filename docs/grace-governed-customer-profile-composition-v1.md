# GRACE Governed Customer Profile Composition V1

## Status

**Stages 1-3 Verified / Demo Composition Locally Verified / Gate B Production Source Blocked / No Promotion**

This work package evaluates whether existing Wealth and Insurance Customer MCPs
can provide one governed `customer_profile` contract with role-specific
projections. Production evaluation does not manufacture missing customer facts
and does not treat Gateway compatibility as source authority. A separate,
explicit Demo assurance mode may compose synthetic facts for stable Demo subject
ids; those facts remain ineligible for Production assurance.

## Stage 1 - Source inventory

The read-only local inventory is stored at:

```text
examples/customer-profile-contract-v1/source-inventory-local.v1.json
```

Run:

```bash
pnpm customer-profile:sources:inventory
```

The report records only source shape paths, canonical field paths, coverage,
reason codes and readiness flags. It contains no customer values.

Result:

```text
status: SOURCE_INPUT_BLOCKED
environment: work.linggan.top
```

The existing Insurance source provides stable list identity, basic profile,
vehicle summary, driving record and protection-gap data. It does not provide:

- governed source-native organization, principal, Purpose and row scope;
- authoritative business `asOf`;
- renewal date and status;
- current coverage summary;
- claims-risk summary;
- field-level denial evidence.

The existing Wealth source is reachable with row scope but still lacks customer
status, governed recent-contact facts, investment horizon, liquidity needs and
authoritative business time required by the frozen Wealth task contracts.

## Stage 2 - Governed composition

The current Customer Profile Provider already enforces:

- stable subject equality across contributing sources;
- disjoint canonical field composition;
- source-specific field Provenance;
- source and result fingerprints;
- deterministic conflict detection;
- fail-closed behavior for subject mismatch or conflicting enterprise facts.

Provider tests now include successful composition of customer-master and
insurance-policy facts while preserving the original source Provenance for each
field. Conflicting values still block the complete projection.

## Stage 3 - Purpose projection

The frozen projections remain:

```text
WealthCustomerProfileV1     → wealth_advisory
InsuranceCustomerProfileV1  → insurance_advisory
```

One canonical source contract can produce different minimized field sets.
Insurance cannot receive Wealth balances, holdings or private relationship
fields, and Wealth cannot receive Insurance fields. Missing task-required facts
produce `BLOCKED`; no model inference can satisfy the gate.

Verification:

```text
Customer Profile Provider tests: 37/37 PASS
Business contract fingerprint: fcc21f0aca43858cecb8b141982d82880511fa32092ab4e4973c141286774fd0
```

## Demo facts composition

The local Demo environment composes the existing Insurance Customer MCP with a
small GRACE-owned synthetic contributor. It is enabled only when both flags are
explicitly set:

```text
EA_CUSTOMER_PROFILE_PROVIDER_SHADOW_ENABLED=true
EA_CUSTOMER_PROFILE_DEMO_FACTS_ENABLED=true
```

The upstream source remains authoritative for the fields it already supplies.
The synthetic contributor only fills the missing renewal, coverage and
claims-risk fields for stable Demo subject ids. It cannot overwrite an upstream
field, subject mismatches and conflicting values still fail closed, and unknown
subject ids receive no synthetic facts.

Local runtime evidence on 2026-08-24:

```text
environment:                 work.linggan.top
release:                     20260824T095435Z-4f18f22ae138
source commit:               4f18f22ae138fb8c7c192447baeae6c58fc43d42
provider mode:               shadow
required assurance:          demo
projection status:           DEGRADED
missing required fields:     0
remaining gaps:              optional fields only
source evidence:             2
Provided Business Data:      1 customer_profile
Context Receipt fingerprint: present
unknown subject behavior:    SUBJECT_OUT_OF_SCOPE / zero sources
```

Field-level Provenance shows that existing profile and vehicle fields came from
`insurance_customer_profile`, while the supplemental fields came from
`grace_demo_insurance_facts`. `DEGRADED` is intentionally preserved rather than
inventing more optional data. This result proves the Demo composition path; it
does not authorize the data or satisfy the Production Gate B source contract.

## Stage 4 - Gate B rerun

The complete Production-assurance environment Gate was rerun without changing
the Golden Set, Resolver, Eligibility or authorization:

```bash
pnpm context:insurance:gate-b:environment
```

Passing evidence:

```text
Snapshot Integrity:       PASS
Shared Binding Identity:  3/3
Purpose Isolation:        PASS
Eligibility Violations:   0
Cross-role Leakage:       0
Exact Binding Semantics:  PASS
Wealth Golden Tasks:      PASS
Insurance Golden Tasks:   PASS
Wealth Candidate Provided 3/3
```

Blocked evidence:

```text
Insurance Candidate Provided: 2/3
Missing candidate:             customer_profile
Gate error:                    SHARED_BINDING_CANDIDATE_NOT_PROVIDED
Promotion performed:           false
```

No new immutable validation snapshot is valid yet because no authoritative
source or authorization input changed. Reusing the existing fingerprint while
claiming a new source state would be incorrect.

## Stage 5 - Promotion and deployment decision

Promotion Review is not permitted while Candidate Provided remains `2/3`.
Consequently:

- no Production Shared Binding is created;
- no Shanghai Runtime activation is performed;
- the already deployed local compatibility adapter remains Shadow-only;
- existing Wealth production behavior remains unchanged.

The next valid input is an authoritative Insurance policy/customer contributor
that supplies renewal, current coverage and minimized claims-risk facts with
business time and Provenance. It may be composed by the GRACE-owned facade; the
existing upstream MCP does not need to be rewritten. After that input exists,
GRACE must issue new source/configuration and authorization fingerprints, freeze
a new snapshot, rerun the complete dual-role Gate B and then conduct Promotion
Review.
