import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ICAL from "ical.js";
import { meetingIcs, meetingUid, loadOwnMeeting, matchesMeeting, createOwnMeeting, cancelOwnMeeting, rescheduleOwnMeeting } from "./meeting-calendar";
import { meetingPayloadSchema } from "../../../shared/scheduling";
const payload = {
  event: { title: "Meeting", location: "Room", time: { type: "timed" as const, start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z" } },
  organizer: { userId: 1, name: "Alice", username: "alice", email: "alice@calendar.local.invalid" },
  attendees: [{ userId: 2, name: "Bob", username: "bob", email: "bob@calendar.local.invalid" }],
};
const owner = { userId: 1, username: "alice", calendarName: "personal", appPassword: "secret", writeEnabled: true };
const recipient = { ...owner, userId: 2, username: "bob" };
function report(username: string, data: string) {
  return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/remote.php/dav/calendars/${username}/personal/event.ics</d:href><d:propstat><d:prop><d:getetag>"v1"</d:getetag><c:calendar-data>${data}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207, headers: { "content-type": "application/xml" } });
}
function emptyReport() { return new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207, headers: { "content-type": "application/xml" } }); }
beforeEach(() => vi.stubEnv("NEXTCLOUD_BASE_URL", "http://127.0.0.1:8088"));
afterEach(() => vi.unstubAllEnvs());
describe("Owner-scoped meeting invitations", () => {
  it("reconciles timestamps at the provider's second precision", () => {
    const withMilliseconds = { ...payload, event: { ...payload.event, time: { type: "timed" as const, start: "2026-10-20T09:00:00.987Z", end: "2026-10-20T10:00:00.987Z" } } };
    const event = new ICAL.Component(ICAL.parse(meetingIcs("precision", withMilliseconds))).getFirstSubcomponent("vevent")!;
    expect(matchesMeeting(event, withMilliseconds)).toBe(true);
  });
  it("updates the original resource and UID, increments sequence and preserves provider invitation metadata without requiring replies", async () => {
    const previous = new ICAL.Component(ICAL.parse(meetingIcs("draft", payload)));
    previous.getFirstSubcomponent("vevent")!.getFirstProperty("attendee")!.setParameter("partstat", "ACCEPTED");
    const next = { ...payload, event: { ...payload.event, time: { type: "timed" as const, start: "2026-10-21T09:00:00Z", end: "2026-10-21T10:00:00Z" } } };
    const transport = vi.fn(async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (options?.method === "REPORT") return report("alice", previous.toString());
      expect(String(url)).toBe("http://127.0.0.1:8088/remote.php/dav/calendars/alice/personal/event.ics");
      expect((options?.headers as Record<string, string>)["if-match"]).toBe('"v1"');
      const event = new ICAL.Component(ICAL.parse(String(options?.body))).getFirstSubcomponent("vevent")!;
      expect(event.getFirstPropertyValue("uid")).toBe(meetingUid("draft"));
      expect(event.getFirstPropertyValue("sequence")).toBe(1);
      expect(event.getFirstProperty("attendee")!.getParameter("partstat")).toBe("ACCEPTED");
      expect(event.getFirstProperty("attendee")!.getParameter("rsvp")).toBe("FALSE");
      expect(matchesMeeting(event, next)).toBe(true);
      return new Response(null, { status: 204 });
    });
    await rescheduleOwnMeeting(1, owner, "draft", "change", payload, next, '"v1"', transport);
  });
  it("rejects changed meeting versions and cross-owner reschedules", async () => {
    const next = { ...payload, event: { ...payload.event, title: "Changed" } };
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) => report("alice", meetingIcs("draft", payload)));
    await expect(rescheduleOwnMeeting(1, owner, "draft", "change", payload, next, '"v0"', transport)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(transport.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
    const reads = transport.mock.calls.length;
    await expect(rescheduleOwnMeeting(2, recipient, "draft", "change", payload, next, '"v1"', transport)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transport).toHaveBeenCalledTimes(reads);
  });
  it("reconciles a retried reschedule without another PUT", async () => {
    const next = { ...payload, event: { ...payload.event, title: "Changed" } };
    const calendar = new ICAL.Component(ICAL.parse(meetingIcs("draft", next)));
    calendar.getFirstSubcomponent("vevent")!.updatePropertyWithValue("x-ea-operation-id", "change");
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) => report("alice", calendar.toString()));
    expect(await rescheduleOwnMeeting(1, owner, "draft", "change", payload, next, '"v1"', transport)).toEqual({ reconciled: true });
    expect(transport.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  });
  it("rejects duplicated recipients or calendar addresses", () => {
    expect(meetingPayloadSchema.safeParse({ ...payload, attendees: [payload.attendees[0], payload.attendees[0]] }).success).toBe(false);
    expect(meetingPayloadSchema.safeParse({ ...payload, attendees: [{ ...payload.attendees[0], email: payload.organizer.email }] }).success).toBe(false);
  });
  it("creates a stable shared UID with needs-action recipients", () => {
    const calendar = new ICAL.Component(ICAL.parse(meetingIcs("draft", payload)));
    const component = calendar.getFirstSubcomponent("vevent")!;
    expect(new ICAL.Event(component).uid).toBe(meetingUid("draft"));
    expect(component.getFirstProperty("attendee")!.getParameter("rsvp")).toBe("FALSE");
    expect(matchesMeeting(component, payload)).toBe(true);
    expect(matchesMeeting(component, { ...payload, event: { ...payload.event, title: "Changed" } })).toBe(false);
  });
  it("rejects cross-owner loads before calling the transport", async () => {
    const transport = vi.fn();
    await expect(loadOwnMeeting(2, owner, "draft", transport)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("writes only the organizer collection with If-None-Match", async () => {
    const transport = vi.fn(async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      expect(String(url)).toContain("/alice/personal/");
      if (options?.method === "REPORT") return emptyReport();
      expect(options?.method).toBe("PUT");
      expect((options?.headers as Record<string, string>)["if-none-match"]).toBe("*");
      return new Response(null, { status: 201 });
    });
    await expect(createOwnMeeting(1, owner, "draft", payload, transport)).resolves.toEqual({ reconciled: false });
  });
  it("reconciles without writing another meeting", async () => {
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) => report("alice", meetingIcs("draft", payload)));
    expect(await createOwnMeeting(1, owner, "draft", payload, transport)).toEqual({ reconciled: true });
    expect(transport.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  });
  it("cancels only an unchanged reviewed meeting with a version condition", async () => {
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (options?.method === "REPORT") return report("alice", meetingIcs("draft", payload));
      expect(options?.method).toBe("DELETE");
      expect((options?.headers as Record<string, string>)["if-match"]).toBe('"v1"');
      return new Response(null, { status: 204 });
    });
    await cancelOwnMeeting(1, owner, "draft", payload, transport);
  });
});
