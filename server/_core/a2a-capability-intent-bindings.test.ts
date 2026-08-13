import { describe, expect, it } from "vitest";
import { collectA2ACapabilityIntents } from "./a2a-capability-intent";
import {
  A2ACapabilityIntentBindingError,
  assertProductionA2ABindingRuntime,
  parseProductionA2ACapabilityBindings,
  resolveA2ACapabilityIntentBinding,
} from "./a2a-capability-intent-bindings";

function intent(overrides: Record<string, unknown> = {}) {
  return collectA2ACapabilityIntents({
    schema: "ea.capability-intent.v1",
    intentId: "followup-demo-001",
    capabilityId: "enterprise.crm",
    operation: "create_followup",
    sideEffect: "write",
    arguments: {
      customer_ref: "张先生（Demo）",
      objective: "完成访后回访",
      due_at: "2026-08-20T09:00:00+08:00",
      priority: "medium",
    },
    idempotencyKey: "followup-demo-001",
    ...overrides,
  })[0];
}

describe("A2A capability intent bindings", () => {
  it("maps the explicit CRM follow-up contract to the governed demo MCP", () => {
    const resolved = resolveA2ACapabilityIntentBinding(intent());
    expect(resolved.binding).toMatchObject({
      bindingId: "linggan-bank.wealth-demo.create-followup",
      targetServerId: "wealth_governance_demo",
      targetToolName: "demo_create_followup_task",
    });
    expect(resolved.arguments).toMatchObject({
      customer_ref: "张先生（Demo）",
      priority: "medium",
      idempotency_key: "followup-demo-001",
    });
    expect(resolved.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed for unregistered capabilities and side-effect downgrades", () => {
    expect(() => resolveA2ACapabilityIntentBinding(intent({ operation: "delete_customer" })))
      .toThrowError(A2ACapabilityIntentBindingError);
    expect(() => resolveA2ACapabilityIntentBinding(intent({ sideEffect: "external_send" })))
      .toThrow("副作用类型");
  });

  it("rejects real customer references and incomplete business parameters", () => {
    expect(() => resolveA2ACapabilityIntentBinding(intent({
      arguments: {
        customer_ref: "张先生",
        objective: "回访",
        due_at: "2026-08-20T09:00:00+08:00",
      },
    }))).toThrow("Demo");
    expect(() => resolveA2ACapabilityIntentBinding(intent({
      idempotencyKey: "short",
    }))).toThrow("幂等键");
  });

  it("accepts only explicit production contracts with identity, approval and idempotency", () => {
    const [binding] = parseProductionA2ACapabilityBindings(JSON.stringify([{
      schema: "ea.a2a-capability-binding.v1",
      mode: "production",
      bindingId: "bank.crm.create-followup",
      bindingVersion: "1.0.0",
      capabilityId: "bank.crm",
      operation: "create_followup",
      sideEffect: "write",
      displayName: "创建客户跟进",
      targetServerId: "bank_crm",
      targetToolName: "create_followup",
      argumentMap: { customerId: "customer_id", objective: "objective" },
      requiredArguments: ["customerId", "objective"],
      approvalRequired: true,
      idempotencyRequired: true,
      identityRequired: true,
    }]));
    const productionIntent = intent({
      capabilityId: "bank.crm",
      arguments: { customerId: "C-001", objective: "到期沟通", injected: "must-not-forward" },
      idempotencyKey: "prod-followup-001",
    });
    const resolved = resolveA2ACapabilityIntentBinding(productionIntent, [binding]);
    expect(resolved.arguments).toEqual({ customer_id: "C-001", objective: "到期沟通", idempotency_key: "prod-followup-001" });
  });

  it("rejects production contracts that weaken mandatory controls", () => {
    expect(() => parseProductionA2ACapabilityBindings(JSON.stringify([{
      schema: "ea.a2a-capability-binding.v1",
      mode: "production",
      bindingId: "unsafe",
      bindingVersion: "1",
      capabilityId: "bank.crm",
      operation: "write",
      sideEffect: "write",
      displayName: "Unsafe",
      targetServerId: "bank_crm",
      targetToolName: "write",
      argumentMap: { value: "value" },
      requiredArguments: [],
      approvalRequired: false,
      idempotencyRequired: true,
      identityRequired: true,
    }]))).toThrow();
  });

  it("activates production bindings only against an enforced verified MCP policy", () => {
    const [binding] = parseProductionA2ACapabilityBindings(JSON.stringify([{
      schema: "ea.a2a-capability-binding.v1", mode: "production", bindingId: "bank.crm.write", bindingVersion: "1",
      capabilityId: "bank.crm", operation: "write", sideEffect: "write", displayName: "写 CRM",
      targetServerId: "bank_crm", targetToolName: "write", argumentMap: { value: "value" }, requiredArguments: ["value"],
      approvalRequired: true, idempotencyRequired: true, identityRequired: true,
    }]));
    const connection = { environment: "prod", lifecycleState: "enforced", authMode: "oauth2_access_token", identityVerificationStatus: "verified" };
    const policy = { toolName: "write", enabled: true, sideEffect: "write", approvalMode: "always", idempotencyRequired: true };
    expect(() => assertProductionA2ABindingRuntime({ binding, connection, policy })).not.toThrow();
    expect(() => assertProductionA2ABindingRuntime({ binding, connection: { ...connection, lifecycleState: "shadow" }, policy })).toThrow(/强制治理/u);
    expect(() => assertProductionA2ABindingRuntime({ binding, connection, policy: { ...policy, approvalMode: "never" } })).toThrow(/确认和幂等/u);
  });
});
