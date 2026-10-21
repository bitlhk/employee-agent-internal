vi.mock("../../db/coop-identity", () => ({ assertCoopMember: vi.fn(), assertCoopParticipants: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({
  getClawByAdoptId: vi.fn(),
  getCollabSettings: vi.fn(),
  getCalendarBinding: vi.fn(),
  getCollabRequest: vi.fn(),
  finishApprovedCollabRequest: vi.fn(),
  getCalendarCredentials: vi.fn(),
  readOwnCalendar: vi.fn(),
  availabilityForSlots: vi.fn(),
}));
vi.mock("../../db", () => store);
vi.mock("../../db/scheduling", () => store);
vi.mock("../scheduling/calendar", () => store);
vi.mock("../scheduling/availability", () => store);
vi.mock("../audit-events", () => ({ recordAuditRequired: vi.fn() }));
import { collaborationReplyInput, replyToCollaboration } from "./reply-service";
import {
  projectCollaborationConclusion,
  projectLegacyCollaborationResult,
} from "./result-projection";
const reply = {
  requestId: 1,
  scheduling: {
    availability: "conditional" as const,
    slots: [
      { start: "2026-10-20T09:00:00+08:00", end: "2026-10-20T10:00:00+08:00" },
    ],
    validUntil: "",
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  store.getClawByAdoptId.mockResolvedValue({
    userId: 20,
    permissionProfile: "plus",
    status: "active",
  });
  store.getCollabRequest.mockResolvedValue({
    id: 1,
    targetAdoptId: "B",
    targetUserId: 20,
    taskType: "scheduling",
    status: "approved",
  });
  store.finishApprovedCollabRequest.mockResolvedValue(true);
  reply.scheduling.validUntil = new Date(Date.now() + 300_000).toISOString();
});
describe("one exchange, recipient-owned reply", () => {
  it("projects requested slots from the approved recipient calendar without private details", async () => {
    store.getCollabRequest.mockResolvedValue({ id: 1, targetAdoptId: "B", targetUserId: 20, taskType: "scheduling", status: "approved", inputPayload: JSON.stringify({ slots: reply.scheduling.slots }) });
    store.getCalendarCredentials.mockResolvedValue({ username: "B", calendarName: "own", grantId: "grant" });
    store.readOwnCalendar.mockResolvedValue([{ title: "PRIVATE" }]);
    store.availabilityForSlots.mockReturnValue(["busy"]);
    await replyToCollaboration(20, "B", reply);
    const saved = store.finishApprovedCollabRequest.mock.calls[0][2].resultSummary;
    expect(JSON.parse(saved).observations).toEqual([{ ...reply.scheduling.slots[0], availability: "busy" }]);
    expect(saved).not.toContain("PRIVATE");
    expect(store.readOwnCalendar.mock.calls[0][0]).toBe(20);
  });
  it("rechecks automatic calendar consent and stops after revocation", async () => {
    store.getCollabRequest.mockResolvedValue({ id: 1, targetAdoptId: "B", targetUserId: 20, taskType: "scheduling", status: "approved", approvalMode: "auto", approvedBy: null });
    store.getCollabSettings.mockResolvedValue({ acceptTask: "auto", allowedTaskTypes: '["scheduling"]' });
    store.getCalendarBinding.mockResolvedValue({ enabled: true, autoAvailability: false });
    await expect(replyToCollaboration(20, "B", reply)).rejects.toThrow("授权已撤销");
    expect(store.finishApprovedCollabRequest).not.toHaveBeenCalled();
    store.getCalendarBinding.mockResolvedValue({ enabled: true, autoAvailability: true });
    await expect(replyToCollaboration(20, "B", reply)).resolves.toMatchObject({ status: "completed" });
  });
  it("releases only bounded availability, never declares a calendar changed", async () => {
    await replyToCollaboration(20, "B", reply);
    const patch = store.finishApprovedCollabRequest.mock.calls[0][2];
    expect(JSON.parse(patch.resultSummary)).toMatchObject({
      availability: "conditional",
      calendarChanged: false,
    });
    expect(patch.status).toBe("completed");
  });
  it("rechecks availability strictly with the recipient owner's identity", async () => {
    store.getCalendarCredentials.mockResolvedValue({
      userId: 20,
      timeZone: "Asia/Shanghai",
    });
    store.readOwnCalendar.mockResolvedValue([]);
    store.availabilityForSlots.mockReturnValue(["free"]);
    const available = {
      ...reply,
      scheduling: { ...reply.scheduling, availability: "available" as const },
    };
    await replyToCollaboration(20, "B", available);
    expect(store.getCalendarCredentials).toHaveBeenCalledWith(20);
    expect(store.readOwnCalendar.mock.calls[0][0]).toBe(20);
    store.availabilityForSlots.mockReturnValue(["busy"]);
    await expect(replyToCollaboration(20, "B", available)).rejects.toThrow(
      "冲突"
    );
    store.getCalendarCredentials.mockResolvedValue(null);
    await expect(replyToCollaboration(20, "B", available)).rejects.toThrow(
      "未授权"
    );
  });
  it("rejects another owner or another target", async () => {
    await expect(replyToCollaboration(10, "B", reply)).rejects.toThrow(
      "只能回复"
    );
    await expect(replyToCollaboration(20, "C", reply)).rejects.toThrow(
      "只能回复"
    );
    expect(store.finishApprovedCollabRequest).not.toHaveBeenCalled();
  });
  it("cannot approve or answer a pending or cancelled request", async () => {
    for (const status of ["pending", "cancelled", "rejected"]) {
      store.getCollabRequest.mockResolvedValue({
        id: 1,
        targetAdoptId: "B",
        targetUserId: 20,
        taskType: "scheduling",
        status,
      });
      await expect(replyToCollaboration(20, "B", reply)).rejects.toThrow(
        "尚未批准"
      );
    }
    expect(store.finishApprovedCollabRequest).not.toHaveBeenCalled();
  });
  it("rejects expired observations, raw details and unsupported calendar identities", async () => {
    await expect(
      replyToCollaboration(20, "B", {
        ...reply,
        scheduling: { ...reply.scheduling, validUntil: "2000-01-01T00:00:00Z" },
      })
    ).rejects.toThrow("过期");
    await expect(
      replyToCollaboration(20, "B", { ...reply, summary: "私人会议内容" })
    ).rejects.toThrow("私人");
    expect(() =>
      collaborationReplyInput.parse({ ...reply, userId: 10 })
    ).toThrow();
    expect(() =>
      collaborationReplyInput.parse({
        ...reply,
        scheduling: { ...reply.scheduling, privateEvents: [] },
      })
    ).toThrow();
    expect(() =>
      collaborationReplyInput.parse({
        ...reply,
        scheduling: {
          ...reply.scheduling,
          slots: [{ start: "2026-10-20T10:00:00", end: "2026-10-20T09:00:00" }],
        },
      })
    ).toThrow();
  });
  it("does not overwrite a reply when approval changes during execution", async () => {
    store.finishApprovedCollabRequest.mockResolvedValue(false);
    await expect(replyToCollaboration(20, "B", reply)).rejects.toThrow(
      "状态已变化"
    );
  });
});
describe("released results and legacy envelope compatibility", () => {
  const row = {
    resultSummary: "old private summary",
    resultMeta: JSON.stringify({
      deliverMode: "summary",
      deliveredContent: "only released conclusion",
      structured_outputs: { privateCalendar: true },
      artifacts: [{ visibility: "private" }],
    }),
  };
  it("honors summary-only and none delivery without private intermediate results", () => {
    expect(projectCollaborationConclusion(row, true)).toEqual({
      shared: true,
      summary: "only released conclusion",
    });
    expect(JSON.stringify(projectLegacyCollaborationResult(row))).not.toContain(
      "privateCalendar"
    );
    const none = { ...row, resultMeta: '{"deliverMode":"none"}' };
    expect(projectCollaborationConclusion(none, true)).toEqual({
      shared: false,
      summary: "",
    });
    expect(projectLegacyCollaborationResult(none)).toEqual({
      resultSummary: "",
      resultMeta: { deliverMode: "none" },
    });
  });
  it("requires recipient sharing consent for automatic conclusion reads", () => {
    expect(
      projectCollaborationConclusion({ resultSummary: "conclusion" }, false)
    ).toEqual({ shared: false, summary: "" });
    expect(
      projectCollaborationConclusion({ resultSummary: "conclusion" }, true)
    ).toEqual({ shared: true, summary: "conclusion" });
  });
  it("retains legacy full envelopes and handles damaged historical metadata", () => {
    expect(
      projectLegacyCollaborationResult({
        resultSummary: "legacy",
        resultMeta: '{"structured_outputs":{"total":1}}',
      })
    ).toEqual({
      resultSummary: "legacy",
      resultMeta: { structured_outputs: { total: 1 } },
    });
    expect(() =>
      projectLegacyCollaborationResult({ resultMeta: "invalid" })
    ).not.toThrow();
  });
});
