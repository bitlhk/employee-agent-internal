import { describe, expect, it } from "vitest";
import { extractTrustedContextReceipt } from "./governance/response-evidence";
import { attachReferenceRoleTaskReceipt } from "./reference-role-task-evidence";

const base = {
  principalFingerprint: "p".repeat(64),
  capabilityVersion: "1",
  policyDecision: {
    decisionId: "decision_1",
    policyCode: "EA_ENTERPRISE_MCP_POLICY",
    ruleVersion: "enterprise-mcp-v1",
    effect: "ALLOW" as const,
  },
  requestId: "request_1",
  resultFingerprint: "r".repeat(64),
  argumentsFingerprint: "a".repeat(64),
  failed: false,
  now: new Date("2026-08-13T10:00:00.000Z"),
};

describe("reference role task evidence adapter", () => {
  it("creates an insurance Context Receipt from a real enterprise MCP data stage", () => {
    const result = attachReferenceRoleTaskReceipt({
      ...base,
      result: { content: [{ type: "text", text: "customer data" }] },
      roleTemplate: "insurance-advisor",
      serverId: "insurance_customer_profile",
      toolName: "get_customer_profile_by_name",
      sideEffect: "read",
    });
    const receipt = extractTrustedContextReceipt("enterprise_any_tool", result);
    expect(receipt).toMatchObject({ taskId: "IA-GT-01", taskLabel: "客户续保访前准备" });
    expect(receipt?.provided.businessData[0]).toMatchObject({
      sourceSystem: "insurance_customer_profile",
      entityRef: "a".repeat(64),
      resultFingerprint: "r".repeat(64),
    });
    expect(receipt?.readiness.status).toBe("READY");
    expect(JSON.stringify(receipt)).not.toContain("customer data");
  });

  it.each([
    ["wealth-manager", "WM-GT-05", "客户跟进创建"],
    ["insurance-advisor", "IA-GT-01", "客户续保访前准备"],
  ] as const)("uses the same Business Receipt path for %s", (roleTemplate, taskId, taskLabel) => {
    const result = attachReferenceRoleTaskReceipt({
      ...base,
      result: { content: [{ type: "text", text: "created" }] },
      roleTemplate,
      serverId: "wealth_governance_demo",
      toolName: "demo_create_followup_task",
      sideEffect: "write",
      externalRequestId: "DEMO-FOLLOWUP-1",
      approvalId: "approval_1",
      idempotencyProtected: true,
    });
    const receipt = extractTrustedContextReceipt("enterprise_followup", result);
    expect(receipt).toMatchObject({ taskId, taskLabel });
    expect(receipt?.applied.capabilityExecutions[0]).toMatchObject({
      approvalId: "approval_1",
      externalRequestId: "DEMO-FOLLOWUP-1",
      idempotencyProtected: true,
    });
    expect(receipt?.readiness.status).toBe("READY");
  });

  it("does not invent evidence for an unregistered role task", () => {
    const result = { content: [{ type: "text", text: "ok" }] };
    expect(attachReferenceRoleTaskReceipt({
      ...base,
      result,
      roleTemplate: "risk-manager",
      serverId: "unknown",
      toolName: "read",
      sideEffect: "read",
    })).toBe(result);
  });
});
