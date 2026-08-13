# GRACE Runtime Contracts V1

## 1. Scope

This increment keeps the GRACE top-level architecture unchanged and adds compatible engineering contracts for selected wealth-manager benchmark tasks.

The active rollout scope is:

- `WM-GT-01`: customer previsit context;
- `WM-GT-02`: governed allocation and product candidates;
- `WM-GT-03`: current policy basis;
- `WM-GT-04`: suitability and risk mismatch;
- `WM-GT-05`: confirmed and idempotent business writes;
- `WM-GT-06`: bounded maturity operations;
- active side-effect Capability PEP coverage;
- stable runtime organization identity and authorization snapshots;
- reference knowledge source, series, and replacement versions;
- role-pack contract validation;
- persisted role-pack release evidence and stale-asset detection;
- execution-time authority intersection on Custom MCP, Enterprise MCP, Platform MCP, A2A, notification, Feishu, Cron, and workspace writes;
- A2A side-effect closure through local-governance Capability Intents.

Ordinary chat and unrelated roles continue to use the existing Runtime Principal V1 path.

## 2. Runtime Contracts

### Runtime Principal V2

`RuntimePrincipalV2` extends the existing adoption identity with stable `tenantId`, `organizationId`, `authorizationSnapshotId`, `authorizationFingerprint`, and `identityVersion`.

The server resolves and persists this identity. Clients and external runtimes cannot declare these fields as authority. Missing snapshot persistence fails closed for the selected governed tasks.

### Task Execution Envelope

The immutable `TaskExecutionEnvelope` binds:

- Runtime Principal V2;
- a principal-bound `TaskContextPack`;
- task and requested-outcome-specific Readiness;
- the exact Capability snapshot;
- release evidence reference;
- correlation ID and fingerprints.

The Context Pack stores only `principalFingerprint`; it does not duplicate mutable identity fields.

### Task Readiness

Readiness returns `READY`, `DEGRADED`, or `BLOCKED`, plus separate allowed, denied, and fallback outcomes. It guides planning and user-visible recovery, but does not replace execution-time Policy or PEP checks.

The release gate resolves the exact evaluation-suite version and current asset-set fingerprint against persisted release evidence. A matching verified release is `READY`; a changed asset set is `DEGRADED / ROLE_PACK_RELEASE_STALE`; a missing release remains in phased rollout and must not be described as model-verified.

Controlled verification and model verification remain distinct. `controlled_scenario` proves deterministic context, policy, scope, and degradation behavior against governed fixtures. It does not claim that every supported model has passed an end-to-end scenario suite.

## 3. Knowledge Version Chain

Reference knowledge import now persists:

- `sourceAssetId`;
- `documentSeriesId`;
- `supersedesDocumentId`;
- existing version, lifecycle, effective time, expiry, and checksum.

Import validation rejects unknown or cyclic replacement references, inconsistent bidirectional links, and overlapping active versions in one document series.

## 4. Capability PEP Evidence

The registry exposes two separate coverage concepts:

- declaration coverage: the active side-effect Capability declares a deterministic fail-close PEP;
- execution proof coverage: the Capability points to a checked-in route, invariant, or boundary test.

These are intentionally separate. Boundary proof is weaker than a route-level `DENY -> executor not called` integration test and is identified as such in the registry.

## 5. Golden Task Contract Runner

Run:

```bash
pnpm rolepack:wealth:contracts
```

The report validates six benchmark task contracts, assertion proof categories, Capability implementation/test evidence, knowledge coverage, and an exact asset-set fingerprint.

`executionLevel=contract` and `scenarioExecution=false` are deliberate. A PASS proves packaging and contract completeness, not that a model has executed all 24 scenarios successfully.

Run the controlled scenarios and persist exact release evidence with:

```bash
pnpm rolepack:wealth:scenarios -- --persist
```

The controlled runner executes fourteen scenarios across all six tasks, including cross-owner denial, expired knowledge degradation, current-policy selection, product eligibility, risk mismatch, expired assessment, policy-unavailable fail-close behavior, Demo write binding, idempotency, maturity prioritization, partial dependency failure, and cross-customer exclusion. Successful persistence marks older verified fingerprints for the same suite as `stale`.

Run the nine real-model scenarios and persist the stronger release evidence with:

```bash
pnpm rolepack:wealth:model-scenarios -- --persist --summary
```

The runner uses the configured EA assistant model without tools. It additionally validates governed allocation candidates, the confirmation boundary for business writes, and maturity operations without automatic replacement-product recommendation.

To require the same suite to pass multiple release models:

```bash
pnpm rolepack:wealth:model-scenarios -- --models=glm-5.2,deepseek-v4-flash --summary
```

The model sees a business-facing projection of governed Context rather than policy decision IDs, fingerprints, or authorization evidence. Detailed model, latency, output, and assertion evidence is persisted in the release record. Release IDs bind both the asset fingerprint and `wm-golden-task-v3`, so an older suite result cannot satisfy the current release gate.

## 6. Execution-time Authority

Custom, Enterprise, and Platform MCP side-effect paths re-resolve current authority immediately before governance and execution. Effective authority is:

```text
task authorization snapshot
INTERSECT current authorization snapshot
INTERSECT current task scope
```

Revoked organization membership, identity drift, missing snapshots, and database failures deny execution. New permissions granted after task creation do not enlarge the task's original authority. Route-level tests prove that revoked authority does not call the remote MCP executor.

Platform MCP forwards the bounded task snapshot when it submits an A2A task. A2A persists that snapshot inside its private task Runtime Context and checks it twice: before reservation/delegation and again in the background Worker immediately before egress and the remote Agent call. A task may therefore be accepted into the queue but still fail closed if authority is revoked before execution. The persisted Runtime Context is removed from public task responses.

Platform-created A2A tasks also derive a stable `sourceMessageId` from the MCP request identity when the caller does not provide one. The database reservation uses it as the downstream idempotency boundary.

Direct notification, Feishu test delivery, Cron mutation, and workspace upload/delete routes use the same execution-time authority intersection immediately before their executor. Their existing egress, path, malware, quota, ownership, and idempotency controls remain independent obligations rather than being replaced by identity authorization.

New Cron jobs persist the bounded task authorization snapshot in private Jiuwen Cron metadata. A completed scheduled run that targets an external channel re-resolves current authority and intersects it with that stored snapshot before invoking the channel provider. If authority was revoked after scheduling, the run result remains recorded while external delivery is marked failed and the provider is not called. Older Cron jobs without a stored task snapshot use the current snapshot as a compatibility ceiling until they are updated or recreated.

## 7. A2A Side-effect Closure

Delegated remote agents are restricted to `read` and `compute`. A direct side-effect delegation request is denied. A remote result may propose an `ea.capability-intent.v1`, but the proposal is persisted as `pending_local_governance`, omitted from ordinary result text, and recorded in audit evidence as not remotely executed.

There is no generic route that blindly executes arbitrary remote intents. V1 registers one isolated checked-in reference binding:

```text
enterprise.crm / create_followup
        ↓ strict argument transformation
wealth_governance_demo / demo_create_followup_task
```

The binding rejects side-effect mismatches, real customer references, invalid due dates, and missing idempotency keys before entering the gateway. Every execution reuses the original task authorization snapshot, re-resolves current authority, and passes the existing Enterprise MCP policy, confirmation, egress, idempotency, short-lived identity, receipt, and audit path. Unsupported intents remain unexecuted.

Execution state is durable in `a2a_capability_intent_executions`. A first request may end at `approval_required`; only the exact approved action and payload can transition through `executing` to `succeeded`. Terminal blocked or failed intents require a new remote proposal rather than replaying a consumed approval.

Production bindings use `ea.a2a-capability-binding.v1` contracts supplied as server-side deployment configuration. They must declare identity, approval and idempotency as mandatory, use an argument allowlist mapping, and target an Enterprise MCP connection that is `prod`, `enforced`, short-token authenticated and identity verified. The target tool policy must independently match the side effect and enforce approval plus idempotency. Any mismatch fails before execution reservation.

## 8. Database Rollout

Apply managed migrations before enabling the selected V2 task paths in an environment:

```text
0015_runtime_principal_v2.sql
0016_knowledge_version_chain.sql
0017_role_pack_release_evidence.sql
0018_a2a_capability_intents.sql
0019_a2a_capability_intent_executions.sql
0020_enterprise_asset_onboarding.sql
```

Migration `0015` backfills stable organizations and memberships from existing non-empty `users.organization` values. Users without an organization receive a stable personal organization only when Principal V2 is first resolved.

## 9. Operational Gates

- Production A2A contracts remain disabled until a target Enterprise MCP has passed identity enforcement and row-level authorization verification.
- Multi-model release evidence is produced only after operators run the suite against the selected deployed models; fixture tests do not count as model verification.
- Enterprise Asset Onboarding V1 supports source registration, Manifest import, human review, existing-Runtime-asset publication, impact analysis and Role Pack stale marking. Scheduled source synchronization and automatic Policy/Skill generation are deliberately outside the Runtime and remain future connector work.
- Channel binding/configuration administration remains ownership-based rather than task-envelope-based.
- Sandbox and external Runtime Hook capabilities retain boundary/invariant proof because their executors are not in-process HTTP routes. Every active in-process HTTP side-effect PEP now requires route-integration proof.
