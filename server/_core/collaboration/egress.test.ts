import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationAwaitingResources } from "./errors";
const scope = vi.hoisted(() => ({
  run: vi.fn(),
  validate: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../../db/collaboration-runs", () => ({
  getCollaborationRun: scope.run,
  runSessionId: (id: string, turn: number) => `ea_collab_${id}_${turn}`,
}));
vi.mock("./scope", () => ({ validateScopedTool: scope.validate }));
vi.mock("../audit-events", () => ({ recordAuditBestEffort: scope.audit }));
import {
  evaluateJiuwenPreToolUse,
  policyUnavailableDecision,
} from "../tool-egress-routes";
beforeEach(() => {
  vi.resetAllMocks();
  scope.run.mockResolvedValue({
    id: "test",
    turn: 1,
    status: "running",
    leaseUntil: new Date(Date.now() + 60_000),
  });
});
describe("isolated collaboration pre-tool hook", () => {
  it("keeps premature completion blocked but tells the model to checkpoint and yield", async () => {
    scope.validate.mockRejectedValue(new CollaborationAwaitingResources());
    const result = await evaluateJiuwenPreToolUse({ session_id: "ea_collab_test_1", tool_name: "mcp_platform_tools_reply_collaboration_request", tool_input: { requestId: 1 } });
    expect(result).toMatchObject({ decision: "block", reason: expect.stringContaining("checkpoint_collaboration_goal") });
  });
  it("passes a valid scoped tool through the existing policy instead of rejecting every isolated run", async () => {
    const result = await evaluateJiuwenPreToolUse({
      session_id: "ea_collab_test_1",
      tool_name: "mcp_platform_tools_checkpoint_collaboration_goal",
      tool_input: { checkpoint: "wait", message: "waiting" },
    });
    expect(scope.validate).toHaveBeenCalledWith(
      expect.anything(),
      "checkpoint_collaboration_goal",
      expect.anything()
    );
    expect(result.decision).toBe("allow");
  });
  it("rejects native tools before execution and fails closed during policy outages", async () => {
    expect(
      (
        await evaluateJiuwenPreToolUse({
          session_id: "ea_collab_test_1",
          tool_name: "bash",
          tool_input: { command: "anything" },
        })
      ).decision
    ).toBe("block");
    expect(scope.validate).not.toHaveBeenCalled();
    expect(
      policyUnavailableDecision({
        session_id: "ea_collab_test",
        tool_name: "read_file",
        tool_input: {},
      }).decision
    ).toBe("block");
    expect(
      policyUnavailableDecision({ tool_name: "read_file", tool_input: {} })
        .decision
    ).toBe("allow");
  });
  it("rejects expired leases and newly revoked grants", async () => {
    scope.run.mockResolvedValue({
      id: "test",
      turn: 1,
      status: "running",
      leaseUntil: new Date(Date.now() - 1),
    });
    expect(
      (
        await evaluateJiuwenPreToolUse({
          session_id: "ea_collab_test_1",
          tool_name: "mcp_platform_tools_query_own_schedules",
          tool_input: {},
        })
      ).decision
    ).toBe("block");
    scope.run.mockResolvedValue({
      id: "test",
      turn: 1,
      status: "running",
      leaseUntil: new Date(Date.now() + 60_000),
    });
    scope.validate.mockRejectedValue(new Error("grant revoked"));
    expect(
      (
        await evaluateJiuwenPreToolUse({
          session_id: "ea_collab_test_1",
          tool_name: "mcp_platform_tools_query_own_schedules",
          tool_input: {},
        })
      ).decision
    ).toBe("block");
    expect(scope.validate).toHaveBeenCalled();
  });
});
