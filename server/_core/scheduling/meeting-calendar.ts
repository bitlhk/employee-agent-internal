import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { fetchCalendarObjects } from "tsdav";
import { TRPCError } from "@trpc/server";
import type { MeetingPayload } from "../../../shared/scheduling";
import { calendarUrl, type CalendarCredentials } from "./calendar";
import { eventIcs, setEventParticipants } from "./write-calendar";

export function meetingUid(id: string) { return `ea-meeting-${createHash("sha256").update(id).digest("hex")}`; }
const address = (email: string) => `mailto:${email.toLowerCase()}`;
export function meetingIcs(id: string, payload: MeetingPayload) {
  const calendar = new ICAL.Component(ICAL.parse(eventIcs(payload.event, meetingUid(id), id)));
  const component = calendar.getFirstSubcomponent("vevent")!;
  component.updatePropertyWithValue("sequence", 0);
  setEventParticipants(component, payload);
  return calendar.toString();
}

function ownerTransport(userId: number, credentials: CalendarCredentials, transport: typeof fetch) {
  if (userId !== credentials.userId) throw new TRPCError({ code: "FORBIDDEN", message: "只能访问本人会议日历" });
  const base = process.env.NEXTCLOUD_BASE_URL;
  if (!base) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "日程系统未配置" });
  const collection = calendarUrl(base, credentials.username, credentials.calendarName);
  const scoped: typeof fetch = async (input, options) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, collection);
    const decoded = decodeURIComponent(target.pathname);
    if (target.origin !== new URL(collection).origin || !target.pathname.startsWith(new URL(collection).pathname) || decoded.split("/").some(part => [".", ".."].includes(part))) throw new Error("Meeting request outside owner scope");
    const response = await transport(target, { ...options, headers: { ...options?.headers, authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.appPassword}`).toString("base64")}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.status === 207 && /HTTP\/\d(?:\.\d)?\s+[345]\d\d/.test(await response.clone().text())) throw new Error("Incomplete calendar result");
    return response;
  };
  return { collection, scoped };
}

export async function loadOwnMeeting(userId: number, credentials: CalendarCredentials, id: string, transport: typeof fetch = fetch) {
  const { collection, scoped } = ownerTransport(userId, credentials, transport);
  const uid = meetingUid(id);
  const objects = await fetchCalendarObjects({ calendar: { url: collection }, expand: false, useMultiGet: false, fetch: scoped,
    filters: { "comp-filter": { _attributes: { name: "VCALENDAR" }, "comp-filter": { _attributes: { name: "VEVENT" }, "prop-filter": { _attributes: { name: "UID" }, "text-match": { _attributes: { collation: "i;octet" }, _text: uid } } } } },
  });
  if (!objects.length) return null;
  if (objects.length !== 1 || !objects[0].etag || typeof objects[0].data !== "string") throw new Error("Ambiguous meeting calendar result");
  const calendar = new ICAL.Component(ICAL.parse(objects[0].data));
  const components = calendar.getAllSubcomponents("vevent");
  if (components.length !== 1 || new ICAL.Event(components[0]).uid !== uid) throw new Error("Meeting identity mismatch");
  const resource = new URL(objects[0].url, collection);
  if (resource.origin !== new URL(collection).origin || !resource.pathname.startsWith(new URL(collection).pathname)) throw new Error("Meeting outside owner calendar");
  return { calendar, component: components[0], url: resource.toString(), version: objects[0].etag };
}

export function matchesMeeting(component: ICAL.Component, payload: MeetingPayload) {
  const event = new ICAL.Event(component); const time = payload.event.time;
  const attendees = component.getAllProperties("attendee").map(prop => String(prop.getFirstValue()).toLowerCase()).sort();
  return !["rrule", "rdate", "recurrence-id"].some(name => component.hasProperty(name))
    && event.summary === payload.event.title && (event.location || "") === payload.event.location
    && String(component.getFirstPropertyValue("organizer")).toLowerCase() === address(payload.organizer.email)
    && JSON.stringify(attendees) === JSON.stringify(payload.attendees.map(person => address(person.email)).sort())
    && (time.type === "timed" ? event.startDate.zone.tzid === "UTC" && event.endDate.zone.tzid === "UTC" && event.startDate.toJSDate().getTime() === Math.floor(Date.parse(time.start) / 1000) * 1000 && event.endDate.toJSDate().getTime() === Math.floor(Date.parse(time.end) / 1000) * 1000
      : event.startDate.isDate && event.endDate.isDate && event.startDate.toString() === time.start && event.endDate.toString() === time.end);
}

export async function createOwnMeeting(userId: number, credentials: CalendarCredentials, id: string, payload: MeetingPayload, transport: typeof fetch = fetch) {
  if (userId !== payload.organizer.userId || !credentials.writeEnabled || credentials.username !== payload.organizer.username) throw new TRPCError({ code: "FORBIDDEN", message: "会议发起人写入权限不可用" });
  const { collection, scoped } = ownerTransport(userId, credentials, transport);
  const existing = await loadOwnMeeting(userId, credentials, id, transport);
  if (existing) {
    if (!matchesMeeting(existing.component, payload)) throw new TRPCError({ code: "CONFLICT", message: "会议内容已变化，请在日历系统核对" });
    return { reconciled: true };
  }
  const response = await scoped(new URL(`${meetingUid(id)}.ics`, collection), { method: "PUT", headers: { "content-type": "text/calendar; charset=utf-8", "if-none-match": "*" }, body: meetingIcs(id, payload) });
  if (!response.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: "会议写入结果未确认，请核对原草稿，不要重复创建" });
  return { reconciled: false };
}

export async function cancelOwnMeeting(userId: number, credentials: CalendarCredentials, id: string, payload: MeetingPayload, transport: typeof fetch = fetch) {
  if (userId !== payload.organizer.userId || !credentials.writeEnabled || credentials.username !== payload.organizer.username) throw new TRPCError({ code: "FORBIDDEN", message: "只能取消本人发起的会议" });
  const current = await loadOwnMeeting(userId, credentials, id, transport);
  if (!current) return;
  if (!matchesMeeting(current.component, payload)) throw new TRPCError({ code: "CONFLICT", message: "会议内容已在日历系统变化，请在那里核对后取消" });
  const { scoped } = ownerTransport(userId, credentials, transport);
  const result = await scoped(current.url, { method: "DELETE", headers: { "if-match": current.version } });
  if (result.status === 412) throw new TRPCError({ code: "CONFLICT", message: "会议版本已变化，请刷新后取消" });
  if (!result.ok && result.status !== 404) throw new TRPCError({ code: "BAD_GATEWAY", message: "取消结果未确认，请刷新核对" });
}

export async function rescheduleOwnMeeting(userId: number, credentials: CalendarCredentials, id: string, operationId: string, previous: MeetingPayload, next: MeetingPayload, version: string, transport: typeof fetch = fetch) {
  if (userId !== previous.organizer.userId || !credentials.writeEnabled || credentials.username !== previous.organizer.username || JSON.stringify(previous.organizer) !== JSON.stringify(next.organizer)) throw new TRPCError({ code: "FORBIDDEN", message: "改期只能由原发起人进行，不能改变组织者" });
  const current = await loadOwnMeeting(userId, credentials, id, transport);
  if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "原会议已不存在" });
  if (matchesMeeting(current.component, next) && current.component.getFirstPropertyValue("x-ea-operation-id") === operationId) return { reconciled: true };
  if (!matchesMeeting(current.component, previous) || current.version !== version) throw new TRPCError({ code: "CONFLICT", message: "原会议版本已变化，请重新准备改期" });
  const calendar = new ICAL.Component(ICAL.parse(eventIcs(next.event, meetingUid(id), operationId, current.calendar.toString())));
  const component = calendar.getFirstSubcomponent("vevent")!;
  component.updatePropertyWithValue("sequence", Number(current.component.getFirstPropertyValue("sequence") || 0) + 1);
  setEventParticipants(component, next);
  const { scoped } = ownerTransport(userId, credentials, transport);
  const response = await scoped(current.url, { method: "PUT", headers: { "content-type": "text/calendar; charset=utf-8", "if-match": version }, body: calendar.toString() });
  if (response.status === 412) throw new TRPCError({ code: "CONFLICT", message: "会议版本已变化，请重新准备改期" });
  if (!response.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: "改期结果未知，请核对原操作，不要新建会议" });
  return { reconciled: false };
}
