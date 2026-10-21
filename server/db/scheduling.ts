import { TRPCError } from "@trpc/server";
import { assertCoopMember, assertCoopParticipants } from "./coop-identity";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { calendarBindings, users } from "../../drizzle/schema";
import { getDb } from "./connection";
import { decryptSecret, encryptSecret } from "../_core/secret-protection";
import type { z } from "zod";
import type { calendarBindingSchema } from "../../shared/scheduling";

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}

export async function getCalendarBinding(userId: number) {
  const db = await database();
  const [binding] = await db.select().from(calendarBindings).where(eq(calendarBindings.userId, userId)).limit(1);
  return binding ?? null;
}

export async function calendarAccountOwner(username: string) {
  const [row] = await (await database()).select({ userId: calendarBindings.userId }).from(calendarBindings).where(eq(calendarBindings.username, username)).limit(1);
  return row?.userId ?? null;
}

export async function getCalendarCredentials(userId: number) {
  const binding = await getCalendarBinding(userId);
  if (!binding?.enabled) return null;
  return { userId, username: binding.username, calendarName: binding.calendarName, appPassword: decryptSecret(binding.encryptedPassword), writeEnabled: binding.writeEnabled, timeZone: binding.timeZone || undefined, grantId: binding.grantId || undefined };
}

export async function saveCalendarBinding(input: z.infer<typeof calendarBindingSchema>) {
  const db = await database();
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user) throw new Error("User not found");
  const { appPassword, ...fields } = input;
  const values = { ...fields, grantId: randomUUID(), encryptedPassword: encryptSecret(appPassword, { maxStoredLength: null }) };
  // Upsert against a secondary unique username could accidentally move another owner's binding.
  // Update strictly by user ID; the database unique constraint rejects cross-owner usernames.
  const [existing] = await db.select({ userId: calendarBindings.userId, username: calendarBindings.username, calendarName: calendarBindings.calendarName }).from(calendarBindings).where(eq(calendarBindings.userId, input.userId)).limit(1);
  if (existing) await db.update(calendarBindings).set({ ...values, ...(existing.username !== input.username || existing.calendarName !== input.calendarName ? { timeZone: "Asia/Shanghai" } : {}) }).where(eq(calendarBindings.userId, input.userId));
  else await db.insert(calendarBindings).values({ ...values, timeZone: "Asia/Shanghai" });
}

export async function revokeCalendarConnection(userId: number) {
  await (await database()).update(calendarBindings).set({ enabled: false, writeEnabled: false, autoAvailability: false, discoverable: false, encryptedPassword: "", grantId: randomUUID() }).where(eq(calendarBindings.userId, userId));
}

export async function searchSchedulingPeople(userId: number, query: string) {
  await assertCoopMember(userId);
  const { listMentionCandidates } = await import("./coop");
  return (await listMentionCandidates({ viewerUserId: userId, keyword: query, limit: 50 })).map(person => ({
    userId: person.userId, name: person.userName, departmentName: person.departmentName,
    teamName: person.teamName, adoptId: person.adoptId,
  }));
}

export async function setAutoAvailability(userId: number, enabled: boolean) {
  await (await database()).update(calendarBindings).set({ autoAvailability: enabled }).where(eq(calendarBindings.userId, userId));
}

export async function setCalendarTimeZone(userId: number, timeZone: string) {
  await (await database()).update(calendarBindings).set({ timeZone }).where(eq(calendarBindings.userId, userId));
}

export async function setLocalCalendarEmail(userId: number, username: string, email: string) {
  await (await database()).update(calendarBindings).set({ calendarEmail: email }).where(and(eq(calendarBindings.userId, userId), eq(calendarBindings.username, username)));
}

export async function getSchedulingPerson(userId: number) {
  const [person] = await (await database()).select({ userId: users.id, name: users.name, enabled: calendarBindings.enabled, discoverable: calendarBindings.discoverable, username: calendarBindings.username, email: calendarBindings.calendarEmail })
    .from(users).innerJoin(calendarBindings, eq(users.id, calendarBindings.userId)).where(eq(users.id, userId)).limit(1);
  return person ?? null;
}

// Resolves trusted calendar addresses for selected organization users, without reading their calendars.
export async function resolveCalendarParticipants(userId: number, participantIds: number[]) {
  const ids = [...new Set(participantIds)].filter(id => id !== userId);
  await assertCoopParticipants(userId, ids);
  const people = await Promise.all([userId, ...ids].map(getSchedulingPerson));
  if (people.some(person => !person?.enabled || !person.email)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "部分成员的日历尚未就绪，请联系管理员配置日历账号" });
  const mapped = people.map(person => ({ userId: person!.userId, name: person!.name || `成员${person!.userId}`, username: person!.username, email: person!.email! }));
  return { organizer: mapped[0], attendees: mapped.slice(1) };
}

export async function calendarPeopleByEmail(emails: string[]) {
  if (!emails.length) return [];
  return (await database()).select({ userId: users.id, name: users.name, email: calendarBindings.calendarEmail })
    .from(calendarBindings).innerJoin(users, eq(users.id, calendarBindings.userId))
    .where(inArray(calendarBindings.calendarEmail, [...new Set(emails.map(value => value.toLowerCase()))]));
}
