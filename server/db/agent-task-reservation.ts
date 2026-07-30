import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  agentTasks,
  type AgentTask,
  type InsertAgentTask,
} from "../../drizzle/schema";
import { getDb } from "./connection";

export type AgentTaskReservation =
  | { kind: "created" }
  | { kind: "existing"; task: AgentTask }
  | { kind: "concurrency_exceeded" }
  | { kind: "daily_exceeded" };

export async function reserveAgentTask(
  data: InsertAgentTask,
  limits: { maxConcurrent: number; maxDailyRequests: number; dayStartedAt: Date },
): Promise<AgentTaskReservation> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.transaction(async (tx) => {
    // Lock one stable expert row so quota checks and insertion are atomic.
    await tx.execute(sql`SELECT id FROM business_agents WHERE id = ${data.agentId} FOR UPDATE`);

    if (data.sourceMessageId) {
      const existing = await tx
        .select()
        .from(agentTasks)
        .where(and(
          eq(agentTasks.adoptId, data.adoptId),
          eq(agentTasks.agentId, data.agentId),
          eq(agentTasks.sourceMessageId, data.sourceMessageId),
        ))
        .limit(1);
      if (existing[0]) return { kind: "existing", task: existing[0] };
    }

    if (limits.maxConcurrent > 0) {
      const active = await tx
        .select({ count: sql<number>`count(*)` })
        .from(agentTasks)
        .where(and(
          eq(agentTasks.agentId, data.agentId),
          inArray(agentTasks.status, ["pending", "running"]),
        ));
      if (Number(active[0]?.count || 0) >= limits.maxConcurrent) {
        return { kind: "concurrency_exceeded" };
      }
    }

    if (limits.maxDailyRequests > 0) {
      const submitted = await tx
        .select({ count: sql<number>`count(*)` })
        .from(agentTasks)
        .where(and(
          eq(agentTasks.agentId, data.agentId),
          isNull(agentTasks.parentTaskId),
          gte(agentTasks.createdAt, limits.dayStartedAt),
        ));
      if (Number(submitted[0]?.count || 0) >= limits.maxDailyRequests) {
        return { kind: "daily_exceeded" };
      }
    }

    await tx.insert(agentTasks).values(data);
    return { kind: "created" };
  });
}
