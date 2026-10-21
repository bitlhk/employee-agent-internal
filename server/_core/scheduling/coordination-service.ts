import { assertCoopParticipants, assertCoopMember } from "../../db/coop-identity";
import { TRPCError } from "@trpc/server";
import { coordinationInputSchema, availabilityReplySchema, type CoordinationInput, type Availability } from "../../../shared/scheduling";
import { getSchedulingPerson } from "../../db/scheduling";
import { createCoordination, getCoordination, listAvailabilityTasks, completeCoordination, listCoordinationRecords } from "../../db/calendar-coordination";
import { executeParticipantAvailability } from "./participant-executor";
import { commonSlotIndices } from "./availability";
import { recordAuditRequired } from "../audit-events";

export async function collectCoordinationReplies(userId: number, coordinationId: string) {
  const record = await getCoordination(coordinationId);
  if (!record || record.creatorUserId !== userId) throw new TRPCError({ code: "NOT_FOUND", message: "协调记录不存在" });
  if (record.status !== "collecting" || record.expiresAt.getTime() <= Date.now()) return;
  const tasks = await listAvailabilityTasks(coordinationId);
  await Promise.all(tasks.filter(task => ["pending", "running"].includes(task.status)).map(task => executeParticipantAvailability(task.id)));
  await refreshCoordinationCompletion(coordinationId);
}

export async function refreshCoordinationCompletion(coordinationId: string) {
  const tasks = await listAvailabilityTasks(coordinationId);
  if (tasks.length && tasks.every(task => ["replied", "declined"].includes(task.status))) await completeCoordination(coordinationId);
}

export async function startCoordination(userId: number, raw: CoordinationInput, excludeMeetingId?: string) {
  const input = coordinationInputSchema.parse(raw);
  await assertCoopMember(userId);
  await assertCoopParticipants(userId, input.participantIds);
  if (input.participantIds.includes(userId)) throw new TRPCError({ code: "BAD_REQUEST", message: "发起人会自动参与，无需重复选择" });
  const people = await Promise.all([userId, ...input.participantIds].map(id => getSchedulingPerson(id)));
  if (people.some((person, index) => !person?.enabled)) throw new TRPCError({ code: "FORBIDDEN", message: "部分参与人未启用日程，请重新选择" });
  await recordAuditRequired({ action: "calendar.coordination.requested", actorType: "agent", actorUserId: userId, targetType: "calendar_coordination", targetId: input.requestKey,
    metadata: { participantCount: input.participantIds.length, slotCount: input.slots.length } });
  const id = await createCoordination(userId, input, people.map(person => ({ userId: person!.userId, name: person!.name || `人员${person!.userId}` })), excludeMeetingId);
  await collectCoordinationReplies(userId, id);
  return getCoordinationView(userId, id);
}

export async function getCoordinationView(userId: number, id: string) {
  const record = await getCoordination(id);
  if (!record || record.creatorUserId !== userId) throw new TRPCError({ code: "NOT_FOUND", message: "协调记录不存在" });
  const input = coordinationInputSchema.parse(record.payload);
  await assertCoopParticipants(userId, input.participantIds);
  const tasks = await listAvailabilityTasks(id);
  const active = !["cancelled", "expired"].includes(record.status) && record.expiresAt.getTime() > Date.now();
  const members = tasks.map(task => {
    const parsed = availabilityReplySchema.safeParse(task.reply);
    const reply: Availability[] = task.status === "replied" && parsed.success && parsed.data.length === input.slots.length
      ? parsed.data : input.slots.map(() => "unknown");
    return { userId: task.targetUserId, name: task.displayName, status: task.status, reply };
  });
  const status = record.status !== "cancelled" && !active ? "expired" as const : record.status;
  return { id, title: input.title, slots: input.slots, members, status, expiresAt: record.expiresAt, internalCheck: Boolean(record.excludeMeetingId),
    commonIndices: active && members.length === input.participantIds.length + 1 ? commonSlotIndices(members.map(member => member.reply), input.slots.length) : [] };
}

export async function listCoordinationViews(userId: number) {
  const records = await Promise.all((await listCoordinationRecords(userId)).map(async record => {
    try { return await getCoordinationView(userId, record.id); }
    catch (error) { if (error instanceof TRPCError && error.code === "FORBIDDEN") return null; throw error; }
  }));
  return records.filter(record => record !== null);
}
