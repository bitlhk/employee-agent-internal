import { describe, expect, it } from "vitest";
import { collectA2ACapabilityIntents } from "./a2a-capability-intent";

describe("A2A capability intent", () => {
  it("accepts side-effect intents without treating them as executed", () => {
    const [intent] = collectA2ACapabilityIntents({
      data: {
        schema: "ea.capability-intent.v1",
        intentId: "crm-followup-001",
        capabilityId: "enterprise.crm",
        operation: "create_followup",
        sideEffect: "write",
        resource: "customer/C001/followups",
        arguments: { customerId: "C001", subject: "回访" },
        idempotencyKey: "followup-C001-001",
      },
    });

    expect(intent).toMatchObject({
      intentId: "crm-followup-001",
      sideEffect: "write",
      executionStatus: "pending_local_governance",
    });
    expect(intent.intentFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects read-only payloads because they are results rather than write intents", () => {
    expect(collectA2ACapabilityIntents({
      schema: "ea.capability-intent.v1",
      capabilityId: "enterprise.crm",
      operation: "get_customer",
      sideEffect: "read",
      arguments: { customerId: "C001" },
    })).toEqual([]);
  });

  it("deduplicates repeated intents and rejects oversized arguments", () => {
    const repeated = {
      schema: "ea.capability-intent.v1",
      intentId: "crm-followup-002",
      capabilityId: "enterprise.crm",
      operation: "create_followup",
      sideEffect: "write",
      arguments: { customerId: "C002" },
    };
    expect(collectA2ACapabilityIntents({ parts: [repeated, repeated] })).toHaveLength(1);
    expect(collectA2ACapabilityIntents({
      ...repeated,
      arguments: { payload: "x".repeat(65 * 1024) },
    })).toEqual([]);
  });
});
