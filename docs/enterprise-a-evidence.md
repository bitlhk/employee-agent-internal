# Enterprise A Readiness Evidence

Date: 2026-07-30

## Scope

This assessment covers the current single-primary deployment used for the
internal enterprise pilot. It does not claim active-active multi-region
availability. Redis, Kubernetes, and multi-instance WebSocket coordination
remain scale-triggered work rather than requirements for the current load
profile.

## Acceptance Summary

| Area | A-level evidence |
| --- | --- |
| Correctness | Expert task admission uses a database transaction, a stable row lock, idempotency lookup, and atomic quota checks. State-transition tests cover concurrent and duplicate requests. |
| Critical-path tests | Coverage budgets are enforced for MCP discovery and selection, sandbox policy and file paths, chat skill selection and session caching, knowledge planning/context/service, and atomic expert task admission. |
| Performance | The multi-identity business load harness exercises authenticated MCP and knowledge requests. The post-cache 50-client local baseline completed without errors with aggregate p95 480.8 ms, MCP p95 506.2 ms, and knowledge p95 557.5 ms. |
| SLOs | Chat, MCP, and knowledge objectives have Prometheus recording rules, 5-minute and 1-hour error-budget burn rates, Grafana panels, and fast-burn alerts delivered through the alert dispatcher. |
| Recovery | Encrypted snapshots are checksum-validated, synchronized daily to a separate recovery host, and restored monthly into an isolated database. The first real remote drill restored 64 tables and 638 users with a measured RPO of 37 minutes and RTO of 17 seconds. |
| Release safety | Immutable release bundles, managed migrations, pre-release backup, health gates, atomic current-release switching, and automatic rollback remain mandatory. |
| Maintainability | Module-size and explicit-`any` debt are ratcheted. MCP response assembly, bounded caches, task reservation, and administrative role reset are isolated and directly tested. |
| Security | Tenant-bound MCP identity, RBAC, audit ledger, encrypted credentials, upload controls, SSRF protection, fail-closed execution isolation, and hardened JiuwenBox remain release gates. |

## Operating Gates

1. All TypeScript checks, lint rules, dependency policy, module-size budgets,
   and type-debt budgets pass.
2. All unit and integration tests pass, followed by the critical coverage
   budget.
3. The production build and immutable release tests pass.
4. The 10/30/50-client multi-identity business load test has no errors and the
   50-client MCP p95 remains below 1.5 seconds.
5. Production readiness, Prometheus rules, Grafana provisioning, backup
   synchronization, and the latest restore-drill report are verified after
   deployment.

## Residual A+ Work

- Introduce Redis-backed distributed rate limiting and event coordination only
  when more than one application instance is required.
- Add active-active application replicas and database failover when measured
  concurrency or recovery objectives require them.
- Continue shrinking the remaining large UI and bridge modules behind the
  existing no-growth budgets.
- Raise global test coverage incrementally without replacing behavior-focused
  integration tests with low-value line execution.
