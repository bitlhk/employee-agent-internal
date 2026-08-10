import { describe, expect, it } from "vitest";
import { normalizeGovernanceApprovalToolEvent } from "./jiuwenclaw-event-normalizers";

describe("governance approval tool event normalization", () => {
  it("extracts structured governance metadata from a tool result", () => {
    const event = normalizeGovernanceApprovalToolEvent({}, {
      content: [{ type: "text", text: "该操作需要确认" }],
      _meta: {
        eaGovernance: {
          code: "EA_APPROVAL_REQUIRED",
          approvalId: "apr_00000000-0000-4000-8000-000000000001",
          expiresAt: "2026-08-09T10:00:00.000Z",
          reason: "写入 Demo 业务记录前需要确认",
          policyCode: "EA_ENTERPRISE_MCP_APPROVAL_REQUIRED",
          toolName: "demo_create_portfolio_draft",
          connectorName: "财富业务演示 MCP（Demo）",
          demo: true,
        },
      },
    });
    expect(event).toEqual({
      approvalId: "apr_00000000-0000-4000-8000-000000000001",
      expiresAt: "2026-08-09T10:00:00.000Z",
      reason: "写入 Demo 业务记录前需要确认",
      policyCode: "EA_ENTERPRISE_MCP_APPROVAL_REQUIRED",
      toolName: "demo_create_portfolio_draft",
      connectorName: "财富业务演示 MCP（Demo）",
      demo: true,
    });
  });

  it("falls back to the confirmation id in text but ignores unrelated tool failures", () => {
    expect(normalizeGovernanceApprovalToolEvent({}, {
      content: [{ type: "text", text: "确认编号：apr_00000000-0000-4000-8000-000000000001" }],
    })?.approvalId).toBe("apr_00000000-0000-4000-8000-000000000001");
    expect(normalizeGovernanceApprovalToolEvent({}, {
      content: [{ type: "text", text: "普通工具执行失败" }],
    })).toBeNull();
  });
});
