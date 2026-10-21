vi.mock("../../db/coop-identity", () => ({ assertCoopMember: vi.fn(), assertCoopParticipants: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ task: vi.fn(), record: vi.fn(), claim: vi.fn(), finish: vi.fn(), binding: vi.fn(), credentials: vi.fn(), read: vi.fn(), meeting: vi.fn() }));
vi.mock("../../db/scheduling", () => ({ getCalendarBinding: mocks.binding, getCalendarCredentials: mocks.credentials }));
vi.mock("../../db/calendar-coordination", () => ({ getAvailabilityTask: mocks.task, getCoordination: mocks.record, claimAvailabilityTask: mocks.claim, finishAvailabilityTask: mocks.finish }));
vi.mock("./calendar", () => ({ readOwnCalendar: mocks.read }));
vi.mock("./write-calendar", () => ({ bindingFingerprint: (input: { username: string }) => input.username }));
vi.mock("../audit-events", () => ({ recordAuditRequired: vi.fn() }));
vi.mock("../../db/calendar-meetings", () => ({ getMeeting: mocks.meeting }));
vi.mock("./meeting-calendar", () => ({ meetingUid: (id: string) => `uid-${id}` }));
import { executeParticipantAvailability } from "./participant-executor";
const slots = [{ start: "2026-10-13T09:00:00Z", end: "2026-10-13T10:00:00Z" }];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.task.mockResolvedValue({ id: "task", coordinationId: "room", targetUserId: 2 });
  mocks.record.mockResolvedValue({ id: "room", creatorUserId: 1, status: "collecting", expiresAt: new Date(Date.now() + 60_000), payload: { requestKey: "00000000-0000-4000-8000-000000000001", title: "Meeting", participantIds: [2], slots } });
  mocks.binding.mockResolvedValue({ enabled: true, discoverable: true, autoAvailability: true, username: "bob", calendarName: "personal" });
  mocks.credentials.mockResolvedValue({ userId: 2, username: "bob", calendarName: "personal", appPassword: "never-export" });
  mocks.claim.mockResolvedValue("lease");
  mocks.read.mockResolvedValue([{ id: "private", title: "private", location: "private", start: slots[0].start, end: slots[0].end, allDay: false, busy: true }]);
});
describe("Recipient-side execution isolation", () => {
  it("derives identity from persisted assignment and returns only availability", async () => {
    await executeParticipantAvailability("task");
    expect(mocks.credentials).toHaveBeenCalledWith(2);
    expect(mocks.read).toHaveBeenCalledWith(2, expect.objectContaining({ userId: 2 }), { start: new Date(slots[0].start).toISOString(), end: new Date(slots[0].end).toISOString() });
    expect(mocks.finish).toHaveBeenCalledWith("task", "lease", ["busy"]);
  });
  it("rejects a caller replying as another recipient", async () => {
    await expect(executeParticipantAvailability("task", 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.credentials).not.toHaveBeenCalled();
  });
  it("waits for approval when auto availability is off", async () => {
    mocks.binding.mockResolvedValue({ enabled: true, discoverable: true, autoAvailability: false });
    await executeParticipantAvailability("task");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("allows a recipient's manual response without auto permission", async () => {
    mocks.binding.mockResolvedValue({ enabled: true, discoverable: true, autoAvailability: false, username: "bob", calendarName: "personal" });
    await executeParticipantAvailability("task", 2);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it("requires a human reply to a secondary conflict request even with auto permission", async () => {
    mocks.task.mockResolvedValue({ id: "task", coordinationId: "room", targetUserId: 2, manualOnly: true });
    await executeParticipantAvailability("task");
    expect(mocks.read).not.toHaveBeenCalled();
    await executeParticipantAvailability("task", 2);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.finish).toHaveBeenCalledWith("task", "lease", ["busy"]);
  });
  it("excludes only the original shared meeting during a legitimate reschedule", async () => {
    const record = await mocks.record();
    mocks.record.mockResolvedValue({ ...record, excludeMeetingId: "original" });
    mocks.meeting.mockResolvedValue({ id: "original", creatorUserId: 1, payload: { event: { title: "Meeting", location: "", time: { type: "timed", ...slots[0] } }, organizer: { userId: 1, name: "Alice", username: "alice", email: "a@local.invalid" }, attendees: [{ userId: 2, name: "Bob", username: "bob", email: "b@local.invalid" }] } });
    const event = { id: "uid-original:date", title: "Shared", location: "", start: slots[0].start, end: slots[0].end, allDay: false, busy: true };
    mocks.read.mockResolvedValue([event]);
    await executeParticipantAvailability("task");
    expect(mocks.finish).toHaveBeenLastCalledWith("task", "lease", ["free"]);
    mocks.read.mockResolvedValue([event, { ...event, id: "private" }]);
    await executeParticipantAvailability("task");
    expect(mocks.finish).toHaveBeenLastCalledWith("task", "lease", ["busy"]);
    mocks.meeting.mockResolvedValue({ creatorUserId: 99 });
    await executeParticipantAvailability("task");
    expect(mocks.finish).toHaveBeenLastCalledWith("task", "lease", ["unknown"]);
  });
  it("does not query after cancellation or expiry", async () => {
    mocks.record.mockResolvedValue({ status: "cancelled", expiresAt: new Date(Date.now() + 60_000) });
    await executeParticipantAvailability("task");
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("returns unknown on failure and when authorization changes mid-query", async () => {
    mocks.read.mockRejectedValue(new Error("private failure"));
    await executeParticipantAvailability("task");
    expect(mocks.finish).toHaveBeenCalledWith("task", "lease", ["unknown"]);
    mocks.read.mockResolvedValue([]);
    mocks.binding.mockResolvedValueOnce({ enabled: true, discoverable: true, autoAvailability: true, username: "bob", calendarName: "personal" }).mockResolvedValueOnce({ enabled: false });
    await executeParticipantAvailability("task");
    expect(mocks.finish).toHaveBeenLastCalledWith("task", "lease", ["unknown"]);
  });
});
