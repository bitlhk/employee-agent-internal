# Risk-control A2A executor

This directory is the deployable contract for the dedicated risk-control JiuwenSwarm node.

## Deployment boundary

- EA owns identity, authorization, governed enterprise data, deterministic policy, confirmation, audit, and task lifecycle.
- The remote node owns only long-running snapshot analysis and report drafting.
- The remote node must not use its historical Mock files or MCP servers as enterprise facts.
- `role-scope.json` keeps the dedicated runtime on one Skill and zero business MCP servers.
- Shanghai reaches the node through an EA same-origin route backed by a managed loopback tunnel. Port `19100` is not a public application interface.

## EA registration

Create an environment-specific copy of `risk-control-a2a-agent.example.json`, set `apiUrl` to the EA public origin plus `/a2a/risk-control`, then run:

```bash
pnpm tsx scripts/register-expert-agent.ts --config /secure/path/risk-control-a2a-agent.json
```

Enable the local proxy and point an SSH/systemd tunnel at the remote JiuwenSwarm A2A port:

```text
RISK_CONTROL_A2A_PROXY_ENABLED=true
RISK_CONTROL_A2A_PORT=19101
RISK_CONTROL_A2A_PROXY_TIMEOUT_MS=700000
```

The registration requires `requireFinalEnvelope=true` and `reuseConversationContext=false`.

## Acceptance

1. A request without the governed request schema is blocked.
2. A request with a mismatched snapshot fingerprint is blocked.
3. A valid snapshot produces only one `<ea_final>` envelope.
4. Remote workspace Mock content never appears in the result.
5. EA strips the envelope and records the asynchronous task receipt.
6. EA deterministic policy remains the only source of the final escalation level.
