import express from "express";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { clawAdoptions } from "../../drizzle/schema";
import { getClawByAdoptId, getDb } from "../db";
import { auditRequest, recordAuditBestEffort } from "./audit-events";

const mcpAuditSchema = z.object({
  action: z.enum(["mcp.tool.started", "mcp.tool.completed", "mcp.tool.failed"]).default("mcp.tool.completed"),
  mcpServer: z.string().optional(),
  serverId: z.string().optional(),
  toolName: z.string().min(1),
  adoptId: z.string().optional(),
  agentId: z.string().optional(),
  runtimeAgentId: z.string().optional(),
  userId: z.union([z.number(), z.string()]).optional(),
  roleTemplate: z.string().optional(),
  result: z.enum(["success", "failed", "denied", "warning"]).optional(),
  durationMs: z.number().optional(),
  errorCode: z.string().optional(),
  error: z.string().optional(),
  argsSummary: z.unknown().optional(),
  responseSummary: z.unknown().optional(),
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  correlationId: z.string().optional(),
  channel: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function auditIngestToken(): string {
  return String(
    process.env.EA_AUDIT_INGEST_TOKEN ||
    process.env.AUDIT_INGEST_TOKEN ||
    process.env.INTERNAL_API_KEY ||
    ""
  ).trim();
}

function requestToken(req: express.Request): string {
  const authorization = String(req.headers.authorization || "").trim();
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return String(req.headers["x-ea-audit-token"] || "").trim();
}

function isLocalAddress(value: string): boolean {
  const addr = value.replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

function isLocalRequest(req: express.Request): boolean {
  const candidates = [
    req.ip,
    req.socket.remoteAddress,
    String(req.headers["x-forwarded-for"] || "").split(",")[0]?.trim(),
  ].filter(Boolean) as string[];
  return candidates.some(isLocalAddress);
}

function authorizeAuditIngest(req: express.Request): boolean {
  const expected = auditIngestToken();
  if (expected) return requestToken(req) === expected;
  if (process.env.NODE_ENV === "production") return false;
  return isLocalRequest(req);
}

function deriveAdoptId(input: { adoptId?: string; agentId?: string; runtimeAgentId?: string }): string | null {
  const direct = String(input.adoptId || "").trim();
  if (direct) return direct;
  const candidate = String(input.agentId || input.runtimeAgentId || "").trim();
  if (!candidate) return null;
  const match = candidate.match(/(?:^|_)(lg[acj]-[a-z0-9-]+)$/i);
  if (match?.[1]) return match[1];
  const trial = candidate.match(/^trial_(lgc-[a-z0-9-]+)$/i);
  if (trial?.[1]) return trial[1];
  const jiuwen = candidate.match(/^jiuwen_(lgj-[a-z0-9-]+)$/i);
  if (jiuwen?.[1]) return jiuwen[1];
  return candidate.startsWith("lg") ? candidate : null;
}

async function findClawForAudit(input: { adoptId?: string; agentId?: string; runtimeAgentId?: string }) {
  const adoptId = deriveAdoptId(input);
  if (adoptId) {
    const claw = await getClawByAdoptId(adoptId).catch(() => null);
    if (claw) return claw;
  }

  const agentId = String(input.agentId || "").trim();
  const runtimeAgentId = String(input.runtimeAgentId || "").trim();
  const db = await getDb();
  if (!db || (!agentId && !runtimeAgentId)) return null;
  const conditions = [
    agentId ? eq(clawAdoptions.agentId, agentId) : null,
    runtimeAgentId ? eq(clawAdoptions.agentId, runtimeAgentId) : null,
    agentId ? eq(clawAdoptions.adoptId, agentId) : null,
    runtimeAgentId ? eq(clawAdoptions.adoptId, runtimeAgentId) : null,
  ].filter(Boolean) as any[];
  const where = conditions.length === 1 ? conditions[0] : or(...conditions);
  const rows = await db.select().from(clawAdoptions).where(and(where)).limit(1);
  return rows[0] || null;
}

function numericUserId(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function registerAuditIngestRoutes(app: express.Express) {
  app.post("/api/claw/audit/mcp-tool", async (req, res) => {
    try {
      if (!authorizeAuditIngest(req)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const parsed = mcpAuditSchema.parse(req.body || {});
      const mcpServer = String(parsed.mcpServer || parsed.serverId || "").trim();
      if (!mcpServer) {
        res.status(400).json({ error: "mcpServer required" });
        return;
      }

      const claw = await findClawForAudit(parsed);
      const runtimeAgentId = String(parsed.runtimeAgentId || parsed.agentId || (claw as any)?.agentId || "").trim() || null;
      const adoptId = String((claw as any)?.adoptId || deriveAdoptId(parsed) || "").trim() || null;
      const runtime = String((claw as any)?.runtime || "").trim() || (adoptId?.startsWith("lgj-") ? "jiuwenswarm" : "openclaw");
      const isFailed = parsed.action === "mcp.tool.failed" || parsed.result === "failed" || Boolean(parsed.error);

      const result = await recordAuditBestEffort({
        action: parsed.action,
        result: parsed.result || (isFailed ? "failed" : "success"),
        severity: isFailed ? "medium" : "info",
        actorType: (claw as any)?.userId || parsed.userId ? "user" : "system",
        actorUserId: numericUserId((claw as any)?.userId ?? parsed.userId),
        ...auditRequest(req),
        requestId: parsed.requestId || auditRequest(req).requestId || null,
        targetType: "mcp_tool",
        targetId: parsed.toolName.slice(0, 128),
        targetName: parsed.toolName.slice(0, 256),
        resourceType: "mcp_server",
        resourceId: mcpServer.slice(0, 128),
        resourceName: mcpServer.slice(0, 256),
        agentInstanceId: adoptId,
        runtimeType: runtime,
        runtimeAgentId,
        sessionId: parsed.sessionId || null,
        correlationId: parsed.correlationId || null,
        channel: parsed.channel || null,
        toolName: parsed.toolName.slice(0, 128),
        errorCode: parsed.errorCode || (isFailed ? "MCP_TOOL_CALL_FAILED" : null),
        metadata: {
          source: "audit_ingest",
          durationMs: parsed.durationMs ?? null,
          roleTemplate: parsed.roleTemplate || (claw as any)?.roleTemplate || null,
          args: parsed.argsSummary ?? null,
          response: parsed.responseSummary ?? null,
          error: parsed.error || null,
          ...(parsed.metadata || {}),
        },
      });

      res.json({ ok: true, eventId: result?.eventId || null, status: result?.status || "queued" });
    } catch (error: any) {
      if (error?.name === "ZodError") {
        res.status(400).json({ error: "invalid payload", issues: error.issues });
        return;
      }
      console.error("[audit-ingest] mcp audit failed", error);
      res.status(500).json({ error: "audit ingest failed" });
    }
  });
}
