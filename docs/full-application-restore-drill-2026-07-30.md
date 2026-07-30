# Full Application Restore Drill - 2026-07-30

## Result

- Status: passed
- Source: Shanghai production full encrypted snapshot `20260729-180511`
- Source commit: `b8739b5dfd5ab69ddfe61b46d8ab5ed78b2ca73f`
- JiuwenSwarm version: `0.2.3+ea.7`
- Recovery target: dedicated isolated host
- Data restore RPO: 53,155 seconds
- Automated data restore RTO: 298 seconds

The RTO covers snapshot validation, decryption, database import, and durable
data validation. Provisioning, dependency installation, build, service startup,
and manual business verification were measured separately.

## Restored Inventory

| Item | Count |
| --- | ---: |
| Database tables | 66 |
| Audit triggers | 8 |
| Users | 633 |
| Agent adoptions | 35 |
| Marketplace skills | 86 |
| Knowledge bases | 6 |
| Knowledge documents | 34 |
| Application data/config files | 123 |
| Skill files | 1,821 |
| JiuwenSwarm files | 2,221 |

All encrypted archive checksums passed before decryption. The restored database
used an isolated MySQL container and a DML-only application account. External
messaging, scheduled delivery, alerts, expert proxies, and production callbacks
were disabled to prevent side effects.

## Functional Evidence

| Check | Result |
| --- | --- |
| Database import and audit attestation | Passed |
| Frozen dependency install, type check, production build | Passed |
| EA, knowledge service, and JiuwenSwarm readiness | Passed |
| Recovered-user login | Passed |
| Main JiuwenSwarm conversation | Passed |
| Skill reconciliation and execution | Passed |
| Platform MCP call | Passed |
| Knowledge reindex, hybrid retrieval, and cited chat | Passed |
| ClamAV clean-file scan | Passed |
| Authenticated artifact upload and tokenized download | Passed |
| Test artifact cleanup | Passed |
| Pre-existing recovery-host services | Unchanged |

## Findings And Closure

1. Generated knowledge indexes were intentionally excluded, but no job existed
   after restore. EA now audits physical indexes at startup and durably queues
   missing-index rebuilds.
2. Production upload policy required ClamAV, but the dependency was not part of
   installation or readiness. The installer now offers `--with-antivirus`, and
   required scanner health participates in `/health/ready`.
3. A repository-owned role baseline used a host-absolute path. Relative paths
   are now resolved from the application root and documented for portable
   deployments.
4. The Skill registry retained source and runtime paths from the source host.
   `pnpm restore:reconcile` now supports explicit root mappings, clears Jiuwen
   runtime projections, and rebuilds them from durable sources.

## Cleanup

All isolated application processes and the restored database container were
stopped. Decrypted archives, database files, generated credentials, temporary
source/runtime copies, and test artifacts were removed. Only sanitized reports
were retained.
