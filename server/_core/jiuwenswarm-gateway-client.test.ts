import { describe, expect, it } from "vitest";
import {
  buildGovernanceContinuationPermission,
  canDegradeAfterEnterpriseMcpProvisioningFailure,
  enterpriseMcpProvisioningFrameResult,
  gatewayProgressStatus,
  gatewayPermissionAnswerMethod,
  gatewayPermissionEventMatchesRequest,
  shouldKeepGatewayRunAfterClientClose,
} from "./jiuwenswarm-gateway-client";

describe("gateway progress continuity", () => {
  it("uses task language for long-running enterprise work", () => {
    expect(gatewayProgressStatus(0)).toBe("正在准备本次任务...");
    expect(gatewayProgressStatus(30_000)).toBe("正在核验任务所需信息...");
    expect(gatewayProgressStatus(90_000)).toContain("复杂任务可能需要几分钟");
    expect(gatewayProgressStatus(150_000)).toBe("正在完成结果整理...");
  });

  it("keeps enterprise work attached to the gateway after the browser disconnects", () => {
    expect(shouldKeepGatewayRunAfterClientClose(true)).toBe(true);
    expect(shouldKeepGatewayRunAfterClientClose(false)).toBe(false);
  });
});

describe("buildGovernanceContinuationPermission", () => {
  it("preserves the EA approval identity for the browser governance card", () => {
    expect(buildGovernanceContinuationPermission({
      approvalId: "apr_00000000-0000-4000-8000-000000000001",
      reason: "该操作会修改演示业务数据，需要你按次确认。",
      policyCode: "demo.write.confirmation_required",
      connectorName: "Demo 跟进任务",
      demo: true,
      expiresAt: "2026-08-25T14:00:00.000Z",
    }, "enterprise_demo_create_followup_task")).toMatchObject({
      requestId: "apr_00000000-0000-4000-8000-000000000001",
      source: "governance_approval",
      kind: "permission",
      toolName: "enterprise_demo_create_followup_task",
      riskLevel: "high",
      reasonCode: "demo.write.confirmation_required",
      connectorName: "Demo 跟进任务",
      demo: true,
      allowAlways: false,
    });
  });
});

describe("enterpriseMcpProvisioningFrameResult", () => {
  const requestId = "request-1:managed-mcp";

  it("accepts a successful tools.add response", () => {
    expect(enterpriseMcpProvisioningFrameResult({
      type: "res",
      id: requestId,
      ok: true,
      payload: { registered_tools: [] },
    }, requestId)).toEqual({ status: "success" });
  });

  it("surfaces an enterprise runtime error without waiting for provisioning timeout", () => {
    expect(enterpriseMcpProvisioningFrameResult({
      type: "event",
      event: "chat.error",
      request_id: requestId,
      payload: {
        error: "EA_RUNTIME_ASSET_BOOTSTRAP_FAILED: managed Skill digest mismatch",
      },
    }, requestId)).toEqual({
      status: "error",
      error: "EA_RUNTIME_ASSET_BOOTSTRAP_FAILED: managed Skill digest mismatch",
    });
  });

  it("ignores frames for the chat request and other clients", () => {
    expect(enterpriseMcpProvisioningFrameResult({
      type: "event",
      event: "chat.error",
      request_id: "another-request",
      payload: { error: "unrelated" },
    }, requestId)).toBeNull();
  });

  it("degrades only when the provisioning confirmation times out", () => {
    expect(canDegradeAfterEnterpriseMcpProvisioningFailure(
      new Error("enterprise MCP provisioning timed out"),
    )).toBe(true);
    expect(canDegradeAfterEnterpriseMcpProvisioningFailure(
      new Error("enterprise MCP provisioning failed"),
    )).toBe(false);
    expect(canDegradeAfterEnterpriseMcpProvisioningFailure(
      new Error("EA_RUNTIME_ASSET_BOOTSTRAP_FAILED: digest mismatch"),
    )).toBe(false);
  });
});

describe("gatewayPermissionAnswerMethod", () => {
  it("resumes persisted tool interruptions through chat.send", () => {
    expect(gatewayPermissionAnswerMethod(true, "permission_interrupt")).toBe("chat.send");
    expect(gatewayPermissionAnswerMethod(false, "permission_interrupt")).toBe("chat.send");
  });

  it("keeps registry-backed enterprise questions on chat.user_answer", () => {
    expect(gatewayPermissionAnswerMethod(true, "ask_tool")).toBe("chat.user_answer");
  });
});

describe("gatewayPermissionEventMatchesRequest", () => {
  it("does not complete a resumed permission from another request in the same session", () => {
    expect(gatewayPermissionEventMatchesRequest({
      type: "event",
      event: "chat.final",
      request_id: "new-chat-request",
    }, "permission-resume-request", "chat.send", true)).toBe(false);
    expect(gatewayPermissionEventMatchesRequest({
      type: "event",
      event: "chat.final",
      request_id: "permission-resume-request",
    }, "permission-resume-request", "chat.send", true)).toBe(true);
  });

  it("does not constrain registry-backed user answers to the answer RPC id", () => {
    expect(gatewayPermissionEventMatchesRequest({
      type: "event",
      event: "chat.final",
      request_id: "original-chat-request",
    }, "answer-rpc-request", "chat.user_answer", true)).toBe(true);
  });

  it("preserves standalone gateways that do not emit top-level request ids", () => {
    expect(gatewayPermissionEventMatchesRequest({
      type: "event",
      event: "chat.final",
    }, "permission-resume-request", "chat.send", false)).toBe(true);
  });
});
