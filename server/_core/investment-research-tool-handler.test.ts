import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { extractTrustedContextReceipt } from "./governance/response-evidence";
import { handleInvestmentResearchTool } from "./investment-research-tool-handler";

vi.mock("./audit-events", () => ({ auditRequest: () => ({}), recordAuditBestEffort: vi.fn(async () => undefined) }));

const principal = {
  tenantId: "linggan-finance",
  organizationId: "linggan-finance",
  userId: 1,
  adoptId: "lgj-ir-test",
  agentId: "agent-ir-test",
  roleTemplate: "investment-researcher",
  workspaceId: "workspace-ir-test",
  permissionProfile: "default",
  authorizationSnapshotId: "snapshot-ir-test",
  authorizationFingerprint: "a".repeat(64),
  sessionId: "session-ir-test",
  identityVersion: "2",
} as const;

describe("investment research platform policy tools", () => {
  it("returns model-safe data assurance output and trusted receipt metadata", async () => {
    const result = await handleInvestmentResearchTool({
      req: { headers: {} } as Request,
      name: "evaluate_investment_research_data_assurance",
      args: { security_id: "600000.SH", source_system: "wind_stock_data", data_as_of: "2026-08-18T00:00:00Z", required_dimensions: ["price"], available_dimensions: ["price"], source_authorized: true, comparable: true },
      adoptId: principal.adoptId,
      principal,
    });
    expect(result.content[0].text).not.toContain("receiptFingerprint");
    expect(extractTrustedContextReceipt("platform_evaluate_investment_research_data_assurance", result)?.taskId).toBe("IR-GT-04");
  });

  it("blocks prohibited output and records a deny decision", async () => {
    const result = await handleInvestmentResearchTool({
      req: { headers: {} } as Request,
      name: "evaluate_investment_research_output_boundary",
      args: { requested_outcome: "automatic_trade", automatic_trade_requested: true, contains_return_promise: false, personalized_recommendation_requested: false, has_customer_suitability_context: false },
      adoptId: principal.adoptId,
      principal,
    });
    expect(result.isError).toBe(true);
    const receipt = extractTrustedContextReceipt("platform_evaluate_investment_research_output_boundary", result)!;
    expect(receipt.applied.policyDecisions[0]).toMatchObject({ policyCode: "INVESTMENT_RESEARCH_OUTPUT_BOUNDARY", effect: "DENY" });
  });
});
