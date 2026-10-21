import { randomUUID } from "node:crypto";
import { and, eq, desc, inArray, isNull } from "drizzle-orm";
import { calendarReschedules } from "../../drizzle/schema";
import { getDb } from "./connection";
import type { MeetingPayload } from "../../shared/scheduling";
import { stableToolInputHash } from "../_core/tool-governance";
async function database() { const db = await getDb(); if (!db) throw new Error("Database unavailable"); return db; }
export async function saveReschedule(userId: number, meetingId: string, previous: MeetingPayload, payload: MeetingPayload, version: string, bindingFingerprint: string, cascadeId?: string, operationId?: string) {
  const id = operationId || randomUUID();
  const insert = (await database()).insert(calendarReschedules).values({ id, userId, meetingId, previous, payload, version, bindingFingerprint, cascadeId, expiresAt: new Date(Date.now() + 10 * 60_000) });
  if (operationId) {
    await insert.onDuplicateKeyUpdate({ set: { id } });
    const existing = await getReschedule(userId, id);
    if (!existing || existing.meetingId !== meetingId || existing.bindingFingerprint !== bindingFingerprint || stableToolInputHash(existing.payload) !== stableToolInputHash(payload) || (existing.cascadeId || undefined) !== cascadeId) throw new Error("改期操作编号已用于不同的日程或授权");
  } else await insert;
  return id;
}
export async function getReschedule(userId: number, id: string) {
  const [row] = await (await database()).select().from(calendarReschedules).where(and(eq(calendarReschedules.id, id), eq(calendarReschedules.userId, userId)));
  return row ?? null;
}
export async function listReschedules(userId: number) { return (await database()).select().from(calendarReschedules).where(and(eq(calendarReschedules.userId, userId), isNull(calendarReschedules.cascadeId))).orderBy(desc(calendarReschedules.updatedAt)).limit(20); }
export async function updateReschedule(userId: number, id: string, patch: { status?: "pending" | "checking" | "executing" | "completed" | "unknown" | "cancelled"; checkCoordinationId?: string }) {
  await (await database()).update(calendarReschedules).set(patch).where(and(eq(calendarReschedules.id, id), eq(calendarReschedules.userId, userId)));
}
export async function cancelReschedule(userId: number, id: string) {
  const [result] = await (await database()).update(calendarReschedules).set({ status: "cancelled" }).where(and(eq(calendarReschedules.id, id), eq(calendarReschedules.userId, userId), inArray(calendarReschedules.status, ["pending", "checking"])));
  return result.affectedRows === 1;
}
