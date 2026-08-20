# GRACE Context Resolution V1 Verification

## Verification Scope

Verification is limited to `WM-GT-01`, `WM-GT-02`, `WM-GT-03`, and `WM-GT-05`. Ordinary chat, other roles, RAGFlow, Graph retrieval, and LLM-based routing are outside this gate.

Local verification used organization `org_personal_244114a0920a4fa108c90749`, the wealth Role Pack, the existing LlamaIndex knowledge base, and the Golden Task verified release `wm-golden-task-v3`. Customer payloads and raw physical source references are not recorded in the report.

## Results

### Resolution Correctness

The Shadow Resolver was run 100 times per task, including the Binding database read on each iteration.

| Metric | Result |
| --- | ---: |
| Logical source comparisons | 12 |
| Exact or agreed-absence matches | 12 |
| Differences | 0 |
| Source match rate | 100% |
| Resolver latency P50 | 0.632 ms |
| Resolver latency P95 | 1.061 ms |
| Maximum observed latency | 34.606 ms |

`WM-GT-01` and `WM-GT-03` resolved `READY`. `WM-GT-02` was intentionally `DEGRADED` because `current_market_view` is optional and has no current provider. `WM-GT-05` was intentionally `DEGRADED` because the optional follow-up guide is not consumed by the existing path. In both cases the Resolver agreed with the legacy path and all required Context resolved.

### Failure Semantics

Automated tests cover:

- required `NO_BINDING` -> `BLOCKED`;
- optional missing Context -> `DEGRADED`;
- disabled Binding -> `BINDING_DISABLED`;
- provider capability mismatch -> `CAPABILITY_MISMATCH`;
- duplicate active Binding -> `AMBIGUOUS_BINDING` and fail closed;
- bound but inaccessible knowledge -> `NOT_ELIGIBLE`;
- expired current knowledge -> `STALE_ASSET`;
- provider success with no usable Context -> required `BLOCKED`, optional `DEGRADED`.

### Provenance

Resolution evidence now records the logical need, requiredness, resolution status, safe reason code, Binding ID, provider type, resource-reference fingerprint, and Binding snapshot fingerprint. Physical references and customer data remain outside the Receipt.

### Promotion Safety

The managed schema was migrated to `25/25`. Real Shadow Bindings were promoted against the controlled-scenario Golden Task release, then verified in production stage:

| Metric | Result |
| --- | ---: |
| Production source comparisons | 12/12 matched |
| Production Resolver latency P95 | 1.300 ms |
| Current policy retrieval | Ready, V2.2 |
| Required business sources | 3/3 resolved |

The database integration test concurrently submitted two promotions for one Shadow set. Exactly one transaction succeeded. The winning promotion retained the previous production snapshot, rollback restored it, and a repeated rollback was rejected. A task-level Binding snapshot prevents Knowledge and Business Data from observing different source versions during a concurrent Promote.

After the controlled test, the local production Bindings were rolled back and Shadow Bindings were reactivated. Repository defaults keep all Context Resolution feature flags disabled.

## Gate Decision

Context Resolution V1 satisfies the local Verification Gate for deterministic resolution, failure semantics, provenance, and promotion safety. Enabling it in another environment still requires that environment's migration, Shadow Diff, Golden Task release evidence, and staged Knowledge then Business Data rollout.
