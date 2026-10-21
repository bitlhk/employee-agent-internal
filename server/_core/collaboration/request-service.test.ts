vi.mock("../../db/coop-identity", () => ({ assertCoopMember: vi.fn(), assertCoopParticipants: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({
  getClawByAdoptId: vi.fn(),
  getCollabSettings: vi.fn(),
  createCollabRequest: vi.fn(),
  getCollabRequestByKey: vi.fn(),
  getCalendarBinding: vi.fn(),
  createConversationCollaborationRequest: vi.fn(),
  requestConversationContinuation: vi.fn(),
}));
vi.mock("../../db/collaboration-runs", () => store);
vi.mock("../../db", () => store);
vi.mock("../../db/collab", () => store);
vi.mock("../../db/scheduling", () => store);
import { sendCollaborationRequest } from "./request-service";
const input = {
  requesterAdoptId: "A",
  targetAdoptId: "B",
  taskType: "general",
  taskSummary: "请分析本次方案",
};
const key = "bb128c20-7243-4b9a-a19d-e5b602adfb08";
beforeEach(() => {
  vi.resetAllMocks();
  store.getClawByAdoptId.mockImplementation(async (adoptId: string) => ({
    id: adoptId === "A" ? 1 : 2,
    userId: adoptId === "A" ? 10 : 20,
    adoptId,
    permissionProfile: "plus",
  }));
  store.getCollabSettings.mockResolvedValue({
    acceptTask: "auto",
    allowedTaskTypes: "[]",
  });
  store.createCollabRequest.mockResolvedValue(123);
  store.getCollabRequestByKey.mockResolvedValue(null);
});
describe("collaboration request compatibility", () => {
  it("retains validated candidates through automatic input filtering without private fields", async () => {
    const slots = [{ start: "2026-10-28T11:00:00+08:00", end: "2026-10-28T12:00:00+08:00" }];
    await sendCollaborationRequest(10, { ...input, taskType: "scheduling", inputPayload: { query: "忙闲查询", slots, private: "PRIVATE" } });
    expect(JSON.parse(store.createCollabRequest.mock.calls[0][0].inputPayload)).toEqual({ query: "忙闲查询", slots });
    await expect(sendCollaborationRequest(10, { ...input, taskType: "scheduling", inputPayload: { slots: [{ ...slots[0], end: slots[0].start }] } })).rejects.toThrow();
  });
  it("creates a direct reply continuation atomically and binds retries to its original session", async () => {
    const source={sourceSessionId:"session-a",sourceConversationId:"a"};
    store.createConversationCollaborationRequest.mockResolvedValue(321);
    await expect(sendCollaborationRequest(10,{...input,requestKey:key},undefined,source)).resolves.toMatchObject({id:321});
    const payload=store.createConversationCollaborationRequest.mock.calls[0][0];
    store.getCollabRequestByKey.mockResolvedValue({...payload,id:321});
    store.requestConversationContinuation.mockResolvedValue(source);
    await expect(sendCollaborationRequest(10,{...input,requestKey:key},undefined,source)).resolves.toMatchObject({id:321});
    expect(store.createConversationCollaborationRequest).toHaveBeenCalledTimes(1);
    await expect(sendCollaborationRequest(10,{...input,requestKey:key},undefined,{...source,sourceSessionId:"other-session"})).rejects.toThrow("其他会话");
  });
  it("enables scheduling independently without enabling historical general requests", async () => {
    store.getCollabSettings.mockResolvedValue({ acceptTask: "off", allowedTaskTypes: '["custom"]', schedulingAcceptTask: "auto" });
    store.getCalendarBinding.mockResolvedValue({ enabled: true, autoAvailability: true });
    await expect(sendCollaborationRequest(10, { ...input, taskType: "scheduling", inputPayload: { query: "09:00是否有空" } })).resolves.toMatchObject({ status: "approved" });
    await expect(sendCollaborationRequest(10, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("can disable scheduling while preserving the legacy empty-list general rule", async () => {
    store.getCollabSettings.mockResolvedValue({ acceptTask: "auto", allowedTaskTypes: "[]", schedulingAcceptTask: "off" });
    await expect(sendCollaborationRequest(10, input)).resolves.toMatchObject({ status: "approved" });
    await expect(sendCollaborationRequest(10, { ...input, taskType: "scheduling" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("preserves historical task types, empty allow-list and field filtering", async () => {
    const result = await sendCollaborationRequest(10, {
      ...input,
      taskType: "existing-custom-task",
      inputPayload: { query: "safe", memory: "private", arbitrary: "blocked" },
    });
    expect(result).toMatchObject({ id: 123, status: "approved" });
    expect(store.createCollabRequest.mock.calls[0][0]).toMatchObject({
      taskType: "existing-custom-task",
      inputPayload: '{"query":"safe"}',
    });
    expect(store.getCalendarBinding).not.toHaveBeenCalled();
    expect(store.getCollabRequestByKey).not.toHaveBeenCalled();
  });
  it("preserves approval mode and high-risk downgrade", async () => {
    store.getCollabSettings.mockResolvedValue({ acceptTask: "approval" });
    expect(await sendCollaborationRequest(10, input)).toMatchObject({
      status: "pending",
      approvalMode: "manual",
    });
    store.getCollabSettings.mockResolvedValue({ acceptTask: "auto" });
    expect(
      await sendCollaborationRequest(10, {
        ...input,
        taskSummary: "x".repeat(501),
      })
    ).toMatchObject({ status: "pending", riskLevel: "high" });
  });
  it("rejects impersonation, starter profiles and disabled recipients", async () => {
    await expect(sendCollaborationRequest(20, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    store.getClawByAdoptId.mockResolvedValue({
      userId: 10,
      permissionProfile: "starter",
    });
    await expect(sendCollaborationRequest(10, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(store.createCollabRequest).not.toHaveBeenCalled();
  });
  it("defaults scheduling reception to auto but still requires calendar consent", async () => {
    store.getCalendarBinding.mockResolvedValue({
      enabled: true,
      autoAvailability: false,
    });
    expect(
      await sendCollaborationRequest(10, { ...input, taskType: "scheduling" })
    ).toMatchObject({ status: "pending" });
    store.getCollabSettings.mockResolvedValue({
      acceptTask: "auto",
      allowedTaskTypes: '["scheduling"]',
    });
    store.getCalendarBinding.mockResolvedValue({
      enabled: true,
      autoAvailability: false,
    });
    expect(
      await sendCollaborationRequest(10, { ...input, taskType: "scheduling" })
    ).toMatchObject({ status: "pending" });
    store.getCalendarBinding.mockResolvedValue({
      enabled: true,
      autoAvailability: true,
    });
    expect(
      await sendCollaborationRequest(10, { ...input, taskType: "scheduling" })
    ).toMatchObject({ status: "approved" });
    store.getCollabSettings.mockResolvedValue(null);
    expect(await sendCollaborationRequest(10, { ...input, taskType: "scheduling" })).toMatchObject({ status: "approved" });
    store.getCollabSettings.mockResolvedValue({ schedulingAcceptTask: "approval" });
    expect(await sendCollaborationRequest(10, { ...input, taskType: "scheduling" })).toMatchObject({ status: "pending" });
  });
  it("replays the same request, rejects a changed proposal with the same key", async () => {
    await sendCollaborationRequest(10, { ...input, requestKey: key });
    const payload = store.createCollabRequest.mock.calls[0][0];
    store.getCollabRequestByKey.mockResolvedValue({
      id: 123,
      status: "completed",
      requestFingerprint: payload.requestFingerprint,
    });
    expect(
      await sendCollaborationRequest(10, { ...input, requestKey: key })
    ).toMatchObject({ id: 123, status: "completed" });
    expect(store.createCollabRequest).toHaveBeenCalledTimes(1);
    await expect(
      sendCollaborationRequest(10, {
        ...input,
        requestKey: key,
        taskSummary: "换一个时间",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("recovers a unique-key collision from a concurrent retry", async () => {
    store.createCollabRequest.mockImplementation(async payload => {
      store.getCollabRequestByKey.mockResolvedValue({
        id: 456,
        status: "approved",
        requestFingerprint: payload.requestFingerprint,
      });
      throw new Error("duplicate key");
    });
    expect(
      await sendCollaborationRequest(10, { ...input, requestKey: key })
    ).toMatchObject({ id: 456 });
  });
  it("creates independent exchanges for new proposals without a group session", async () => {
    await sendCollaborationRequest(10, { ...input, requestKey: key });
    await sendCollaborationRequest(10, {
      ...input,
      requestKey: "2347bb61-81ca-435d-92c6-ef7971ca715e",
      taskSummary: "那改为明天呢？",
    });
    expect(store.createCollabRequest).toHaveBeenCalledTimes(2);
    expect(
      store.createCollabRequest.mock.calls.every(
        ([row]) => row.sessionId === undefined
      )
    ).toBe(true);
  });
});
