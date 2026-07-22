import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { auditEvents, businessAgents, skillMarketplace, agentCallLogs, agentTasks, BusinessAgent, InsertBusinessAgent, InsertAgentTask } from "../../drizzle/schema";
import { getDb } from "./connection";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../_core/secret-protection";

function revealBusinessAgentToken(agent: BusinessAgent): BusinessAgent {
  if (!agent.apiToken) return agent;
  return { ...agent, apiToken: decryptSecret(agent.apiToken) };
}

async function protectLegacyBusinessAgentTokens(db: Awaited<ReturnType<typeof getDb>>, agents: BusinessAgent[]): Promise<void> {
  if (!db) return;
  for (const agent of agents) {
    if (!agent.apiToken || isEncryptedSecret(agent.apiToken)) continue;
    await db
      .update(businessAgents)
      .set({ apiToken: encryptSecret(agent.apiToken, { maxStoredLength: null }) })
      .where(eq(businessAgents.id, agent.id));
  }
}

// ── Business Agents CRUD ────────────────────────────────────────────────
export async function listBusinessAgents(): Promise<BusinessAgent[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(businessAgents).orderBy(businessAgents.sortOrder);
  await protectLegacyBusinessAgentTokens(db, rows);
  return rows.map(revealBusinessAgentToken);
}

export async function listEnabledBusinessAgents(): Promise<BusinessAgent[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(businessAgents)
    .where(and(eq(businessAgents.enabled, 1), isNull(businessAgents.deletedAt)))
    .orderBy(businessAgents.sortOrder);
  await protectLegacyBusinessAgentTokens(db, rows);
  return rows.map(revealBusinessAgentToken);
}

export type BusinessAgentOwnerContext = {
  userId: number;
  adoptId: string;
};

export async function listEnabledBusinessAgentsForContext(
  context: BusinessAgentOwnerContext,
): Promise<BusinessAgent[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(businessAgents)
    .where(and(
      eq(businessAgents.enabled, 1),
      isNull(businessAgents.deletedAt),
      or(
        eq(businessAgents.visibility, "platform"),
        and(
          eq(businessAgents.visibility, "personal"),
          eq(businessAgents.ownerUserId, context.userId),
          eq(businessAgents.ownerAdoptId, context.adoptId),
        ),
      ),
    ))
    .orderBy(businessAgents.sortOrder, businessAgents.createdAt);
  await protectLegacyBusinessAgentTokens(db, rows);
  return rows.map(revealBusinessAgentToken);
}

export async function getBusinessAgent(id: string): Promise<BusinessAgent | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(businessAgents).where(eq(businessAgents.id, id)).limit(1);
  await protectLegacyBusinessAgentTokens(db, rows);
  return rows[0] ? revealBusinessAgentToken(rows[0]) : undefined;
}

export async function getBusinessAgentForContext(
  id: string,
  context: BusinessAgentOwnerContext,
): Promise<BusinessAgent | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(businessAgents).where(and(
    eq(businessAgents.id, id),
    isNull(businessAgents.deletedAt),
    or(
      eq(businessAgents.visibility, "platform"),
      and(
        eq(businessAgents.visibility, "personal"),
        eq(businessAgents.ownerUserId, context.userId),
        eq(businessAgents.ownerAdoptId, context.adoptId),
      ),
    ),
  )).limit(1);
  await protectLegacyBusinessAgentTokens(db, rows);
  return rows[0] ? revealBusinessAgentToken(rows[0]) : undefined;
}

export async function listPersonalBusinessAgents(
  context: BusinessAgentOwnerContext,
): Promise<BusinessAgent[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(businessAgents).where(and(
    eq(businessAgents.visibility, "personal"),
    eq(businessAgents.ownerUserId, context.userId),
    eq(businessAgents.ownerAdoptId, context.adoptId),
    isNull(businessAgents.deletedAt),
  )).orderBy(businessAgents.createdAt);
  await protectLegacyBusinessAgentTokens(db, rows);
  return rows.map(revealBusinessAgentToken);
}

export async function getPersonalBusinessAgent(
  id: string,
  context: BusinessAgentOwnerContext,
): Promise<BusinessAgent | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(businessAgents).where(and(
    eq(businessAgents.id, id),
    eq(businessAgents.visibility, "personal"),
    eq(businessAgents.ownerUserId, context.userId),
    eq(businessAgents.ownerAdoptId, context.adoptId),
    isNull(businessAgents.deletedAt),
  )).limit(1);
  await protectLegacyBusinessAgentTokens(db, rows);
  return rows[0] ? revealBusinessAgentToken(rows[0]) : undefined;
}

export async function createPersonalBusinessAgent(data: InsertBusinessAgent): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(businessAgents).values({
    ...data,
    apiToken: data.apiToken
      ? encryptSecret(String(data.apiToken), { maxStoredLength: null })
      : data.apiToken,
  });
}

export async function updatePersonalBusinessAgent(
  id: string,
  context: BusinessAgentOwnerContext,
  patch: Partial<InsertBusinessAgent>,
): Promise<BusinessAgent | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const protectedPatch: Record<string, unknown> = { ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, "apiToken")) {
    protectedPatch.apiToken = patch.apiToken
      ? encryptSecret(String(patch.apiToken), { maxStoredLength: null })
      : patch.apiToken;
  }
  await db.update(businessAgents).set(protectedPatch).where(and(
    eq(businessAgents.id, id),
    eq(businessAgents.visibility, "personal"),
    eq(businessAgents.ownerUserId, context.userId),
    eq(businessAgents.ownerAdoptId, context.adoptId),
    isNull(businessAgents.deletedAt),
  ));
  return getPersonalBusinessAgent(id, context);
}

export async function deletePersonalBusinessAgent(
  id: string,
  context: BusinessAgentOwnerContext,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(businessAgents).set({
    enabled: 0,
    apiUrl: null,
    apiToken: null,
    endpointDigest: null,
    deletedAt: new Date(),
  }).where(and(
    eq(businessAgents.id, id),
    eq(businessAgents.visibility, "personal"),
    eq(businessAgents.ownerUserId, context.userId),
    eq(businessAgents.ownerAdoptId, context.adoptId),
    isNull(businessAgents.deletedAt),
  ));
}

export async function upsertBusinessAgent(data: InsertBusinessAgent): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const protectedData = {
    ...data,
    apiToken: data.apiToken
      ? encryptSecret(String(data.apiToken), { maxStoredLength: null })
      : data.apiToken,
  };
  await db.insert(businessAgents).values(protectedData)
    .onDuplicateKeyUpdate({ set: {
      name: data.name,
      description: data.description,
      kind: data.kind,
      visibility: data.visibility,
      ownerUserId: data.ownerUserId,
      ownerAdoptId: data.ownerAdoptId,
      apiUrl: data.apiUrl,
      endpointDigest: data.endpointDigest,
      apiToken: protectedData.apiToken,
      remoteAgentId: data.remoteAgentId,
      localAgentId: data.localAgentId,
      skills: data.skills,
      icon: data.icon,
      enabled: data.enabled,
      sortOrder: data.sortOrder,
      expiresAt: data.expiresAt,
      maxDailyRequests: data.maxDailyRequests,
      allowedProfiles: data.allowedProfiles,
      tags: data.tags,
      systemPrompt: data.systemPrompt,
      uiConfig: data.uiConfig,
      providerType: (data as any).providerType,
      adapterProtocol: (data as any).adapterProtocol,
      capabilitiesJson: (data as any).capabilitiesJson,
      endpointConfigJson: (data as any).endpointConfigJson,
      deletedAt: data.deletedAt,
    }});
}

export async function deleteBusinessAgent(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(businessAgents).where(eq(businessAgents.id, id));
}

export async function updateBusinessAgentEnabled(id: string, enabled: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(businessAgents).set({ enabled }).where(eq(businessAgents.id, id));
}


// ── 技能市场 DB helpers ──
export async function listSkillMarketItems(status?: string): Promise<any[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  if (status && status !== "all") {
    return db.select().from(skillMarketplace).where(eq(skillMarketplace.status, status as any)).orderBy(skillMarketplace.createdAt);
  }
  return db.select().from(skillMarketplace).orderBy(skillMarketplace.createdAt);
}

export async function listApprovedSkillMarketItems(): Promise<any[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(skillMarketplace).where(eq(skillMarketplace.status, "approved")).orderBy(skillMarketplace.downloadCount);
}

export async function getSkillMarketItem(id: number): Promise<any | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(skillMarketplace).where(eq(skillMarketplace.id, id)).limit(1);
  return rows[0];
}

export async function insertSkillMarketItem(data: any): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(skillMarketplace).values(data);
  return Number(result[0].insertId);
}

export async function updateSkillMarketItem(id: number, data: Record<string, any>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(skillMarketplace).set(data).where(eq(skillMarketplace.id, id));
}

export async function deleteSkillMarketItem(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(skillMarketplace).where(eq(skillMarketplace.id, id));
}

export async function incrementSkillDownload(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`UPDATE skill_marketplace SET download_count = download_count + 1 WHERE id = ${id}`);
}

export async function listSkillInvocationCounts(skillIds: string[]): Promise<Record<string, number>> {
  const normalized = [...new Set(skillIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (normalized.length === 0) return {};
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({
      skillId: auditEvents.resourceId,
      count: sql<number>`count(*)`,
    })
    .from(auditEvents)
    .where(and(
      eq(auditEvents.action, "skill.invoked"),
      eq(auditEvents.resourceType, "skill"),
      inArray(auditEvents.resourceId, normalized),
    ))
    .groupBy(auditEvents.resourceId);
  const out: Record<string, number> = {};
  for (const row of rows) {
    const skillId = String(row.skillId || "").trim();
    if (skillId) out[skillId] = Number(row.count || 0);
  }
  return out;
}

export async function listMcpInvocationCounts(serverIds: string[]): Promise<Record<string, { total: number; tools: Record<string, number> }>> {
  const normalized = [...new Set(serverIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (normalized.length === 0) return {};
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({
      serverId: auditEvents.resourceId,
      toolName: auditEvents.toolName,
      count: sql<number>`count(*)`,
    })
    .from(auditEvents)
    .where(and(
      eq(auditEvents.action, "mcp.tool.completed"),
      eq(auditEvents.resourceType, "mcp_server"),
      inArray(auditEvents.resourceId, normalized),
    ))
    .groupBy(auditEvents.resourceId, auditEvents.toolName);
  const out: Record<string, { total: number; tools: Record<string, number> }> = {};
  for (const row of rows) {
    const serverId = String(row.serverId || "").trim();
    if (!serverId) continue;
    const toolName = String(row.toolName || "").trim() || "_unknown";
    const count = Number(row.count || 0);
    const bucket = out[serverId] || { total: 0, tools: {} };
    bucket.total += count;
    bucket.tools[toolName] = (bucket.tools[toolName] || 0) + count;
    out[serverId] = bucket;
  }
  return out;
}


// ── Agent 调用日志 + 健康检查 DB helpers ──
export async function insertCallLog(data: { agentId: string; userId?: number; adoptId?: string; status: "success" | "error" | "timeout"; durationMs: number; errorMessage?: string }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(agentCallLogs).values(data as any);
}

export async function getCallLogs(agentId: string, limit = 50): Promise<any[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.select().from(agentCallLogs).where(eq(agentCallLogs.agentId, agentId)).orderBy(desc(agentCallLogs.createdAt)).limit(limit);
}

export async function getCallStats(agentId: string): Promise<{ total: number; today: number; errors: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const all = await db.select().from(agentCallLogs).where(eq(agentCallLogs.agentId, agentId));
  const today = all.filter(r => new Date(r.createdAt) >= todayStart);
  const errors = all.filter(r => r.status !== "success");
  return { total: all.length, today: today.length, errors: errors.length };
}

export async function updateAgentHealth(id: string, healthStatus: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(businessAgents).set({ healthStatus: healthStatus as any, lastHealthCheck: new Date() } as any).where(eq(businessAgents.id, id));
}

export async function updateAgentFields(id: string, fields: Record<string, any>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const protectedFields = {
    ...fields,
    ...(fields.apiToken
      ? { apiToken: encryptSecret(String(fields.apiToken), { maxStoredLength: null }) }
      : {}),
  };
  await db.update(businessAgents).set(protectedFields).where(eq(businessAgents.id, id));
}

export async function createAgentTask(data: InsertAgentTask): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(agentTasks).values(data as any);
}

export async function getAgentTask(id: string): Promise<any | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(agentTasks).where(eq(agentTasks.id, id)).limit(1);
  return rows[0];
}

export async function getAgentTaskBySourceMessage(adoptId: string, sourceMessageId: string): Promise<any | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(agentTasks).where(and(
    eq(agentTasks.adoptId, adoptId),
    eq(agentTasks.sourceMessageId, sourceMessageId),
  )).limit(1);
  return rows[0];
}

export async function listAgentTasks(adoptId: string, limit = 30): Promise<any[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({ task: agentTasks, agentName: businessAgents.name })
    .from(agentTasks)
    .leftJoin(businessAgents, eq(agentTasks.agentId, businessAgents.id))
    .where(eq(agentTasks.adoptId, adoptId))
    .orderBy(desc(agentTasks.createdAt))
    .limit(Math.max(1, Math.min(100, Number(limit || 30))));
  return rows.map((row) => ({ ...row.task, agentName: row.agentName || row.task.agentId }));
}

export async function listAgentTasksByIds(adoptId: string, ids: string[]): Promise<any[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const taskIds = Array.from(new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))).slice(0, 64);
  if (taskIds.length === 0) return [];
  const rows = await db
    .select({ task: agentTasks, agentName: businessAgents.name })
    .from(agentTasks)
    .leftJoin(businessAgents, eq(agentTasks.agentId, businessAgents.id))
    .where(and(eq(agentTasks.adoptId, adoptId), inArray(agentTasks.id, taskIds)))
    .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id));
  return rows.map((row) => ({ ...row.task, agentName: row.agentName || row.task.agentId }));
}

export async function listAgentTasksForHistory(adoptId: string, limit = 500): Promise<any[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({ task: agentTasks, agentName: businessAgents.name })
    .from(agentTasks)
    .leftJoin(businessAgents, eq(agentTasks.agentId, businessAgents.id))
    .where(and(eq(agentTasks.adoptId, adoptId), isNotNull(agentTasks.sourceConversationId)))
    .orderBy(desc(agentTasks.createdAt), desc(agentTasks.id))
    .limit(Math.max(1, Math.min(1000, Number(limit || 500))));
  return rows.map((row) => ({ ...row.task, agentName: row.agentName || row.task.agentId }));
}

export async function listAgentTasksByConversation(
  adoptId: string,
  conversationId: string,
  limit = 100,
): Promise<any[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({ task: agentTasks, agentName: businessAgents.name })
    .from(agentTasks)
    .leftJoin(businessAgents, eq(agentTasks.agentId, businessAgents.id))
    .where(and(
      eq(agentTasks.adoptId, adoptId),
      eq(agentTasks.sourceConversationId, conversationId),
    ))
    .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id))
    .limit(Math.max(1, Math.min(200, Number(limit || 100))));
  return rows.map((row) => ({ ...row.task, agentName: row.agentName || row.task.agentId }));
}

export async function deleteAgentTasksByConversation(adoptId: string, conversationId: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(and(
      eq(agentTasks.adoptId, adoptId),
      eq(agentTasks.sourceConversationId, conversationId),
    ));
  if (rows.length === 0) return 0;
  await db.delete(agentTasks).where(and(
    eq(agentTasks.adoptId, adoptId),
    eq(agentTasks.sourceConversationId, conversationId),
  ));
  return rows.length;
}

export async function countActiveAgentTasks(agentId: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(agentTasks)
    .where(and(
      eq(agentTasks.agentId, agentId),
      inArray(agentTasks.status, ["pending", "running"]),
    ));
  return Number(rows[0]?.count || 0);
}

export async function listAgentTaskCounts(adoptId: string, agentIds: string[]): Promise<Record<string, number>> {
  const normalized = [...new Set(agentIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!adoptId || normalized.length === 0) return {};
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({
      agentId: agentTasks.agentId,
      count: sql<number>`count(*)`,
    })
    .from(agentTasks)
    .where(and(eq(agentTasks.adoptId, adoptId), inArray(agentTasks.agentId, normalized)))
    .groupBy(agentTasks.agentId);
  return Object.fromEntries(rows.map((row) => [String(row.agentId), Number(row.count || 0)]));
}

export async function countAgentCallsSince(agentId: string, since: Date): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(agentCallLogs)
    .where(and(eq(agentCallLogs.agentId, agentId), gte(agentCallLogs.createdAt, since)));
  return Number(rows[0]?.count || 0);
}

export async function updateAgentTask(id: string, fields: Record<string, any>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(agentTasks).set(fields).where(eq(agentTasks.id, id));
}

export async function answerAgentTaskInteractionAndCreate(
  taskId: string,
  context: BusinessAgentOwnerContext,
  responseJson: string,
  continuation: InsertAgentTask,
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(agentTasks)
      .set({
        interactionStatus: "answered",
        interactionResponseJson: responseJson,
        interactionAnsweredAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(
        eq(agentTasks.id, taskId),
        eq(agentTasks.adoptId, context.adoptId),
        eq(agentTasks.userId, context.userId),
        eq(agentTasks.interactionStatus, "pending"),
      ));
    if (Number((updated as any)?.[0]?.affectedRows || 0) !== 1) return false;
    await tx.insert(agentTasks).values(continuation as any);
    return true;
  });
}
