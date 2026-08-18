import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recordAuditBestEffort: vi.fn().mockResolvedValue(null) }));
vi.mock("./audit-events", () => ({
  auditRequest: vi.fn(() => ({})),
  recordAuditBestEffort: mocks.recordAuditBestEffort,
}));

import type { RuntimePrincipal } from "./governance/contracts";
import { handleSmartAuditTool } from "./smart-audit-tool-handler";

const req = { headers: { "x-request-id": "req-audit-1" } } as unknown as Request;
const principal: RuntimePrincipal = {
  userId: 31,
  adoptionId: "lgj-audit-demo",
  agentId: "agent-audit-demo",
  roleTemplate: "credential-compliance",
  workspaceId: "/tmp/audit-demo",
  permissionProfile: "employee",
  sessionId: "session-audit-demo",
};

describe("smart audit platform tool handler", () => {
  it("returns trusted metadata for a deterministic material decision", async () => {
    const result = await handleSmartAuditTool({
      req,
      name: "evaluate_audit_required_materials",
      args: { required_material_types: ["申请表"], provided_material_types: ["申请表"] },
      adoptId: principal.adoptionId,
      principal,
    });
    const meta = result._meta as Record<string, unknown>;
    const receipt = meta.eaContextReceipt as {
      taskId: string;
      applied: { policyDecisions: Array<{ policyCode: string; effect: string }> };
    };
    expect(meta.eaMetadataIssuer).toBe("employee-agent");
    expect(receipt.taskId).toBe("AU-GT-03");
    expect(receipt.applied.policyDecisions[0]).toMatchObject({ policyCode: "AUDIT_REQUIRED_MATERIALS", effect: "ALLOW" });
    expect(JSON.stringify(result.content)).not.toContain("eaContextReceipt");
  });

  it("blocks a final opinion when a critical conflict requires human review", async () => {
    const result = await handleSmartAuditTool({
      req,
      name: "evaluate_audit_human_review",
      args: {
        critical_missing: false,
        critical_conflicts: true,
        rule_version_ready: true,
        image_verification_uncertain: false,
        high_risk_rule_hit: true,
        final_decision_requested: true,
      },
      adoptId: principal.adoptionId,
      principal,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"level":"L4"');
    expect(mocks.recordAuditBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      action: "governance.smart_audit.blocked",
      result: "denied",
    }));
  });
});
