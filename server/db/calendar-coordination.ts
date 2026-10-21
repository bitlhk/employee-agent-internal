import { randomUUID } from "node:crypto";
import { and, eq, desc, lt, or, gt, inArray } from "drizzle-orm";
import { calendarCoordinations, calendarAvailabilityTasks } from "../../drizzle/schema";
import { getDb } from "./connection";
import type { Availability, CoordinationInput } from "../../shared/scheduling";
import { stableToolInputHash } from "../_core/tool-governance";

async function database() { const db = await getDb(); if (!db) throw new Error("Database unavailable"); return db; }
export async function createCoordination(creatorUserId: number, input: CoordinationInput, members: Array<{ userId: number; name: string }>, excludeMeetingId?: string) {
  const db = await database();
  return db.transaction(async tx => {
    const id = randomUUID(); const payloadHash = stableToolInputHash(input);
    await tx.insert(calendarCoordinations).values({ id, creatorUserId, requestKey: input.requestKey, payload: input, payloadHash, excludeMeetingId, expiresAt: new Date(Date.now() + 10 * 60_000) })
      .onDuplicateKeyUpdate({ set: { requestKey: input.requestKey } });
    const [record] = await tx.select().from(calendarCoordinations).where(and(eq(calendarCoordinations.creatorUserId, creatorUserId), eq(calendarCoordinations.requestKey, input.requestKey))).limit(1);
    if (record.payloadHash !== payloadHash || (record.excludeMeetingId || undefined) !== excludeMeetingId) throw new Error("Idempotency key reused with different coordination");
    if (record.id === id) await tx.insert(calendarAvailabilityTasks).values(members.map(member => ({ id: randomUUID(), coordinationId: id, targetUserId: member.userId, displayName: member.name.slice(0, 200) })));
    return record.id;
  });
}
export async function getCoordination(id: string) {
  const db = await database();
  const [record] = await db.select().from(calendarCoordinations).where(eq(calendarCoordinations.id, id)).limit(1);
  return record ?? null;
}
export async function listCoordinationRecords(userId: number) {
  return (await database()).select().from(calendarCoordinations).where(eq(calendarCoordinations.creatorUserId, userId)).orderBy(desc(calendarCoordinations.createdAt)).limit(20);
}
export async function getAvailabilityTask(id: string) {
  const [task] = await (await database()).select().from(calendarAvailabilityTasks).where(eq(calendarAvailabilityTasks.id, id)).limit(1);
  return task ?? null;
}
export async function listAvailabilityTasks(coordinationId: string) {
  return (await database()).select().from(calendarAvailabilityTasks).where(eq(calendarAvailabilityTasks.coordinationId, coordinationId)).orderBy(calendarAvailabilityTasks.targetUserId);
}
export async function incomingAvailabilityTasks(userId: number) {
  return (await database()).select({ task: calendarAvailabilityTasks, coordination: calendarCoordinations })
    .from(calendarAvailabilityTasks).innerJoin(calendarCoordinations, eq(calendarCoordinations.id, calendarAvailabilityTasks.coordinationId))
    .where(and(eq(calendarAvailabilityTasks.targetUserId, userId), eq(calendarCoordinations.status, "collecting"), gt(calendarCoordinations.expiresAt, new Date()), or(eq(calendarAvailabilityTasks.status, "pending"), eq(calendarAvailabilityTasks.status, "running"))))
    .orderBy(desc(calendarCoordinations.createdAt)).limit(20);
}
export async function claimAvailabilityTask(id: string, targetUserId: number) {
  const token = randomUUID();
  const [result] = await (await database()).update(calendarAvailabilityTasks).set({ status: "running", leaseToken: token, updatedAt: new Date() })
    .where(and(eq(calendarAvailabilityTasks.id, id), eq(calendarAvailabilityTasks.targetUserId, targetUserId), or(eq(calendarAvailabilityTasks.status, "pending"), and(eq(calendarAvailabilityTasks.status, "running"), lt(calendarAvailabilityTasks.updatedAt, new Date(Date.now() - 60_000))))));
  return result.affectedRows === 1 ? token : null;
}
export async function finishAvailabilityTask(id: string, token: string, reply: Availability[]) {
  await (await database()).update(calendarAvailabilityTasks).set({ status: "replied", reply, leaseToken: null })
    .where(and(eq(calendarAvailabilityTasks.id, id), eq(calendarAvailabilityTasks.status, "running"), eq(calendarAvailabilityTasks.leaseToken, token)));
}
export async function declineAvailabilityTask(id: string, targetUserId: number) {
  await (await database()).update(calendarAvailabilityTasks).set({ status: "declined", reply: null, leaseToken: null })
    .where(and(eq(calendarAvailabilityTasks.id, id), eq(calendarAvailabilityTasks.targetUserId, targetUserId), inArray(calendarAvailabilityTasks.status, ["pending", "running"])));
}
export async function completeCoordination(id: string) {
  await (await database()).update(calendarCoordinations).set({ status: "completed" }).where(and(eq(calendarCoordinations.id, id), eq(calendarCoordinations.status, "collecting"), gt(calendarCoordinations.expiresAt, new Date())));
}
export async function cancelCoordination(id: string, creatorUserId: number) {
  const [result] = await (await database()).update(calendarCoordinations).set({ status: "cancelled" }).where(and(eq(calendarCoordinations.id, id), eq(calendarCoordinations.creatorUserId, creatorUserId), eq(calendarCoordinations.status, "collecting")));
  return result.affectedRows === 1;
}

export async function requestConflictRecheck(id: string, creatorUserId: number) {
  return (await database()).transaction(async tx => {
    const [record] = await tx.select().from(calendarCoordinations).where(and(eq(calendarCoordinations.id, id), eq(calendarCoordinations.creatorUserId, creatorUserId))).for("update");
    if (!record || ["cancelled", "expired"].includes(record.status) || record.expiresAt.getTime() <= Date.now()) throw new Error("Coordination unavailable");
    const tasks = await tx.select().from(calendarAvailabilityTasks).where(eq(calendarAvailabilityTasks.coordinationId, id));
    const conflicts = tasks.filter(task => task.status === "replied" && Array.isArray(task.reply) && task.reply.includes("busy"));
    if (!conflicts.length) throw new Error("No known conflicts to recheck");
    for (const task of conflicts) await tx.update(calendarAvailabilityTasks).set({ status: "pending", reply: null, manualOnly: true, leaseToken: null }).where(eq(calendarAvailabilityTasks.id, task.id));
    await tx.update(calendarCoordinations).set({ status: "collecting", expiresAt: new Date(Date.now() + 10 * 60_000) }).where(eq(calendarCoordinations.id, id));
    return conflicts.length;
  });
}
