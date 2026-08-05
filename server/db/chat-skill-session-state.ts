import { and, desc, eq, sql } from "drizzle-orm";

import { chatSkillSessionState } from "../../drizzle/schema";
import { getDb } from "./connection";

export type ChatSkillAffinity = {
  skillId: string;
  selectionMode: "manual" | "automatic";
  useCount: number;
  lastSelectedAt: Date;
};

export async function listChatSkillAffinities(
  adoptId: string,
  sessionId: string,
  limit = 12,
): Promise<ChatSkillAffinity[]> {
  if (!adoptId || !sessionId) return [];
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({
      skillId: chatSkillSessionState.skillId,
      selectionMode: chatSkillSessionState.selectionMode,
      useCount: chatSkillSessionState.useCount,
      lastSelectedAt: chatSkillSessionState.lastSelectedAt,
    })
    .from(chatSkillSessionState)
    .where(and(
      eq(chatSkillSessionState.adoptId, adoptId),
      eq(chatSkillSessionState.sessionId, sessionId),
    ))
    .orderBy(desc(chatSkillSessionState.lastSelectedAt))
    .limit(Math.max(1, Math.min(32, Number(limit || 12))));
  return rows.map((row) => ({
    skillId: String(row.skillId),
    selectionMode: row.selectionMode,
    useCount: Number(row.useCount || 0),
    lastSelectedAt: row.lastSelectedAt,
  }));
}

export async function recordChatSkillSelection(input: {
  adoptId: string;
  sessionId: string;
  skillIds: string[];
  selectionMode: "manual" | "automatic";
}): Promise<void> {
  const skillIds = [...new Set(input.skillIds.map((value) => String(value || "").trim()).filter(Boolean))];
  if (!input.adoptId || !input.sessionId || skillIds.length === 0) return;
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  for (const skillId of skillIds) {
    await db
      .insert(chatSkillSessionState)
      .values({
        adoptId: input.adoptId,
        sessionId: input.sessionId,
        skillId,
        selectionMode: input.selectionMode,
      })
      .onDuplicateKeyUpdate({ set: {
        selectionMode: input.selectionMode,
        useCount: sql`${chatSkillSessionState.useCount} + 1`,
        lastSelectedAt: sql`CURRENT_TIMESTAMP`,
      } });
  }
  await db.delete(chatSkillSessionState).where(and(
    eq(chatSkillSessionState.adoptId, input.adoptId),
    sql`${chatSkillSessionState.lastSelectedAt} < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 30 DAY)`,
  ));
}
