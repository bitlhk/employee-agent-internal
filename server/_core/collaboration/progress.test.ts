import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getClawByAdoptId: vi.fn(),
  getCollaborationRun: vi.fn(),
  collaborationWaitingResources: vi.fn(),
  getCollabRequest: vi.fn(),
  getUserById: vi.fn(),
  canCollaborate: vi.fn(),
  getCalendarCredentials: vi.fn(),
  readOwnCalendar: vi.fn(),
  availabilityForSlots: vi.fn(),
}));
vi.mock("../../db", () => mocks);
vi.mock("../../db/collaboration-runs", () => mocks);
vi.mock("./resources", () => mocks);
vi.mock("../../db/coop-identity", () => mocks);
vi.mock("../../db/scheduling", () => mocks);
vi.mock("../scheduling/calendar", () => mocks);
vi.mock("../scheduling/availability", () => mocks);
import { goalAvailability, incomingSchedulingProgress } from "./progress";
const slot = {
  start: "2026-10-28T11:00:00+08:00",
  end: "2026-10-28T12:00:00+08:00",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getClawByAdoptId.mockResolvedValue({ userId: 1 });
  mocks.getCollaborationRun.mockResolvedValue({
    id: "goal",
    userId: 1,
    adoptId: "A",
  });
  mocks.collaborationWaitingResources.mockResolvedValue([
    {
      resourceKind: "request",
      resourceId: "2",
      result: { shared: false, summary: "" },
    },
  ]);
  mocks.getCollabRequest.mockResolvedValue({
    id: 2,
    requesterUserId: 1,
    requesterAdoptId: "A",
    targetUserId: 2,
    targetAdoptId: "B",
    taskType: "scheduling",
    inputPayload: JSON.stringify({ slots: [slot], private: "PRIVATE" }),
    status: "completed",
  });
  mocks.canCollaborate.mockResolvedValue({ ok: true });
  mocks.getUserById.mockResolvedValue({ name: "成员B" });
  mocks.getCalendarCredentials.mockResolvedValue({ userId: 1 });
  mocks.readOwnCalendar.mockResolvedValue([{ title: "PRIVATE" }]);
  mocks.availabilityForSlots.mockReturnValue(["free"]);
});
it("never reads recipient calendars and honors current result sharing", async () => {
  const matrix = await goalAvailability(1, "A", "goal");
  expect(matrix.rows[0].cells).toEqual(["free", "unshared"]);
  expect(matrix.rows[0].common).toBe(false);
  expect(mocks.getCalendarCredentials).toHaveBeenCalledExactlyOnceWith(1);
  expect(JSON.stringify(matrix)).not.toContain("PRIVATE");
});
it("rejects another owner's goal or incoming card before accessing calendar data", async () => {
  await expect(goalAvailability(2, "A", "goal")).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(incomingSchedulingProgress(1, "A", 2)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(mocks.readOwnCalendar).not.toHaveBeenCalled();
});
it("does not infer availability when a waiting resource has no released result", async () => {
  mocks.collaborationWaitingResources.mockResolvedValue([
    { resourceKind: "request", resourceId: "2", state: "unavailable", terminal: true, completed: false },
  ]);
  const matrix = await goalAvailability(1, "A", "goal");
  expect(matrix.rows[0].cells).toEqual(["free", "unshared"]);
  expect(matrix.rows[0].common).toBe(false);
  expect(mocks.getCalendarCredentials).toHaveBeenCalledExactlyOnceWith(1);
});
it("hides participants removed from the organization", async () => {
  mocks.canCollaborate.mockResolvedValue({ ok: false });
  const matrix = await goalAvailability(1, "A", "goal");
  expect(matrix.people).toEqual([{ id: "1", name: "我" }]);
  expect(matrix.rows).toEqual([]);
});
it("keeps expiry visible after resource projection removes stale availability", async () => {
  mocks.collaborationWaitingResources.mockResolvedValue([{ resourceKind: "request", resourceId: "2", result: { shared: true, summary: "结论已过期，需要重新询问", expired: true } }]);
  const matrix = await goalAvailability(1, "A", "goal");
  expect(matrix.rows[0].cells).toEqual(["free", "expired"]);
  expect(matrix.rows[0].common).toBe(false);
});
it("returns only the recipient's saved structured reply without rechecking calendars", async () => {
  mocks.getClawByAdoptId.mockResolvedValue({ userId: 2 });
  const request = await mocks.getCollabRequest();
  const reply = {
    availability: "available",
    slots: [slot],
    validUntil: "2020-01-01T00:00:00Z",
  };
  mocks.getCollabRequest.mockResolvedValue({
    ...request,
    resultSummary: JSON.stringify({ ...reply, private: "PRIVATE" }),
  });
  expect((await incomingSchedulingProgress(2, "B", 2)).reply).toEqual(reply);
  expect(mocks.readOwnCalendar).not.toHaveBeenCalled();
  mocks.getCollabRequest.mockResolvedValue({
    ...request,
    status: "running",
    resultSummary: JSON.stringify(reply),
  });
  expect((await incomingSchedulingProgress(2, "B", 2)).reply).toBeNull();
});
