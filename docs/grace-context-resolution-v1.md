# GRACE Context Resolution V1

## Scope

V1 proves that a Reference Role Pack can declare logical Context needs while GRACE resolves existing LlamaIndex and MCP sources without putting physical source IDs in Role Pack Skills. It is limited to `WM-GT-01`, `WM-GT-02`, `WM-GT-03`, and `WM-GT-05`. Ordinary chat and all other roles keep their existing paths.

The runtime chain is:

```text
ContextNeedPlanV1
  -> eligible ContextSourceBindingV1
  -> deterministic SourceResolverV1
  -> existing provider adapter
  -> ContextItemV1
  -> TaskContextPack
  -> Context Receipt
```

The Resolver does not understand business semantics, grant permissions, execute Skills, or generate answers. It only maps a logical need to one eligible active Binding. Knowledge eligibility still runs before document retrieval; MCP authorization and PEP remain at their existing execution boundaries.

## Rollout

1. Apply `0023_context_source_bindings.sql` and `0024_context_source_binding_promotions.sql`.
2. Create Shadow Bindings with `pnpm context:wealth:bindings -- --organization=<org> --knowledge-base=<kb_public_id> --apply`.
3. Set `EA_CONTEXT_RESOLUTION_SHADOW_ENABLED=true` and compare `logs/context-resolution-shadow.log`. Shadow failures never affect users and the log contains references and match booleans, not customer payloads.
4. Run the wealth Role Pack contracts and Golden Task scenarios against the candidate knowledge version. Contract-only verification cannot promote a Binding; the release must have `controlled_scenario` or `model_scenario` evidence.
5. Promote only against a verified Role Pack release:

```bash
pnpm context:wealth:bindings -- \
  --organization=<org> \
  --promote \
  --verified-release-id=<verified_release> \
  --apply
```

6. Enable `EA_CONTEXT_RESOLUTION_KNOWLEDGE_ENABLED=true`. After validation, independently enable `EA_CONTEXT_RESOLUTION_BUSINESS_DATA_ENABLED=true`.

Run the deterministic old/new source comparison with:

```bash
pnpm context:wealth:verify -- \
  --organization=<org> \
  --knowledge-base=<kb_public_id> \
  --stage=shadow \
  --iterations=100
```

All flags default to `false`; disabling them restores the legacy paths without reverting the additive migration.

## Readiness And Evidence

- Provider Health and Context Readiness are separate signals. Provider Health reports whether LlamaIndex, MCP, or an API is reachable; it cannot establish that a task has the required facts.
- Context Readiness is evaluated per `ContextNeed` from requiredness and usable returned Context. A healthy CRM with a missing customer risk level can still make an allocation task `BLOCKED`.
- Missing required Binding or provider capability is `BLOCKED` before a governed result or write.
- Missing optional knowledge is `DEGRADED`; WM-GT-02 can continue without the optional market view but must disclose the limitation.
- A resolved provider that returns no usable Context is not `READY`. Receipts use bounded reason codes: `NO_BINDING`, `BINDING_DISABLED`, `CAPABILITY_MISMATCH`, `AMBIGUOUS_BINDING`, `NOT_ELIGIBLE`, `SOURCE_UNAVAILABLE`, `NO_USABLE_CONTEXT`, and `STALE_ASSET`.
- A task resolves Knowledge and Business Data from one in-memory Binding snapshot. The snapshot fingerprint is carried into resolution evidence so a concurrent Promote cannot silently mix source versions within one task.
- Receipt entries retain logical asset ID, Binding ID, provider type, and a SHA-256 resource-reference fingerprint. Raw physical references do not enter model content or the Receipt.
- `TaskContextPack` and the Receipt carry an Effective Context Snapshot containing only logical asset IDs, asset/version identifiers, business-data timestamps, and a fingerprint. It never contains retrieved text or physical provider addresses.
- `Retrieved`, `Provided`, `Cited`, and `Applied` remain separate evidence semantics. A resolved Binding is not itself proof that content was retrieved or used.

Operations views may show both Provider Health and task-level Context Readiness, but must not collapse them into one score. Employee-facing experiences translate missing Context into business language rather than exposing internal status or provider names.

## Deliberate Non-Goals

V1 does not add an LLM router, RAGFlow, Graph retrieval, a second permission system, a new Context microservice, or a replacement Knowledge Center. Additional providers enter through adapters after a real role task requires them.

## Promotion Safety

Promotion runs in one database transaction and requires a Role Pack release verified by a controlled or model Golden Task. The transaction stores immutable previous and promoted Binding snapshots. Rollback succeeds only if production still matches the promoted snapshot; a later change makes the rollback fail closed instead of overwriting newer configuration.
