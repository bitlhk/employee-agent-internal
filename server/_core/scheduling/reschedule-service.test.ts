vi.mock("../../db/coop-identity", () => ({ assertCoopMember: vi.fn(), assertCoopParticipants: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ draft: vi.fn(), meeting: vi.fn(), credentials: vi.fn(), person: vi.fn(), load: vi.fn(), write: vi.fn(), save: vi.fn(), update: vi.fn(), updateMeeting: vi.fn(), start: vi.fn(), view: vi.fn(), tasks: vi.fn(), query: vi.fn() }));
vi.mock("mysql2/promise", () => ({ default: { createConnection: async () => ({ query: mocks.query, end: vi.fn() }) } }));
vi.mock("../../db/calendar-reschedules", () => ({ getReschedule: mocks.draft, saveReschedule: mocks.save, updateReschedule: mocks.update }));
vi.mock("../../db/calendar-meetings", () => ({ getMeeting: mocks.meeting, updateMeeting: mocks.updateMeeting }));
vi.mock("../../db/scheduling", () => ({ getCalendarCredentials: mocks.credentials, getSchedulingPerson: mocks.person }));
vi.mock("../../db/calendar-coordination", () => ({ listAvailabilityTasks: mocks.tasks }));
vi.mock("./coordination-service", () => ({ startCoordination: mocks.start, getCoordinationView: mocks.view, collectCoordinationReplies: vi.fn() }));
vi.mock("./write-calendar", () => ({ bindingFingerprint: () => "bound" }));
vi.mock("./meeting-calendar", () => ({ loadOwnMeeting: mocks.load, matchesMeeting: (component: { title: string }, payload: { event: { title: string } }) => component.title === payload.event.title, rescheduleOwnMeeting: mocks.write }));
vi.mock("../audit-events", () => ({ recordAuditRequired: vi.fn() }));
import { confirmReschedule, prepareReschedule } from "./reschedule-service";
const time = { type: "timed" as const, start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 90_000_000).toISOString() };
const previous = { event: { title: "Old", location: "", time }, organizer: { userId: 1, name: "Alice", username: "alice", email: "a@local.invalid" }, attendees: [{ userId: 2, name: "Bob", username: "bob", email: "b@local.invalid" }] };
const payload = { ...previous, event: { ...previous.event, title: "New" } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([[{ acquired: 1 }]]);
  mocks.draft.mockImplementation(async (userId: number) => userId === 1 ? { id: "change", meetingId: "original", userId: 1, previous, payload, version: "v1", bindingFingerprint: "bound", status: "pending", expiresAt: new Date(Date.now() + 60_000) } : null);
  mocks.meeting.mockResolvedValue({ id: "original", creatorUserId: 1, payload: previous, status: "invited", bindingFingerprint: "bound" });
  mocks.credentials.mockResolvedValue({ userId: 1, username: "alice", writeEnabled: true });
  mocks.person.mockImplementation(async (userId: number) => ({ enabled: true, discoverable: true, username: userId === 1 ? "alice" : "bob", email: userId === 1 ? "a@local.invalid" : "b@local.invalid" }));
  mocks.load.mockResolvedValue({ component: { title: "Old", getFirstPropertyValue: () => "initial" }, version: "v1" });
  mocks.start.mockResolvedValue({ id: "check" });
  mocks.view.mockResolvedValue({ status: "completed", commonIndices: [0] });
  mocks.tasks.mockResolvedValue([]);
});
describe("Confirmed original-meeting reschedule", () => {
  it("never writes before confirmation and retains participant identity in the draft", async () => {
    await prepareReschedule(1, "original", payload.event);
    expect(mocks.save).toHaveBeenCalledWith(1, "original", previous, payload, "v1", "bound");
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rejects another owner and revoked write authorization", async () => {
    await expect(confirmReschedule(2, "change")).rejects.toMatchObject({ code: "NOT_FOUND" });
    mocks.credentials.mockResolvedValue({ writeEnabled: false });
    await expect(confirmReschedule(1, "change")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("applies an explicitly confirmed reschedule without a busy query", async () => {
    mocks.view.mockResolvedValue({ status: "collecting", commonIndices: [] });
    expect(await confirmReschedule(1, "change")).toEqual({ status: "completed" });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledOnce();
  });
  it("updates the same meeting after an owner-version-checked write", async () => {
    expect(await confirmReschedule(1, "change")).toEqual({ status: "completed" });
    expect(mocks.write).toHaveBeenCalledWith(1, expect.objectContaining({ userId: 1 }), "original", "change", previous, payload, "v1");
    expect(mocks.updateMeeting).toHaveBeenCalledWith("original", 1, expect.objectContaining({ payload }));
  });
  it("reconciles a persisted uncertain outcome even after draft expiry without writing again", async () => {
    mocks.draft.mockResolvedValue({ id: "change", meetingId: "original", userId: 1, previous, payload, version: "v1", bindingFingerprint: "bound", status: "unknown", expiresAt: new Date(0) });
    mocks.load.mockResolvedValue({ component: { title: "New", getFirstPropertyValue: () => "change" }, version: "v2" });
    expect(await confirmReschedule(1, "change")).toEqual({ status: "completed" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rejects stale source versions and changed participants before a new write", async () => {
    mocks.load.mockResolvedValue({ component: { title: "Old" }, version: "v2" });
    await expect(confirmReschedule(1, "change")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
