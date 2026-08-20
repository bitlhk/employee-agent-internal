# GRACE Production Activation Record - 2026-08-20

## Decision

GRACE Context Resolution V1 is **Production Activated for Wealth Manager** in the Shanghai environment. Enterprise Asset Release remains gated per candidate; other roles are not covered by this activation record.

This is a production fact record, not a claim that all GRACE Context capabilities are generally available.

The corresponding machine-readable, point-in-time inventory is `grace-production-context-inventory-2026-08-20.yaml`. It is an evidence snapshot, not a production configuration source.

## Observed Runtime State

Read-only verification on 2026-08-20 confirmed:

- deployed application commit: `8aaf93255e2e0713fd70c5349e7372fbf3d1cba4`;
- `EA_CONTEXT_RESOLUTION_SHADOW_ENABLED=true`;
- `EA_CONTEXT_RESOLUTION_KNOWLEDGE_ENABLED=true`;
- `EA_CONTEXT_RESOLUTION_BUSINESS_DATA_ENABLED=true`;
- role scope: `linggan-bank.wealth-manager`;
- organization scope: `*`;
- seven active Production Bindings;
- seven active Shadow Bindings;
- one active Binding Promotion;
- production readiness checks passed for the database, Knowledge service, JiuwenSwarm, and antivirus dependency.

The Production Binding set contains:

| Context type  | Logical assets                                                                              | Provider types |
| ------------- | ------------------------------------------------------------------------------------------- | -------------- |
| Knowledge     | `current_previsit_sop`, `current_wealth_policy`                                             | LlamaIndex     |
| Business Data | `available_products`, `customer_portfolio`, `customer_profile`, `governed_followup_payload` | MCP / API      |
| Memory        | `customer_relationship_memory`                                                              | API            |

No physical `resourceRef`, credential, customer value, or retrieved Context content is recorded here.

## Promotion Evidence

- promotion ID: `ctxp_cadc8ba3248444eabd8c1eaa8b0ec06c`;
- promotion status: `active`;
- promotion time: `2026-08-20 15:58:54` Asia/Shanghai;
- verified release reference: `linggan-bank.wealth-manager@fb121195e3a859b1:wm-golden-task-v3`;
- verification level: `controlled_scenario`;
- current verified record time: `2026-08-20 16:01:11` Asia/Shanghai.

The release record can be re-verified after Promotion under the same release ID. Its latest `verifiedAt` timestamp is therefore evidence of the current verified record, not an immutable timestamp proving the original Promotion ordering. Promotion history and Role Pack verification remain distinct evidence objects.

The dedicated deterministic verifier previously reported 12 of 12 expected source matches with approximately 1.972 ms P95 Resolver latency. Runtime shadow logs also contain deliberate failure-semantics injection around 16:04, followed by recovered normal observations from 16:05. Raw shadow-log history must therefore not be presented as an uninterrupted 100% match series.

## Lifecycle Boundaries

- Code rollback changes application code; it does not restore Asset or Binding state.
- Asset rollback changes version eligibility through the Asset Lifecycle.
- Binding rollback uses the guarded Promotion snapshot and does not alter document versions.
- Feature Flag changes alter the active runtime path and require an explicit production decision.

## Not Activated By This Record

- multi-role Context Resolution;
- enterprise-scale Connector and asynchronous onboarding;
- automatic Runtime Projection;
- RAGFlow, Graph, or other external provider federation;
- unrestricted enterprise asset activation;
- deterministic replay of historical decisions;
- clause-level semantic proof for arbitrary policy documents.

## Next Verification

Use an isolated Demo organization to validate a real short-cycle V3.2 to V3.3 effective-time transition. The demonstration must not change the host clock or expose test `asOf` controls as a production feature. Evidence should include candidate validation, the pre-effective and post-effective eligible versions, the Effective Context Snapshot, and the old-version exclusion reason.
