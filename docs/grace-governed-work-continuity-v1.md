# GRACE Governed Work Continuity V1

Status: Engineering implementation; runtime verification pending.

## Objective

Prove that a user-confirmed work item extracted from meeting text can be recalled, continued, and closed in a later interaction without treating unconfirmed model output as an enterprise fact.

This is not a meeting assistant or a general memory platform.

## Runtime chain

```text
Meeting Text
  -> Deterministic Structured Extraction
  -> Work Item Draft
  -> Explicit User Confirmation
  -> Capability Execution
  -> Execution Receipt
  -> Governed Work State
  -> ContextNeedPlan / Resolver / TaskContextPack
  -> Later Recall / Continue
  -> Confirmed Update / Close
```

## Supported semantics

- Persisted work item types: `decision`, `action_item`, `open_question`.
- `owner` and `dueAt` are properties of a work item, not separate memory entities.
- States: `draft`, `confirmed`, `open`, `in_progress`, `done`, `cancelled`.
- Drafts may be displayed to their creator but are excluded from formal work Context.
- Confirmed, open, and in-progress items may be provided as `memory` Context.
- Done and cancelled items are excluded from active work Context unless history is explicitly requested.

## Governance boundaries

- Extraction output is a suggestion, not an enterprise work fact.
- Every write requires explicit confirmation.
- Conversational writes use the existing governance approval service.
- Authenticated UI writes require a confirmation dialog and create the same immutable execution receipt.
- State transitions are scoped by organization, user, and adopted role instance.
- Idempotency keys are scoped by organization, user, and adopted role instance.
- A failed capability call must not advance work state.
- Context Receipt answers what facts were provided; Execution Receipt answers what action was performed.

## Golden scenario

### T1 - Create

Input meeting text identifies a decision, two action items, their owner/dates, and one open question. The user confirms selected drafts. Only confirmed items become formal work state.

### T2 - Continue

In a later interaction, the Agent resolves `governed_work_state` through the existing Context Resolution chain and reports remaining work from confirmed state, not by reinterpreting the meeting transcript.

### T3 - Close

The user explicitly confirms completion. The write capability creates an Execution Receipt and changes status to `done`. Subsequent active-work retrieval must not return the closed item.

## Verification

```bash
pnpm work:continuity:verify
pnpm check
pnpm test:integration:db
```

The frozen expert-confirmed Context Quality baseline is not modified. `governed_work_state` is defined in an additive catalog extension under `examples/governed-work-continuity-v1/`.
