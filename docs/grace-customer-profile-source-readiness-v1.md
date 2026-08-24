# GRACE Customer Profile Source Readiness Gate V1

## Status

**Engineering Complete / Local Environment Evaluated / Source Remediation Pending**

This gate determines whether an existing customer source can satisfy the frozen
Customer Profile Contract for a specific role and task. It reuses the real
Customer Profile Provider projection logic and records only field paths,
counts, reason codes and fingerprints. Customer identifiers and field values
are never written to the readiness report.

The gate does not change a Role Pack, Binding, Principal authorization or
Production Runtime.

## Commands

```bash
pnpm customer-profile:sources:assess
pnpm customer-profile:sources:require-ready
```

The first command is diagnostic and succeeds when the assessment completes.
The second is a production gate and exits non-zero unless every evaluated role
and task is ready.

## Local environment result

Evaluated on 2026-08-24 against `work.linggan.top` and runtime release:

```text
20260824T072610Z-a9a862770633-local2
```

Frozen business inputs remained unchanged:

```text
Customer Profile Contract:
fcc21f0aca43858cecb8b141982d82880511fa32092ab4e4973c141286774fd0

Source Mapping:
849a01d97e9eb08735beb97a21036768e350ad99e095fbf6535718aaff0241cd
```

Overall result:

```text
SOURCE_REMEDIATION_PENDING
```

Stable aggregate evidence is stored in:

```text
examples/customer-profile-contract-v1/source-readiness-local.v1.json
```

## Wealth source result

The active Wealth Manager Runtime Principal and customer row scope were both
accepted by the existing Wealth Customer MCP. The source returned all 16
currently mapped fields, so service recovery and row-level access are not the
remaining blockers.

The source is still blocked because it is not production-ready and cannot
satisfy the frozen task contracts:

| Task       | Missing required facts                               |
| ---------- | ---------------------------------------------------- |
| `WM-GT-01` | customer status, governed recent-contact summary     |
| `WM-GT-02` | customer status, investment horizon, liquidity needs |
| `WM-GT-03` | customer status                                      |
| `WM-GT-04` | customer status                                      |

The source also lacks authoritative business `asOf` and complete field-level
provider evidence. Retrieval time must not be promoted as business fact time.

## Insurance source result

The existing Insurance Customer Profile remains a Demo source. The Insurance
Runtime Principal has no approved row-level access to it, and the current
loader therefore returns no customer record.

The declared source mapping cannot satisfy:

- `IA-GT-01`: renewal date/status, current coverage, claims risk and governed
  service scope;
- `IA-GT-02`: current coverage and governed service scope.

The source also lacks authoritative `asOf`, field-level provenance and
purpose-aware authorization evidence.

## Promotion boundary

This result is not a Gate B rerun. Gate B remains at Candidate Provided `2/3`.
The next valid progression requires real source remediation:

1. add the missing authoritative Wealth customer facts;
2. provide an Insurance source with approved customer-row scope and the
   minimum insurance fields;
3. preserve stable customer identity across contributing sources;
4. issue a new source contract and authorization fingerprint;
5. generate a new immutable Gate validation snapshot;
6. rerun the complete dual-role Gate B.

No Production Binding may be promoted from this assessment.
