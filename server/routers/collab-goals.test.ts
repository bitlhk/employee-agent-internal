import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";
const state = vi.hoisted(() => ({
  owner: vi.fn(),
  runs: vi.fn(),
  resources: vi.fn(),
}));
vi.mock("../db", () => ({ getClawByAdoptId: state.owner }));
vi.mock("../db/collaboration-runs", () => ({
  ownCollaborationRuns: state.runs,
}));
vi.mock("../_core/collaboration/resources", () => ({
  collaborationWaitingResources: state.resources,
}));
import { collabRouter } from "./collab";
beforeEach(() => {
  vi.resetAllMocks();
  state.owner.mockResolvedValue({ userId: 42 });
  state.runs.mockResolvedValue([
    {
      id: "goal",
      objective: "安排会议",
      status: "waiting",
      publicMessage: "请确认",
      updatedAt: new Date(0),
    },
  ]);
});
describe("conversation-scoped calendar confirmations", () => {
  it.each([
    ["request", "completed", true, false],
    ["coordination", "completed", false, false],
    ["draft", "pending", false, false],
    ["reschedule", "unknown", false, false],
    ["reschedule", "cancelled", false, false],
    ["draft", "completed", true, true],
    ["meeting", "invited", true, true],
    ["reschedule", "completed", true, true],
    ["cascade", "completed", true, true],
  ])("derives calendar updates from %s %s execution receipts", async (resourceKind, status, completed, expected) => {
    state.runs.mockResolvedValue([{ id: "goal", status: "completed", publicMessage: "日历已更新", objective: "安排会议", updatedAt: new Date(0) }]);
    state.resources.mockResolvedValue([{ resourceKind, resourceId: "resource", state: status, completed }]);
    const caller = collabRouter.createCaller({ user: { id: 42 } } as TrpcContext);
    expect((await caller.goals({ adoptId: "own" }))[0].calendarUpdated).toBe(expected);
  });
  it("hides automatic reply cards in old and new messages while retaining real completed goals", async () => {
    state.runs.mockResolvedValue([
      { id: "reply", requestKey: "reply:146", status: "completed", publicMessage: "对方有空", objective: "回告结果", updatedAt: new Date(0) },
      { id: "goal", requestKey: "explicit-goal", status: "completed", publicMessage: "已安排", objective: "安排会议", updatedAt: new Date(0) },
    ]);
    state.resources.mockResolvedValue([]);
    const caller = collabRouter.createCaller({user:{id:42}} as TrpcContext);
    const goals = await caller.goals({adoptId:"own"});
    expect(goals.map(goal => goal.id)).toEqual(["goal"]);
    expect(goals[0].status).toBe("completed");
    expect(state.resources).toHaveBeenCalledTimes(1);
  });
  it("returns owned calendar references without exposing child requests or checkpoints", async () => {
    state.resources.mockResolvedValue([
      {
        resourceKind: "draft",
        resourceId: "own-draft",
        state: "pending",
        checkpoint: "private",
      },
      {
        resourceKind: "request",
        resourceId: "child-request",
        state: "completed",
        result: "private",
      },
      {
        resourceKind: "meeting",
        resourceId: "already-created",
        state: "invited",
        completed: true,
      },
      {
        resourceKind: "cascade",
        resourceId: "unavailable",
        state: "unavailable",
      },
    ]);
    const caller = collabRouter.createCaller({
      user: { id: 42 },
    } as TrpcContext);
    const [goal] = await caller.goals({
      adoptId: "own",
      conversationId: "conversation",
    });
    expect(state.runs).toHaveBeenCalledWith(42, "own", "conversation");
    expect(goal.confirmations).toEqual([{ kind: "draft", id: "own-draft" }]);
    expect(JSON.stringify(goal)).not.toContain("child-request");
    expect(JSON.stringify(goal)).not.toContain("already-created");
    expect(JSON.stringify(goal)).not.toContain("private");
  });
  it("rejects another owner's assistant before loading any resources", async () => {
    const caller = collabRouter.createCaller({
      user: { id: 99 },
    } as TrpcContext);
    await expect(
      caller.goals({ adoptId: "own", conversationId: "conversation" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.runs).not.toHaveBeenCalled();
    expect(state.resources).not.toHaveBeenCalled();
  });
});
