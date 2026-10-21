import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { TRPCError } from "@trpc/server";
import { calendarWriteSchema, type CalendarWrite } from "../../../shared/scheduling";
import { calendarUrl, type CalendarCredentials } from "./calendar";
import { wallInstants } from "./timezone";
import type { MeetingPayload } from "../../../shared/scheduling";
import { getCalendarBinding, resolveCalendarParticipants, calendarPeopleByEmail } from "../../db/scheduling";

export function setEventParticipants(component: ICAL.Component, people: Pick<MeetingPayload, "organizer" | "attendees">) {
  component.updatePropertyWithValue("organizer", `mailto:${people.organizer.email.toLowerCase()}`);
  component.getFirstProperty("organizer")!.setParameter("cn", people.organizer.name.replace(/[\r\n]/g, " "));
  component.getFirstProperty("organizer")!.setParameter("x-ea-user-id", String(people.organizer.userId));
  const previous = new Map(component.getAllProperties("attendee").map(property => [String(property.getFirstValue()).toLowerCase(), property]));
  component.removeAllProperties("attendee");
  for (const person of people.attendees) {
    const address = `mailto:${person.email.toLowerCase()}`;
    const attendee = previous.get(address) || new ICAL.Property("attendee");
    attendee.setValue(address);
    attendee.setParameter("cn", person.name.replace(/[\r\n]/g, " ").slice(0, 200));
    attendee.setParameter("x-ea-user-id", String(person.userId));
    if (!previous.has(address)) attendee.setParameter("partstat", "NEEDS-ACTION");
    attendee.setParameter("rsvp", "FALSE");
    component.addProperty(attendee);
  }
}

export function bindingFingerprint(credentials: CalendarCredentials) {
  const identity = [process.env.NEXTCLOUD_BASE_URL, credentials.userId, credentials.username, credentials.calendarName];
  if (credentials.grantId) identity.push(credentials.grantId);
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function writeResourceId(userId: number, draftId: string) {
  return `ea-event-${createHash("sha256").update(`${userId}:${draftId}`).digest("hex")}.ics`;
}

export function eventIcs(input: Exclude<CalendarWrite, { action: "delete" }>["event"], uid: string, draftId: string, existing?: string, people?: Pick<MeetingPayload, "organizer" | "attendees">): string {
  const calendar = existing ? new ICAL.Component(ICAL.parse(existing)) : new ICAL.Component(["vcalendar", [], []]);
  calendar.updatePropertyWithValue("version", "2.0");
  calendar.updatePropertyWithValue("prodid", "-//Employee Agent//Personal Calendar//ZH");
  const component = existing ? calendar.getFirstSubcomponent("vevent")! : new ICAL.Component("vevent");
  const event = new ICAL.Event(component);
  event.uid = uid;
  event.summary = input.title;
  event.location = input.location;
  const utc = (value: string) => ICAL.Time.fromJSDate(new Date(value), true);
  event.startDate = input.time.type === "allDay" ? ICAL.Time.fromDateString(input.time.start) : utc(input.time.start);
  event.endDate = input.time.type === "allDay" ? ICAL.Time.fromDateString(input.time.end) : utc(input.time.end);
  component.removeAllProperties("duration");
  component.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  component.updatePropertyWithValue("x-ea-operation-id", draftId);
  if (people) setEventParticipants(component, people);
  if (existing) component.updatePropertyWithValue("sequence", Number(component.getFirstPropertyValue("sequence") || 0) + 1);
  if (!existing) calendar.addSubcomponent(component);
  return calendar.toString();
}

function isApplied(raw: string, operation: Exclude<CalendarWrite, { action: "delete" }>, draftId: string) {
  const calendar = new ICAL.Component(ICAL.parse(raw));
  const components = calendar.getAllSubcomponents("vevent");
  if (components.length !== 1) return false;
  const component = components[0];
  const event = new ICAL.Event(component);
  if (component.getFirstPropertyValue("x-ea-operation-id") !== draftId) return false;
  if (operation.participantIds !== undefined) {
    const actual = component.getAllProperties("attendee").map(p => Number(p.getParameter("x-ea-user-id"))).sort((a, b) => a - b);
    if (JSON.stringify(actual) !== JSON.stringify([...operation.participantIds].sort((a, b) => a - b))) return false;
  }
  const { time } = operation.event;
  const start = event.startDate; const end = event.endDate;
  return event.summary === operation.event.title && (event.location || "") === operation.event.location
    && start.isDate === (time.type === "allDay")
    && (time.type === "allDay" ? start.toString() === time.start && end.toString() === time.end
      : start.toJSDate().getTime() === Math.floor(Date.parse(time.start) / 1000) * 1000 && end.toJSDate().getTime() === Math.floor(Date.parse(time.end) / 1000) * 1000);
}

export async function executeCalendarWrite(userId: number, credentials: CalendarCredentials, draftId: string, input: CalendarWrite, transport: typeof fetch = fetch, reconcileOnly = false) {
  if (credentials.userId !== userId || !credentials.writeEnabled) throw new TRPCError({ code: "FORBIDDEN", message: "本人日历写入未授权" });
  const operation = calendarWriteSchema.parse(input);
  if (operation.action !== "delete" && operation.participantIds) operation.participantIds = operation.participantIds.filter(id => id !== userId);
  const base = process.env.NEXTCLOUD_BASE_URL;
  if (!base) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "日程系统未配置" });
  const collection = calendarUrl(base, credentials.username, credentials.calendarName);
  const resourceId = operation.action === "create" ? writeResourceId(userId, draftId) : operation.resourceId;
  const url = new URL(resourceId, collection).toString();
  const request = (method: string, headers: Record<string, string> = {}, body?: string) => transport(url, {
    method, headers: { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.appPassword}`).toString("base64")}`, ...headers },
    body, redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  try {
    const current = await request("GET");
    if (current.status !== 404 && !current.ok) throw new Error("Read failed");
    const raw = current.ok ? await current.text() : null;
    if (operation.action !== "delete" && raw && isApplied(raw, operation, draftId)) return { resourceId, reconciled: true };
    if (operation.action === "delete" && current.status === 404) return { resourceId, reconciled: true };
    if (reconcileOnly) throw new TRPCError({ code: "TIMEOUT", message: "已过期操作尚未查到成功回执，仅核对结果，不再执行写入" });
    if (operation.action === "create" && raw) throw new TRPCError({ code: "CONFLICT", message: "创建标识已占用，请重新生成草稿" });
    if (operation.action !== "create") {
      if (!raw || current.headers.get("etag") !== operation.version) throw new TRPCError({ code: "CONFLICT", message: "日程已被更改，请刷新后重新确认" });
      const component = new ICAL.Component(ICAL.parse(raw));
      const events = component.getAllSubcomponents("vevent");
      if (events.length !== 1 || ["rrule", "rdate", "recurrence-id"].some(name => events[0].hasProperty(name))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "重复日程请在日历系统中编辑" });
      }
      const organizer = events[0].getFirstPropertyValue("organizer");
      if (organizer) {
        const binding = await getCalendarBinding(userId);
        if (!binding?.calendarEmail || String(organizer).toLowerCase() !== `mailto:${binding.calendarEmail.toLowerCase()}`) throw new TRPCError({ code: "FORBIDDEN", message: "只有组织者可以修改或取消这项日程" });
      }
      if (operation.action === "delete" && new ICAL.Event(events[0]).summary !== operation.title) throw new TRPCError({ code: "CONFLICT", message: "日程标题已变化，请重新确认取消" });
    }
    if (operation.action !== "delete") {
      const time = operation.event.time;
      if (time.type === "allDay") {
        if (!credentials.timeZone) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先保存本人日历时区，再创建或修改全天日程" });
        const starts = wallInstants(time.start, 0, credentials.timeZone); const ends = wallInstants(time.end, 0, credentials.timeZone);
        if (!starts.length || !ends.length) throw new TRPCError({ code: "BAD_REQUEST", message: "所选日期在本人时区没有有效午夜边界" });
      }
      // Saving an explicit schedule does not require a free/busy negotiation.
    }
    let response: Response;
    if (operation.action === "delete") response = await request("DELETE", { "if-match": operation.version });
    else {
      const uid = operation.action === "create" ? resourceId.slice(0, -4) : new ICAL.Event(new ICAL.Component(ICAL.parse(raw!)).getFirstSubcomponent("vevent")!).uid;
      let ids = operation.participantIds;
      if (ids === undefined && raw) {
        const attendees = new ICAL.Component(ICAL.parse(raw)).getFirstSubcomponent("vevent")!.getAllProperties("attendee");
        if (attendees.length) {
          const addresses = attendees.map(p => String(p.getFirstValue()).replace(/^mailto:/i, "").toLowerCase());
          const known = await calendarPeopleByEmail(addresses);
          if (addresses.some(email => !known.some(p => p.email?.toLowerCase() === email))) throw new TRPCError({ code: "FORBIDDEN", message: "日程包含无法匹配的参与人，请重新选择组织成员" });
          ids = known.map(p => p.userId);
        }
      }
      const people = ids !== undefined && (ids.length || raw?.includes("ORGANIZER")) ? await resolveCalendarParticipants(userId, ids) : undefined;
      response = await request("PUT", { "content-type": "text/calendar; charset=utf-8", ...(operation.action === "create" ? { "if-none-match": "*" } : { "if-match": operation.version }) }, eventIcs(operation.event, uid, draftId, operation.action === "update" ? raw! : undefined, people));
    }
    if (response.status === 412) throw new TRPCError({ code: "CONFLICT", message: "日程版本发生变化，请刷新后核对结果" });
    if (!response.ok) throw new Error("Write result unknown");
    return { resourceId, reconciled: false };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: "BAD_GATEWAY", message: "写入结果尚未确认，请保留草稿并重试核对，勿重复创建" });
  }
}
