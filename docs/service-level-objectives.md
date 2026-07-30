# Service Level Objectives

## Scope

These objectives define the A-level operating target for the current
single-node enterprise deployment. They measure user-visible outcomes and
recovery evidence. They do not claim active-active availability or 50
simultaneous paid model generations.

Cancelled user requests are excluded from success-rate denominators. Missing or
low-volume data is shown as no data and does not become an artificial zero
percent success rate.

## Objectives

| Capability | Service level indicator | Objective | Window |
| --- | --- | ---: | --- |
| Web application | Non-5xx HTTP responses | 99.5% | rolling 30 days |
| Agent conversation | Successful non-cancelled completions | 98% | rolling 30 days |
| First visible response | Chat first-token p95 | <= 20 seconds | rolling 10 minutes |
| MCP execution | Successful or valid-empty non-cancelled calls | 97% | rolling 30 days |
| MCP status page | `/api/claw/mcp-tools/status` p95 | <= 1.5 seconds | rolling 10 minutes |
| Knowledge search | Successful or valid-empty searches | 99% | rolling 30 days |
| Knowledge search | Search p95 | <= 2.5 seconds | rolling 10 minutes |
| Release control | Activation succeeds or automatically rolls back | 100% | per release |
| Backup | Latest validated snapshot age | <= 26 hours | continuous |
| Recovery | Measured RPO | <= 24 hours | every drill |
| Recovery | Measured data restore RTO | <= 4 hours | every drill |

The chat and external-tool objectives include upstream provider behavior because
that is what users experience. Provider-specific failures remain visible through
bounded runtime and MCP labels; they are not silently removed from the platform
objective.

## Alert Policy

- Availability and safety failures page immediately after a short confirmation
  interval.
- Latency and success-rate alerts require a minimum sample count so low traffic
  does not create false alarms.
- Initial success-rate alerts use a 30-minute operational window. Monthly
  compliance is reviewed in Grafana from the same counters.
- Restore evidence becomes stale after 35 days. Backup freshness remains a
  separate daily control.

## Recovery Evidence

Daily backups are encrypted and validated automatically. A data-layer restore
drill runs monthly on an isolated recovery host. A full application exercise
that starts MySQL, knowledge, JiuwenSwarm, and EA and validates login, chat, MCP,
knowledge, upload, and download runs quarterly.

The restore runner writes a bounded status report containing only counts, RPO,
RTO, source commit, and operational metadata. Prometheus reads the latest
successful report; it does not expose restored row contents.

## Promotion Gate

The platform reaches the A operating target when:

1. MCP status p95 passes the 20-client authenticated business test.
2. Critical-path coverage and all existing CI gates pass.
3. A representative 30-50 participant mixed workload stays within these
   objectives without capacity leakage after the test.
4. Release rollback and monthly restore evidence are current.
5. Grafana and Feishu show no unresolved critical alerts from the validation
   window.
