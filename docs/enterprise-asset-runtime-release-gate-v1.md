# Enterprise Asset Runtime Release Gate V1

## Purpose

An approved governance asset is not automatically searchable or available to an Agent. Every approved knowledge asset must have one explicit Runtime projection decision:

- `searchable_only`: visible in the administrator governance catalog; excluded from Agent retrieval and Runtime Context.
- `runtime_candidate`: mapped to canonical Logical Context and affected Golden Tasks; eligible to enter the candidate release gate.
- `archived`: retained for audit; no searchable or Runtime projection.

`pending` is a migration and workflow state only. A closed asset lifecycle has no approved asset left in `pending`.

## Runtime Candidate Gate

A Runtime Candidate must declare `logicalAssetIds` and `relatedTasks`. Staging and activation are separate operations.

Activation requires all of the following:

1. Candidate-level eligibility selects the exact document at its effective time.
2. The predecessor exits the eligible set when superseded.
3. The affected controlled Golden Tasks pass.
4. Each affected task builds a `TaskContextPack` containing the candidate document.
5. Each gate Receipt contains the same `candidateAssetFingerprint` in `provided.knowledge`.

A task that passes while consuming a different asset does not satisfy the gate.

The candidate fingerprint binds candidate ID, enterprise asset ID, source version, checksum, projected document ID, Logical Context IDs, and affected tasks. Changing any of these invalidates the prior validation.

## Boundaries

- `searchable_only` does not mean semantic RAG indexing. It is an administrator governance-catalog capability in V1.
- Golden Task gate Receipts prove controlled candidate Context assembly. They do not claim full historical replay.
- Asset version changes use the Asset lifecycle. Provider or resource changes use the Binding lifecycle.
- Role Pack and Skill code must not contain physical KB IDs or MCP source IDs.

## Controlled Production Classification

Run a read-only preview first:

```bash
pnpm context:assets:classify
```

Apply only after the preview is reviewed:

```bash
pnpm context:assets:classify --apply
```

The V1 controlled operation classifies active approved demo/reference assets without an expert-confirmed task Evidence contract as `searchable_only`. It does not create Runtime mappings, bindings, or publish knowledge.

## Exit Criteria

- Every approved knowledge asset has an explicit projection decision.
- Every Runtime Candidate has canonical Logical Context and affected task mappings.
- Candidate fingerprint is present in each affected task's Provided Context Receipt.
- Failed or stale candidate validation cannot activate the asset.
- Existing Agent Runtime behavior is unchanged by classifying `searchable_only` assets.
