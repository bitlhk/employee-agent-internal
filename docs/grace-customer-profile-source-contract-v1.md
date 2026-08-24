# GRACE Customer Profile Source Contract V1

## Status

**Engineering Complete / Provider Implementation Pending / Runtime Unchanged**

This contract translates the nine data-owner-confirmed remediation items into a
single implementation boundary for Wealth and Insurance customer sources. It
does not replace either source MCP and does not make either source
production-ready.

Machine-readable assets:

```text
examples/customer-profile-contract-v1/source-implementation-contract.v1.json
examples/customer-profile-contract-v1/customer-profile-source-envelope.v1.schema.json
examples/customer-profile-contract-v1/source-envelope.valid.fixture.json
```

Source implementation contract fingerprint:

```text
1d7d415e5baf950c81f45334aadb93e37caf37a3ee6693fac76c20d8302323f0
```

## Responsibility boundary

The source service owns:

- stable customer-subject lookup;
- organization, principal and customer-row authorization;
- authoritative business `asOf` values;
- field-level source record and mapping provenance;
- canonical customer facts required by the confirmed remediation plan.

The EA Customer Profile Provider owns:

- canonical `customer_profile` validation;
- role and Purpose projection;
- task-required field checks;
- conflict handling and fail-closed behavior;
- ContextItem normalization and Receipt evidence.

This means the same governed source facts may support both Wealth and Insurance,
while each role receives a different field projection. Shared source identity
does not grant shared visibility.

## Trusted invocation

The MCP tool is defined as:

```text
get_governed_customer_profile(subjectId)
```

Only the stable `subjectId` may be supplied as a normal tool argument. The
organization, principal, Role, Purpose and authorization fingerprint must not be
accepted from model-controlled arguments.

The existing internal Runtime token does not currently carry a complete Purpose
delegation to a separate source service. V1 therefore keeps Purpose projection
inside EA. A source service must derive its row-authorization evidence from a
trusted identity/authorization channel, not from tool arguments. A future remote
transport must be separately reviewed before it may convey signed Purpose.

## Envelope guarantees

A conformant source response contains:

- stable `subjectId` and opaque `sourceRecordRef`;
- authoritative `businessAsOf` separated from retrieval `observedAt`;
- authorization snapshot and fingerprint evidence;
- proof that subject and row scope were applied;
- canonical fields with field-level provenance;
- explicit denied-field evidence;
- source contract and result fingerprints;
- no raw upstream payload.

EA checks that the authorization evidence matches the active Runtime identity.
It rejects subject mismatch, unknown or duplicate fields, invalid types,
untrusted timestamps, inconsistent provenance, missing remediation facts, raw
payload properties and invalid fingerprints.

## Activation boundary

A conformant Envelope is still adapted as:

```text
productionReady = false
providerGap = SOURCE_IMPLEMENTATION_CANDIDATE_NOT_PROMOTED
```

No source mapping, authorization or Binding changes are made. Production use
still requires:

```text
Real provider implementation
        ↓
Environment conformance evidence
        ↓
Source Readiness READY
        ↓
New authorization fingerprint
        ↓
New immutable Gate B snapshot
        ↓
Dual-role Candidate Provided 3/3
        ↓
Promotion Review
```

## Verification

```bash
pnpm customer-profile:sources:contract:verify
```

The fixture is synthetic. The command reports field paths and fingerprints but
does not print customer values.
