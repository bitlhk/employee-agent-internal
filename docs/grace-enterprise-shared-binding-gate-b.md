# GRACE Enterprise-shared Binding Gate B

Status: Core Validation PASS / Environment Dependency Blocked / No Promotion

## Frozen Validation Snapshot

Gate B is bound to the immutable snapshot:

```text
ccf1a10b181bbf1955b3605a8bfc0d9772a91224e7a45e9c8da304181995cbc7
```

The frozen artifact is:

```text
examples/insurance-advisor-reference-role-pack/eval/shared-binding-validation-snapshot.v1.json
```

This fingerprint freezes Context Provider configuration, Role Pack releases, plans, and the three candidate Bindings. Any change to those inputs requires a new Context snapshot.

Gate B also computes a separate validation snapshot fingerprint from:

```text
Context snapshot fingerprint
+ Wealth Manager authorization fingerprint
+ Insurance Advisor authorization fingerprint
```

This composite fingerprint binds both Role Packs to the same Context snapshot and the authorization state actually evaluated. An authorization change does not rewrite the Context snapshot, but it must create a new Gate validation snapshot and trigger a complete Gate B rerun.

The current blocked run is bound to:

```text
Gate validation snapshot: 799ec8c235e756f4530851eca6d6d6d7acaea09f675adbf6fff87e677bb49ba4
Blocked evidence:          3789490573299b561a6cbb0ddff614e0e5ccc9fb156be641e2d540da5aff90f8
```

The stable evidence artifact is:

```text
examples/insurance-advisor-reference-role-pack/eval/shared-binding-gate-b-blocked.v1.json
```

## Environment Gate

Run:

```bash
pnpm context:insurance:gate-b:environment
```

The gate requires:

- Shared Binding identity `3/3`
- identical authorization-aware Gate validation snapshot for both Role Packs
- Purpose Isolation PASS and zero cross-role leakage
- zero Eligibility violations
- all Wealth and Insurance controlled Golden Tasks PASS
- each role's aggregate Context Receipt contains all three candidate Binding fingerprints
- Exact Binding disabled or capability-mismatch states do not fall back to Shared
- no promotion is performed by the verifier

## Current Evidence

Passing:

- Snapshot integrity: PASS
- Shared Binding identity: `3/3`
- Purpose Isolation: PASS
- Eligibility violations: `0`
- Cross-role leakage: `0`
- Exact Binding failure semantics: PASS
- Wealth Golden Tasks: PASS
- Insurance Golden Tasks: PASS
- `customer_relationship_memory` Provided for both roles
- `governed_work_state` Provided for both roles

Blocked:

- Candidate Provided is `2/3` for both roles.
- Wealth Manager customer source cannot reach its configured upstream customer API.
- Insurance Advisor is not authorized for the Shared Binding's `wealth_assistant_customer` MCP server.

This is a Provider availability and runtime authorization gap. It must not be bypassed in the validation harness, and the frozen Context, Golden Set, Resolver, Memory Provider, and Binding ADR must not be weakened to make the gate pass.

The Customer MCP recovery and the Insurance Customer Profile authorization review are separate changes. After either dependency changes, Gate B must compute a new authorization-aware validation snapshot and rerun the full evidence chain.

## Promotion Boundary

Gate B remains blocked with `SHARED_BINDING_CANDIDATE_NOT_PROVIDED`. Production Shared Binding count must remain zero. Promotion Review may start only after both roles produce a Receipt with all three candidate fingerprints under the same immutable snapshot.
