import { describe, expect, it } from "vitest";
import { collectA2ACapabilityIntents } from "./a2a-capability-intent";
import { A2ACapabilityIntentBindingError, resolveA2ACapabilityIntentBinding } from "./a2a-capability-intent-bindings";

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
});
