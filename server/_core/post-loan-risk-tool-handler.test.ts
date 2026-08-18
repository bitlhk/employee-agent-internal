import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recordAuditBestEffort: vi.fn().mockResolvedValue(null) }));
vi.mock("./audit-events", () => ({
  auditRequest: vi.fn(() => ({})),
  recordAuditBestEffort: mocks.recordAuditBestEffort,
}));

import { handlePostLoanRiskEscalationTool } from "./post-loan-risk-tool-handler";
import type { RuntimePrincipal } from "./governance/contracts";

function request(): Request {
  return { headers: { "x-request-id": "req-risk-1" } } as Request;
}

function principal(roleTemplate = "post-loan-risk-control"): RuntimePrincipal {
  return {
    userId: 23,
    adoptionId: "lgj-risk-demo",
    agentId: "agent-risk-demo",
    roleTemplate,
    workspaceId: "/tmp/risk-demo",
    permissionProfile: "employee",
    sessionId: "session-risk-demo",
  };
}

describe("post-loan risk platform tool handler", () => {
  it("returns trusted metadata evidence without claiming unqueried knowledge", async () => {
    const result = await handlePostLoanRiskEscalationTool({
      req: request(),
      args: { overdue_days: 35, five_level_class: "次级", critical_data_complete: true },
      adoptId: "lgj-risk-demo",
      principal: principal(),
    });
    const meta = result._meta as Record<string, unknown>;
    const receipt = meta.eaContextReceipt as {
      provided: { knowledge: unknown[]; capabilities: Array<{ capabilityId: string }> };
      cited: { knowledgeAssetIds: string[] };
      applied: { policyDecisions: Array<{ policyCode: string; effect: string }> };
    };
    expect(meta.eaMetadataIssuer).toBe("employee-agent");
    expect(receipt.provided.knowledge).toEqual([]);
    expect(receipt.cited.knowledgeAssetIds).toEqual([]);
    expect(receipt.provided.capabilities).toEqual([
      expect.objectContaining({ capabilityId: "evaluate_post_loan_risk_escalation" }),
    ]);
    expect(receipt.applied.policyDecisions).toEqual([
      expect.objectContaining({ policyCode: "POST_LOAN_RISK_ESCALATION", effect: "ALLOW" }),
    ]);
    expect(JSON.stringify(result.content)).not.toContain("eaContextReceipt");
  });

  it("blocks a different role and records the deterministic denial", async () => {
    const result = await handlePostLoanRiskEscalationTool({
      req: request(),
      args: { overdue_days: 90, critical_data_complete: true },
      adoptId: "lgj-risk-demo",
      principal: principal("general-assistant"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('\"status\":\"blocked\"');
    expect(mocks.recordAuditBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      action: "governance.post_loan_risk.blocked",
      result: "denied",
    }));
  });
});
