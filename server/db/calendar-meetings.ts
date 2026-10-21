import { randomUUID } from "node:crypto";
import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { calendarMeetings } from "../../drizzle/schema";
import { getDb } from "./connection";
import type { MeetingPayload } from "../../shared/scheduling";
import { stableToolInputHash } from "../_core/tool-governance";
async function database() { const db = await getDb(); if (!db) throw new Error("Database unavailable"); return db; }
export async function createMeetingDraft(creatorUserId: number, coordinationId: string | null, payload: MeetingPayload, bindingFingerprint: string, requestKey = coordinationId || randomUUID()) {
  const db = await database(); const id = randomUUID(); const payloadHash = stableToolInputHash(payload);
  await db.insert(calendarMeetings).values({ id, creatorUserId, coordinationId, requestKey, payload, payloadHash, bindingFingerprint, expiresAt: new Date(Date.now() + 10 * 60_000) })
    .onDuplicateKeyUpdate({ set: { requestKey: sql`${calendarMeetings.requestKey}` } });
  const [record] = await db.select().from(calendarMeetings).where(coordinationId ? eq(calendarMeetings.coordinationId, coordinationId) : and(eq(calendarMeetings.creatorUserId, creatorUserId), eq(calendarMeetings.requestKey, requestKey))).limit(1);
  if (!record || record.creatorUserId !== creatorUserId || record.payloadHash !== payloadHash || record.bindingFingerprint !== bindingFingerprint || record.coordinationId !== coordinationId) throw new Error("同一请求编号已用于不同日程或授权，请核对原草稿");
  return record.id;
}
export async function getMeeting(id: string) {
  const [record] = await (await database()).select().from(calendarMeetings).where(eq(calendarMeetings.id, id)).limit(1);
  return record ?? null;
}
export async function listMeetingRecords(userId: number) {
  // JSON_CONTAINS membership would couple the API to database JSON details; bound a recent set then filter in the service.
  return (await database()).select().from(calendarMeetings).where(eq(calendarMeetings.creatorUserId, userId)).orderBy(desc(calendarMeetings.updatedAt)).limit(20);
}
export async function listParticipantMeetingRecords(userId: number) {
  const db = await database();
  const { sql } = await import("drizzle-orm");
  return db.select().from(calendarMeetings).where(and(inArray(calendarMeetings.status, ["invited", "unknown"]), sql`JSON_CONTAINS(JSON_EXTRACT(${calendarMeetings.payload}, '$.attendees[*].userId'), ${JSON.stringify(userId)})`)).orderBy(desc(calendarMeetings.updatedAt)).limit(20);
}
export async function updateMeeting(id: string, userId: number, patch: { status?: "pending" | "checking" | "creating" | "invited" | "unknown" | "cancelled"; checkCoordinationId?: string; payload?: MeetingPayload; payloadHash?: string }) {
  await (await database()).update(calendarMeetings).set(patch).where(and(eq(calendarMeetings.id, id), eq(calendarMeetings.creatorUserId, userId)));
}

export async function getMeetingByResource(userId: number, resourceId: string) {
  const [record] = await (await database()).select().from(calendarMeetings).where(and(
    eq(calendarMeetings.creatorUserId, userId),
    sql`CONCAT('ea-meeting-', SHA2(${calendarMeetings.id}, 256), '.ics') = ${resourceId}`,
  )).limit(1);
  return record || null;
}
