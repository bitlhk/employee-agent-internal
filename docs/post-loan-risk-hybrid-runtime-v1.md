# GRACE Post-loan Risk Hybrid Runtime V1

## Status

Engineering implementation complete. Local runtime verification and Shanghai deployment remain release gates.

## User experience

The risk-control role has two intentionally different execution paths:

```text
Enterprise lookup / single-factor check
  -> governed post_loan_risk_data MCP
  -> immediate result + Context Receipt

Complete risk assessment report
  -> immutable governed risk snapshot
  -> asynchronous risk-control-a2a task
  -> specialist analysis draft
  -> deterministic EA escalation policy
  -> human review / confirmed follow-up action
```

Users therefore get a fast answer for routine checks and a tracked task card for long reports. A remote report failure does not disable enterprise lookup or single-factor checks.

## Authority boundaries

EA remains authoritative for:

- runtime principal and role authorization;
- enterprise discovery and source identity;
- business facts, data time, completeness, and snapshot fingerprint;
- deterministic warning level and current policy;
- write confirmation, execution, receipts, and audit.

The remote JiuwenSwarm node is authoritative only for:

- long-running four-dimension analysis;
- evidence organization;
- report drafting.

It has no active business MCP, no trusted Mock dataset, no automatic regulatory classification, and no write capability.

## Data contract

Full assessments require `ea.post-loan-risk-assessment-request.v1` with:

- an 18-character enterprise identity;
- an `ea.post-loan-risk-snapshot.v1` snapshot in `READY` state;
- `data.completeness.criticalComplete=true`;
- matching declared, stored, result, and recomputed SHA-256 fingerprints;
- constraints that prohibit regulatory classification and automatic credit action and require human review.

EA rejects the task before egress if any requirement fails. Current enterprise JiuwenSwarm does not expose A2A data parts to the Agent, so EA sends the already-validated payload both as the protocol data part and as a deterministic `<ea_governed_payload>` text envelope. The duplicated representation carries the same data and does not create a second authority.

## Network boundary

The dedicated node runs on `113.44.127.99`. EA reaches it through a managed loopback SSH tunnel and a same-origin route:

```text
EA public origin /a2a/risk-control/a2a
  -> EA local proxy
  -> 127.0.0.1:19101
  -> SSH tunnel
  -> risk node 127.0.0.1:19100/a2a
```

Direct port `19100` is not the intended application interface and should be restricted by the infrastructure firewall after both EA environments use the tunnel.

## Output boundary

The dedicated executor must place user-visible text in `<ea_final>...</ea_final>`. EA returns only the last complete envelope. If an environment requires this envelope and it is missing, the asynchronous task fails instead of exposing reasoning traces.

## Acceptance gates

1. Unknown enterprises fail closed.
2. An unchanged enterprise snapshot produces an unchanged fingerprint.
3. A changed snapshot with an old fingerprint is blocked before A2A egress.
4. Fast enterprise lookup works while A2A is unavailable.
5. A full report is asynchronous and records a task receipt.
6. Remote Mock content is absent from the report.
7. The final escalation level comes from EA deterministic policy, not the remote Agent.
8. Follow-up writes require confirmation and an execution receipt.
