vi.mock("../../db/coop-identity", () => ({ assertCoopParticipants: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({
  searchSchedulingPeople: vi.fn(),
  getClawByAdoptId: vi.fn(),
  getCollabRequest: vi.fn(),
  getCollabSettings: vi.fn(),
  getUserById: vi.fn(),
  listCollabDirectory: vi.fn(),
  listIncomingCollabRequests: vi.fn(),
  sendCollaborationRequest: vi.fn(),
  replyToCollaboration: vi.fn(),
  registry: vi.fn(),
}));
vi.mock("../helpers", () => ({ readSessionRegistry: store.registry }));
vi.mock("../../db", () => store);
vi.mock("../../db/scheduling", () => ({ searchSchedulingPeople: store.searchSchedulingPeople }));
vi.mock("./request-service", async importOriginal => ({
  ...(await importOriginal<typeof import("./request-service")>()),
  sendCollaborationRequest: store.sendCollaborationRequest,
}));
vi.mock("./reply-service", async importOriginal => ({
  ...(await importOriginal<typeof import("./reply-service")>()),
  replyToCollaboration: store.replyToCollaboration,
}));
import {
  handleCollaborationTool,
  COLLABORATION_PLATFORM_TOOLS,
} from "./platform-tools";
import { resolveToolGovernance } from "../tool-governance";
const read = async (name: string, args = {}) =>
  JSON.parse(
    (await handleCollaborationTool(10, "A", name, args)).content[0].text
  );
beforeEach(() => {
  vi.resetAllMocks();
  store.getClawByAdoptId.mockImplementation(async id => ({
    id: id === "A" ? 1 : 2,
    adoptId: id,
    userId: id === "A" ? 10 : 20,
    status: "active",
    permissionProfile: "plus",
  }));
  store.getCollabSettings.mockResolvedValue({ sharingPolicy: "result-only" });
  store.registry.mockReturnValue({ "A:web:original": { sessionKey: "verified-session" } });
});
describe("trusted collaboration platform tools", () => {
  it("binds the requester to the authenticated assistant and rejects identity overrides", async () => {
    const input = {
      targetAdoptId: "B",
      taskType: "scheduling",
      taskSummary: "明天下午是否有空？",
      requestKey: "a3e8b057-5cc8-41c3-b4d0-3aab3235b83c",
    };
    store.sendCollaborationRequest.mockResolvedValue({
      id: 1,
      status: "pending",
    });
    await handleCollaborationTool(10, "A", "send_collaboration_request", input, { sessionId: "verified-session" });
    expect(store.sendCollaborationRequest).toHaveBeenCalledWith(10, {
      ...input,
      requesterAdoptId: "A",
    }, undefined, { sourceSessionId: "verified-session", sourceConversationId: "original", authorizationSnapshotId: undefined });
    await expect(read("send_collaboration_request", input)).rejects.toThrow("缺少已验证的发起对话");
    await expect(
      read("send_collaboration_request", { ...input, requesterAdoptId: "C" })
    ).rejects.toThrow();
    await expect(read("query_own_schedules", { userId: 20 })).rejects.toThrow(
      "Unknown"
    );
  });
  it("returns only a released conclusion and never the target's internal data", async () => {
    store.getCollabRequest.mockResolvedValue({
      requesterAdoptId: "A",
      requesterUserId: 10,
      targetAdoptId: "B",
      targetUserId: 20,
      status: "completed",
      taskType: "general",
      resultSummary: "公开结论",
      resultMeta:
        '{"structured_outputs":{"childRequest":123,"privateEvents":[]}}',
    });
    expect(await read("get_collaboration_result", { requestId: 1 })).toEqual({
      requestId: 1,
      status: "completed",
      taskType: "general",
      shared: true,
      summary: "公开结论",
    });
    store.getCollabSettings.mockResolvedValue({ sharingPolicy: "none" });
    expect(
      await read("get_collaboration_result", { requestId: 1 })
    ).toMatchObject({ shared: false, summary: "" });
  });
  it("cannot inspect another assistant's requests, even for the same owner", async () => {
    store.getCollabRequest.mockResolvedValue({
      requesterAdoptId: "other",
      requesterUserId: 10,
    });
    await expect(
      read("get_collaboration_result", { requestId: 1 })
    ).rejects.toThrow("只能查询");
  });
  it("downgrades an expired scheduling observation instead of reporting available", async () => {
    store.getCollabRequest.mockResolvedValue({
      requesterAdoptId: "A",
      requesterUserId: 10,
      targetAdoptId: "B",
      targetUserId: 20,
      status: "completed",
      taskType: "scheduling",
      resultSummary:
        '{"availability":"available","validUntil":"2000-01-01T00:00:00Z"}',
    });
    const result = await read("get_collaboration_result", { requestId: 1 });
    expect(result.summary).toContain("过期");
    expect(result.summary).not.toContain("available");
  });
  it("searches existing names without exposing private accounts or inactive assistants", async () => {
    store.searchSchedulingPeople.mockResolvedValue([{ userId: 20, adoptId: "B" }]);
    store.getCollabSettings.mockResolvedValue({ displayName: "协作助手", acceptTask: "approval" });
    store.listCollabDirectory.mockResolvedValue([
      {
        adoptId: "B",
        displayName: "协作助手",
        acceptTask: "approval",
        permissionProfile: "plus",
      },
      { adoptId: "C", displayName: "Private", acceptTask: "off" },
    ]);
    store.getUserById.mockResolvedValue({
      id: 20,
      name: "张三",
      email: "private@example.com",
    });
    const result = await read("search_collaboration_people", { query: "张三" });
    expect(result.people).toEqual([
      {
        userId: 20,
        name: "张三",
        adoptId: "B",
        assistantName: "协作助手",
        acceptTask: "approval",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private@example.com");
  });
  it("keeps starter permissions and governance side effects unchanged", async () => {
    for (const tool of COLLABORATION_PLATFORM_TOOLS) {
      const profile = resolveToolGovernance(`mcp_platform_tools_${tool.name}`);
      expect(profile.sideEffect).toBe(
        ["send_collaboration_request", "reply_collaboration_request"].includes(
          tool.name
        )
          ? "external_send"
          : tool.name === "cancel_collaboration_request" ? "workspace_write" : "read"
      );
    }
    store.getClawByAdoptId.mockResolvedValue({
      userId: 10,
      status: "active",
      permissionProfile: "starter",
    });
    await expect(read("list_collaboration_requests")).rejects.toThrow(
      "没有协作权限"
    );
  });
});
