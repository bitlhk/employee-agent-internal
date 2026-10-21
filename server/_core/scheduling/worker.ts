import { and, eq, gt, inArray, lt, or, isNull } from "drizzle-orm";
import { calendarCoordinations, calendarAvailabilityTasks, calendarMeetings, calendarReschedules, calendarBindings, calendarCascades, calendarWriteDrafts } from "../../../drizzle/schema";
import { getDb } from "../../db/connection";
import { executeParticipantAvailability } from "./participant-executor";
import { refreshCoordinationCompletion } from "./coordination-service";
import { confirmMeeting } from "./meeting-service";
import { confirmReschedule } from "./reschedule-service";
import { dispatchCalendarReminders } from "./reminders";
import { confirmCalendarWrite } from "./write-service";

// Pending drafts never enter recovery: checking/executing states establish a prior explicit confirmation.
export async function recoverSchedulingWork() {
  const db = await getDb(); if (!db) return;
  await db.update(calendarCoordinations).set({ status: "expired" }).where(and(inArray(calendarCoordinations.status, ["collecting", "completed"]), lt(calendarCoordinations.expiresAt, new Date())));
  const { advanceCascade } = await import("./cascade-service");
  const cascades = await db.select().from(calendarCascades).where(and(or(isNull(calendarCascades.leaseUntil), lt(calendarCascades.leaseUntil, new Date())), or(inArray(calendarCascades.status, ["confirmed", "running", "waiting", "compensating"]), and(eq(calendarCascades.stopRequested, true), inArray(calendarCascades.status, ["drafting", "pending"]))))).orderBy(calendarCascades.updatedAt, calendarCascades.id).limit(10);
  for (const plan of cascades) await advanceCascade(plan.userId, plan.id);
  const tasks = await db.select({ task: calendarAvailabilityTasks }).from(calendarAvailabilityTasks)
    .innerJoin(calendarCoordinations, eq(calendarCoordinations.id, calendarAvailabilityTasks.coordinationId))
    .innerJoin(calendarBindings, eq(calendarBindings.userId, calendarAvailabilityTasks.targetUserId))
    .where(and(eq(calendarCoordinations.status, "collecting"), gt(calendarCoordinations.expiresAt, new Date()), eq(calendarAvailabilityTasks.manualOnly, false), eq(calendarBindings.enabled, true),
      or(eq(calendarAvailabilityTasks.targetUserId, calendarCoordinations.creatorUserId), eq(calendarBindings.autoAvailability, true)),
      inArray(calendarAvailabilityTasks.status, ["pending", "running"]))).limit(30);
  for (const { task } of tasks) {
    try { await executeParticipantAvailability(task.id); await refreshCoordinationCompletion(task.coordinationId); } catch { /* Reclaimable lease or explicit retry remains visible. */ }
  }
  const personal = await db.select().from(calendarWriteDrafts).where(or(eq(calendarWriteDrafts.status, "unknown"), and(eq(calendarWriteDrafts.status, "executing"), lt(calendarWriteDrafts.updatedAt, new Date(Date.now() - 120_000))))).orderBy(calendarWriteDrafts.updatedAt).limit(10);
  for (const draft of personal) { try { await confirmCalendarWrite(draft.userId, draft.id); } catch { /* Reconcile only after expiry; never run a pending unconfirmed draft. */ } }
  const meetings = await db.select().from(calendarMeetings).where(inArray(calendarMeetings.status, ["checking", "creating", "unknown"])).orderBy(calendarMeetings.updatedAt).limit(10);
  for (const meeting of meetings) { try { await db.update(calendarMeetings).set({ updatedAt: new Date() }).where(eq(calendarMeetings.id, meeting.id)); await confirmMeeting(meeting.creatorUserId, meeting.id); } catch { /* Fail closed; UI can inspect the original confirmed draft. */ } }
  const reschedules = await db.select().from(calendarReschedules).where(and(isNull(calendarReschedules.cascadeId), inArray(calendarReschedules.status, ["checking", "executing", "unknown"]))).orderBy(calendarReschedules.updatedAt).limit(10);
  for (const draft of reschedules) { try { await db.update(calendarReschedules).set({ updatedAt: new Date() }).where(eq(calendarReschedules.id, draft.id)); await confirmReschedule(draft.userId, draft.id); } catch { /* Preserve the original UID and operation. */ } }
}

export function startSchedulingRecovery() {
  let running = false; let stopped = false;
  const tick = async () => {
    if (running || stopped || !process.env.NEXTCLOUD_BASE_URL) return;
    running = true;
    try { await recoverSchedulingWork(); await dispatchCalendarReminders(); } catch { /* DB startup/restart is retried next tick. */ } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 30_000); timer.unref(); void tick();
  return () => { stopped = true; clearInterval(timer); };
}
