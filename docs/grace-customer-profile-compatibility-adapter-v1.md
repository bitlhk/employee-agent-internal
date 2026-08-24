# GRACE Customer Profile Compatibility Adapter V1

## Status

**Engineering Complete / Local Shadow Verified / Production Sources Unchanged**

This adapter proves that an existing role-owned Customer MCP can enter the
canonical GRACE Customer Profile Provider without requiring the upstream team
to rewrite its current MCP contract first.

It is a compatibility boundary, not a second customer system and not a
Production authorization shortcut.

## Runtime path

```text
Insurance Runtime Principal
        ↓
GRACE Customer Profile Provider (shadow)
        ↓
Customer Profile Compatibility Adapter
        ↓
Enterprise MCP Gateway
        ↓
Existing Insurance Customer MCP
        ↓
Canonical source normalization
        ↓
Purpose-aware projection and Context Receipt
```

The legacy Insurance source exposes list-by-scope and detail-by-name tools. The
adapter does not treat a display name as identity proof. It first selects the
requested stable customer id from the governed list result, then calls the
detail tool with the exact listed name and verifies that the detail response
returns the same id and name.

## Local environment verification

Verified on 2026-08-24 against:

```text
environment: https://work.linggan.top
release: 20260824T091058Z-113a0a461c5f
source commit: 113a0a461c5fdfd42c8d3741f155c974eda2b95e
```

An active Insurance Advisor Runtime Principal invoked
`get_governed_customer_profile` through the deployed internal MCP route. The
adapter used the existing Enterprise MCP Gateway and recorded completed calls
to both legacy Insurance tools.

Valid, in-scope subject evidence:

```text
source count: 1
source contract: insurance-customer-profile-demo-v1
source system: insurance_customer_profile
principal authorized: true
subject in scope: true
customer values in adapter evidence: false

readiness: BLOCKED
reason: CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING
reason: CUSTOMER_PROFILE_PROVIDER_NOT_PRODUCTION_READY
Provided Business Data: 0
Excluded Business Data: 1
Context Receipt fingerprint: present
```

Unknown subject evidence:

```text
source count: 0
subject in scope: false
readiness: BLOCKED
reason: SUBJECT_OUT_OF_SCOPE
Provided Business Data: 0
Context Receipt fingerprint: present
```

The result is intentionally fail-closed. It proves that the upstream MCP can be
consumed through the unified contract, while also proving that compatibility
does not make a Demo source authoritative or Production-ready.

## Security and ownership boundary

- The adapter calls the Insurance MCP only through the existing Enterprise MCP
  Gateway and its active Runtime Principal.
- Model-controlled input cannot supply organization, role, purpose or
  authorization authority.
- A display name is used only after stable-id selection from the governed list.
- Raw upstream payload and customer values are not copied into adapter evidence.
- Existing source ownership, endpoint and upstream test environments remain
  unchanged.
- Existing Production Bindings and Gate B snapshots remain unchanged.

## Verification

```bash
pnpm customer-profile:provider:verify
pnpm check
```

The verified suite includes the legacy Insurance adapter identity, scope,
normalization and fail-closed tests. Provider verification passed 32 tests.

## Promotion boundary

This result does not change the current source-readiness or Gate B decision.
Promotion still requires authoritative source facts, approved field-level
visibility, a new authorization fingerprint, a new immutable validation
snapshot, dual-role Golden Task PASS and Candidate Provided `3/3`.
