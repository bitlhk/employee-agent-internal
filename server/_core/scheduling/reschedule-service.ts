import { assertCoopParticipants } from "../../db/coop-identity";
import mysql from "mysql2/promise";
import { TRPCError } from "@trpc/server";
import { meetingPayloadSchema, personalEventSchema } from "../../../shared/scheduling";
import { getMeeting, updateMeeting } from "../../db/calendar-meetings";
import { getCalendarCredentials, getSchedulingPerson } from "../../db/scheduling";
import { getReschedule, saveReschedule, updateReschedule, cancelReschedule } from "../../db/calendar-reschedules";
import { bindingFingerprint } from "./write-calendar";
import { loadOwnMeeting, matchesMeeting, rescheduleOwnMeeting } from "./meeting-calendar";
import { recordAuditRequired } from "../audit-events";
import { stableToolInputHash } from "../tool-governance";
import { cancelCoordination } from "../../db/calendar-coordination";

export async function cancelRescheduleRequest(userId: number, id: string) {
  const connection = await mysql.createConnection(process.env.DATABASE_URL!); const lock = `calendar-write:${userId}`; let acquired = false;
  try {
    const [rows] = await connection.query<Array<{ acquired: number } & mysql.RowDataPacket>>("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    acquired = rows[0]?.acquired === 1;
    if (!acquired) throw new TRPCError({ code: "CONFLICT", message: "改期正在执行，请稍后核对" });
    const draft = await getReschedule(userId, id);
    if (!draft || !["pending", "checking"].includes(draft.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "改期不能直接撤回，请先核对执行结果" });
    await recordAuditRequired({ action: "calendar.meeting.reschedule.cancelled", actorType: "user", actorUserId: userId, targetType: "calendar_reschedule", targetId: id });
    const cancelled = await cancelReschedule(userId, id);
    if (draft.checkCoordinationId) await cancelCoordination(draft.checkCoordinationId, userId);
    return { cancelled };
  } finally { if (acquired) await connection.query("SELECT RELEASE_LOCK(?)", [lock]).catch(() => undefined); await connection.end(); }
}

export async function prepareReschedule(userId: number, id: string, raw: unknown, cascadeId?: string, operationId?: string) {
  const event = personalEventSchema.parse(raw);
  if (operationId) {
    const existing = await getReschedule(userId, operationId);
    if (existing) {
      if (existing.meetingId !== id || stableToolInputHash(meetingPayloadSchema.parse(existing.payload).event) !== stableToolInputHash(event) || (existing.cascadeId || undefined) !== cascadeId) throw new Error("不能将同一操作编号用于不同改期");
      return { draftId: existing.id, confirmationUrl: "/calendar" };
    }
  }
  if (event.time.type !== "timed" || Date.parse(event.time.start) <= Date.now()) throw new TRPCError({ code: "BAD_REQUEST", message: "会议改期需要未来的具体时段" });
  const meeting = await getMeeting(id);
  if (!meeting || meeting.creatorUserId !== userId || meeting.status !== "invited") throw new TRPCError({ code: "NOT_FOUND", message: "只能改期自己发起的已邀请会议" });
  const previous = meetingPayloadSchema.parse(meeting.payload);
  await assertCoopParticipants(userId, previous.attendees.map(person => person.userId));
  const credentials = await getCalendarCredentials(userId);
  if (!credentials?.writeEnabled || bindingFingerprint(credentials) !== meeting.bindingFingerprint) throw new TRPCError({ code: "FORBIDDEN", message: "本人日历写入授权或绑定已变化" });
  const current = await loadOwnMeeting(userId, credentials, id);
  if (!current || !matchesMeeting(current.component, previous)) throw new TRPCError({ code: "CONFLICT", message: "原会议内容已变化，请核对日历" });
  const payload = meetingPayloadSchema.parse({ ...previous, event });
  const draftId = operationId ? await saveReschedule(userId, id, previous, payload, current.version, bindingFingerprint(credentials), cascadeId, operationId) : cascadeId ? await saveReschedule(userId, id, previous, payload, current.version, bindingFingerprint(credentials), cascadeId) : await saveReschedule(userId, id, previous, payload, current.version, bindingFingerprint(credentials));
  return { draftId, confirmationUrl: "/calendar" };
}

export async function confirmReschedule(userId: number, id: string, cascade?: { cascadeId: string; leaseToken: string; reconcileOnly?: boolean }) {
  const connection = await mysql.createConnection(process.env.DATABASE_URL!); const locks: string[] = [];
  try {
    const record = await getReschedule(userId, id);
    if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "改期草稿不存在" });
    if (record.cascadeId) {
      if (!cascade || cascade.cascadeId !== record.cascadeId) throw new TRPCError({ code: "FORBIDDEN", message: "请通过级联方案整体确认该步骤" });
      const { validateCascadeExecution } = await import("../../db/calendar-cascades");
      await validateCascadeExecution(userId, id, record.cascadeId, cascade.leaseToken);
    }
    if (record.status === "completed") return { status: "completed" as const };
    if (record.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "改期已取消" });
    const previous = meetingPayloadSchema.parse(record.previous); const payload = meetingPayloadSchema.parse(record.payload);
    for (const personId of [userId]) {
      const lock = `calendar-write:${personId}`;
      const [rows] = await connection.query<Array<{ acquired: number } & mysql.RowDataPacket>>("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
      if (rows[0]?.acquired !== 1) throw new TRPCError({ code: "CONFLICT", message: "参会人日历正在更新，请稍后重试" });
      locks.push(lock);
    }
    const meeting = await getMeeting(record.meetingId); const credentials = await getCalendarCredentials(userId);
    if (!meeting || meeting.creatorUserId !== userId || meeting.status !== "invited") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "原会议已取消或不可改期" });
    if (!credentials?.writeEnabled || bindingFingerprint(credentials) !== record.bindingFingerprint) throw new TRPCError({ code: "FORBIDDEN", message: "本人日历绑定或授权已变化" });
    const current = await loadOwnMeeting(userId, credentials, meeting.id);
    if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "原会议已不存在" });
    const reconciled = matchesMeeting(current.component, payload) && current.component.getFirstPropertyValue("x-ea-operation-id") === id;
    if (!reconciled) {
      if (cascade?.reconcileOnly) throw new TRPCError({ code: "TIMEOUT", message: "方案已停止，仅核对已发出的改期结果，不再写入" });
      if (record.expiresAt.getTime() <= Date.now() || Date.parse(payload.event.time.start) <= Date.now()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "改期草稿已过期，请重新准备" });
      if (!matchesMeeting(current.component, previous) || current.version !== record.version || stableToolInputHash(meeting.payload) !== stableToolInputHash(previous)) throw new TRPCError({ code: "CONFLICT", message: "原会议版本已变化，请重新准备改期" });
      await assertCoopParticipants(userId, payload.attendees.map(person => person.userId));
      for (const person of [payload.organizer, ...payload.attendees]) {
        const binding = await getSchedulingPerson(person.userId);
        if (!binding?.enabled || binding.email !== person.email || binding.username !== person.username) throw new TRPCError({ code: "FORBIDDEN", message: "参会人授权或账号已变化" });
      }
      await recordAuditRequired({ action: "calendar.meeting.reschedule.confirmed", actorType: "user", actorUserId: userId, targetType: "calendar_meeting", targetId: meeting.id });
      await updateReschedule(userId, id, { status: "executing" });
      try { await rescheduleOwnMeeting(userId, credentials, meeting.id, id, previous, payload, record.version); }
      catch (error) { await updateReschedule(userId, id, { status: "unknown" }); throw error; }
    }
    await recordAuditRequired({ action: "calendar.meeting.rescheduled", actorType: "user", actorUserId: userId, targetType: "calendar_meeting", targetId: meeting.id });
    await updateMeeting(meeting.id, userId, { payload, payloadHash: stableToolInputHash(payload) });
    await updateReschedule(userId, id, { status: "completed" });
    return { status: "completed" as const };
  } finally { for (const lock of locks.reverse()) await connection.query("SELECT RELEASE_LOCK(?)", [lock]).catch(() => undefined); await connection.end(); }
}
