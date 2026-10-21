vi.mock("../../db/coop-identity", () => ({
  assertCoopMember: vi.fn(),
  assertCoopParticipants: vi.fn(),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationRun } from "../../../drizzle/schema";
const state = vi.hoisted(() => ({
  owner: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  finish: vi.fn(),
  checkpoint: vi.fn(),
  resources: vi.fn(),
  ready: vi.fn(),
  resource: vi.fn(),
}));
vi.mock("../../db", () => ({ getClawByAdoptId: state.owner }));
vi.mock("../../db/collaboration-runs", () => ({
  createCollaborationGoal: state.create,
  finishCollaborationTurn: state.finish,
  getCollaborationRun: state.get,
  watchCollaborationResource: vi.fn(),
  saveCollaborationCheckpoint: state.checkpoint,
}));
vi.mock("../helpers", () => ({
  readSessionRegistry: () => ({
    "a:agent:web:conversation-1": { sessionKey: "verified-session" },
  }),
}));
vi.mock("./resources", () => ({
  collaborationWaitingResources: state.resources,
  assertCollaborationReadyToAnswer: state.ready,
  collaborationResource: state.resource,
}));
vi.mock("../audit-events", () => ({ recordAuditRequired: vi.fn() }));
import {
  handleCollaborationGoalTool,
  conversationForRuntime,
} from "./goal-tools";
const id = "11111111-1111-4111-8111-111111111111";
const run = {
  id,
  userId: 1,
  adoptId: "a",
  kind: "goal",
  expectedEffect: "calendar_write",
} as CollaborationRun;
const context = { run, leaseToken: "lease" };
beforeEach(() => {
  vi.resetAllMocks();
  state.owner.mockResolvedValue({
    userId: 1,
    status: "active",
    permissionProfile: "plus",
  });
  state.resources.mockResolvedValue([]);
  state.finish.mockResolvedValue(true);
  state.resource.mockResolvedValue({ completed: true });
});
describe("goal completion and durable waiting", () => {
  it("binds the source conversation through the server registry", () => {
    expect(conversationForRuntime("a", "verified-session")).toBe(
      "conversation-1"
    );
    expect(conversationForRuntime("b", "verified-session")).toBeNull();
  });
  it("returns progress only to the original conversation and never returns private checkpoints", async () => {
    state.get.mockResolvedValue({
      ...run,
      sourceSessionId: "verified-session",
      status: "waiting",
      checkpoint: "private internal context",
      publicMessage: "正在等待回复",
    });
    const result = await handleCollaborationGoalTool(
      1,
      "a",
      "get_collaboration_goal",
      { goalId: id },
      { sessionId: "verified-session" }
    );
    expect(JSON.stringify(result)).toContain("正在等待回复");
    expect(JSON.stringify(result)).not.toContain("private internal context");
    await expect(
      handleCollaborationGoalTool(
        1,
        "a",
        "get_collaboration_goal",
        { goalId: id },
        { sessionId: "other-session" }
      )
    ).rejects.toThrow("当前会话");
    await expect(
      handleCollaborationGoalTool(
        2,
        "a",
        "get_collaboration_goal",
        { goalId: id },
        { sessionId: "verified-session" }
      )
    ).rejects.toThrow("协作权限");
  });
  it("preserves the existing starter restriction before creating a goal", async () => {
    state.owner.mockResolvedValue({
      userId: 1,
      status: "active",
      permissionProfile: "starter",
    });
    await expect(
      handleCollaborationGoalTool(
        1,
        "a",
        "start_collaboration_goal",
        {
          requestKey: id,
          objective: "arrange",
          taskType: "scheduling",
          expectedEffect: "read",
        },
        { sessionId: "verified-session" }
      )
    ).rejects.toThrow("协作权限");
    expect(state.create).not.toHaveBeenCalled();
  });
  it("requires a verified originating session and forwards its task authority snapshot", async () => {
    const args = {
      requestKey: id,
      objective: "安排会议",
      taskType: "scheduling",
      expectedEffect: "calendar_write",
    };
    await expect(
      handleCollaborationGoalTool(1, "a", "start_collaboration_goal", args, {})
    ).rejects.toThrow("原始会话");
    await expect(
      handleCollaborationGoalTool(1, "a", "start_collaboration_goal", args, {
        sessionId: "unregistered-session",
      })
    ).rejects.toThrow("已注册");
    await expect(
      handleCollaborationGoalTool(1, "a", "start_collaboration_goal", args, {
        sessionId: "another-owners-session",
      })
    ).rejects.toThrow("已注册");
    state.create.mockResolvedValue({ id, status: "ready" });
    await handleCollaborationGoalTool(
      1,
      "a",
      "start_collaboration_goal",
      args,
      { sessionId: "verified-session", authorizationSnapshotId: "snapshot" }
    );
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceConversationId: "conversation-1",
        authorizationSnapshotId: "snapshot",
      })
    );
  });
  it("checkpoints and releases execution while a child or owner confirmation waits", async () => {
    state.resources.mockResolvedValue([{ terminal: false }]);
    await handleCollaborationGoalTool(
      1,
      "a",
      "checkpoint_collaboration_goal",
      { checkpoint: "waiting B", message: "等待回复" },
      context
    );
    expect(state.finish).toHaveBeenCalledWith(id, "lease", {
      status: "waiting",
      publicMessage: "等待回复",
    });
  });
  it("cannot finish a write goal from an availability reply or an unexecuted draft", async () => {
    await expect(
      handleCollaborationGoalTool(
        1,
        "a",
        "finish_collaboration_goal",
        { message: "done", evidence: [] },
        context
      )
    ).rejects.toThrow("成功凭据");
    state.resources.mockResolvedValue([
      { resourceKind: "draft", resourceId: id },
    ]);
    state.resource.mockResolvedValue({ completed: false });
    await expect(
      handleCollaborationGoalTool(
        1,
        "a",
        "finish_collaboration_goal",
        { message: "done", evidence: [{ kind: "draft", id }] },
        context
      )
    ).rejects.toThrow("尚未完成");
    expect(state.finish).not.toHaveBeenCalled();
  });
  it("rejects unrelated historical receipts even if they are successful", async () => {
    await expect(
      handleCollaborationGoalTool(
        1,
        "a",
        "finish_collaboration_goal",
        { message: "done", evidence: [{ kind: "meeting", id }] },
        context
      )
    ).rejects.toThrow("历史回执");
    expect(state.finish).not.toHaveBeenCalled();
  });
  it("finishes only with this goal's owner-bound successful receipts and a live lease", async () => {
    state.resources.mockResolvedValue([
      { resourceKind: "cascade", resourceId: id },
    ]);
    await handleCollaborationGoalTool(
      1,
      "a",
      "finish_collaboration_goal",
      { message: "done", evidence: [{ kind: "cascade", id }] },
      context
    );
    expect(state.finish).toHaveBeenCalledWith(id, "lease", {
      status: "completed",
      publicMessage: "done",
    });
    state.finish.mockResolvedValue(false);
    await expect(
      handleCollaborationGoalTool(
        1,
        "a",
        "finish_collaboration_goal",
        { message: "done", evidence: [{ kind: "cascade", id }] },
        context
      )
    ).rejects.toThrow("状态已变化");
  });
});
