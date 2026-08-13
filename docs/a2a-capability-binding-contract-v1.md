# A2A Capability Binding Contract V1

## Purpose

A remote Agent may propose a business side effect, but it cannot execute that side effect directly. A production binding maps one explicit remote `Capability Intent` to one governed Enterprise MCP tool.

```text
Remote Agent Capability Intent
        -> local binding allowlist
        -> current task authority snapshot
        -> Enterprise MCP Governance + PEP
        -> confirmed, idempotent business execution
```

## Contract

Production bindings are supplied through `EA_A2A_CAPABILITY_BINDINGS_JSON`. The value is a JSON array. It is deployment configuration, not model input and not client input.

```json
[
  {
    "schema": "ea.a2a-capability-binding.v1",
    "mode": "production",
    "bindingId": "bank.crm.create-followup",
    "bindingVersion": "1.0.0",
    "capabilityId": "bank.crm",
    "operation": "create_followup",
    "sideEffect": "write",
    "displayName": "创建客户跟进",
    "targetServerId": "bank_crm",
    "targetToolName": "create_followup",
    "argumentMap": {
      "customerId": "customer_id",
      "objective": "objective",
      "dueAt": "due_at"
    },
    "requiredArguments": ["customerId", "objective", "dueAt"],
    "approvalRequired": true,
    "idempotencyRequired": true,
    "identityRequired": true
  }
]
```

Only mapped arguments reach the target tool. `idempotency_key` is injected from the task intent and must contain at least eight characters. Unknown fields are dropped.

## Activation Gate

The binding is executable only when all checks pass:

- target connector environment is `prod`;
- lifecycle is `enforced`;
- authentication is `oauth2_access_token`;
- identity verification status is `verified`;
- target tool exists and is enabled;
- target tool side effect exactly matches the binding;
- target policy requires idempotency;
- target policy requires conditional or always-on confirmation;
- original task authorization snapshot and current authority both permit execution.

The Enterprise MCP Gateway then independently executes role grants, row scope, policy, argument rules, egress guard, approval binding, receipt reservation, short-lived identity and audit. A binding never bypasses those controls.

## Rollout

1. Register and verify the Enterprise MCP connector.
2. Configure tool policy and role grants.
3. Prove missing/wrong identity and cross-user requests are rejected by the MCP server.
4. Add the production binding in deployment secrets/configuration.
5. Restart EA and run the A2A route PEP tests plus a staging Golden Task.
6. Enable the affected Role Pack release only after the exact asset set passes evaluation.

Invalid JSON, duplicate capability/operation pairs, weakened mandatory controls, target-policy drift, or missing authority all fail closed.
