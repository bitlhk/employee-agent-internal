import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or, desc } from "drizzle-orm";
import { calendarWriteDrafts } from "../../drizzle/schema";
import { getDb } from "./connection";
import type { CalendarWrite } from "../../shared/scheduling";
import { stableToolInputHash } from "../_core/tool-governance";

async function database() { const db = await getDb(); if (!db) throw new Error("Database unavailable"); return db; }
export async function createCalendarDraft(userId: number, bindingFingerprint: string, payload: CalendarWrite, operationId?: string) {
  const db = await database(); const id = operationId || randomUUID();
  const insert = db.insert(calendarWriteDrafts).values({ id, userId, bindingFingerprint, payload, expiresAt: new Date(Date.now() + 10 * 60_000) });
  if (operationId) {
    await insert.onDuplicateKeyUpdate({ set: { id } });
    const existing = await getCalendarDraft(userId, id);
    if (!existing || existing.bindingFingerprint !== bindingFingerprint || stableToolInputHash(existing.payload) !== stableToolInputHash(payload)) throw new Error("草稿操作编号已用于不同的日程或授权");
  } else await insert;
  return id;
}
export async function listCalendarDrafts(userId: number) {
  return (await database()).select().from(calendarWriteDrafts).where(eq(calendarWriteDrafts.userId, userId)).orderBy(desc(calendarWriteDrafts.updatedAt)).limit(20);
}
export async function getCalendarDraft(userId: number, id: string) {
  const [draft] = await (await database()).select().from(calendarWriteDrafts).where(and(eq(calendarWriteDrafts.id, id), eq(calendarWriteDrafts.userId, userId))).limit(1);
  return draft ?? null;
}
export async function claimCalendarDraft(userId: number, id: string) {
  const [result] = await (await database()).update(calendarWriteDrafts).set({ status: "executing", updatedAt: new Date() })
    .where(and(eq(calendarWriteDrafts.id, id), eq(calendarWriteDrafts.userId, userId), or(inArray(calendarWriteDrafts.status, ["pending", "unknown"]), and(eq(calendarWriteDrafts.status, "executing"), lt(calendarWriteDrafts.updatedAt, new Date(Date.now() - 120_000))))));
  return result.affectedRows === 1;
}
export async function finishCalendarDraft(userId: number, id: string, status: "completed" | "unknown" | "cancelled") {
  await (await database()).update(calendarWriteDrafts).set({ status }).where(and(eq(calendarWriteDrafts.id, id), eq(calendarWriteDrafts.userId, userId)));
}
export async function cancelCalendarDraft(userId: number, id: string) {
  const [result] = await (await database()).update(calendarWriteDrafts).set({ status: "cancelled" }).where(and(eq(calendarWriteDrafts.id, id), eq(calendarWriteDrafts.userId, userId), eq(calendarWriteDrafts.status, "pending")));
  return result.affectedRows === 1;
}
