import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
    .where(eq(businessAgents.enabled, 1))
    .orderBy(businessAgents.sortOrder);
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
      apiUrl: data.apiUrl,
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

export async function listAgentTasks(adoptId: string, limit = 30): Promise<any[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.adoptId, adoptId))
    .orderBy(desc(agentTasks.createdAt))
    .limit(Math.max(1, Math.min(100, Number(limit || 30))));
}

export async function updateAgentTask(id: string, fields: Record<string, any>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(agentTasks).set(fields).where(eq(agentTasks.id, id));
}

// ── TIL 审计查询（Day 4 审计面板）────────────────────────────────────
// business_agent_audit 与 business_agent_tenant_map 不在 drizzle schema 里（手建表），
// 通过 drizzle 的 sql 模板做参数化 raw query。

export type TenantAuditRow = {
  id: number;
  userId: number;
  tenantToken: string;
  tenantShort: string;
  agentId: string;
  action: string;
  sessionKey: string | null;
  meta: any;
  createdAt: Date;
  userName: string | null;
  userEmail: string | null;
};

function mapAuditRow(r: any): TenantAuditRow {
  let metaParsed: any = r.meta;
  try {
    if (typeof r.meta === "string" && r.meta.length > 0) metaParsed = JSON.parse(r.meta);
  } catch {}
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    tenantToken: String(r.tenant_token),
    tenantShort: String(r.tenant_token).slice(0, 16),
    agentId: String(r.agent_id),
    action: String(r.action),
    sessionKey: r.session_key ?? null,
    meta: metaParsed,
    createdAt: r.created_at,
    userName: r.user_name ?? null,
    userEmail: r.user_email ?? null,
  };
}

export async function listBusinessAgentAudit(params: {
  userId?: number;
  agentId?: string;
  fromIso?: string;
  toIso?: string;
  limit?: number;
}): Promise<TenantAuditRow[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  if (!db) return [];
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);

  const conditions: any[] = [];
  if (params.userId !== undefined) conditions.push(sql`a.user_id = ${params.userId}`);
  if (params.agentId) conditions.push(sql`a.agent_id = ${params.agentId}`);
  if (params.fromIso) conditions.push(sql`a.created_at >= ${params.fromIso}`);
  if (params.toIso) conditions.push(sql`a.created_at <= ${params.toIso}`);

  let whereSql = sql``;
  if (conditions.length > 0) {
    whereSql = sql`WHERE ${conditions[0]}`;
    for (let i = 1; i < conditions.length; i++) {
      whereSql = sql`${whereSql} AND ${conditions[i]}`;
    }
  }

  const result: any = await db.execute(sql`
    SELECT a.id, a.user_id, a.tenant_token, a.agent_id, a.action, a.session_key,
           a.meta, a.created_at,
           u.name AS user_name, u.email AS user_email
    FROM business_agent_audit a
    LEFT JOIN users u ON u.id = a.user_id
    ${whereSql}
    ORDER BY a.id DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  const rows = Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : [];
  return rows.map(mapAuditRow);
}

export type TenantReverseLookup = {
  tenantToken: string;
  tenantShort: string;
  userId: number | null;
  userName: string | null;
  userEmail: string | null;
  agentId: string | null;
  workspacePath: string | null;
  firstUsedAt: Date | null;
  lastUsedAt: Date | null;
  messageCount: number | null;
  auditHistory: TenantAuditRow[];
};

export async function reverseTenantToken(tenantToken: string): Promise<TenantReverseLookup> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const tokenShort = (tenantToken || "").slice(0, 16);

  if (!db || !tenantToken) {
    return {
      tenantToken,
      tenantShort: tokenShort,
      userId: null,
      userName: null,
      userEmail: null,
      agentId: null,
      workspacePath: null,
      firstUsedAt: null,
      lastUsedAt: null,
      messageCount: null,
      auditHistory: [],
    };
  }

  // 支持完整 token 或前 16 字符前缀匹配
  const mapResult: any = await db.execute(sql`
    SELECT m.user_id, m.agent_id, m.tenant_token, m.workspace_path,
           m.first_used_at, m.last_used_at, m.message_count,
           u.name AS user_name, u.email AS user_email
    FROM business_agent_tenant_map m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.tenant_token = ${tenantToken}
       OR m.tenant_token LIKE ${tenantToken + "%"}
    LIMIT 1
  `);
  const mapRows = Array.isArray(mapResult) ? (Array.isArray(mapResult[0]) ? mapResult[0] : mapResult) : [];
  const m = mapRows[0] || {};

  let auditHistory: TenantAuditRow[] = [];
  if (m.tenant_token) {
    const auditResult: any = await db.execute(sql`
      SELECT a.id, a.user_id, a.tenant_token, a.agent_id, a.action, a.session_key,
             a.meta, a.created_at,
             u.name AS user_name, u.email AS user_email
      FROM business_agent_audit a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.tenant_token = ${m.tenant_token}
      ORDER BY a.id DESC
      LIMIT 200
    `);
    const auditRows = Array.isArray(auditResult) ? (Array.isArray(auditResult[0]) ? auditResult[0] : auditResult) : [];
    auditHistory = auditRows.map(mapAuditRow);
  }

  return {
    tenantToken: m.tenant_token || tenantToken,
    tenantShort: (m.tenant_token || tenantToken).slice(0, 16),
    userId: m.user_id ?? null,
    userName: m.user_name ?? null,
    userEmail: m.user_email ?? null,
    agentId: m.agent_id ?? null,
    workspacePath: m.workspace_path ?? null,
    firstUsedAt: m.first_used_at ?? null,
    lastUsedAt: m.last_used_at ?? null,
    messageCount: m.message_count ?? null,
    auditHistory,
  };
}

export type TenantAuditStats = {
  totalAudit: number;
  totalTenantMap: number;
  uniqueUsers: number;
  uniqueTenants: number;
  byUser: Array<{ userId: number; userName: string | null; userEmail: string | null; count: number }>;
  byAgent: Array<{ agentId: string; count: number }>;
  byAction: Array<{ action: string; count: number }>;
  recentActivity: TenantAuditRow[];
};

export async function getTenantAuditStats(): Promise<TenantAuditStats> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  if (!db) {
    return {
      totalAudit: 0,
      totalTenantMap: 0,
      uniqueUsers: 0,
      uniqueTenants: 0,
      byUser: [],
      byAgent: [],
      byAction: [],
      recentActivity: [],
    };
  }

  const totals: any = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM business_agent_audit) AS total_audit,
      (SELECT COUNT(*) FROM business_agent_tenant_map) AS total_map,
      (SELECT COUNT(DISTINCT user_id) FROM business_agent_audit) AS unique_users,
      (SELECT COUNT(DISTINCT tenant_token) FROM business_agent_audit) AS unique_tenants
  `);
  const totalsRow = (Array.isArray(totals) ? (Array.isArray(totals[0]) ? totals[0] : totals) : [])[0] || {};

  const byUserResult: any = await db.execute(sql`
    SELECT a.user_id, u.name AS user_name, u.email AS user_email, COUNT(*) AS cnt
    FROM business_agent_audit a
    LEFT JOIN users u ON u.id = a.user_id
    GROUP BY a.user_id, u.name, u.email
    ORDER BY cnt DESC
    LIMIT 20
  `);
  const byUserRows = Array.isArray(byUserResult) ? (Array.isArray(byUserResult[0]) ? byUserResult[0] : byUserResult) : [];

  const byAgentResult: any = await db.execute(sql`
    SELECT agent_id, COUNT(*) AS cnt
    FROM business_agent_audit
    GROUP BY agent_id
    ORDER BY cnt DESC
  `);
  const byAgentRows = Array.isArray(byAgentResult) ? (Array.isArray(byAgentResult[0]) ? byAgentResult[0] : byAgentResult) : [];

  const byActionResult: any = await db.execute(sql`
    SELECT action, COUNT(*) AS cnt
    FROM business_agent_audit
    GROUP BY action
    ORDER BY cnt DESC
  `);
  const byActionRows = Array.isArray(byActionResult) ? (Array.isArray(byActionResult[0]) ? byActionResult[0] : byActionResult) : [];

  const recent = await listBusinessAgentAudit({ limit: 20 });

  return {
    totalAudit: Number(totalsRow.total_audit || 0),
    totalTenantMap: Number(totalsRow.total_map || 0),
    uniqueUsers: Number(totalsRow.unique_users || 0),
    uniqueTenants: Number(totalsRow.unique_tenants || 0),
    byUser: byUserRows.map((r: any) => ({
      userId: Number(r.user_id),
      userName: r.user_name ?? null,
      userEmail: r.user_email ?? null,
      count: Number(r.cnt),
    })),
    byAgent: byAgentRows.map((r: any) => ({ agentId: String(r.agent_id), count: Number(r.cnt) })),
    byAction: byActionRows.map((r: any) => ({ action: String(r.action), count: Number(r.cnt) })),
    recentActivity: recent,
  };
}
