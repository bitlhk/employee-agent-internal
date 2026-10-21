import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ICAL from "ical.js";
import { TRPCError } from "@trpc/server";
const read = vi.hoisted(() => vi.fn());
const directory = vi.hoisted(() => ({ resolve: vi.fn(), binding: vi.fn(), byEmail: vi.fn() }));
vi.mock("../../db/scheduling", () => ({ resolveCalendarParticipants: directory.resolve, getCalendarBinding: directory.binding, calendarPeopleByEmail: directory.byEmail }));
vi.mock("./calendar", async original => ({ ...await original<typeof import("./calendar")>(), readOwnCalendar: read }));
import { eventIcs, executeCalendarWrite, writeResourceId } from "./write-calendar";

const credentials = { userId: 1, username: "alice", calendarName: "personal", appPassword: "private-test", writeEnabled: true };
const event = { title: "Project review", location: "Room 1", time: { type: "timed" as const, start: "2026-10-13T09:00:00+08:00", end: "2026-10-13T10:00:00+08:00" } };
beforeEach(() => { vi.stubEnv("NEXTCLOUD_BASE_URL", "http://127.0.0.1:8088"); read.mockResolvedValue([]); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("Confirmed calendar writes", () => {
  it("recovery after expiry never issues a PUT even when the original operation is absent", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(executeCalendarWrite(1, credentials, "expired", { action: "create", event }, transport, true)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(transport).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
  });
  it("can verify an applied write after expiry without executing again", async () => {
    const transport = vi.fn(async () => new Response(eventIcs(event, "uid", "expired")));
    await expect(executeCalendarWrite(1, credentials, "expired", { action: "create", event }, transport, true)).resolves.toMatchObject({ reconciled: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("saves all-day dates without querying busy times", async () => {
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => new Response(null, { status: options?.method === "GET" ? 404 : 201 }));
    const allDay = { ...event, time: { type: "allDay" as const, start: "2026-10-13", end: "2026-10-14" } };
    await executeCalendarWrite(1, { ...credentials, timeZone: "Asia/Shanghai" }, "draft", { action: "create", event: allDay }, transport);
    expect(read).not.toHaveBeenCalled();
    expect(String(transport.mock.calls[1][1]?.body)).toContain("DTSTART;VALUE=DATE:20261013");
  });
  it("does not write all-day events without a known owner timezone", async () => {
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) => new Response(null, { status: 404 }));
    await expect(executeCalendarWrite(1, credentials, "draft", { action: "create", event: { ...event, time: { type: "allDay", start: "2026-10-13", end: "2026-10-14" } } }, transport)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(transport.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  });
  it("never reaches the network for a different owner or read-only authorization", async () => {
    const transport = vi.fn();
    await expect(executeCalendarWrite(2, credentials, "draft", { action: "create", event }, transport)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(executeCalendarWrite(1, { ...credentials, writeEnabled: false }, "draft", { action: "create", event }, transport)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("creates with a stable owner-specific URL and If-None-Match", async () => {
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (options?.method === "GET") return new Response(null, { status: 404 });
      expect(options?.method).toBe("PUT");
      expect((options?.headers as Record<string, string>)["if-none-match"]).toBe("*");
      expect(String(options?.body)).toContain("DTSTART:20261013T010000Z");
      return new Response(null, { status: 201 });
    });
    expect(await executeCalendarWrite(1, credentials, "draft", { action: "create", event }, transport)).toMatchObject({ reconciled: false });
    expect(writeResourceId(1, "draft")).not.toBe(writeResourceId(2, "draft"));
  });
  it("reconciles an already-applied create without another PUT", async () => {
    const transport = vi.fn(async () => new Response(eventIcs(event, "uid", "draft")));
    expect(await executeCalendarWrite(1, credentials, "draft", { action: "create", event }, transport)).toMatchObject({ reconciled: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not equate a modified event with the original operation", async () => {
    const transport = vi.fn(async () => new Response(eventIcs({ ...event, title: "Changed" }, "uid", "draft")));
    await expect(executeCalendarWrite(1, credentials, "draft", { action: "create", event }, transport)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("saves an explicit event even when another event occupies the time", async () => {
    read.mockResolvedValue([{ busy: true }]);
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => new Response(null, { status: options?.method === "GET" ? 404 : 201 }));
    await expect(executeCalendarWrite(1, credentials, "draft", { action: "create", event }, transport)).resolves.toMatchObject({ reconciled: false });
    expect(read).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("rejects stale update versions", async () => {
    const transport = vi.fn(async () => new Response(eventIcs(event, "uid", "old"), { headers: { etag: '"new"' } }));
    await expect(executeCalendarWrite(1, credentials, "draft", { action: "update", resourceId: writeResourceId(1, "old"), version: '"old"', event }, transport)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("preserves existing notes while updating and sends If-Match", async () => {
    const raw = eventIcs(event, "uid", "old").replace("END:VEVENT", "DESCRIPTION:Keep notes\r\nEND:VEVENT");
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (options?.method === "GET") return new Response(raw, { headers: { etag: '"old"' } });
      expect((options?.headers as Record<string, string>)["if-match"]).toBe('"old"');
      expect(String(options?.body)).toContain("DESCRIPTION:Keep notes");
      return new Response(null, { status: 204 });
    });
    await executeCalendarWrite(1, credentials, "draft", { action: "update", resourceId: writeResourceId(1, "old"), version: '"old"', event: { ...event, title: "Updated" } }, transport);
  });
  it("deletes only a reviewed current version", async () => {
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (options?.method === "GET") return new Response(eventIcs(event, "uid", "old"), { headers: { etag: '"old"' } });
      expect(options?.method).toBe("DELETE");
      expect((options?.headers as Record<string, string>)["if-match"]).toBe('"old"');
      return new Response(null, { status: 204 });
    });
    await executeCalendarWrite(1, credentials, "draft", { action: "delete", resourceId: writeResourceId(1, "old"), version: '"old"', title: event.title }, transport);
  });
  it("reports uncertain network results without credentials", async () => {
    const transport = vi.fn(async () => { throw new Error("sensitive upstream detail"); });
    await expect(executeCalendarWrite(1, credentials, "draft", { action: "create", event }, transport)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
  });
  it("serializes exclusive-end all-day dates", () => {
    const raw = eventIcs({ title: "Holiday", location: "", time: { type: "allDay", start: "2026-10-13", end: "2026-10-14" } }, "uid", "draft");
    const parsed = new ICAL.Event(new ICAL.Component(ICAL.parse(raw)).getFirstSubcomponent("vevent")!);
    expect(parsed.startDate.isDate).toBe(true);
    expect(parsed.endDate.toString()).toBe("2026-10-14");
  });
});

const people = { organizer: { userId: 1, name: "Alice", username: "alice", email: "alice@local.invalid" }, attendees: [{ userId: 2, name: "Bob", username: "bob", email: "bob@local.invalid" }] };
describe("organization participant calendar writes", () => {
  beforeEach(() => { directory.resolve.mockResolvedValue(people); directory.binding.mockResolvedValue({ calendarEmail: people.organizer.email }); });
  it("writes resolved participants only to the organizer calendar and reconciles retries", async () => {
    let saved: string | null = null;
    const transport = vi.fn(async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      expect(String(url)).toContain("/alice/personal/");
      if (options?.method === "GET") return saved ? new Response(saved) : new Response(null, { status: 404 });
      saved = String(options?.body);
      return new Response(null, { status: 201 });
    });
    const input = { action: "create" as const, event: { ...event, time: { type: "timed" as const, start: "2026-10-20T09:00:00.987Z", end: "2026-10-20T10:00:00.987Z" } }, participantIds: [2] };
    await executeCalendarWrite(1, credentials, "shared", input, transport);
    const component = new ICAL.Component(ICAL.parse(saved!)).getFirstSubcomponent("vevent")!;
    expect(component.getFirstPropertyValue("organizer")).toBe("mailto:alice@local.invalid");
    expect(component.getFirstPropertyValue("attendee")).toBe("mailto:bob@local.invalid");
    expect(component.getFirstProperty("attendee")!.getParameter("rsvp")).toBe("FALSE");
    directory.resolve.mockRejectedValue(new TRPCError({ code: "FORBIDDEN" }));
    await expect(executeCalendarWrite(1, credentials, "shared", input, transport)).resolves.toMatchObject({ reconciled: true });
    expect(transport.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects revoked or cross-organization participants before PUT", async () => {
    directory.resolve.mockRejectedValue(new TRPCError({ code: "FORBIDDEN" }));
    const transport = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(executeCalendarWrite(1, credentials, "shared", { action: "create", event, participantIds: [9] }, transport)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("removes participants in-place while preserving UID, notes and ETag", async () => {
    directory.resolve.mockResolvedValue({ ...people, attendees: [] });
    const raw = eventIcs(event, "same-uid", "old", undefined, people).replace("END:VEVENT", "DESCRIPTION:Keep notes\r\nEND:VEVENT");
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (options?.method === "GET") return new Response(raw, { headers: { etag: '"v1"' } });
      const component = new ICAL.Component(ICAL.parse(String(options?.body))).getFirstSubcomponent("vevent")!;
      expect(component.getAllProperties("attendee")).toEqual([]);
      expect(component.getFirstPropertyValue("uid")).toBe("same-uid");
      expect(component.getFirstPropertyValue("description")).toBe("Keep notes");
      expect((options?.headers as Record<string, string>)["if-match"]).toBe('"v1"');
      return new Response(null, { status: 204 });
    });
    await executeCalendarWrite(1, credentials, "updated", { action: "update", event, resourceId: writeResourceId(1, "old"), version: '"v1"', participantIds: [] }, transport);
  });
  it("does not let a recipient alter the organizer's event", async () => {
    directory.binding.mockResolvedValue({ calendarEmail: "recipient@local.invalid" });
    const transport = vi.fn(async () => new Response(eventIcs(event, "shared", "old", undefined, people), { headers: { etag: '"v1"' } }));
    await expect(executeCalendarWrite(1, credentials, "update", { action: "update", event, resourceId: writeResourceId(1, "old"), version: '"v1"', participantIds: [] }, transport)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
