import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  owner: vi.fn(),
  registry: vi.fn(),
  command: vi.fn(),
  session: vi.fn(),
  db: vi.fn(),
}));
vi.mock("../../db", () => ({ getClawByAdoptId: state.owner }));
vi.mock("../../db/connection", () => ({ getDb: state.db }));
vi.mock("../helpers", () => ({ readSessionRegistry: state.registry }));
vi.mock("../jiuwenclaw-bridge", () => ({
  buildJiuwenAgentId: () => "agent_fixture",
  buildJiuwenSessionId: state.session,
}));
vi.mock("./runtime-readiness", () => ({
  collaborationRuntimeCommand: state.command,
}));
import {
  appendConversationContext,
  appendWorkspaceContext,
} from "./conversation-context";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INTERNAL_RUNTIME_TOKEN_SECRET", "fixture-secret");
  state.owner.mockResolvedValue({
    userId: 7,
    adoptId: "lgj-fixture",
    status: "active",
  });
  state.registry.mockReturnValue({
    "lgj-fixture:web:original": { sessionKey: "sess_original" },
    "lgj-other:web:private": { sessionKey: "sess_private" },
  });
  state.session.mockReturnValue("sess_fixture_calendar");
  state.command.mockResolvedValue({ persisted: true });
});
const input = {
  userId: 7,
  adoptId: "lgj-fixture",
  resource: "run:fixture",
  content: "已创建日程",
  timestamp: new Date(),
};
describe("persistent conversation delivery", () => {
  it("persists intermediate progress as context without requesting another visible message", async () => {
    await appendConversationContext({
      ...input,
      resource: "run:matrix-progress",
      presentation: "context-only",
    });
    expect(
      JSON.parse(state.command.mock.calls[0][0].ea_payload).context.presentation
    ).toBe("context-only");
  });
  it("does not replay historical work into a newly created assistant", async () => {
    const query = {
      select: () => query,
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: async () => [
        {
          adoptId: "lgj-fixture",
          userId: 7,
          createdAt: new Date("2026-10-19T10:00:00Z"),
        },
      ],
    };
    state.db.mockResolvedValue(query);
    await appendWorkspaceContext(
      7,
      "availability:historical",
      "旧任务已回复",
      new Date("2026-10-18T10:00:00Z")
    );
    expect(state.command).not.toHaveBeenCalled();
    await appendWorkspaceContext(
      7,
      "availability:current",
      "收到新的组织请求",
      new Date("2026-10-19T11:00:00Z")
    );
    expect(state.command).toHaveBeenCalledOnce();
  });
  it("uses the verified original conversation and signs the complete message", async () => {
    await appendConversationContext({
      ...input,
      sessionId: "sess_original",
      actions: [{ kind: "draft", id: "own-draft" }],
    });
    const params = state.command.mock.calls[0][0];
    const payload = JSON.parse(params.ea_payload);
    expect(payload).toMatchObject({
      sessionId: "sess_original",
      adoptId: "lgj-fixture",
      content: input.content,
      context: { actions: [{ kind: "draft", id: "own-draft" }] },
    });
    expect(params.ea_signature).toBe(
      createHmac("sha256", "fixture-secret")
        .update(params.ea_payload)
        .digest("hex")
    );
    expect(state.session).not.toHaveBeenCalled();
  });
  it("does not append to another owner's or unregistered conversation", async () => {
    await appendConversationContext({ ...input, sessionId: "sess_private" });
    await appendConversationContext({ ...input, sessionId: "unregistered" });
    await appendConversationContext({ ...input, userId: 8 });
    state.owner.mockResolvedValue({ userId: 7, status: "disabled" });
    await appendConversationContext(input);
    expect(state.command).not.toHaveBeenCalled();
  });
  it("retries a dropped ACK with the same message ID and deduplicates only after durable ACK", async () => {
    const delivery = { ...input, content: "重试写入", resource: "run:retry" };
    state.command.mockRejectedValueOnce(new Error("connection lost"));
    await expect(appendConversationContext(delivery)).rejects.toThrow(
      "connection lost"
    );
    await appendConversationContext({
      ...delivery,
      timestamp: new Date(Date.now() + 1000),
    });
    const ids = state.command.mock.calls.map(
      ([params]) => JSON.parse(params.ea_payload).messageId
    );
    expect(ids[0]).toBe(ids[1]);
    await appendConversationContext(delivery);
    expect(state.command).toHaveBeenCalledTimes(2);
    expect(state.session).toHaveBeenCalledWith(
      expect.anything(),
      "agent_fixture",
      { channel: "web", conversationId: "calendar" }
    );
  });
  it("does not consider a transport response without a persisted ACK delivered", async () => {
    state.command.mockResolvedValueOnce({ ok: true });
    const delivery = { ...input, resource: "run:no-ack" };
    await expect(appendConversationContext(delivery)).rejects.toThrow(
      "尚未写入"
    );
    await appendConversationContext(delivery);
    expect(state.command).toHaveBeenCalledTimes(2);
  });
});
