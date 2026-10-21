import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarBindingSchema, schedulingRangeSchema } from "../../../shared/scheduling";
import { calendarUrl, parseCalendarObjects, readOwnCalendar } from "./calendar";

const range = { start: "2026-10-12T00:00:00Z", end: "2026-10-19T00:00:00Z" };
const credentials = { userId: 1, username: "alice", calendarName: "personal", appPassword: "test-only" };
function ics(lines: string[]) { return ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:meeting-1", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n"); }

afterEach(() => vi.unstubAllEnvs());
describe("Calendar owner isolation and bounded queries", () => {
  it("rejects a different execution owner before any network access", async () => {
    const transport = vi.fn();
    await expect(readOwnCalendar(2, credentials, range, transport)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects identity injection and invalid ranges", () => {
    expect(schedulingRangeSchema.safeParse({ ...range, userId: 2 }).success).toBe(false);
    expect(schedulingRangeSchema.safeParse({ start: range.end, end: range.start }).success).toBe(false);
    expect(schedulingRangeSchema.safeParse({ ...range, end: "2027-01-01T00:00:00Z" }).success).toBe(false);
    expect(calendarBindingSchema.safeParse({ ...credentials, enabled: true, discoverable: true, username: "../bob" }).success).toBe(false);
  });
  it("requires secure remote transport and encodes usernames", () => {
    expect(() => calendarUrl("http://example.com", "alice", "personal")).toThrow();
    expect(calendarUrl("https://example.com/cloud", "a@b", "personal")).toBe("https://example.com/cloud/remote.php/dav/calendars/a%40b/personal/");
    expect(() => calendarUrl("https://example.com", "..", "personal")).toThrow();
  });
  it("reads timed and exclusive-end all-day events", () => {
    const events = parseCalendarObjects([
      ics(["DTSTART:20261012T090000Z", "DTEND:20261012T100000Z", "SUMMARY:Project meeting", "TRANSP:TRANSPARENT"]),
      ics(["DTSTART;VALUE=DATE:20261013", "DTEND;VALUE=DATE:20261014", "SUMMARY:Holiday"]),
    ], range);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ start: "2026-10-12T09:00:00.000Z", busy: false });
    expect(events[1]).toMatchObject({ start: "2026-10-13", end: "2026-10-14", allDay: true });
  });
  it("retains all-day events near UTC midnight and filters by the owner's saved zone", () => {
    const data = [ics(["DTSTART;VALUE=DATE:20261013", "DTEND;VALUE=DATE:20261014", "SUMMARY:Holiday"])];
    const late = { start: "2026-10-12T16:30:00Z", end: "2026-10-12T17:00:00Z" };
    expect(parseCalendarObjects(data, late)).toHaveLength(1);
    expect(parseCalendarObjects(data, late, "Asia/Shanghai")).toHaveLength(1);
    expect(parseCalendarObjects(data, late, "America/New_York")).toHaveLength(0);
  });
  it("does not invent availability from incomplete recurrence or floating time", () => {
    expect(() => parseCalendarObjects([ics(["DTSTART:20261012T090000Z", "DTEND:20261012T100000Z", "RRULE:FREQ=DAILY"])], range)).toThrow(/expand/);
    expect(() => parseCalendarObjects([ics(["DTSTART:20261012T090000", "DTEND:20261012T100000"])], range)).toThrow();
  });
  it("excludes cancelled and out-of-range events", () => {
    expect(parseCalendarObjects([
      ics(["DTSTART:20261012T090000Z", "DTEND:20261012T100000Z", "STATUS:CANCELLED"]),
      ics(["DTSTART:20261019T000000Z", "DTEND:20261019T010000Z"]),
    ], range)).toEqual([]);
  });
  it("rejects upstream failure without exposing credentials", async () => {
    vi.stubEnv("NEXTCLOUD_BASE_URL", "http://127.0.0.1:8088");
    const transport = vi.fn(async () => new Response("private server error", { status: 401 }));
    await expect(readOwnCalendar(1, credentials, range, transport)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    expect(String(transport.mock.calls[0][0])).toContain("/alice/personal/");
  });
  it("rejects partial DAV denial rather than reporting empty schedules", async () => {
    vi.stubEnv("NEXTCLOUD_BASE_URL", "http://127.0.0.1:8088");
    const transport = vi.fn(async () => new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:status>HTTP/1.1 403 Forbidden</d:status></d:response></d:multistatus>', { status: 207, headers: { "content-type": "application/xml" } }));
    await expect(readOwnCalendar(1, credentials, range, transport)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
  });
  it("rejects resources outside the authenticated owner's collection", async () => {
    vi.stubEnv("NEXTCLOUD_BASE_URL", "http://127.0.0.1:8088");
    const data = ics(["DTSTART:20261012T090000Z", "DTEND:20261012T100000Z", "SUMMARY:Private"]);
    const transport = vi.fn(async () => new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/remote.php/dav/calendars/bob/personal/event.ics</d:href><d:propstat><d:prop><d:getetag>v1</d:getetag><c:calendar-data>${data}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 }));
    await expect(readOwnCalendar(1, credentials, range, transport)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
  });
  it("queries the owner's collection with expansion and parses a real DAV response", async () => {
    vi.stubEnv("NEXTCLOUD_BASE_URL", "http://127.0.0.1:8088");
    const data = ics(["DTSTART:20261012T090000Z", "DTEND:20261012T100000Z", "SUMMARY:Meeting"]);
    const transport = vi.fn(async (_request: Parameters<typeof fetch>[0], options?: RequestInit) => {
      expect(options?.redirect).toBe("error");
      expect(String(options?.body)).toContain("expand");
      expect(options?.method).toBe("REPORT");
      return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/remote.php/dav/calendars/alice/personal/event.ics</d:href><d:propstat><d:prop><d:getetag>"v1"</d:getetag><c:calendar-data>${data}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207, headers: { "content-type": "application/xml" } });
    });
    expect(await readOwnCalendar(1, credentials, range, transport)).toMatchObject([{ title: "Meeting", allDay: false }]);
  });
});
