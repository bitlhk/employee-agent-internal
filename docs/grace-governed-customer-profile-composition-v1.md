# GRACE Governed Customer Profile Composition V1

## Status

**Stages 1-3 Verified / Gate B Source Input Blocked / No Promotion**

This work package evaluates whether existing Wealth and Insurance Customer MCPs
can provide one governed `customer_profile` contract with role-specific
projections. It does not manufacture missing customer facts and does not treat
Gateway compatibility as source authority.

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
Customer Profile Provider tests: 33/33 PASS
Business contract fingerprint: fcc21f0aca43858cecb8b141982d82880511fa32092ab4e4973c141286774fd0
```

## Stage 4 - Gate B rerun

The complete environment Gate was rerun without changing the Golden Set,
Resolver, Eligibility or authorization:

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
