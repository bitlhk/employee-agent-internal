# Enterprise A- Readiness Evidence

## Decision

The current platform meets an A- baseline for an internal enterprise pilot and
a 30-50 participant training deployment on the documented single-node
architecture.

This rating does not claim active-active high availability, regional disaster
recovery, or 50 simultaneous model generations. Deployments requiring those
properties remain below A- until the residual items in this document are closed.

## Evidence

| Area | Evidence | Assessment |
| --- | --- | --- |
| Runtime boundary | JiuwenSwarm is the only active Agent runtime; OpenClaw execution, provisioning, recovery, channel, and fallback paths are removed and fail closed | A- |
| Identity and governance | Authenticated ownership checks, RBAC, tenant-bound MCP identity, append-only audit ledger, encrypted credentials, upload controls, and JiuwenBox isolation | A- |
| Operability | Correlation IDs, structured logs, liveness/readiness, bounded Prometheus metrics, Grafana dashboards, Feishu alert transitions, capacity rejection metrics | A- |
| Recovery | Encrypted full backup, checksum validation, isolated database restore, durable file recovery, knowledge rebuild, Skill reconciliation, real login/chat/MCP/upload checks | A- |
| Release safety | Immutable release bundles, manifest checksums, frozen lockfile, managed migrations, pre-release backup, health gate, atomic switch, automatic application rollback | A- |
| Supply chain | Dependency policy, production audit gate, pinned package manager, package and lockfile hashes, direct dependency manifest; zero high or critical production advisories | A- |
| Maintainability | Route extraction, history and health modules, module-size budgets, type-debt non-growth gate, all-source coverage gate | B+ |
| Capacity | 50-client platform reads and 20-client authenticated business reads pass their measured SLO with zero errors; real MCP and sandbox paths verified | B+ |

## Recovery Drill

The 2026-07-30 isolated full-application drill restored a Shanghai encrypted
snapshot to a dedicated host:

- 66 database tables and 8 audit triggers
- 633 users and 35 Agent adoptions
- 86 marketplace Skills and 34 knowledge documents
- 4,165 restored application, Skill, and JiuwenSwarm files
- data restore RPO 53,155 seconds, within the initial 24-hour target
- automated data restore RTO 298 seconds, within the initial 4-hour target
- login, JiuwenSwarm chat, Skill, MCP, knowledge, antivirus, upload, and
  tokenized download checks passed

Decrypted data and the isolated database were removed after the drill.

## Capacity And SLO

The corrected smooth-weighted baseline is in
`capacity-baseline-2026-07-29.md`.

- Read-only platform traffic at 50 concurrent clients: 640.4 req/s, zero
  errors, p95 11.6 ms.
- Authenticated business traffic at 20 continuous clients: 14.67 req/s, zero
  errors, aggregate p95 2.07 seconds.
- Real wealth MCP chat: first byte 2.54 seconds, first tool event 6.70 seconds,
  successful completion.
- Focused real MCP probe: successful Prometheus call lifecycle with no leaked
  active span.
- Real JiuwenBox sandbox smoke: 0.39 seconds, expected marker returned.

The accepted operating envelope is normal 30-50 person training traffic with
staggered Agent use. MCP status long-tail latency at 20 continuous clients and
upstream model latency are the first constraints, not static asset delivery.

## Enforced Gates

CI and release verification enforce:

1. Empty, existing, incompatible, and supported-legacy database migration paths.
2. Lint, TypeScript, explicit-any non-growth, and large-module budgets.
3. Production dependency policy and high-severity audit.
4. All-source coverage floors.
5. Unit and integration tests plus knowledge-service tests.
6. Release manifest, checksum, deploy, rollback, and production verifier tests.
7. Production build and dependency readiness.

## Residual Risks

1. The application, MySQL, JiuwenSwarm, and knowledge service are single-node
   components. There is no automatic failover or active-active deployment.
2. Redis and multi-instance session coordination are intentionally deferred
   until measured traffic requires them.
3. The capacity test does not create 50 simultaneous paid model generations.
   Upstream quota, latency, and cost must be calibrated before that claim.
4. All-source coverage is 21.99% statements/lines, 42.09% functions, and 66.04%
   branches. The floor prevents regression but is not a mature long-term target.
5. `server/routers/claw.ts` and `client/src/pages/Home.tsx` remain large. Their
   non-growth budgets are enforced, but further behavior-preserving extraction
   is still required.
6. Production dependencies currently have one low and one moderate advisory,
   with zero high or critical advisories.
7. Database schema rollback is forward-compatible rather than automatically
   reversible; releases must preserve one-window backward compatibility.

## Next Promotion Gate

The next step toward a full A rating is not Kubernetes by default. It is:

1. reduce MCP status long-tail latency and repeat the 20-client business test;
2. raise coverage around chat, runtime, MCP authorization, restore, and release
   control paths;
3. continue splitting the remaining large modules;
4. add MySQL and runtime failover only when the service-level objective requires
   automatic recovery rather than operator-led restoration.
