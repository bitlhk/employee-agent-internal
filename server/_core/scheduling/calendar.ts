import { getCalendarBinding, calendarPeopleByEmail } from "../../db/scheduling";
import ICAL from "ical.js";
import { fetchCalendarObjects } from "tsdav";
import { TRPCError } from "@trpc/server";
import { schedulingRangeSchema, type CalendarEvent, type SchedulingRange } from "../../../shared/scheduling";
import { wallInstants } from "./timezone";

export type CalendarCredentials = { userId: number; username: string; calendarName: string; appPassword: string; writeEnabled?: boolean; timeZone?: string; grantId?: string };

export function calendarUrl(baseUrl: string, username: string, calendarName: string): string {
  if ([username, calendarName].some(value => !value || [".", ".."].includes(value) || /[/\\?#\s]/.test(value))) {
    throw new Error("Invalid calendar owner path");
  }
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || !["http:", "https:"].includes(base.protocol)) {
    throw new Error("Invalid Nextcloud URL");
  }
  if (base.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
    throw new Error("Nextcloud requires HTTPS outside loopback");
  }
  return new URL(`remote.php/dav/calendars/${encodeURIComponent(username)}/${encodeURIComponent(calendarName)}/`, `${base.toString().replace(/\/$/, "")}/`).toString();
}

// Expansion is requested from CalDAV. Never treat an unexpanded recurrence as complete availability.
export function parseCalendarObjects(data: string[], range: SchedulingRange, timeZone?: string): CalendarEvent[] {
  const result: CalendarEvent[] = [];
  for (const raw of data) {
    const calendar = new ICAL.Component(ICAL.parse(raw));
    for (const component of calendar.getAllSubcomponents("vevent")) {
      if (component.hasProperty("rrule") || component.hasProperty("rdate")) {
        throw new Error("Calendar server did not expand recurring events");
      }
      if (component.getFirstPropertyValue("status") === "CANCELLED") continue;
      const event = new ICAL.Event(component);
      const start = event.startDate;
      const end = event.endDate;
      if (!start || !end || !event.uid) throw new Error("Incomplete calendar event");
      // Floating or unknown TZID values must not silently become UTC.
      for (const time of [start, end]) {
        if (!time.isDate && time.zone.tzid !== "UTC") throw new Error("Calendar server must expand times to UTC");
      }
      const startAt = start.toJSDate().getTime();
      const endAt = end.toJSDate().getTime();
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) throw new Error("Invalid calendar time");
      let earliest = startAt; let latest = endAt;
      if (start.isDate) {
      const starts = timeZone ? wallInstants(start.toString(), 0, timeZone) : [];
      const ends = timeZone ? wallInstants(end.toString(), 0, timeZone) : [];
      // DATE has no server-local offset. Derive the conservative envelope from
      // its literal UTC date, otherwise changing the host timezone loses days.
      earliest = starts.length ? Math.min(...starts) : Date.parse(`${start.toString()}T00:00:00Z`) - 14 * 3_600_000;
      latest = ends.length ? Math.max(...ends) : Date.parse(`${end.toString()}T00:00:00Z`) + 12 * 3_600_000;
      }
      if (earliest >= Date.parse(range.end) || latest <= Date.parse(range.start)) continue;
      const person = (property: ICAL.Property) => ({
        name: String(property.getParameter("cn") || ""),
        email: String(property.getFirstValue()).replace(/^mailto:/i, ""),
      });
      const organizer = component.getFirstProperty("organizer");
      const participants = component.getAllProperties("attendee").map(person);
      result.push({
        ...(organizer ? { organizer: person(organizer), participants } : {}),
        id: `${event.uid}:${start.toString()}`,
        title: event.summary || "未命名日程",
        start: start.isDate ? start.toString() : new Date(startAt).toISOString(),
        end: end.isDate ? end.toString() : new Date(endAt).toISOString(),
        allDay: start.isDate,
        location: event.location || "",
        busy: component.getFirstPropertyValue("transp") !== "TRANSPARENT",
      });
    }
  }
  return result.sort((a, b) => a.start.localeCompare(b.start));
}

export async function readOwnCalendar(
  executionUserId: number,
  credentials: CalendarCredentials,
  input: SchedulingRange,
  transport: typeof fetch = fetch,
): Promise<CalendarEvent[]> {
  if (executionUserId !== credentials.userId) throw new TRPCError({ code: "FORBIDDEN", message: "只能查询本人日历" });
  const range = schedulingRangeSchema.parse(input);
  const baseUrl = process.env.NEXTCLOUD_BASE_URL;
  if (!baseUrl) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "尚未配置日程系统" });
  const url = calendarUrl(baseUrl, credentials.username, credentials.calendarName);
  const confinedFetch: typeof fetch = async (request, options) => {
    const target = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    if (target.origin !== new URL(url).origin || !target.pathname.startsWith(new URL(url).pathname)) {
      throw new Error("Calendar request outside owner scope");
    }
    const response = await transport(request, { ...options, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Calendar request failed");
    if (response.status === 207) {
      const xml = await response.clone().text();
      if (!/<(?:[\w-]+:)?multistatus[\s>]/.test(xml) || /HTTP\/\d(?:\.\d)?\s+[345]\d\d/.test(xml)) {
        throw new Error("Incomplete CalDAV multistatus");
      }
    }
    return response;
  };
  try {
    const objects = await fetchCalendarObjects({
      calendar: { url },
      headers: { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.appPassword}`).toString("base64")}` },
      timeRange: { start: new Date(Date.parse(range.start) - 86_400_000).toISOString(), end: new Date(Date.parse(range.end) + 86_400_000).toISOString() },
      expand: true,
      useMultiGet: false,
      fetch: confinedFetch,
    });
    if (objects.length > 2000 || objects.some(object => typeof object.data !== "string")) throw new Error("Incomplete calendar response");
    const binding = objects.some(object => /\r?\nORGANIZER[;:]/i.test(String(object.data))) ? await getCalendarBinding(executionUserId) : null;
    const parsed = objects.flatMap(object => {
      const target = new URL(object.url, url);
      const owner = new URL(url);
      if (target.origin !== owner.origin || !target.pathname.startsWith(owner.pathname) || decodeURIComponent(target.pathname).split("/").some(part => [".", ".."].includes(part))) throw new Error("Calendar response outside owner scope");
      const file = target.pathname.slice(owner.pathname.length);
      const editable = target.origin === owner.origin && target.pathname.startsWith(owner.pathname)
        && /^ea-(?:event|meeting)-[a-f0-9]{64}\.ics$/.test(file)
        && !/\r?\n(?:RRULE|RDATE|RECURRENCE-ID)[;:]/i.test(String(object.data));
      return parseCalendarObjects([String(object.data)], range, credentials.timeZone).map(event => ({ ...event,
        canEdit: editable && (!event.organizer || event.organizer.email.toLowerCase() === binding?.calendarEmail?.toLowerCase()),
        ...(editable && object.etag && (!event.organizer || event.organizer.email.toLowerCase() === binding?.calendarEmail?.toLowerCase()) ? { resourceId: file, version: object.etag } : {}),
      }));
    }).sort((a, b) => a.start.localeCompare(b.start));
    const addresses = parsed.flatMap(event => [...(event.participants || []), ...(event.organizer ? [event.organizer] : [])].map(person => person.email));
    if (addresses.length) {
      const people = await calendarPeopleByEmail(addresses);
      for (const event of parsed) for (const person of [...(event.participants || []), ...(event.organizer ? [event.organizer] : [])]) {
        const known = people.find(p => p.email?.toLowerCase() === person.email.toLowerCase());
        if (known) Object.assign(person, { userId: known.userId, name: person.name || known.name || person.email });
      }
    }
    return parsed;
  } catch {
    throw new TRPCError({ code: "BAD_GATEWAY", message: "无法完整读取日历，请检查连接、账号权限和日程格式；不能据此判断有空" });
  }
}
