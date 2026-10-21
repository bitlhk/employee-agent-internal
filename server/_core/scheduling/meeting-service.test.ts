vi.mock("../../db/coop-identity", () => ({ assertCoopMember: vi.fn(), assertCoopParticipants: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  meeting: vi.fn(), save: vi.fn(), update: vi.fn(), ownRecords: vi.fn(), memberRecords: vi.fn(), credentials: vi.fn(), binding: vi.fn(), person: vi.fn(),
  view: vi.fn(), start: vi.fn(), collect: vi.fn(), tasks: vi.fn(), cancelCoordination: vi.fn(),
  create: vi.fn(), load: vi.fn(), cancel: vi.fn(), query: vi.fn(), end: vi.fn(),
}));
vi.mock("mysql2/promise", () => ({ default: { createConnection: vi.fn(async () => ({ query: mocks.query, end: mocks.end })) } }));
vi.mock("../../db/scheduling", () => ({ getCalendarCredentials: mocks.credentials, getCalendarBinding: mocks.binding, getSchedulingPerson: mocks.person, resolveCalendarParticipants: async () => ({ organizer: payload.organizer, attendees: payload.attendees }) }));
vi.mock("../../db/calendar-meetings", () => ({ getMeeting: mocks.meeting, createMeetingDraft: mocks.save, updateMeeting: mocks.update, listMeetingRecords: mocks.ownRecords, listParticipantMeetingRecords: mocks.memberRecords }));
vi.mock("../../db/calendar-coordination", () => ({ listAvailabilityTasks: mocks.tasks, cancelCoordination: mocks.cancelCoordination }));
vi.mock("./coordination-service", () => ({ getCoordinationView: mocks.view, startCoordination: mocks.start, collectCoordinationReplies: mocks.collect }));
vi.mock("./write-calendar", () => ({ bindingFingerprint: () => "owner-binding" }));
vi.mock("./meeting-calendar", () => ({ createOwnMeeting: mocks.create, loadOwnMeeting: mocks.load, cancelOwnMeeting: mocks.cancel }));
vi.mock("../audit-events", () => ({ recordAuditRequired: vi.fn() }));
import { prepareMeeting, prepareDirectMeeting, confirmMeeting, cancelMeeting } from "./meeting-service";
const slot = { start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 90_000_000).toISOString() };
const payload = { event: { title: "Meeting", location: "Room", time: { type: "timed", ...slot } }, organizer: { userId: 1, name: "Alice", username: "alice", email: "alice@local.invalid" }, attendees: [{ userId: 2, name: "Bob", username: "bob", email: "bob@local.invalid" }] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([[{ acquired: 1 }]]);
  mocks.meeting.mockResolvedValue({ id: "meeting", creatorUserId: 1, payload, status: "pending", expiresAt: new Date(Date.now() + 60_000), bindingFingerprint: "owner-binding", checkCoordinationId: null });
  mocks.credentials.mockImplementation(async (userId: number) => ({ userId, username: userId === 1 ? "alice" : "bob", writeEnabled: true }));
  mocks.binding.mockImplementation(async (userId: number) => ({ calendarEmail: userId === 1 ? "alice@local.invalid" : "bob@local.invalid" }));
  mocks.person.mockImplementation(async (userId: number) => ({ userId, enabled: true, discoverable: true, username: userId === 1 ? "alice" : "bob", email: userId === 1 ? "alice@local.invalid" : "bob@local.invalid", name: userId === 1 ? "Alice" : "Bob" }));
  mocks.view.mockResolvedValue({ id: "check", commonIndices: [0], status: "completed", title: "Meeting", slots: [slot], members: [{ userId: 1 }, { userId: 2 }] });
  mocks.start.mockResolvedValue({ id: "check" });
  mocks.load.mockResolvedValue(null);
  mocks.save.mockResolvedValue("meeting");
});
describe("Meeting confirmation and attendee authority", () => {
  it("prepares a concrete common-slot draft without writing a calendar", async () => {
    expect(await prepareMeeting(1, "coordination", 0, "Room")).toMatchObject({ meetingId: "meeting" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects unverified slots before saving", async () => {
    mocks.view.mockResolvedValue({ commonIndices: [] });
    await expect(prepareMeeting(1, "coordination", 0, "Room")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("creates from the confirmed payload without a busy query", async () => {
    expect(await confirmMeeting(1, "meeting")).toEqual({ status: "invited" });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(1, expect.objectContaining({ userId: 1 }), "meeting", payload);
    expect(mocks.credentials.mock.calls.every(([id]) => id === 1)).toBe(true);
  });
  it("does not gate explicit creation on manual availability", async () => {
    mocks.view.mockResolvedValue({ id: "check", status: "collecting", commonIndices: [] });
    expect(await confirmMeeting(1, "meeting")).toEqual({ status: "invited" });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("rejects a changed calendar binding or non-organizer confirmation", async () => {
    await expect(confirmMeeting(2, "meeting")).rejects.toMatchObject({ code: "NOT_FOUND" });
    mocks.credentials.mockResolvedValue({ userId: 1, username: "alice", writeEnabled: false });
    await expect(confirmMeeting(1, "meeting")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("prepares a meeting directly without any coordination record", async () => {
    const requestKey = "9127ce89-930b-454b-8c03-004b18f1821b";
    await prepareDirectMeeting(1, { requestKey, event: payload.event, participantIds: [2] });
    expect(mocks.save).toHaveBeenCalledWith(1, null, payload, "owner-binding", requestKey);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("cannot cancel another owner's meeting", async () => {
    await expect(cancelMeeting(2, "meeting")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalled();
  });
  it("does not expose provider details on a failed confirmation", async () => {
    mocks.load.mockRejectedValue(new Error("private upstream details"));
    await expect(confirmMeeting(1, "meeting")).rejects.toMatchObject({ code: "BAD_GATEWAY", message: "会议执行未完成，请刷新核对原草稿和日历连接" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
