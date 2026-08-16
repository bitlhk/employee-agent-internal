import { describe, expect, it } from "vitest";
import {
  canDegradeAfterEnterpriseMcpProvisioningFailure,
  enterpriseMcpProvisioningFrameResult,
} from "./jiuwenswarm-gateway-client";

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
