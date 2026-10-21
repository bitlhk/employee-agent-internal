vi.mock("../../db/coop-identity", () => ({ assertCoopMember: vi.fn(), assertCoopParticipants: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ person: vi.fn(), create: vi.fn(), record: vi.fn(), tasks: vi.fn(), complete: vi.fn(), records: vi.fn(), execute: vi.fn() }));
vi.mock("../../db/scheduling", () => ({ getSchedulingPerson: mocks.person }));
vi.mock("../../db/calendar-coordination", () => ({ createCoordination: mocks.create, getCoordination: mocks.record, listAvailabilityTasks: mocks.tasks, completeCoordination: mocks.complete, listCoordinationRecords: mocks.records }));
vi.mock("./participant-executor", () => ({ executeParticipantAvailability: mocks.execute }));
vi.mock("../audit-events", () => ({ recordAuditRequired: vi.fn() }));
import { startCoordination, getCoordinationView, collectCoordinationReplies } from "./coordination-service";
const input = { requestKey: "00000000-0000-4000-8000-000000000001", title: "Meeting", participantIds: [2], slots: [{ start: "2026-10-13T09:00:00Z", end: "2026-10-13T10:00:00Z" }] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.person.mockImplementation(async (userId: number) => ({ userId, name: `User${userId}`, enabled: true, discoverable: true }));
  mocks.create.mockResolvedValue("room");
  mocks.record.mockResolvedValue({ id: "room", creatorUserId: 1, status: "collecting", expiresAt: new Date(Date.now() + 60_000), payload: input });
  mocks.tasks.mockResolvedValue([{ id: "t1", targetUserId: 1, displayName: "Owner", status: "replied", reply: ["free"] }, { id: "t2", targetUserId: 2, displayName: "Peer", status: "pending", reply: null }]);
});
describe("Meeting coordinator", () => {
  it("resolves people then dispatches only persisted task IDs", async () => {
    const result = await startCoordination(1, input);
    expect(mocks.create).toHaveBeenCalledWith(1, input, [{ userId: 1, name: "User1" }, { userId: 2, name: "User2" }], undefined);
    expect(mocks.execute).toHaveBeenCalledWith("t2");
    expect(result.commonIndices).toEqual([]);
  });
  it("rejects disabled calendars before creating or dispatching", async () => {
    mocks.person.mockImplementation(async (userId: number) => ({ userId, name: "Peer", enabled: userId === 1, discoverable: true }));
    await expect(startCoordination(1, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not expose another owner's coordination", async () => {
    await expect(getCoordinationView(2, "room")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(collectCoordinationReplies(2, "room")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not mark missing or malformed replies free", async () => {
    mocks.tasks.mockResolvedValue([{ targetUserId: 1, displayName: "Owner", status: "replied", reply: ["free"] }, { targetUserId: 2, displayName: "Peer", status: "replied", reply: ["private-event"] }]);
    expect((await getCoordinationView(1, "room")).commonIndices).toEqual([]);
  });
  it("returns common times only with all explicit free replies", async () => {
    mocks.tasks.mockResolvedValue([{ targetUserId: 1, displayName: "Owner", status: "replied", reply: ["free"] }, { targetUserId: 2, displayName: "Peer", status: "replied", reply: ["free"] }]);
    expect((await getCoordinationView(1, "room")).commonIndices).toEqual([0]);
    mocks.record.mockResolvedValue({ creatorUserId: 1, status: "cancelled", expiresAt: new Date(Date.now() + 60_000), payload: input });
    expect((await getCoordinationView(1, "room")).commonIndices).toEqual([]);
  });
  it("marks completed snapshots expired so stale free replies cannot prepare a meeting", async () => {
    mocks.record.mockResolvedValue({ creatorUserId: 1, status: "completed", expiresAt: new Date(0), payload: input });
    mocks.tasks.mockResolvedValue([{ targetUserId: 1, displayName: "Owner", status: "replied", reply: ["free"] }, { targetUserId: 2, displayName: "Peer", status: "replied", reply: ["free"] }]);
    expect(await getCoordinationView(1, "room")).toMatchObject({ status: "expired", commonIndices: [] });
  });
});
