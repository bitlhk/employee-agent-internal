import type { Request } from "express";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { auditEvents } from "../../drizzle/schema";
import { getDb } from "../db";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { OpenClawRuntimeAdapter } from "./runtime/openclaw-runtime-adapter";

type OpenClawToolAuditInput = {
  runtimeAgentId: string;
  sessionKey: string;
  adoptId: string;
  userId?: number | null;
  startedAtMs?: number;
  endedAtMs?: number;
  channel?: string | null;
  transport?: "http" | "ws" | string;
  req?: Request;
};

const seenEventIds = new Set<string>();

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      return Object.keys(item as Record<string, unknown>).sort().reduce((acc: Record<string, unknown>, key) => {
        acc[key] = (item as Record<string, unknown>)[key];
        return acc;
      }, {});
    });
  } catch {
    return String(value);
  }
}

function eventIdFor(event: any, runtimeAgentId: string, sessionKey: string) {
  const raw = [
    runtimeAgentId,
    sessionKey,
    event?.traceId || "",
    event?.runId || "",
    event?.seq || "",
    event?.type || "",
    event?.data?.toolCallId || event?.data?.itemId || "",
  ].join("|");
  return `oc_tool_${sha256(raw).slice(0, 56)}`;
}

function skillEventIdFor(event: any, runtimeAgentId: string, sessionKey: string, skillId: string) {
  const raw = [
    runtimeAgentId,
    sessionKey,
    event?.traceId || "",
    event?.runId || "",
    event?.seq || "",
    event?.type || "",
    event?.data?.toolCallId || event?.data?.itemId || "",
    skillId,
  ].join("|");
  return `skill_${sha256(raw).slice(0, 58)}`;
}

async function auditEventExists(eventId: string) {
  if (seenEventIds.has(eventId)) return true;
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ eventId: auditEvents.eventId }).from(auditEvents).where(eq(auditEvents.eventId, eventId)).limit(1);
  const exists = rows.length > 0;
  if (exists) seenEventIds.add(eventId);
  return exists;
}

function eventTimeMs(event: any) {
  const ts = event?.ts ? new Date(String(event.ts)).getTime() : 0;
  return Number.isFinite(ts) ? ts : 0;
}

function summarizeArgs(args: unknown) {
  const source = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const json = stableJson(source);
  return {
    argsHash: sha256(json),
    argsBytes: Buffer.byteLength(json, "utf8"),
    fieldNames: Object.keys(source).sort(),
  };
}

function summarizeResult(result: unknown) {
  const json = stableJson(result ?? null);
  return {
    resultHash: sha256(json),
    resultBytes: Buffer.byteLength(json, "utf8"),
  };
}

export function inferMcpServerFromOpenClawToolName(toolName: string): string | null {
  const name = String(toolName || "").trim();
  if (!name) return null;
  const mcpTool = name.match(/^mcp_([a-zA-Z0-9_]+)__[a-zA-Z0-9_]+$/);
  if (mcpTool?.[1]) return mcpTool[1];
  return null;
}

export function inferSkillIdFromToolArgs(args: unknown): string | null {
  const json = stableJson(args);
  const patterns = [
    /(?:^|[/"'\s])(?:skills|skills-shared|temp-skills\/skills)\/([a-zA-Z0-9._-]+)(?:\/|["'\s]|$)/,
    /(?:^|[/"'\s])\.codex\/skills\/[^/"'\s]+\/([a-zA-Z0-9._-]+)(?:\/|["'\s]|$)/,
    /(?:^|[/"'\s])\.agents\/skills\/([a-zA-Z0-9._-]+)(?:\/|["'\s]|$)/,
  ];
  for (const pattern of patterns) {
    const match = json.match(pattern);
    const skillId = String(match?.[1] || "").trim();
    if (skillId && skillId !== "SKILL.md") return skillId;
  }
  const named = json.match(/"skill(?:Id|_id|Name|_name)"\s*:\s*"([a-zA-Z0-9._-]+)"/);
  return String(named?.[1] || "").trim() || null;
}

async function reconcileOpenClawToolAuditNow(input: OpenClawToolAuditInput) {
  const runtimeAgentId = String(input.runtimeAgentId || "").trim();
  const sessionKey = String(input.sessionKey || "").trim();
  if (!runtimeAgentId || !sessionKey) return;

  const adapter = new OpenClawRuntimeAdapter();
  const session = adapter.getSessionId(runtimeAgentId, sessionKey);
  if (!session.ok) return;
  const trajectory = adapter.readTrajectoryText(runtimeAgentId, session.sessionId);
  if (!trajectory.ok) return;

  const lower = Math.max(0, Number(input.startedAtMs || 0) - 10_000);
  const upper = Number(input.endedAtMs || Date.now()) + 60_000;
  for (const line of trajectory.text.split("\n")) {
    if (!line.includes('"type":"tool.')) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.sessionKey !== sessionKey) continue;
    if (event?.type !== "tool.call" && event?.type !== "tool.result") continue;
    const at = eventTimeMs(event);
    if (at && lower && at < lower) continue;
    if (at && at > upper) continue;

    const data = event?.data && typeof event.data === "object" ? event.data : {};
    const toolName = String(data.name || data.toolName || "tool").slice(0, 128);
    const eventId = eventIdFor(event, runtimeAgentId, sessionKey);
    if (await auditEventExists(eventId)) continue;

    const isResult = event.type === "tool.result";
    const isError = Boolean(data.isError || data.status === "failed" || data.error);
    const skillId = !isResult ? inferSkillIdFromToolArgs(data.arguments) : null;
    if (skillId) {
      const skillEventId = skillEventIdFor(event, runtimeAgentId, sessionKey, skillId);
      if (!(await auditEventExists(skillEventId))) {
        await recordAuditBestEffort({
          eventId: skillEventId,
          eventTime: event.ts ? new Date(event.ts) : undefined,
          action: "skill.invoked",
          result: "success",
          severity: "info",
          actorType: input.userId ? "user" : "system",
          actorUserId: input.userId ?? null,
          ...(input.req ? auditRequest(input.req) : {}),
          targetType: "skill",
          targetId: skillId.slice(0, 128),
          targetName: skillId.slice(0, 256),
          resourceType: "skill",
          resourceId: skillId.slice(0, 128),
          resourceName: skillId.slice(0, 256),
          agentInstanceId: input.adoptId || runtimeAgentId,
          runtimeType: "openclaw",
          runtimeAgentId,
          sessionId: session.sessionId,
          correlationId: String(event.runId || event.traceId || "").slice(0, 128) || null,
          channel: input.channel || null,
          toolName,
          metadata: {
            source: "openclaw_trajectory",
            inferredFrom: "tool.call.arguments",
            transport: input.transport || null,
            traceId: event.traceId || null,
            runId: event.runId || null,
            seq: event.seq ?? null,
            toolCallId: data.toolCallId || null,
            itemId: data.itemId || null,
            args: summarizeArgs(data.arguments),
          },
        });
        seenEventIds.add(skillEventId);
      }
    }
    await recordAuditBestEffort({
      eventId,
      eventTime: event.ts ? new Date(event.ts) : undefined,
      action: isResult
        ? isError ? "tool.openclaw.failed" : "tool.openclaw.completed"
        : "tool.openclaw.started",
      result: isResult ? isError ? "failed" : "success" : "success",
      severity: isError ? "medium" : "info",
      actorType: input.userId ? "user" : "system",
      actorUserId: input.userId ?? null,
      ...(input.req ? auditRequest(input.req) : {}),
      targetType: "runtime_tool",
      targetId: String(data.toolCallId || data.itemId || eventId).slice(0, 128),
      targetName: toolName,
      resourceType: "openclaw_tool",
      resourceId: String(data.toolCallId || data.itemId || eventId).slice(0, 128),
      resourceName: toolName,
      agentInstanceId: input.adoptId || runtimeAgentId,
      runtimeType: "openclaw",
      runtimeAgentId,
      sessionId: session.sessionId,
      correlationId: String(event.runId || event.traceId || "").slice(0, 128) || null,
      channel: input.channel || null,
      toolName,
      errorCode: isError ? "OPENCLAW_TOOL_FAILED" : null,
      metadata: {
        source: "openclaw_trajectory",
        transport: input.transport || null,
        traceId: event.traceId || null,
        runId: event.runId || null,
        seq: event.seq ?? null,
        provider: event.provider || null,
        modelId: event.modelId || null,
        modelApi: event.modelApi || null,
        workspaceDir: event.workspaceDir || null,
        toolCallId: data.toolCallId || null,
        itemId: data.itemId || null,
        status: data.status || null,
        isError,
        args: isResult ? null : summarizeArgs(data.arguments),
        result: isResult ? summarizeResult(data.result) : null,
      },
    });
    seenEventIds.add(eventId);

    const mcpServer = inferMcpServerFromOpenClawToolName(toolName);
    if (mcpServer) {
      const mcpEventId = `oc_mcp_${sha256(`${eventId}|${mcpServer}`).slice(0, 57)}`;
      if (!(await auditEventExists(mcpEventId))) {
        await recordAuditBestEffort({
          eventId: mcpEventId,
          eventTime: event.ts ? new Date(event.ts) : undefined,
          action: isResult
            ? isError ? "mcp.tool.failed" : "mcp.tool.completed"
            : "mcp.tool.started",
          result: isResult ? isError ? "failed" : "success" : "success",
          severity: isError ? "medium" : "info",
          actorType: input.userId ? "user" : "system",
          actorUserId: input.userId ?? null,
          ...(input.req ? auditRequest(input.req) : {}),
          targetType: "mcp_tool",
          targetId: toolName.slice(0, 128),
          targetName: toolName.slice(0, 256),
          resourceType: "mcp_server",
          resourceId: mcpServer.slice(0, 128),
          resourceName: mcpServer.slice(0, 256),
          agentInstanceId: input.adoptId || runtimeAgentId,
          runtimeType: "openclaw",
          runtimeAgentId,
          sessionId: session.sessionId,
          correlationId: String(event.runId || event.traceId || "").slice(0, 128) || null,
          channel: input.channel || null,
          toolName,
          errorCode: isError ? "MCP_TOOL_CALL_FAILED" : null,
          metadata: {
            source: "openclaw_trajectory",
            inferredFrom: "tool.name",
            transport: input.transport || null,
            traceId: event.traceId || null,
            runId: event.runId || null,
            seq: event.seq ?? null,
            toolCallId: data.toolCallId || null,
            itemId: data.itemId || null,
            status: data.status || null,
            isError,
            args: isResult ? null : summarizeArgs(data.arguments),
            result: isResult ? summarizeResult(data.result) : null,
          },
        });
        seenEventIds.add(mcpEventId);
      }
    }
  }
}

export function scheduleOpenClawToolAudit(input: OpenClawToolAuditInput) {
  const delays = [800, 2500, 7000];
  for (const delay of delays) {
    setTimeout(() => {
      reconcileOpenClawToolAuditNow(input).catch((error) => {
        console.warn("[openclaw-tool-audit] reconcile failed", {
          runtimeAgentId: input.runtimeAgentId,
          sessionKey: input.sessionKey,
          error: error?.message || String(error),
        });
      });
    }, delay).unref?.();
  }
}
