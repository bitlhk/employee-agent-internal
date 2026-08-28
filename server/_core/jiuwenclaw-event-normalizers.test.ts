import { describe, expect, it } from "vitest";
import { normalizeGovernanceApprovalToolEvent, normalizeJiuwenToolPayload } from "./jiuwenclaw-event-normalizers";

describe("tool result normalization", () => {
  it("preserves trusted EA metadata emitted as Jiuwen raw output", () => {
    const rawOutput = {
      content: [{ type: "text", text: "business result" }],
      _meta: {
        eaMetadataIssuer: "employee-agent",
        eaContextReceipt: { schema: "ea.context-receipt.v1", receiptId: "r1" },
      },
    };

    const result = normalizeJiuwenToolPayload("chat.tool_result", {
      tool_result: {
        tool_name: "get_wealth_policy_basis",
        tool_call_id: "call-1",
        result: "business result",
        raw_output: rawOutput,
      },
    });

    expect(result?.resultPayload).toEqual(rawOutput);
  });

  it("does not expose untrusted raw output", () => {
    const result = normalizeJiuwenToolPayload("chat.tool_result", {
      tool_result: {
        tool_name: "third_party_tool",
        result: "safe result",
        raw_output: { _meta: { private: "value" } },
      },
    });

    expect(result?.resultPayload).toBe("safe result");
  });
});

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

  it("recognizes a flattened approval result but ignores unrelated ids and failures", () => {
    expect(normalizeGovernanceApprovalToolEvent({}, {
      content: [{ type: "text", text: "该操作需要你本人确认。确认编号：apr_00000000-0000-4000-8000-000000000001。确认后重试。" }],
    })?.approvalId).toBe("apr_00000000-0000-4000-8000-000000000001");
    expect(normalizeGovernanceApprovalToolEvent({}, {
      content: [{ type: "text", text: "执行记录关联确认编号 apr_00000000-0000-4000-8000-000000000001。" }],
    })).toBeNull();
    expect(normalizeGovernanceApprovalToolEvent({}, {
      content: [{ type: "text", text: "普通工具执行失败" }],
    })).toBeNull();
  });

  it("does not recreate a confirmation from metadata retained on a successful retry", () => {
    expect(normalizeGovernanceApprovalToolEvent({
      tool_result: {
        _meta: {
          eaGovernance: {
            code: "EA_APPROVAL_REQUIRED",
            approvalId: "apr_00000000-0000-4000-8000-000000000001",
          },
        },
      },
    }, {
      executionReceipt: {
        schema: "ea.customer-crm-execution-receipt.v1",
        status: "completed",
      },
    })).toBeNull();
  });
});
