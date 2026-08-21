# GRACE LlamaIndex Provider Certification V1

## Current status

`Certified`

This certification is bound to GRACE Context Quality Baseline V1 and the
deterministic retrieval query plan recorded in the Provider configuration. It
does not modify the expert-confirmed Golden Set.

| Item | Value |
|---|---|
| Baseline fingerprint | `a7439134abfea0263864d9f37ffe3f8063892e498b49aa3df5c8e545e607c40a` |
| Certification ID | `pcert_aecb0e843e312196a560` |
| Certification profile fingerprint | `08f74285c4fe4c49738721a69dabe5da3fb4ed1b3eb5c6640a4f6cc3f8bb3afc` |
| Provider config fingerprint | `422e28500cdecbf8b48f608da6e63c7d9d7a4e992ad688120659ae934dd24e3f` |
| Query plan fingerprint | `58c683d11f9f8ae62bffd17888f61a1638d8f171f5fb275dad8a26e323a7adde` |
| Certification fingerprint | `b0a7f5195398e22eae44c252e5443b5487153cb4d9223b9e9d781d31c5e1a9e7` |
| Index version | `v1787267507944-65668384` |
| Parser version | `2.1` |
| Embedding model | `bge-m3` |
| Reranker | disabled |
| Expert-confirmed Golden cases | 16 |
| Retrieval-layer cases | 7 |
| Measured requests | 21 |

The immutable machine-readable record is
`examples/wealth-manager-reference-role-pack/eval/llamaindex-provider-certification-baseline.v1.json`.
Verify its Golden, Profile, Query Plan, Provider Snapshot, and Certification
fingerprints with:

```bash
pnpm context:provider:llamaindex:baseline:verify
```

The evaluation used an explicit Eligibility snapshot of the frozen Wealth
reference corpus. Mutable runtime additions were excluded and cannot silently
redefine the expert-confirmed baseline.

## Certification gates

| Layer | Metric | Threshold | Actual | Result |
|---|---|---:|---:|---|
| Retrieval | Hit rate | >= 90% | 100% | PASS |
| Retrieval | Document recall | >= 90% | 100% | PASS |
| Retrieval | Version accuracy | 100% | 100% | PASS |
| Retrieval | Forbidden source rate | 0% | 0% | PASS |
| Retrieval | Position hit rate | >= 90% | 100% | PASS |
| Retrieval | MRR | >= 0.80 | 0.9048 | PASS |
| Governance | Eligibility violations | 0 | 0 | PASS |
| Governance | Deterministic scenarios | all | 7/7 | PASS |
| Context contract | ContextItem completeness | 100% | 42/42 | PASS |
| Operations | Error rate | 0% | 0% | PASS |
| Operations | Empty result rate | 0% | 0% | PASS |
| Operations | Warm-cache P95 | <= 2000 ms | 7.9 ms | PASS |
| Operations | Warm-cache P99 | <= 3000 ms | 8.1 ms | PASS |

## Retrieval correction evidence

The initial evaluation was correctly held at `Evaluated / Not Certified`.
Governance and ContextItem checks passed, while `WM-CG-015` and `WM-CG-016`
failed multi-evidence coverage.

Bounded diagnostics traced BM25, Vector, RRF, rerank, and final Top-K without
returning candidate content. They showed:

- `WM-CG-015`: BM25 missed the V2.2 policy; Vector found it, but the original
  compound query did not cover all required policy sections and fusion pushed
  the document below final Top-K.
- `WM-CG-016`: section 3.4 was present at BM25 rank 14 and Vector/RRF rank 8,
  then lost during final assembly.

The correction uses the existing production `KnowledgeQueryPlanner` and
multi-query coverage merge. Deterministic plans split product source,
preconditions, risk matching, and channel status into independently retrievable
evidence, and split before/after execution requirements. Top-K remains 6.

Final evidence includes:

- `WM-CG-015`: procedure 4.4 plus current policy V2.2 sections 3, 4.1, and 4.3.
- `WM-CG-016`: follow-up guide sections 3.3 and 3.4.

No Golden Case, threshold, Asset, Binding, Eligibility, or Receipt contract was
changed.

## Governance and Context contract

All seven governance scenarios passed: active assets were eligible; inactive,
wrong-role, insufficient-clearance, future-effective, and superseded assets
were filtered before retrieval. An empty Eligibility set remains governed empty
and cannot fall back to unrestricted retrieval.

All 42 retrieved items normalized to `ea.context-item.v1`. Certification records
`Retrieved` and normalized items only; it does not label them as `Provided`,
`Cited`, or `Applied`.

## Operational variants

| Variant | Hit rate | Document recall | Version accuracy | Position hit | MRR | P95 |
|---|---:|---:|---:|---:|---:|---:|
| Hybrid, configured path | 100% | 100% | 100% | 100% | 0.9048 | 7.9 ms warm cache |
| BM25 only | 100% | 100% | 100% | 100% | 0.8571 | 26.4 ms |
| Vector only | 85.71% | 100% | 100% | 83.33% | 0.9286 | 586.2 ms |
| Hybrid, rerank disabled | 100% | 100% | 100% | 100% | 0.9048 | 481.5 ms |

The primary run was measured after per-case warmup. Variant runs are
single-sample diagnostics, not statistically equivalent latency benchmarks.
Cold process startup was not evaluated.

## State and invalidation

```text
candidate -> evaluated -> certified -> suspended
```

Changes to the index, parser, embedding model, reranker, chunking, retrieval
mode, Top-K, Eligibility snapshot, or deterministic query plan change the
Provider config fingerprint. The certification must then become `suspended`
until reevaluated.

Run the certification with:

```bash
pnpm context:provider:llamaindex:certify -- \
  --knowledge-base=<kb_public_id> \
  --output=/secure/path/llamaindex-certification.json
```

The full output contains physical Provider and document identifiers. Store it
as controlled evaluation evidence, not as a Context Receipt.
