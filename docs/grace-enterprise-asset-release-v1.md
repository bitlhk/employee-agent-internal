# GRACE Enterprise Asset Release V1

## Purpose

This release slice connects governed knowledge candidates to the verified Context Resolution path without turning Binding into a document-version switch.

```text
Candidate Asset
  -> human metadata confirmation
  -> independent review
  -> draft Knowledge projection
  -> affected Role Pack becomes stale
  -> Golden Task re-verification
  -> asset activation
  -> effective-time Eligibility
  -> TaskContextPack / Context Receipt
```

## Lifecycle Boundaries

- Asset Lifecycle owns document version, `effectiveAt`, `expiresAt`, and `supersedesDocumentId`.
- Projection Lifecycle owns whether an approved asset has entered the existing runtime knowledge service as a draft.
- Binding Lifecycle owns changes to the physical provider or knowledge-base endpoint. A new document version in the same knowledge base does not create or promote a Binding.

A replacement only supersedes its predecessor after the replacement passes every ordinary Eligibility check. Therefore a future V3.3 does not hide current V3.2. At the V3.3 effective time, V3.2 is excluded with reason `superseded` and V3.3 enters the eligible set without changing Role Pack, Skill, or Binding.

## Administrator Experience

The Enterprise Asset panel exposes business states:

- `可进入岗位验证`: reviewed candidate has not entered Runtime;
- `待标杆任务验收`: draft is indexed but cannot enter employee Context;
- `已验证，等待生效`: activation was approved but `effectiveAt` is in the future;
- `当前有效`: document is eligible at the current time.

Official policy candidates require a confirmed effective time. The target must be an existing role or enterprise knowledge base, and role-scoped targets must match the candidate's applicable role.

## Release Gate

Staging marks every affected verified Role Pack release stale. Activation requires:

1. the draft document index status is `ready`;
2. candidate-level validation proves that the exact candidate checksum becomes the selected policy at its effective time and its predecessor leaves the eligible set;
3. the affected wealth controlled Golden Tasks pass and produce a verified Role Pack release newer than the staging event;
4. the candidate and document are activated in one database transaction.

Activation does not bypass future effective time. Runtime Eligibility remains the authority for whether the document is visible to an Agent.

## Effective Context Snapshot

Every new Task Context and Context Receipt contains a compact snapshot of the effective knowledge versions, business-data timestamps, and referenced memory IDs supplied to that task. The snapshot excludes raw Context text, customer fields, and provider addresses, and is protected by its own fingerprint.

## Deliberate Limits

- No RAGFlow, Graph, LLM Router, new vector store, or second Registry is introduced.
- Candidate validation binds the exact candidate/document/checksum to effective-time selection and the controlled wealth task suite. Automatic clause-level semantic regression against arbitrary newly uploaded document contents remains a later Asset Intelligence capability.
- Object-inventory discovery does not pull remote content or credentials; only candidates with locally staged content can enter the draft knowledge projection in this version.
