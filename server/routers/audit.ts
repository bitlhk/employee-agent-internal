import { createHash, randomBytes } from "crypto";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import { and, count, desc, eq, gte, inArray, like, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  auditEvents,
  auditExports,
  auditSecurityFindings,
  auditToolEvents,
  adminMfaCredentials,
  skillMarketplace,
  users,
} from "../../drizzle/schema";
import { APP_ROOT } from "./helpers";
import { auditActor, auditErrorMetadata, auditRequest, recordAuditRequired } from "../_core/audit-events";
import { getAuditBaselineHealth } from "../_core/audit-health";
import {
  deriveSecurityOverviewStatus,
  ratioPercent,
  traceabilityCoverage,
  type SecurityCapabilityStatus,
} from "../_core/security-overview";

const EXPORT_DIR = path.join(APP_ROOT, "data", "audit-exports");
const EXPORT_TTL_MS = Number(process.env.AUDIT_EXPORT_TTL_MS || 24 * 60 * 60 * 1000);
const MAX_EXPORT_ROWS = Number(process.env.AUDIT_EXPORT_MAX_ROWS || 10000);

const auditFilterSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  action: z.string().trim().min(1).max(128).optional(),
  category: z.string().trim().min(1).max(64).optional(),
  actorUserId: z.number().int().positive().optional(),
  targetId: z.string().trim().min(1).max(128).optional(),
  agentInstanceId: z.string().trim().min(1).max(128).optional(),
  resourceType: z.string().trim().min(1).max(64).optional(),
  resourceName: z.string().trim().min(1).max(256).optional(),
  toolName: z.string().trim().min(1).max(128).optional(),
  result: z.enum(["success", "failed", "denied", "warning"]).optional(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  q: z.string().trim().min(1).max(128).optional(),
});

const auditListSchema = auditFilterSchema.extend({
  page: z.number().int().min(1).max(500).default(1),
  pageSize: z.number().int().min(10).max(200).default(50),
});

function buildConditions(input: z.infer<typeof auditFilterSchema>) {
  const conditions = [];
  if (input.from) conditions.push(gte(auditEvents.eventTime, new Date(input.from)));
  if (input.to) conditions.push(lte(auditEvents.eventTime, new Date(input.to)));
  if (input.action) conditions.push(eq(auditEvents.action, input.action));
  if (input.category) conditions.push(eq(auditEvents.category, input.category));
  if (input.actorUserId) conditions.push(eq(auditEvents.actorUserId, input.actorUserId));
  if (input.targetId) conditions.push(eq(auditEvents.targetId, input.targetId));
  if (input.agentInstanceId) conditions.push(eq(auditEvents.agentInstanceId, input.agentInstanceId));
  if (input.resourceType) conditions.push(eq(auditEvents.resourceType, input.resourceType));
  if (input.resourceName) conditions.push(like(auditEvents.resourceName, `%${input.resourceName.replace(/[%_]/g, "\\$&")}%`));
  if (input.toolName) conditions.push(eq(auditEvents.toolName, input.toolName));
  if (input.result) conditions.push(eq(auditEvents.result, input.result));
  if (input.severity) conditions.push(eq(auditEvents.severity, input.severity));
  if (input.q) {
    const pattern = `%${input.q.replace(/[%_]/g, "\\$&")}%`;
    conditions.push(or(
      like(auditEvents.eventId, pattern),
      like(auditEvents.action, pattern),
      like(auditEvents.actorEmail, pattern),
      like(auditEvents.targetName, pattern),
      like(auditEvents.resourceName, pattern),
      like(auditEvents.runtimeAgentId, pattern),
      like(auditEvents.agentInstanceId, pattern),
      like(auditEvents.toolName, pattern),
    ));
  }
  return conditions.length ? and(...conditions) : undefined;
}

function toPublicEvent(row: typeof auditEvents.$inferSelect) {
  return {
    eventId: row.eventId,
    eventTime: row.eventTime,
    category: row.category,
    action: row.action,
    result: row.result,
    severity: row.severity,
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    actorEmail: row.actorEmail,
    actorRole: row.actorRole,
    targetType: row.targetType,
    targetId: row.targetId,
    targetName: row.targetName,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    resourceName: row.resourceName,
    agentInstanceId: row.agentInstanceId,
    runtimeType: row.runtimeType,
    runtimeAgentId: row.runtimeAgentId,
    requestId: row.requestId,
    correlationId: row.correlationId,
    ip: row.ip,
    errorCode: row.errorCode,
    policyCode: row.policyCode,
    riskType: row.riskType,
    channel: row.channel,
    toolName: row.toolName,
    metadataJson: row.metadataJson,
    metadataTruncated: row.metadataTruncated,
  };
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function serializeExport(rows: Array<typeof auditEvents.$inferSelect>, format: "csv" | "json") {
  const publicRows = rows.map(toPublicEvent);
  if (format === "json") return `${JSON.stringify(publicRows, null, 2)}\n`;
  const columns: Array<keyof ReturnType<typeof toPublicEvent>> = [
    "eventId", "eventTime", "category", "action", "result", "severity", "actorType", "actorUserId",
    "actorEmail", "actorRole", "targetType", "targetId", "targetName", "resourceType", "resourceId",
    "resourceName", "agentInstanceId", "runtimeType", "runtimeAgentId", "requestId", "correlationId",
    "ip", "errorCode", "policyCode", "riskType", "channel", "toolName", "metadataTruncated", "metadataJson",
  ];
  return [
    columns.join(","),
    ...publicRows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n") + "\n";
}

function createExportId() {
  return `audexp_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

function fileHash(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function asNumber(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

async function optionalQuery<T>(operation: () => Promise<T>): Promise<{ available: true; value: T } | { available: false; value: null }> {
  try {
    return { available: true, value: await operation() };
  } catch {
    return { available: false, value: null };
  }
}

function capability(
  key: string,
  label: string,
  status: SecurityCapabilityStatus,
  detail: string,
) {
  return { key, label, status, detail };
}

export const auditRouter = router({
  overview: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "database unavailable" });

    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const agentRelevant = sql`(
      ${auditEvents.category} IN ('agent', 'runtime', 'mcp', 'tool', 'skill', 'file', 'browser', 'model')
      OR ${auditEvents.agentInstanceId} IS NOT NULL
      OR ${auditEvents.runtimeAgentId} IS NOT NULL
    )`;
    const runtimeRelevant = sql`(
      ${auditEvents.category} IN ('runtime', 'mcp', 'tool', 'skill', 'file', 'browser', 'model')
      OR ${auditEvents.runtimeType} IS NOT NULL
      OR ${auditEvents.runtimeAgentId} IS NOT NULL
    )`;
    const mcpRelevant = sql`(${auditEvents.category} = 'mcp' OR ${auditEvents.action} LIKE 'mcp.%')`;

    const [eventsResult, traceResult, recentResult, findingsResult, toolsResult, skillsResult, mfaResult, baseline] = await Promise.all([
      optionalQuery(async () => {
        const [row] = await db.select({
          total: count(),
          denied: sql<number>`COALESCE(SUM(CASE WHEN ${auditEvents.result} = 'denied' THEN 1 ELSE 0 END), 0)`,
          failed: sql<number>`COALESCE(SUM(CASE WHEN ${auditEvents.result} = 'failed' THEN 1 ELSE 0 END), 0)`,
          highRisk: sql<number>`COALESCE(SUM(CASE WHEN ${auditEvents.severity} IN ('high', 'critical') THEN 1 ELSE 0 END), 0)`,
        }).from(auditEvents).where(gte(auditEvents.eventTime, dayAgo));
        return row;
      }),
      optionalQuery(async () => {
        const [row] = await db.select({
          actorExpected: sql<number>`COALESCE(SUM(CASE WHEN ${auditEvents.actorType} = 'user' THEN 1 ELSE 0 END), 0)`,
          actorBound: sql<number>`COALESCE(SUM(CASE WHEN ${auditEvents.actorType} = 'user' AND ${auditEvents.actorUserId} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
          agentExpected: sql<number>`COALESCE(SUM(CASE WHEN ${agentRelevant} THEN 1 ELSE 0 END), 0)`,
          agentBound: sql<number>`COALESCE(SUM(CASE WHEN ${agentRelevant} AND ${auditEvents.agentInstanceId} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
          runtimeExpected: sql<number>`COALESCE(SUM(CASE WHEN ${runtimeRelevant} THEN 1 ELSE 0 END), 0)`,
          runtimeBound: sql<number>`COALESCE(SUM(CASE WHEN ${runtimeRelevant} AND ${auditEvents.runtimeAgentId} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
          mcpExpected: sql<number>`COALESCE(SUM(CASE WHEN ${mcpRelevant} THEN 1 ELSE 0 END), 0)`,
          mcpBound: sql<number>`COALESCE(SUM(CASE WHEN ${mcpRelevant} AND ${auditEvents.agentInstanceId} IS NOT NULL AND ${auditEvents.runtimeAgentId} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
        }).from(auditEvents).where(gte(auditEvents.eventTime, weekAgo));
        return row;
      }),
      optionalQuery(() => db.select({
        eventId: auditEvents.eventId,
        eventTime: auditEvents.eventTime,
        action: auditEvents.action,
        result: auditEvents.result,
        severity: auditEvents.severity,
        agentInstanceId: auditEvents.agentInstanceId,
        toolName: auditEvents.toolName,
      }).from(auditEvents)
        .where(and(
          gte(auditEvents.eventTime, weekAgo),
          or(ne(auditEvents.result, "success"), inArray(auditEvents.severity, ["high", "critical"])),
        ))
        .orderBy(desc(auditEvents.eventTime))
        .limit(5)),
      optionalQuery(async () => {
        const [row] = await db.select({
          total: count(),
          active: sql<number>`COALESCE(SUM(CASE WHEN ${auditSecurityFindings.status} IN ('open', 'acknowledged') THEN 1 ELSE 0 END), 0)`,
          highActive: sql<number>`COALESCE(SUM(CASE WHEN ${auditSecurityFindings.status} IN ('open', 'acknowledged') AND ${auditSecurityFindings.severity} IN ('high', 'critical') THEN 1 ELSE 0 END), 0)`,
        }).from(auditSecurityFindings);
        return row;
      }),
      optionalQuery(async () => {
        const [row] = await db.select({
          total: count(),
          denied: sql<number>`COALESCE(SUM(CASE WHEN ${auditToolEvents.policyDecision} = 'deny' THEN 1 ELSE 0 END), 0)`,
          allowed: sql<number>`COALESCE(SUM(CASE WHEN ${auditToolEvents.policyDecision} IN ('allow', 'rewrite') THEN 1 ELSE 0 END), 0)`,
          sandboxed: sql<number>`COALESCE(SUM(CASE WHEN ${auditToolEvents.policyDecision} IN ('allow', 'rewrite') AND ${auditToolEvents.executor} = 'sandbox' THEN 1 ELSE 0 END), 0)`,
          native: sql<number>`COALESCE(SUM(CASE WHEN ${auditToolEvents.policyDecision} IN ('allow', 'rewrite') AND ${auditToolEvents.executor} = 'native' THEN 1 ELSE 0 END), 0)`,
        }).from(auditToolEvents).where(gte(auditToolEvents.createdAt, weekAgo));
        return row;
      }),
      optionalQuery(async () => {
        const [row] = await db.select({
          total: count(),
          pending: sql<number>`COALESCE(SUM(CASE WHEN ${skillMarketplace.status} = 'pending' THEN 1 ELSE 0 END), 0)`,
          approved: sql<number>`COALESCE(SUM(CASE WHEN ${skillMarketplace.status} = 'approved' THEN 1 ELSE 0 END), 0)`,
          rejected: sql<number>`COALESCE(SUM(CASE WHEN ${skillMarketplace.status} = 'rejected' THEN 1 ELSE 0 END), 0)`,
          offline: sql<number>`COALESCE(SUM(CASE WHEN ${skillMarketplace.status} = 'offline' THEN 1 ELSE 0 END), 0)`,
        }).from(skillMarketplace);
        return row;
      }),
      optionalQuery(async () => {
        const [row] = await db.select({
          admins: sql<number>`COALESCE(SUM(CASE WHEN ${users.role} = 'admin' THEN 1 ELSE 0 END), 0)`,
          protectedAdmins: sql<number>`COALESCE(SUM(CASE WHEN ${users.role} = 'admin' AND ${adminMfaCredentials.enabled} = 1 THEN 1 ELSE 0 END), 0)`,
        }).from(users).leftJoin(adminMfaCredentials, eq(adminMfaCredentials.userId, users.id));
        return row;
      }),
      getAuditBaselineHealth({ db: db as any }),
    ]);

    const eventRow = eventsResult.value || {};
    const traceRow = traceResult.value || {};
    const findingRow = findingsResult.value || {};
    const toolRow = toolsResult.value || {};
    const skillRow = skillsResult.value || {};
    const mfaRow = mfaResult.value || {};
    const traceability = {
      actor: {
        bound: asNumber((traceRow as any).actorBound),
        expected: asNumber((traceRow as any).actorExpected),
        percent: ratioPercent(asNumber((traceRow as any).actorBound), asNumber((traceRow as any).actorExpected)),
      },
      agent: {
        bound: asNumber((traceRow as any).agentBound),
        expected: asNumber((traceRow as any).agentExpected),
        percent: ratioPercent(asNumber((traceRow as any).agentBound), asNumber((traceRow as any).agentExpected)),
      },
      runtime: {
        bound: asNumber((traceRow as any).runtimeBound),
        expected: asNumber((traceRow as any).runtimeExpected),
        percent: ratioPercent(asNumber((traceRow as any).runtimeBound), asNumber((traceRow as any).runtimeExpected)),
      },
      mcp: {
        bound: asNumber((traceRow as any).mcpBound),
        expected: asNumber((traceRow as any).mcpExpected),
        percent: ratioPercent(asNumber((traceRow as any).mcpBound), asNumber((traceRow as any).mcpExpected)),
      },
    };
    const events24h = {
      total: asNumber((eventRow as any).total),
      denied: asNumber((eventRow as any).denied),
      failed: asNumber((eventRow as any).failed),
      highRisk: asNumber((eventRow as any).highRisk),
    };
    const findings = {
      available: findingsResult.available,
      total: asNumber((findingRow as any).total),
      active: asNumber((findingRow as any).active),
      highActive: asNumber((findingRow as any).highActive),
    };
    const toolAudit = {
      available: toolsResult.available,
      total: asNumber((toolRow as any).total),
      denied: asNumber((toolRow as any).denied),
      allowed: asNumber((toolRow as any).allowed),
      sandboxed: asNumber((toolRow as any).sandboxed),
      native: asNumber((toolRow as any).native),
    };
    const skillReview = {
      available: skillsResult.available,
      total: asNumber((skillRow as any).total),
      pending: asNumber((skillRow as any).pending),
      approved: asNumber((skillRow as any).approved),
      rejected: asNumber((skillRow as any).rejected),
      offline: asNumber((skillRow as any).offline),
    };
    const adminMfa = {
      available: mfaResult.available,
      admins: asNumber((mfaRow as any).admins),
      protectedAdmins: asNumber((mfaRow as any).protectedAdmins),
    };
    const ledger = {
      available: baseline.ledger.exists,
      healthy: baseline.ok,
      totalEvents: baseline.ledger.rowCount || 0,
      oldestAt: baseline.ledger.oldestEventTime,
      newestAt: baseline.ledger.newestEventTime,
      dlqEvents: baseline.dlq?.eventCount || 0,
      permissionsOk: baseline.permissions.ok,
      triggersOk: baseline.triggers.ok,
      warningCount: baseline.warnings.length,
    };
    const overall = deriveSecurityOverviewStatus({
      ledgerAvailable: eventsResult.available && ledger.available,
      ledgerHealthy: ledger.healthy,
      hasLedgerEvents: ledger.totalEvents > 0,
      failedEvents24h: events24h.failed,
      deniedEvents24h: events24h.denied,
      highRiskEvents24h: events24h.highRisk,
      activeFindings: findings.active,
      highRiskFindings: findings.highActive,
      dlqEvents: ledger.dlqEvents,
      nativeExecutions7d: toolAudit.native,
      traceabilityPercents: [traceability.actor.percent, traceability.agent.percent, traceability.runtime.percent, traceability.mcp.percent],
    });

    let sandboxStatus: SecurityCapabilityStatus = "unverified";
    let sandboxDetail = "近7天没有可用于判断执行隔离的工具记录";
    if (toolAudit.native > 0) {
      sandboxStatus = "risk";
      sandboxDetail = `${toolAudit.native} 次工具调用记录为宿主机执行`;
    } else if (toolAudit.allowed > 0 && toolAudit.sandboxed === toolAudit.allowed) {
      sandboxStatus = "covered";
      sandboxDetail = `${toolAudit.sandboxed} 次允许执行均记录为沙箱`;
    } else if (toolAudit.sandboxed > 0) {
      sandboxStatus = "partial";
      sandboxDetail = `${toolAudit.sandboxed}/${toolAudit.allowed} 次允许执行记录为沙箱`;
    } else if (toolAudit.allowed > 0) {
      sandboxDetail = `${toolAudit.allowed} 次允许执行缺少可识别的执行器证据`;
    }

    const capabilities = [
      capability(
        "agent_identity",
        "Agent 身份绑定",
        traceabilityCoverage(traceability.agent.bound, traceability.agent.expected),
        traceability.agent.percent === null ? "近7天没有相关事件" : `${traceability.agent.bound}/${traceability.agent.expected} 个事件可追溯`,
      ),
      capability(
        "mcp_identity",
        "MCP 身份绑定",
        traceabilityCoverage(traceability.mcp.bound, traceability.mcp.expected),
        traceability.mcp.percent === null ? "近7天没有 MCP 事件" : `${traceability.mcp.bound}/${traceability.mcp.expected} 个事件绑定 Agent 与 Runtime`,
      ),
      capability(
        "audit_ledger",
        "审计账本完整性",
        !ledger.available ? "unverified" : ledger.healthy ? "covered" : "partial",
        !ledger.available ? "审计账本不可用" : ledger.healthy ? "权限与防篡改基线正常" : `${ledger.warningCount} 项基线需要检查`,
      ),
      capability(
        "tool_policy",
        "工具策略审计",
        !toolAudit.available || toolAudit.total === 0 ? "unverified" : "covered",
        !toolAudit.available ? "工具审计表不可用" : toolAudit.total === 0 ? "近7天没有工具策略记录" : `${toolAudit.total} 次决策，阻断 ${toolAudit.denied} 次`,
      ),
      capability("runtime_sandbox", "运行时沙箱", sandboxStatus, sandboxDetail),
      capability(
        "skill_review",
        "技能上架审核",
        !skillReview.available ? "unverified" : "covered",
        !skillReview.available ? "技能审核数据不可用" : `${skillReview.approved} 个已通过，${skillReview.pending} 个待审核`,
      ),
      capability(
        "admin_mfa",
        "管理员二次验证",
        !adminMfa.available || adminMfa.admins === 0
          ? "unverified"
          : adminMfa.protectedAdmins === adminMfa.admins ? "covered" : adminMfa.protectedAdmins > 0 ? "partial" : "risk",
        !adminMfa.available
          ? "管理员二次验证状态不可用"
          : `${adminMfa.protectedAdmins}/${adminMfa.admins} 个管理员已启用`,
      ),
      capability("workspace_isolation", "工作区隔离", "unverified", "尚未接入可验证的运行时策略证据"),
    ];

    return {
      checkedAt: baseline.checkedAt,
      status: overall.status,
      reasons: overall.reasons,
      events24h,
      traceability7d: traceability,
      findings,
      ledger,
      toolAudit7d: toolAudit,
      skillReview,
      adminMfa,
      capabilities,
      recentRisks: (recentResult.value || []).map((event) => ({
        ...event,
        eventTime: event.eventTime instanceof Date ? event.eventTime.toISOString() : event.eventTime,
      })),
    };
  }),

  listEvents: adminProcedure
    .input(auditListSchema)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "database unavailable" });
      const where = buildConditions(input);
      const offset = (input.page - 1) * input.pageSize;
      const [totalRow] = await db.select({ total: count() }).from(auditEvents).where(where);
      const rows = await db
        .select()
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.eventTime), desc(auditEvents.id))
        .limit(input.pageSize)
        .offset(offset);
      return {
        rows: rows.map(toPublicEvent),
        total: Number(totalRow?.total || 0),
        page: input.page,
        pageSize: input.pageSize,
      };
    }),

  listExports: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "database unavailable" });
    const rows = await db.select().from(auditExports).orderBy(desc(auditExports.createdAt)).limit(50);
    return rows.map((row) => ({
      exportId: row.exportId,
      actorUserId: row.actorUserId,
      actorEmail: row.actorEmail,
      filtersJson: row.filtersJson,
      format: row.format,
      rowCount: row.rowCount,
      fileHash: row.fileHash,
      fileSizeBytes: row.fileSizeBytes,
      encrypted: row.encrypted,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      downloadUrl: `/api/audit/exports/${encodeURIComponent(row.exportId)}/download`,
    }));
  }),

  createExport: adminProcedure
    .input(auditFilterSchema.extend({ format: z.enum(["csv", "json"]).default("csv") }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "database unavailable" });

      const exportId = createExportId();
      await recordAuditRequired({
        action: "audit.export.requested",
        ...auditActor(ctx.user),
        ...auditRequest(ctx.req),
        targetType: "audit_export",
        targetId: exportId,
        metadata: { format: input.format, filters: input },
      });

      try {
        const where = buildConditions(input);
        const rows = await db
          .select()
          .from(auditEvents)
          .where(where)
          .orderBy(desc(auditEvents.eventTime), desc(auditEvents.id))
          .limit(MAX_EXPORT_ROWS);
        const content = serializeExport(rows, input.format);
        const hash = fileHash(content);
        const fileSizeBytes = Buffer.byteLength(content, "utf8");
        const storageKey = `${exportId}.${input.format}`;
        const filePath = path.join(EXPORT_DIR, storageKey);
        const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);

        await mkdir(EXPORT_DIR, { recursive: true });
        await writeFile(filePath, content, "utf8");
        await db.insert(auditExports).values({
          exportId,
          actorUserId: ctx.user.id,
          actorEmail: ctx.user.email || null,
          filtersJson: input,
          format: input.format,
          rowCount: rows.length,
          storageKey,
          fileHash: hash,
          fileSizeBytes,
          encrypted: false,
          expiresAt,
        });

        await recordAuditRequired({
          action: "audit.export.completed",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "audit_export",
          targetId: exportId,
          metadata: {
            format: input.format,
            rowCount: rows.length,
            fileSizeBytes,
            fileHash: hash,
            storageKey,
            expiresAt: expiresAt.toISOString(),
          },
        });

        return {
          exportId,
          rowCount: rows.length,
          fileSizeBytes,
          fileHash: hash,
          expiresAt,
          downloadUrl: `/api/audit/exports/${encodeURIComponent(exportId)}/download`,
        };
      } catch (error) {
        try {
          await recordAuditRequired({
            action: "audit.export.failed",
            result: "failed",
            severity: "high",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "audit_export",
            targetId: exportId,
            errorCode: "AUDIT_EXPORT_FAILED",
            metadata: {
              format: input.format,
              filters: input,
              ...auditErrorMetadata(error),
            },
          });
        } catch (auditError) {
          console.error("[AUDIT-EXPORT] failed to record export failure", auditError);
        }
        throw error;
      }
    }),
});

export async function getAuditExportRecord(exportId: string) {
  const db = await getDb();
  if (!db) throw new Error("database unavailable");
  const rows = await db.select().from(auditExports).where(eq(auditExports.exportId, exportId)).limit(1);
  const record = rows[0];
  return record || null;
}

export async function getAuditExportFile(exportId: string) {
  const record = await getAuditExportRecord(exportId);
  if (!record) return null;
  const filePath = path.join(EXPORT_DIR, record.storageKey);
  const [file, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
  const hash = fileHash(file);
  if (hash !== record.fileHash) throw new Error("audit export hash mismatch");
  if (Number(fileStat.size) !== Number(record.fileSizeBytes)) throw new Error("audit export size mismatch");
  return { record, filePath };
}
