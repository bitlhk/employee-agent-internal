import { assertCoopParticipants } from "../../db/coop-identity";
import { TRPCError } from "@trpc/server";
import { coordinationInputSchema, type Availability } from "../../../shared/scheduling";
import { getCalendarBinding, getCalendarCredentials } from "../../db/scheduling";
import { getAvailabilityTask, getCoordination, claimAvailabilityTask, finishAvailabilityTask } from "../../db/calendar-coordination";
import { readOwnCalendar } from "./calendar";
import { availabilityForSlots } from "./availability";
import { recordAuditRequired } from "../audit-events";
import { bindingFingerprint } from "./write-calendar";
import { getMeeting } from "../../db/calendar-meetings";
import { meetingPayloadSchema } from "../../../shared/scheduling";
import { meetingUid } from "./meeting-calendar";

// Internal capability router. The initiating assistant has no endpoint for setting executionUserId.
// Only the persisted task assignment can establish the automatic recipient's execution identity.
export async function executeParticipantAvailability(taskId: string, manualUserId?: number) {
  const task = await getAvailabilityTask(taskId);
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "协调任务不存在" });
  if (manualUserId !== undefined && manualUserId !== task.targetUserId) throw new TRPCError({ code: "FORBIDDEN", message: "只能回复发给本人的协调任务" });
  const coordination = await getCoordination(task.coordinationId);
  if (!coordination || coordination.status !== "collecting" || coordination.expiresAt.getTime() <= Date.now()) return;
  const input = coordinationInputSchema.parse(coordination.payload);
  await assertCoopParticipants(coordination.creatorUserId, [task.targetUserId]);
  if (![coordination.creatorUserId, ...input.participantIds].includes(task.targetUserId)) throw new TRPCError({ code: "FORBIDDEN", message: "参与人身份不匹配" });
  const binding = await getCalendarBinding(task.targetUserId);
  const isCreator = task.targetUserId === coordination.creatorUserId;
  if (manualUserId === undefined && task.manualOnly) return;
  if (manualUserId === undefined && !isCreator && !binding?.autoAvailability) return;
  const token = await claimAvailabilityTask(task.id, task.targetUserId);
  if (!token) return;
  const unknown: Availability[] = input.slots.map(() => "unknown");
  let reply: Availability[];
  try {
    if (!binding?.enabled) throw new Error("Availability authorization revoked");
    const executionUserId = task.targetUserId;
    const credentials = await getCalendarCredentials(executionUserId);
    if (!credentials) throw new Error("Own calendar unavailable");
    await recordAuditRequired({ action: "calendar.availability.read.requested", actorType: "agent", actorUserId: executionUserId,
      targetType: "calendar_coordination", targetId: coordination.id, metadata: { requesterUserId: coordination.creatorUserId, taskId: task.id } });
    // Read under the recipient identity. Return only slot decisions, never events or credentials.
    const range = { start: new Date(Math.min(...input.slots.map(slot => Date.parse(slot.start)))).toISOString(), end: new Date(Math.max(...input.slots.map(slot => Date.parse(slot.end)))).toISOString() };
    let events = await readOwnCalendar(executionUserId, credentials, range);
    if (coordination.excludeMeetingId) {
      const meeting = await getMeeting(coordination.excludeMeetingId);
      const payload = meeting && meetingPayloadSchema.parse(meeting.payload);
      if (!meeting || meeting.creatorUserId !== coordination.creatorUserId || !payload || ![payload.organizer.userId, ...payload.attendees.map(person => person.userId)].includes(executionUserId)) throw new Error("Invalid reschedule context");
      events = events.filter(event => !event.id.startsWith(`${meetingUid(meeting.id)}:`));
    }
    const currentBinding = await getCalendarBinding(executionUserId);
    if (!currentBinding?.enabled || (!isCreator && (manualUserId === undefined && !currentBinding.autoAvailability))) throw new Error("Authorization revoked during read");
    if (bindingFingerprint({ ...credentials, username: currentBinding.username, calendarName: currentBinding.calendarName, grantId: currentBinding.grantId || undefined }) !== bindingFingerprint(credentials)) throw new Error("Calendar owner binding changed");
    const currentCoordination = await getCoordination(coordination.id);
    if (!currentCoordination || currentCoordination.status !== "collecting" || currentCoordination.expiresAt.getTime() <= Date.now()) throw new Error("Coordination no longer active");
    if (currentBinding.timeZone !== binding.timeZone) throw new Error("Calendar timezone changed during read");
    await assertCoopParticipants(coordination.creatorUserId, [executionUserId]);
    reply = availabilityForSlots(events, input.slots, credentials.timeZone);
  } catch { reply = unknown; }
  await finishAvailabilityTask(task.id, token, reply);
}
