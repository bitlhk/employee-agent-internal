import { assertCoopParticipants } from "../../db/coop-identity";
import { TRPCError } from "@trpc/server";
import mysql from "mysql2/promise";
import {
  calendarWriteSchema,
  type CalendarWrite,
} from "../../../shared/scheduling";
import { getCalendarCredentials } from "../../db/scheduling";
import {
  createCalendarDraft,
  getCalendarDraft,
  claimCalendarDraft,
  finishCalendarDraft,
} from "../../db/calendar-drafts";
import { recordAuditRequired } from "../audit-events";
import { bindingFingerprint, executeCalendarWrite } from "./write-calendar";

export async function prepareCalendarWrite(
  userId: number,
  input: CalendarWrite,
  operationId?: string
) {
  const operation = calendarWriteSchema.parse(input);
  operationId = operationId || operation.operationId;
  if (operation.action !== "delete" && operation.participantIds)
    operation.participantIds = operation.participantIds.filter(
      id => id !== userId
    );
  if (operation.action !== "delete" && operation.participantIds)
    await assertCoopParticipants(userId, operation.participantIds);
  const credentials = await getCalendarCredentials(userId);
  if (!credentials?.writeEnabled)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "请管理员启用本人日历写入权限",
    });
  if (!process.env.NEXTCLOUD_BASE_URL)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "日程系统尚未配置",
    });
  const draftId = operationId
    ? await createCalendarDraft(
        userId,
        bindingFingerprint(credentials),
        operation,
        operationId
      )
    : await createCalendarDraft(
        userId,
        bindingFingerprint(credentials),
        operation
      );
  return { draftId, confirmationUrl: "/calendar" };
}

// Serialize writes to this owner across platform processes; CalDAV ETags guard external edits.
export async function confirmCalendarWrite(userId: number, draftId: string) {
  const connection = await mysql.createConnection(process.env.DATABASE_URL!);
  const lock = `calendar-write:${userId}`;
  let acquired = false;
  try {
    const [rows] = await connection.query<
      Array<{ acquired: number } & mysql.RowDataPacket>
    >("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    acquired = rows[0]?.acquired === 1;
    if (!acquired)
      throw new TRPCError({
        code: "CONFLICT",
        message: "本人日历正在更新，请稍后重试",
      });
    const draft = await getCalendarDraft(userId, draftId);
    if (!draft)
      throw new TRPCError({ code: "NOT_FOUND", message: "草稿不存在" });
    if (draft.status === "completed") return { completed: true };
    if (
      draft.status === "cancelled" ||
      (draft.status === "pending" && draft.expiresAt.getTime() <= Date.now())
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "草稿已取消或过期，请重新确认",
      });
    const credentials = await getCalendarCredentials(userId);
    if (
      !credentials?.writeEnabled ||
      bindingFingerprint(credentials) !== draft.bindingFingerprint
    )
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "日历授权或账号已变化，请重新生成草稿",
      });
    if (!(await claimCalendarDraft(userId, draftId)))
      throw new TRPCError({
        code: "CONFLICT",
        message: "草稿正在执行，请稍后核对",
      });
    let calendarApplied = false;
    try {
      await recordAuditRequired({
        action: "calendar.write.confirmed",
        actorType: "user",
        actorUserId: userId,
        targetType: "calendar_draft",
        targetId: draftId,
      });
      const receipt =
        draft.expiresAt.getTime() <= Date.now()
          ? await executeCalendarWrite(
              userId,
              credentials,
              draftId,
              calendarWriteSchema.parse(draft.payload),
              fetch,
              true
            )
          : await executeCalendarWrite(
              userId,
              credentials,
              draftId,
              calendarWriteSchema.parse(draft.payload)
            );
      calendarApplied = true;
      await recordAuditRequired({
        action: "calendar.write.completed",
        actorType: "user",
        actorUserId: userId,
        targetType: "calendar_draft",
        targetId: draftId,
        metadata: receipt,
      });
      const operation = calendarWriteSchema.parse(draft.payload);
      if (
        operation.action !== "create" &&
        operation.resourceId.startsWith("ea-meeting-")
      ) {
        const { getMeetingByResource, updateMeeting } = await import(
          "../../db/calendar-meetings"
        );
        const meeting = await getMeetingByResource(
          userId,
          operation.resourceId
        );
        if (meeting) {
          if (operation.action === "delete")
            await updateMeeting(meeting.id, userId, { status: "cancelled" });
          else {
            const { meetingPayloadSchema } = await import(
              "../../../shared/scheduling"
            );
            const { getSchedulingPerson } = await import("../../db/scheduling");
            const { stableToolInputHash } = await import("../tool-governance");
            const previous = meetingPayloadSchema.parse(meeting.payload);
            // The calendar write (or its reconciled receipt) already checked membership.
            // Synchronizing local metadata must not turn a successful write into a
            // rejection if organization permissions change before this step.
            const attendees =
              operation.participantIds === undefined
                ? previous.attendees
                : await Promise.all(
                    operation.participantIds.map(async id => {
                      const person = await getSchedulingPerson(id);
                      if (!person?.email) {
                        const existing = previous.attendees.find(
                          person => person.userId === id
                        );
                        if (existing) return existing;
                        throw new Error("已写入日历，参与人信息仍待核对");
                      }
                      return {
                        userId: id,
                        name: person.name || `成员${id}`,
                        username: person.username,
                        email: person.email,
                      };
                    })
                  );
            const people = { organizer: previous.organizer, attendees };
            const payload = meetingPayloadSchema.parse({
              ...people,
              event: operation.event,
            });
            await updateMeeting(meeting.id, userId, {
              payload,
              payloadHash: stableToolInputHash(payload),
            });
          }
        }
      }
      await finishCalendarDraft(userId, draftId, "completed");
      return { completed: true };
    } catch (error) {
      const rejected =
        error instanceof TRPCError &&
        [
          "CONFLICT",
          "FORBIDDEN",
          "BAD_REQUEST",
          "PRECONDITION_FAILED",
        ].includes(error.code);
      await finishCalendarDraft(
        userId,
        draftId,
        rejected && !calendarApplied ? "cancelled" : "unknown"
      );
      throw error;
    }
  } finally {
    if (acquired)
      await connection
        .query("SELECT RELEASE_LOCK(?)", [lock])
        .catch(() => undefined);
    await connection.end();
  }
}
