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

  it("binds post-loan enterprise data to the registered risk task", () => {
    const result = attachReferenceRoleTaskReceipt({
      ...base,
      result: { content: [{ type: "text", text: "sensitive enterprise fixture" }] },
      roleTemplate: "post-loan-risk-control",
      serverId: "post_loan_risk_data",
      toolName: "get_financial_statements",
      sideEffect: "read",
    });
    const receipt = extractTrustedContextReceipt("enterprise_get_financial_statements", result);
    expect(receipt).toMatchObject({ taskId: "RC-GT-02", taskLabel: "财务与还款异常诊断" });
    expect(receipt?.provided.businessData[0]?.sourceSystem).toBe("post_loan_risk_data");
    expect(JSON.stringify(receipt)).not.toContain("sensitive enterprise fixture");
  });

  it("uses the shared confirmed write receipt for a risk follow-up", () => {
    const result = attachReferenceRoleTaskReceipt({
      ...base,
      result: { content: [{ type: "text", text: "created" }] },
      roleTemplate: "post-loan-risk-control",
      serverId: "wealth_governance_demo",
      toolName: "demo_create_followup_task",
      sideEffect: "write",
      externalRequestId: "DEMO-RISK-1",
      approvalId: "approval-risk",
      idempotencyProtected: true,
    });
    const receipt = extractTrustedContextReceipt("enterprise_demo_create_followup_task", result);
    expect(receipt).toMatchObject({ taskId: "RC-GT-06", taskLabel: "风险复评与跟踪任务" });
    expect(receipt?.applied.capabilityExecutions[0]).toMatchObject({
      approvalId: "approval-risk",
      externalRequestId: "DEMO-RISK-1",
      idempotencyProtected: true,
    });
  });

  it("binds smart-audit extraction and confirmed human review to the shared evidence protocol", () => {
    const readResult = attachReferenceRoleTaskReceipt({
      ...base,
      result: { content: [{ type: "text", text: "sensitive credential fixture" }] },
      roleTemplate: "credential-compliance",
      serverId: "credential_image_workspace",
      toolName: "credential_image_extract_from_workspace",
      sideEffect: "read",
    });
    const readReceipt = extractTrustedContextReceipt("enterprise_credential_image_extract_from_workspace", readResult);
    expect(readReceipt).toMatchObject({ taskId: "AU-GT-02", taskLabel: "凭证要素提取与原文定位" });
    expect(JSON.stringify(readReceipt)).not.toContain("sensitive credential fixture");

    const writeResult = attachReferenceRoleTaskReceipt({
      ...base,
      result: { content: [{ type: "text", text: "created" }] },
      roleTemplate: "credential-compliance",
      serverId: "wealth_governance_demo",
      toolName: "demo_create_audit_review_task",
      sideEffect: "write",
      externalRequestId: "DEMO-AUDIT-1",
      approvalId: "approval-audit",
      idempotencyProtected: true,
    });
    const writeReceipt = extractTrustedContextReceipt("enterprise_demo_create_audit_review_task", writeResult);
    expect(writeReceipt).toMatchObject({ taskId: "AU-GT-06", taskLabel: "审核意见与人工复核闭环" });
    expect(writeReceipt?.applied.capabilityExecutions[0]).toMatchObject({
      approvalId: "approval-audit",
      externalRequestId: "DEMO-AUDIT-1",
      idempotencyProtected: true,
    });
  });

  it("binds Wind research and confirmed watch writes to the shared evidence protocol", () => {
    const readResult = attachReferenceRoleTaskReceipt({
      ...base,
      result: { content: [{ type: "text", text: "dynamic Wind fixture" }] },
      roleTemplate: "investment-researcher",
      serverId: "wind_stock_data",
      toolName: "get_stock_basicinfo",
      sideEffect: "read",
    });
    const readReceipt = extractTrustedContextReceipt("enterprise_get_stock_basicinfo", readResult);
    expect(readReceipt).toMatchObject({ taskId: "IR-GT-01", taskLabel: "公司快速研究" });
    expect(JSON.stringify(readReceipt)).not.toContain("dynamic Wind fixture");

    const writeResult = attachReferenceRoleTaskReceipt({
      ...base,
      result: { content: [{ type: "text", text: "created" }] },
      roleTemplate: "investment-researcher",
      serverId: "wealth_governance_demo",
      toolName: "demo_create_research_watch_task",
      sideEffect: "write",
      externalRequestId: "DEMO-RESEARCH-WATCH-1",
      approvalId: "approval-ir",
      idempotencyProtected: true,
    });
    const writeReceipt = extractTrustedContextReceipt("enterprise_demo_create_research_watch_task", writeResult);
    expect(writeReceipt).toMatchObject({ taskId: "IR-GT-06", taskLabel: "研究备忘与跟踪" });
    expect(writeReceipt?.applied.capabilityExecutions[0]).toMatchObject({ approvalId: "approval-ir", externalRequestId: "DEMO-RESEARCH-WATCH-1", idempotencyProtected: true });
  });
});
