import { assertCoopParticipants } from "../../db/coop-identity";
import mysql from "mysql2/promise";
import { TRPCError } from "@trpc/server";
import { meetingPayloadSchema, directMeetingSchema } from "../../../shared/scheduling";
import { getCalendarBinding, getCalendarCredentials, getSchedulingPerson, resolveCalendarParticipants } from "../../db/scheduling";
import { createMeetingDraft, getMeeting, listMeetingRecords, listParticipantMeetingRecords, updateMeeting } from "../../db/calendar-meetings";
import { cancelCoordination } from "../../db/calendar-coordination";
import { getCoordinationView } from "./coordination-service";
import { bindingFingerprint } from "./write-calendar";
import { createOwnMeeting, loadOwnMeeting, cancelOwnMeeting } from "./meeting-calendar";
import { recordAuditRequired } from "../audit-events";

export async function prepareMeeting(userId: number, coordinationId: string, slotIndex: number, location: string) {
  const view = await getCoordinationView(userId, coordinationId);
  if (!view.commonIndices.includes(slotIndex)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该候选时间尚未得到所有人的可用回复" });
  await assertCoopParticipants(userId, view.members.filter(person => person.userId !== userId).map(person => person.userId));
  const credentials = await getCalendarCredentials(userId);
  if (!credentials?.writeEnabled) throw new TRPCError({ code: "FORBIDDEN", message: "本人日历写入未授权" });
  const people = await Promise.all(view.members.map(member => getSchedulingPerson(member.userId)));
  if (people.some(person => !person?.enabled || !person.email)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请管理员为所有参会人配置日历邀请地址" });
  const organizer = people.find(person => person!.userId === userId)!;
  const participant = (person: NonNullable<typeof organizer>) => ({ userId: person.userId, name: person.name || `人员${person.userId}`, username: person.username, email: person.email });
  const slot = view.slots[slotIndex];
  if (Date.parse(slot.start) <= Date.now()) throw new TRPCError({ code: "BAD_REQUEST", message: "请选择未来的会议时间" });
  const payload = meetingPayloadSchema.parse({ event: { title: view.title, location, time: { type: "timed", ...slot } }, organizer: participant(organizer), attendees: people.filter(person => person!.userId !== userId).map(person => participant(person!)) });
  const meetingId = await createMeetingDraft(userId, coordinationId, payload, bindingFingerprint(credentials));
  return { meetingId, confirmationUrl: "/calendar" };
}

export async function confirmMeeting(userId: number, id: string) {
  const connection = await mysql.createConnection(process.env.DATABASE_URL!);
  const locks: string[] = [];
  try {
    const record = await getMeeting(id);
    if (!record || record.creatorUserId !== userId) throw new TRPCError({ code: "NOT_FOUND", message: "会议草稿不存在" });
    const payload = meetingPayloadSchema.parse(record.payload);
    for (const personId of [userId]) {
      const lock = `calendar-write:${personId}`;
      const [rows] = await connection.query<Array<{ acquired: number } & mysql.RowDataPacket>>("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
      if (rows[0]?.acquired !== 1) throw new TRPCError({ code: "CONFLICT", message: "参会人的日历正在更新，请稍后确认" });
      locks.push(lock);
    }
    if (record.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "会议已取消" });
    if (record.status === "invited") return { status: "invited" as const };
    const credentials = await getCalendarCredentials(userId);
    if (!credentials?.writeEnabled || bindingFingerprint(credentials) !== record.bindingFingerprint) throw new TRPCError({ code: "FORBIDDEN", message: "发起人日历授权或绑定已变化" });
    const existing = await loadOwnMeeting(userId, credentials, id);
    if (existing) {
      await createOwnMeeting(userId, credentials, id, payload);
      await recordAuditRequired({ action: "calendar.meeting.reconciled", actorType: "user", actorUserId: userId, targetType: "calendar_meeting", targetId: id });
      await updateMeeting(id, userId, { status: "invited" });
      return { status: "invited" as const };
    }
    if (record.expiresAt.getTime() <= Date.now()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "会议草稿已过期，请重新准备" });
    if (Date.parse(payload.event.time.start) <= Date.now()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "会议时间已经开始，请重新准备" });
    await assertCoopParticipants(userId, payload.attendees.map(person => person.userId));
    // Validate directory metadata, not another person's credentials or calendar.
    for (const person of [payload.organizer, ...payload.attendees]) {
      const current = await getSchedulingPerson(person.userId);
      if (!current?.enabled || current.username !== person.username || current.email !== person.email) throw new TRPCError({ code: "FORBIDDEN", message: "参会人账号或授权已变化，请重新准备" });
    }
    await recordAuditRequired({ action: "calendar.meeting.confirmed", actorType: "user", actorUserId: userId, targetType: "calendar_meeting", targetId: id });
    await updateMeeting(id, userId, { status: "creating" });
    try {
      await createOwnMeeting(userId, credentials, id, payload);
      await recordAuditRequired({ action: "calendar.meeting.created", actorType: "user", actorUserId: userId, targetType: "calendar_meeting", targetId: id });
      await updateMeeting(id, userId, { status: "invited" });
    } catch (error) { await updateMeeting(id, userId, { status: "unknown" }); throw error; }
    return { status: "invited" as const };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: "BAD_GATEWAY", message: "会议执行未完成，请刷新核对原草稿和日历连接" });
  } finally {
    for (const lock of locks.reverse()) await connection.query("SELECT RELEASE_LOCK(?)", [lock]).catch(() => undefined);
    await connection.end();
  }
}

export async function listMeetings(userId: number) {
  const records = [...await listMeetingRecords(userId), ...await listParticipantMeetingRecords(userId)];
  const unique = [...new Map(records.map(record => [record.id, record])).values()];
  return Promise.all(unique.map(async record => {
    const payload = meetingPayloadSchema.parse(record.payload);
    const isOrganizer = record.creatorUserId === userId;
    const member = isOrganizer ? payload.organizer : payload.attendees.find(person => person.userId === userId);
    if (!member) throw new TRPCError({ code: "FORBIDDEN", message: "会议成员不匹配" });
    let synced = false;
    if (["invited", "unknown"].includes(record.status)) {
      try {
        const credentials = await getCalendarCredentials(userId);
        const binding = await getCalendarBinding(userId);
        if (credentials && credentials.username === member.username && binding?.calendarEmail === member.email) {
          const own = await loadOwnMeeting(userId, credentials, record.id);
          if (own) synced = true;
        }
      } catch { /* Unknown is visible, never pretend an invitation was accepted. */ }
    }
    return { id: record.id, coordinationId: isOrganizer ? record.coordinationId : null, status: record.status, event: payload.event, isOrganizer, synced, expiresAt: record.expiresAt,
      attendees: payload.attendees.map(person => ({ userId: person.userId, name: person.name })) };
  }));
}

export async function cancelMeeting(userId: number, id: string) {
  const connection = await mysql.createConnection(process.env.DATABASE_URL!);
  const lock = `calendar-write:${userId}`; let acquired = false;
  try {
    const [rows] = await connection.query<Array<{ acquired: number } & mysql.RowDataPacket>>("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    acquired = rows[0]?.acquired === 1;
    if (!acquired) throw new TRPCError({ code: "CONFLICT", message: "会议正在更新，请稍后重试" });
    const record = await getMeeting(id);
    if (!record || record.creatorUserId !== userId) throw new TRPCError({ code: "NOT_FOUND", message: "会议不存在" });
    if (["creating", "invited", "unknown"].includes(record.status)) {
      const credentials = await getCalendarCredentials(userId);
      if (!credentials || bindingFingerprint(credentials) !== record.bindingFingerprint) throw new TRPCError({ code: "FORBIDDEN", message: "日历绑定或授权已变化" });
      await recordAuditRequired({ action: "calendar.meeting.cancel.confirmed", actorType: "user", actorUserId: userId, targetType: "calendar_meeting", targetId: id });
      await cancelOwnMeeting(userId, credentials, id, meetingPayloadSchema.parse(record.payload));
    }
    if (record.checkCoordinationId) await cancelCoordination(record.checkCoordinationId, userId);
    await updateMeeting(id, userId, { status: "cancelled" });
    return { success: true };
  } finally { if (acquired) await connection.query("SELECT RELEASE_LOCK(?)", [lock]).catch(() => undefined); await connection.end(); }
}

export async function prepareDirectMeeting(userId: number, raw: unknown) {
  const input = directMeetingSchema.parse(raw);
  const people = await resolveCalendarParticipants(userId, input.participantIds);
  const credentials = await getCalendarCredentials(userId);
  if (!credentials?.writeEnabled) throw new TRPCError({ code: "FORBIDDEN", message: "本人日历写入未授权" });
  const payload = meetingPayloadSchema.parse({ event: input.event, ...people });
  const meetingId = await createMeetingDraft(userId, null, payload, bindingFingerprint(credentials), input.requestKey);
  return { meetingId, confirmationUrl: "/calendar" };
}
