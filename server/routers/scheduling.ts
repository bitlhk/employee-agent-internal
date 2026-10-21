import { assertCoopMember } from "../db/coop-identity";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicCascade, confirmCascade, stopCascade } from "../_core/scheduling/cascade-service";
import { listCascades } from "../db/calendar-cascades";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { calendarBindingSchema, schedulingRangeSchema, calendarWriteSchema, coordinationInputSchema } from "../../shared/scheduling";
import { collectCoordinationReplies, listCoordinationViews, getCoordinationView, refreshCoordinationCompletion } from "../_core/scheduling/coordination-service";
import { executeParticipantAvailability } from "../_core/scheduling/participant-executor";
import { cancelCoordination, incomingAvailabilityTasks, getAvailabilityTask, declineAvailabilityTask, requestConflictRecheck } from "../db/calendar-coordination";
import { listCalendarDrafts, cancelCalendarDraft } from "../db/calendar-drafts";
import { prepareCalendarWrite, confirmCalendarWrite } from "../_core/scheduling/write-service";
import { getCalendarBinding, getCalendarCredentials, saveCalendarBinding, searchSchedulingPeople, setAutoAvailability, setCalendarTimeZone } from "../db/scheduling";
import { readOwnCalendar } from "../_core/scheduling/calendar";
import { auditActor, auditRequest, recordAuditRequired } from "../_core/audit-events";
import { prepareMeeting, confirmMeeting, listMeetings, cancelMeeting } from "../_core/scheduling/meeting-service";
import { prepareReschedule, confirmReschedule, cancelRescheduleRequest } from "../_core/scheduling/reschedule-service";
import { listReschedules } from "../db/calendar-reschedules";
import { personalEventSchema, meetingPayloadSchema } from "../../shared/scheduling";
import { selfConnectionSchema, connectOwnCalendar, disconnectOwnCalendar, ownConnectionInfo } from "../_core/scheduling/connection-service";
import { assistantPreferenceInput, getSchedulingAssistantPreferences, saveSchedulingAssistantPreferences } from "../_core/scheduling/assistant-preferences";

export const schedulingRouter = router({
  assistantPreferences: protectedProcedure.input(z.object({ adoptId: z.string().min(1) }).strict()).query(({ ctx, input }) => getSchedulingAssistantPreferences(ctx.user.id, input.adoptId)),
  saveAssistantPreferences: protectedProcedure.input(assistantPreferenceInput).mutation(({ ctx, input }) => saveSchedulingAssistantPreferences(ctx.user.id, input)),
  ensureCalendar: protectedProcedure.mutation(({ ctx }) => import("../_core/scheduling/provisioning-service").then(service => service.ensureOwnCalendar(ctx.user.id))),
  cascades: protectedProcedure.query(async ({ ctx }) => (await listCascades(ctx.user.id)).map(publicCascade)),
  confirmCascade: protectedProcedure.input(z.object({ id: z.string().uuid(), planHash: z.string().length(64), compensate: z.boolean().default(false) }).strict()).mutation(({ ctx, input }) => confirmCascade(ctx.user.id, input.id, input.planHash, input.compensate)),
  stopCascade: protectedProcedure.input(z.object({ id: z.string().uuid() }).strict()).mutation(({ ctx, input }) => stopCascade(ctx.user.id, input.id)),
  connection: protectedProcedure.query(({ ctx }) => ownConnectionInfo(ctx.user.id)),
  connect: protectedProcedure.input(selfConnectionSchema).mutation(({ ctx, input }) => connectOwnCalendar(ctx.user.id, input)),
  disconnect: protectedProcedure.mutation(({ ctx }) => disconnectOwnCalendar(ctx.user.id)),
  setTimeZone: protectedProcedure.input(z.object({ timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }) }).strict()).mutation(async ({ ctx, input }) => {
    if (!(await getCalendarBinding(ctx.user.id))?.enabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "本人日历未启用" });
    await recordAuditRequired({ action: "calendar.timezone.changed", ...auditActor(ctx.user), targetType: "calendar", targetId: String(ctx.user.id), metadata: input });
    await setCalendarTimeZone(ctx.user.id, input.timeZone); return { success: true };
  }),
  recheckConflicts: protectedProcedure.input(z.object({ id: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => {
    await assertCoopMember(ctx.user.id);
    await recordAuditRequired({ action: "calendar.coordination.conflict.recheck", ...auditActor(ctx.user), targetType: "calendar_coordination", targetId: input.id });
    try { return { count: await requestConflictRecheck(input.id, ctx.user.id) }; } catch { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "没有可再次询问的冲突，或协调记录已过期" }); }
  }),
  prepareReschedule: protectedProcedure.input(z.object({ meetingId: z.string().uuid(), event: personalEventSchema }).strict()).mutation(({ ctx, input }) => prepareReschedule(ctx.user.id, input.meetingId, input.event)),
  confirmReschedule: protectedProcedure.input(z.object({ draftId: z.string().uuid() }).strict()).mutation(({ ctx, input }) => confirmReschedule(ctx.user.id, input.draftId)),
  reschedules: protectedProcedure.query(async ({ ctx }) => (await listReschedules(ctx.user.id)).map(draft => ({ id: draft.id, meetingId: draft.meetingId, cascadeId: draft.cascadeId, previous: meetingPayloadSchema.parse(draft.previous).event, event: meetingPayloadSchema.parse(draft.payload).event, status: draft.status, expiresAt: draft.expiresAt }))),
  cancelReschedule: protectedProcedure.input(z.object({ draftId: z.string().uuid() }).strict()).mutation(({ ctx, input }) => cancelRescheduleRequest(ctx.user.id, input.draftId)),
  status: protectedProcedure.query(async ({ ctx }) => {
    const binding = await getCalendarBinding(ctx.user.id);
    return { configured: Boolean(process.env.NEXTCLOUD_BASE_URL), bound: Boolean(binding), enabled: binding?.enabled ?? false, discoverable: binding?.discoverable ?? false, writeEnabled: binding?.writeEnabled ?? false, autoAvailability: binding?.autoAvailability ?? false, timeZone: binding?.timeZone || "" };
  }),
  events: protectedProcedure.input(schedulingRangeSchema).query(async ({ ctx, input }) => {
    const credentials = await getCalendarCredentials(ctx.user.id);
    if (!credentials) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请管理员启用你的日历账号绑定" });
    await recordAuditRequired({ action: "calendar.read.requested", ...auditActor(ctx.user), ...auditRequest(ctx.req), targetType: "calendar", targetId: String(ctx.user.id) });
    return readOwnCalendar(ctx.user.id, credentials, input);
  }),
  searchPeople: protectedProcedure.input(z.object({ query: z.string().trim().min(1).max(100) }).strict())
    .query(({ ctx, input }) => searchSchedulingPeople(ctx.user.id, input.query)),
  setAutoAvailability: protectedProcedure.input(z.object({ enabled: z.boolean() }).strict()).mutation(async ({ ctx, input }) => {
    await recordAuditRequired({ action: "calendar.availability.policy.changed", ...auditActor(ctx.user), ...auditRequest(ctx.req), targetType: "user", targetId: String(ctx.user.id), metadata: { enabled: input.enabled } });
    await setAutoAvailability(ctx.user.id, input.enabled);
    if (input.enabled) {
      const pending = await incomingAvailabilityTasks(ctx.user.id);
      await Promise.all(pending.map(async ({ task }) => {
        await executeParticipantAvailability(task.id);
        await refreshCoordinationCompletion(task.coordinationId);
      }));
    }
    return { success: true };
  }),
  coordinations: protectedProcedure.query(({ ctx }) => listCoordinationViews(ctx.user.id)),
  refreshCoordination: protectedProcedure.input(z.object({ id: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => {
    await collectCoordinationReplies(ctx.user.id, input.id);
    return getCoordinationView(ctx.user.id, input.id);
  }),
  cancelCoordination: protectedProcedure.input(z.object({ id: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => ({ cancelled: await cancelCoordination(input.id, ctx.user.id) })),
  incomingCoordination: protectedProcedure.query(async ({ ctx }) => (await incomingAvailabilityTasks(ctx.user.id)).map(({ task, coordination }) => ({
    taskId: task.id, title: coordinationInputSchema.parse(coordination.payload).title, slots: coordinationInputSchema.parse(coordination.payload).slots, expiresAt: coordination.expiresAt, conflictRecheck: task.manualOnly,
  }))),
  respondCoordination: protectedProcedure.input(z.object({ taskId: z.string().uuid(), action: z.enum(["reply", "decline"]) }).strict()).mutation(async ({ ctx, input }) => {
    const task = await getAvailabilityTask(input.taskId);
    if (!task || task.targetUserId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "协调请求不存在" });
    if (input.action === "reply") await executeParticipantAvailability(task.id, ctx.user.id);
    else await declineAvailabilityTask(task.id, ctx.user.id);
    await refreshCoordinationCompletion(task.coordinationId);
    return { success: true };
  }),
  prepareWrite: protectedProcedure.input(calendarWriteSchema).mutation(({ ctx, input }) => prepareCalendarWrite(ctx.user.id, input)),
  drafts: protectedProcedure.query(async ({ ctx }) => {
    return (await listCalendarDrafts(ctx.user.id)).map(draft => ({ id: draft.id, payload: calendarWriteSchema.parse(draft.payload), status: draft.status, expiresAt: draft.expiresAt }));
  }),
  confirmWrite: protectedProcedure.input(z.object({ draftId: z.string().uuid() }).strict()).mutation(({ ctx, input }) => confirmCalendarWrite(ctx.user.id, input.draftId)),
  cancelWrite: protectedProcedure.input(z.object({ draftId: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => ({ cancelled: await cancelCalendarDraft(ctx.user.id, input.draftId) })),
  prepareMeeting: protectedProcedure.input(z.object({ coordinationId: z.string().uuid(), slotIndex: z.number().int().min(0).max(5), location: z.string().trim().max(300).default("") }).strict())
    .mutation(({ ctx, input }) => prepareMeeting(ctx.user.id, input.coordinationId, input.slotIndex, input.location)),
  confirmMeeting: protectedProcedure.input(z.object({ meetingId: z.string().uuid() }).strict()).mutation(({ ctx, input }) => confirmMeeting(ctx.user.id, input.meetingId)),
  meetings: protectedProcedure.query(({ ctx }) => listMeetings(ctx.user.id)),
  cancelMeeting: protectedProcedure.input(z.object({ meetingId: z.string().uuid() }).strict()).mutation(({ ctx, input }) => cancelMeeting(ctx.user.id, input.meetingId)),
  binding: adminProcedure.input(z.object({ userId: z.number().int().positive() }).strict()).query(async ({ input }) => {
    const binding = await getCalendarBinding(input.userId);
    return binding ? { userId: binding.userId, username: binding.username, calendarName: binding.calendarName, enabled: binding.enabled, discoverable: binding.discoverable, writeEnabled: binding.writeEnabled, autoAvailability: binding.autoAvailability, calendarEmail: binding.calendarEmail } : null;
  }),
  saveBinding: adminProcedure.input(calendarBindingSchema).mutation(async ({ ctx, input }) => {
    await recordAuditRequired({ action: "calendar.binding.change.requested", ...auditActor(ctx.user), ...auditRequest(ctx.req), targetType: "user", targetId: String(input.userId) });
    try { await saveCalendarBinding(input); }
    catch { throw new TRPCError({ code: "BAD_REQUEST", message: "绑定失败，请确认用户存在且日历账号未绑定其他用户" }); }
    return { success: true };
  }),
});
