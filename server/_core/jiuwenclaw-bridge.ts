import type { Request, Response } from "express";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "fs";
import os from "os";
import path from "path";
import { WebSocket, type RawData } from "ws";
import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";
import { parseUploadedAttachmentRuntimeMessage } from "@shared/uploaded-attachment-context";
import type { UploadedAttachmentContextFile } from "@shared/uploaded-attachment-context";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { privateMessageLogFields } from "./log-privacy";
import {
  appendLogAsync,
  JIUWENCLAW_HOME,
  buildSessionRegistryScope,
  bumpSessionEpoch,
  lookupSessionRegistry,
  jiuwenClawSessionsDir,
  normalizeConversationId,
  normalizeSessionChannel,
  normalizeSessionPart,
  readSessionEpoch,
  resolveRuntimeWorkspace,
  upsertSessionRegistry,
} from "./helpers";
import {
  isUserVisibleJiuwenArtifactPath,
  writeJiuwenSessionArtifacts,
  type JiuwenSessionArtifactFile,
} from "./jiuwen-session-artifacts";
import { inferMcpServerForJiuwenTool, recordJiuwenMcpMetricEvent } from "./jiuwenswarm-mcp-metrics";
import {
  buildJiuwenFinalSnapshot,
  buildJiuwenRunDescriptor,
  buildJiuwenTextDelta,
} from "./jiuwenswarm-stream-contract";
import { filterCitedKnowledgeSources, validateKnowledgeCitations } from "@shared/knowledge-citations";
import { detectInstructionAttackSignals } from "./instruction-attack";
import {
  normalizeJiuwenToolPayload,
  normalizeGovernanceApprovalToolEvent,
  normalizeJiuwenUsageSummary,
  stringifyJiuwenToolPayload,
} from "./jiuwenclaw-event-normalizers";
import {
  isJiuwenHumanApprovalEvent,
  normalizeJiuwenPermissionRequest,
  summarizeJiuwenApprovalEvent,
  type JiuwenInteractionAnswer,
  type JiuwenInteractionQuestion,
  type JiuwenPermissionRequest,
} from "./jiuwen-permission-events";
import { createResponseEvidenceCollector } from "./governance/response-evidence";
import type { EnterpriseRuntimeRoute } from "./enterprise-runtime-adapter";
export { bumpSessionEpoch } from "./helpers";
export { inferMcpServerForJiuwenTool } from "./jiuwenswarm-mcp-metrics";
export {
  buildJiuwenFinalSnapshot,
  buildJiuwenRunDescriptor,
  buildJiuwenTextDelta,
  type JiuwenRunDescriptor,
} from "./jiuwenswarm-stream-contract";
export {
  normalizeGovernanceApprovalToolEvent,
  normalizeJiuwenToolPayload,
  normalizeJiuwenUsageSummary,
  stringifyJiuwenToolPayload,
} from "./jiuwenclaw-event-normalizers";
export {
  normalizeJiuwenPermissionRequest,
  type JiuwenInteractionAnswer,
  type JiuwenInteractionQuestion,
  type JiuwenPermissionRequest,
} from "./jiuwen-permission-events";
export type JiuwenClawRuntimeClaw = {
  adoptId: string;
  agentId: string;
  userId: number;
  roleTemplate?: string;
};
export type JiuwenForwardOptions = {
  model?: string;
  modelName?: string;
  req?: Request;
  channel?: unknown;
  conversationId?: unknown;
  epochLabel?: unknown;
  clientRunId?: string | null;
  runtimeMode?: unknown;
  cancelPendingPermission?: unknown;
  selectedSkills?: JiuwenSelectedSkillMetadata[];
  uploadedAttachments?: UploadedAttachmentContextFile[];
  enterpriseRoute?: EnterpriseRuntimeRoute | null;
  knowledgeSources?: Array<Record<string, unknown>>;
  memoryUserMessage?: string;
  onFirstToken?: () => void;
  onRuntimeOutcome?: (outcome: "success" | "error" | "timeout" | "cancelled") => void;
  onUsage?: (usage: Record<string, number>) => void;
};
export type JiuwenSelectedSkillMetadata = {
  id: string;
  name?: string;
  description?: string;
  skillFile?: string;
  runtimePath?: string;
  sourceKind?: string;
  version?: string;
};
const DEFAULT_AGENTSERVER_WS_URL = "ws://127.0.0.1:18092";
const DEFAULT_SERVICE_ID = "linggan";
const seenJiuwenAuditEventIds = new Set<string>();
const recentlyAnsweredPermissions = new Map<string, { requestId: string; answeredAt: number }>();
const RECENT_PERMISSION_TTL_MS = 30 * 60 * 1000;

function runtimeEnabled(): boolean {
  return String(process.env.JIUWENCLAW_RUNTIME_ENABLED || "").toLowerCase() === "true";
}

export function isJiuwenClawRuntimeEnabled(): boolean {
  return runtimeEnabled();
}

function useJiuwenGatewayTransport(): boolean {
  return String(process.env.JIUWENCLAW_CHAT_TRANSPORT || "").trim().toLowerCase() === "gateway";
}

async function readyEnterpriseRuntimeRoute(adoptionId: string): Promise<EnterpriseRuntimeRoute | null> {
  if (String(process.env.EA_ENTERPRISE_RUNTIME_ENABLED || "").trim().toLowerCase() !== "true") {
    return null;
  }
  try {
    const { resolveEnterpriseRuntimeRoute } = await import("./enterprise-runtime-adapter");
    const decision = await resolveEnterpriseRuntimeRoute(adoptionId);
    if (decision.target === "enterprise") return decision.route;
    appendLogAsync("jiuwenclaw-exec.log", {
      ts: new Date().toISOString(),
      event: "enterprise_runtime_fallback",
      adoptId: adoptionId,
      reason: decision.reason,
    });
  } catch (error) {
    appendLogAsync("jiuwenclaw-exec.log", {
      ts: new Date().toISOString(),
      event: "enterprise_runtime_route_failed",
      adoptId: adoptionId,
      error: String((error as Error)?.message || error).slice(0, 500),
    });
  }
  return null;
}

function sanitizeRuntimeId(value: unknown, fallback: string, maxLen = 96): string {
  const normalized = normalizeSessionPart(value, maxLen).replace(/:/g, "_").toLowerCase();
  return normalized || fallback;
}

export function buildJiuwenServiceId(): string {
  return sanitizeRuntimeId(process.env.JIUWENCLAW_SERVICE_ID || DEFAULT_SERVICE_ID, DEFAULT_SERVICE_ID, 64);
}

export function buildJiuwenAgentId(claw: JiuwenClawRuntimeClaw): string {
  const configured = process.env.JIUWENCLAW_AGENT_ID_OVERRIDE;
  if (configured) return sanitizeRuntimeId(configured, `jiuwen_${claw.adoptId}`, 96);
  return sanitizeRuntimeId(claw.agentId || `jiuwen_${claw.adoptId}`, `jiuwen_${claw.adoptId}`, 96);
}

export function buildJiuwenSessionId(claw: JiuwenClawRuntimeClaw, agentId: string, opts: JiuwenForwardOptions): string {
  const epoch = readSessionEpoch(claw.adoptId);
  const scope = buildSessionRegistryScope(opts.channel, opts.conversationId);
  const found = lookupSessionRegistry(claw.adoptId, agentId, epoch, scope);
  if (found) return found;

  const channel = normalizeSessionChannel(opts.channel);
  const conversationId = normalizeConversationId(opts.conversationId);
  const epochLabel = normalizeSessionPart(opts.epochLabel, 48);
  const scopePart = channel !== "main" && conversationId ? `${channel}_${conversationId}` : "main";
  const suffix = epochLabel || (epoch > 0 ? `e${epoch}` : "default");
  const sessionId = sanitizeRuntimeId(`sess_${claw.adoptId}_${scopePart}_${suffix}`, "sess_default", 160);
  upsertSessionRegistry(claw.adoptId, agentId, sessionId, epoch, scope);
  return sessionId;
}

function jiuwenChannelFromOption(value: unknown): string {
  const channel = normalizeSessionChannel(value);
  if (channel === "weixin" || channel === "wechat") return "wechat";
  if (channel === "wecom") return "wecom";
  if (channel === "feishu") return "feishu";
  if (channel === "xiaoyi") return "xiaoyi";
  if (channel === "dingtalk") return "dingtalk";
  return "web";
}

function wsOriginFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${url.host}`;
  } catch {
    return "http://127.0.0.1";
  }
}

function initSse(res: Response): void {
  if (!res.headersSent) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
  }
  if (res.socket) res.socket.setNoDelay(true);
}

function asJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJsonFrame(raw: RawData): Record<string, unknown> | null {
  try {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : String(raw);
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

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

function summarizeAuditPayload(value: unknown) {
  const json = stableJson(value ?? null);
  return {
    hash: sha256(json),
    bytes: Buffer.byteLength(json, "utf8"),
    fieldNames: value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).sort()
      : [],
  };
}

export function inferSkillIdFromJiuwenPayload(value: unknown): string | null {
  const json = stableJson(value);
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

export async function recordJiuwenToolAudit(args: {
  claw: JiuwenClawRuntimeClaw;
  req?: Request;
  agentId: string;
  sessionId: string;
  requestId: string;
  channelId: string;
  eventType: string;
  delta: unknown;
}) {
  const tool = normalizeJiuwenToolPayload(args.eventType, args.delta);
  if (!tool) return;
  const phase = tool.isResult ? (tool.isError ? "failed" : "completed") : "started";
  const baseRaw = [
    args.agentId,
    args.sessionId,
    args.requestId,
    args.eventType,
    tool.callId,
    tool.toolName,
    phase,
  ].join("|");
  const baseEventId = `jw_tool_${sha256(baseRaw).slice(0, 55)}`;
  if (!seenJiuwenAuditEventIds.has(baseEventId)) {
    seenJiuwenAuditEventIds.add(baseEventId);
    await recordAuditBestEffort({
      eventId: baseEventId,
      action: `tool.jiuwenswarm.${phase}`,
      result: tool.isError ? "failed" : "success",
      severity: tool.isError ? "medium" : "info",
      actorType: "user",
      actorUserId: args.claw.userId,
      ...(args.req ? auditRequest(args.req) : {}),
      requestId: args.requestId,
      targetType: "runtime_tool",
      targetId: (tool.callId || baseEventId).slice(0, 128),
      targetName: tool.toolName.slice(0, 256),
      resourceType: "jiuwenswarm_tool",
      resourceId: (tool.callId || baseEventId).slice(0, 128),
      resourceName: tool.toolName.slice(0, 256),
      agentInstanceId: args.claw.adoptId,
      runtimeType: "jiuwenswarm",
      runtimeAgentId: args.agentId,
      sessionId: args.sessionId,
      correlationId: args.requestId,
      channel: args.channelId,
      toolName: tool.toolName.slice(0, 128),
      errorCode: tool.isError ? "JIUWENSWARM_TOOL_FAILED" : null,
      metadata: {
        source: "jiuwenswarm_webchannel",
        eventType: args.eventType,
        callId: tool.callId || null,
        args: tool.isResult ? null : summarizeAuditPayload(tool.argumentsPayload),
        result: tool.isResult ? summarizeAuditPayload(tool.resultPayload) : null,
      },
    });
  }

  if (tool.isResult) {
    const instructionAttack = detectInstructionAttackSignals(tool.resultPayload);
    const securityEventId = `jw_guard_${sha256(`${baseRaw}|${instructionAttack.fingerprint}`).slice(0, 53)}`;
    if (instructionAttack.detected && !seenJiuwenAuditEventIds.has(securityEventId)) {
      seenJiuwenAuditEventIds.add(securityEventId);
      await recordAuditBestEffort({
        eventId: securityEventId,
        category: "security",
        action: "security.instruction_attack.detected",
        result: "warning",
        severity: instructionAttack.severity,
        actorType: "agent",
        actorUserId: args.claw.userId,
        ...(args.req ? auditRequest(args.req) : {}),
        requestId: args.requestId,
        targetType: "runtime_tool",
        targetId: (tool.callId || baseEventId).slice(0, 128),
        targetName: tool.toolName.slice(0, 256),
        resourceType: "jiuwenswarm_tool_result",
        resourceId: (tool.callId || baseEventId).slice(0, 128),
        resourceName: tool.toolName.slice(0, 256),
        agentInstanceId: args.claw.adoptId,
        runtimeType: "jiuwenswarm",
        runtimeAgentId: args.agentId,
        sessionId: args.sessionId,
        correlationId: args.requestId,
        channel: args.channelId,
        toolName: tool.toolName.slice(0, 128),
        source: "jiuwenswarm_tool_result",
        detailType: "instruction_attack_signal",
        policyCode: "EA_INSTRUCTION_ATTACK_MONITOR_V1",
        riskType: "prompt_injection",
        metadata: {
          contentSource: "tool_result",
          eventType: args.eventType,
          callId: tool.callId || null,
          ruleIds: instructionAttack.signals.map((signal) => signal.ruleId),
          categories: Array.from(new Set(instructionAttack.signals.map((signal) => signal.category))),
          fingerprint: instructionAttack.fingerprint,
          scannedChars: instructionAttack.scannedChars,
          blocked: false,
        },
      });
    }
  }

  const mcpServer = tool.toolName.startsWith("mcp_") ? inferMcpServerForJiuwenTool(tool.toolName) || "jiuwenswarm_mcp" : null;
  if (mcpServer) {
    const mcpEventId = `jw_mcp_${sha256(`${baseRaw}|${mcpServer}`).slice(0, 56)}`;
    if (!seenJiuwenAuditEventIds.has(mcpEventId)) {
      seenJiuwenAuditEventIds.add(mcpEventId);
      recordJiuwenMcpMetricEvent({
        agentId: args.agentId,
        sessionId: args.sessionId,
        requestId: args.requestId,
        tool,
      });
      await recordAuditBestEffort({
        eventId: mcpEventId,
        action: `mcp.tool.${phase}`,
        result: tool.isError ? "failed" : "success",
        severity: tool.isError ? "medium" : "info",
        actorType: "user",
        actorUserId: args.claw.userId,
        ...(args.req ? auditRequest(args.req) : {}),
        requestId: args.requestId,
        targetType: "mcp_tool",
        targetId: tool.toolName.slice(0, 128),
        targetName: tool.toolName.slice(0, 256),
        resourceType: "mcp_server",
        resourceId: mcpServer.slice(0, 128),
        resourceName: mcpServer.slice(0, 256),
        agentInstanceId: args.claw.adoptId,
        runtimeType: "jiuwenswarm",
        runtimeAgentId: args.agentId,
        sessionId: args.sessionId,
        correlationId: args.requestId,
        channel: args.channelId,
        toolName: tool.toolName.slice(0, 128),
        errorCode: tool.isError ? "MCP_TOOL_CALL_FAILED" : null,
        metadata: {
          source: "jiuwenswarm_webchannel",
          eventType: args.eventType,
          callId: tool.callId || null,
          args: tool.isResult ? null : summarizeAuditPayload(tool.argumentsPayload),
          result: tool.isResult ? summarizeAuditPayload(tool.resultPayload) : null,
        },
      });
    }
  }

  if (!tool.isResult) {
    const skillId = inferSkillIdFromJiuwenPayload(tool.argumentsPayload);
    if (skillId) {
      const skillEventId = `jw_skill_${sha256(`${baseRaw}|${skillId}`).slice(0, 54)}`;
      if (!seenJiuwenAuditEventIds.has(skillEventId)) {
        seenJiuwenAuditEventIds.add(skillEventId);
        await recordAuditBestEffort({
          eventId: skillEventId,
          action: "skill.invoked",
          result: "success",
          severity: "info",
          actorType: "user",
          actorUserId: args.claw.userId,
          ...(args.req ? auditRequest(args.req) : {}),
          requestId: args.requestId,
          targetType: "skill",
          targetId: skillId.slice(0, 128),
          targetName: skillId.slice(0, 256),
          resourceType: "skill",
          resourceId: skillId.slice(0, 128),
          resourceName: skillId.slice(0, 256),
          agentInstanceId: args.claw.adoptId,
          runtimeType: "jiuwenswarm",
          runtimeAgentId: args.agentId,
          sessionId: args.sessionId,
          correlationId: args.requestId,
          channel: args.channelId,
          toolName: tool.toolName.slice(0, 128),
          metadata: {
            source: "jiuwenswarm_webchannel",
            inferredFrom: "chat.tool_call.arguments",
            eventType: args.eventType,
            callId: tool.callId || null,
            args: summarizeAuditPayload(tool.argumentsPayload),
          },
        });
      }
    }
  }
}

export function pickJiuwenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  for (const key of ["content", "text", "message", "delta"]) {
    if (typeof obj[key] === "string") return obj[key];
  }
  for (const key of ["payload", "result", "body", "delta"]) {
    const nested = pickJiuwenText(obj[key]);
    if (nested) return nested;
  }
  return "";
}

function pickErrorMessage(frame: unknown): string {
  const root = asJsonObject(frame);
  const body = asJsonObject(root.body);
  const delta = asJsonObject(body.delta);
  const details = asJsonObject(body.details);
  const raw = String(
    body?.message
      || body?.error
      || body?.content
      || body?.text
      || delta?.error
      || delta?.message
      || delta?.content
      || delta?.text
      || details.message
      || details.error
      || root.message
      || "jiuwenclaw runtime error"
  ).slice(0, 1000);
  if (/max(?:imum)? iterations?|iteration limit|达到.{0,8}(?:迭代|工具).{0,8}上限/i.test(raw)) {
    return "本轮联网检索未能在限定步骤内收敛。请缩小问题范围，或提供一个明确的原始网址后重试。";
  }
  return raw;
}

export function collectRecentWorkspaceFiles(workspaceDir: string, sinceMs: number): Array<{ name: string; size: number; path: string }> {
  if (!workspaceDir || !existsSync(workspaceDir)) return [];
  const skipDirs = new Set(["skills", "memory", "prompt_attachment", "node_modules", ".git", ".dreams", "dist", "build", ".openclaw", ".agent_history", "context"]);
  const files: Array<{ name: string; size: number; path: string }> = [];

  const scanDir = (dir: string, relBase: string, depth: number) => {
    if (depth > 3) return;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".")) continue;
        if (depth === 0 && skipDirs.has(entry)) continue;
        const full = `${dir}/${entry}`;
        const rel = relBase ? `${relBase}/${entry}` : entry;
        try {
          const st = statSync(full);
          if (st.isFile()) {
            if (st.mtimeMs >= sinceMs && isUserVisibleJiuwenArtifactPath(rel)) {
              files.push({ name: entry, size: st.size, path: rel });
            }
          } else if (st.isDirectory()) {
            scanDir(full, rel, depth + 1);
          }
        } catch {}
      }
    } catch {}
  };

  scanDir(workspaceDir, "", 0);
  return files.sort((a, b) => b.path.localeCompare(a.path));
}

function sanitizeWorkspaceRelativePath(raw: unknown): string | null {
  const text = String(raw || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!text) return null;
  const parts = text.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function normalizeWorkspaceFilePayload(file: unknown, workspaceDir: string): { name: string; size: number; path: string } | null {
  const payload = file && typeof file === "object" ? file as Record<string, unknown> : {};
  const rawPath = String(payload.path || payload.file_path || payload.full_path || payload.filepath || "").trim();
  let relPath: string | null = null;

  if (rawPath) {
    if (path.isAbsolute(rawPath)) {
      const workspaceRoot = path.resolve(workspaceDir);
      const absPath = path.resolve(rawPath);
      const rel = path.relative(workspaceRoot, absPath);
      if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") return null;
      relPath = rel.split(path.sep).join("/");
    } else {
      relPath = sanitizeWorkspaceRelativePath(rawPath);
    }
  }

  if (!relPath || !isUserVisibleJiuwenArtifactPath(relPath)) return null;
  const absFile = path.join(workspaceDir, relPath);
  let size = Number(payload.size || 0);
  try {
    const st = statSync(absFile);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {}

  const name = String(payload.name || path.basename(relPath)).trim() || path.basename(relPath);
  return { name, size, path: relPath };
}

export function normalizeJiuwenFileEvent(delta: unknown, workspaceDir: string): Array<{ name: string; size: number; path: string }> {
  const payload = delta && typeof delta === "object" ? delta as Record<string, unknown> : {};
  const candidates = Array.isArray(payload.files)
    ? payload.files
    : Array.isArray(payload.file_list)
      ? payload.file_list
      : payload.file
        ? [payload.file]
        : payload.path
          ? [payload]
          : [];
  const files: Array<{ name: string; size: number; path: string }> = [];
  for (const candidate of candidates) {
    const normalized = normalizeWorkspaceFilePayload(candidate, workspaceDir);
    if (normalized) files.push(normalized);
  }
  return files;
}

export function normalizeJiuwenMode(value: unknown): "agent.fast" | "agent.plan" | "team" {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "plan" || mode === "agent.plan") return "agent.plan";
  if (mode === "team" || mode === "code.team") return "team";
  return "agent.fast";
}

const JIUWEN_IMAGE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

export function buildJiuwenImageMediaItems(message: string, workspaceDir: string): Array<{
  type: "image";
  filename: string;
  path: string;
  mime_type: string;
  size_bytes: number;
}> {
  if (!workspaceDir || !existsSync(workspaceDir)) return [];
  const attachments = parseUploadedAttachmentRuntimeMessage(message).attachments;
  if (!attachments.length) return [];

  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(workspaceDir);
  } catch {
    return [];
  }

  const mediaItems: Array<{
    type: "image";
    filename: string;
    path: string;
    mime_type: string;
    size_bytes: number;
  }> = [];
  for (const attachment of attachments) {
    const mimeType = JIUWEN_IMAGE_MIME_BY_EXTENSION.get(path.extname(attachment.path).toLowerCase());
    if (!mimeType) continue;
    try {
      const resolved = realpathSync(path.resolve(workspaceRoot, attachment.path));
      const relative = path.relative(workspaceRoot, resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const stats = statSync(resolved);
      if (!stats.isFile()) continue;
      mediaItems.push({
        type: "image",
        filename: path.basename(resolved),
        path: resolved,
        mime_type: mimeType,
        size_bytes: stats.size,
      });
    } catch {}
  }
  return mediaItems.slice(0, 8);
}

export function buildJiuwenAgentServerChatRequest(args: {
  requestId: string;
  serviceId: string;
  agentId: string;
  sessionId: string;
  channelId: string;
  message: string;
  workspaceDir: string;
  model?: string;
  runtimeMode?: unknown;
  selectedSkills?: JiuwenSelectedSkillMetadata[];
}) {
  const mode = normalizeJiuwenMode(args.runtimeMode || process.env.JIUWENCLAW_DEFAULT_MODE);
  const selectedSkills = Array.isArray(args.selectedSkills) ? args.selectedSkills : [];
  const mediaItems = buildJiuwenImageMediaItems(args.message, args.workspaceDir);
  const requestMetadata = {
    effective_project_dir: args.workspaceDir,
    source_channel: args.channelId,
    ...(selectedSkills.length ? { selected_skills: selectedSkills } : {}),
  };
  return {
    protocol_version: "1.0",
    request_id: args.requestId,
    timestamp: new Date().toISOString(),
    identity_origin: "user",
    channel: args.channelId,
    channel_context: {
      effective_project_dir: args.workspaceDir,
      cwd: args.workspaceDir,
      source_channel: args.channelId,
    },
    metadata: requestMetadata,
    method: "chat.send",
    is_stream: true,
    service_id: args.serviceId,
    agent_id: args.agentId,
    session_id: args.sessionId,
    params: {
      service_id: args.serviceId,
      agent_id: args.agentId,
      session_id: args.sessionId,
      query: args.message,
      content: args.message,
      project_dir: args.workspaceDir,
      interactive_ask: true,
      request_metadata: requestMetadata,
      mode,
      ...(mediaItems.length ? { media_items: mediaItems } : {}),
      ...(args.model ? { model_name: args.model } : {}),
    },
  };
}

export function buildJiuwenAgentServerPermissionAnswerRequest(args: {
  envelopeRequestId: string;
  permissionRequestId: string;
  serviceId: string;
  agentId: string;
  sessionId: string;
  channelId: string;
  workspaceDir: string;
  selectedOption: string;
  answers?: JiuwenInteractionAnswer[];
  source?: string;
  runtimeMode?: unknown;
}) {
  const mode = normalizeJiuwenMode(args.runtimeMode || process.env.JIUWENCLAW_DEFAULT_MODE);
  const source = String(args.source || "permission_interrupt").trim() || "permission_interrupt";
  return {
    protocol_version: "1.0",
    request_id: args.envelopeRequestId,
    timestamp: new Date().toISOString(),
    identity_origin: "user",
    channel: args.channelId,
    channel_context: {
      effective_project_dir: args.workspaceDir,
      cwd: args.workspaceDir,
      source_channel: args.channelId,
    },
    method: "chat.send",
    is_stream: true,
    service_id: args.serviceId,
    agent_id: args.agentId,
    session_id: args.sessionId,
    params: {
      service_id: args.serviceId,
      agent_id: args.agentId,
      session_id: args.sessionId,
      query: "",
      content: "",
      request_id: args.permissionRequestId,
      answers: args.answers?.length
        ? args.answers.map((answer) => ({
            selected_options: answer.selectedOptions,
            custom_input: answer.customInput,
          }))
        : [{ selected_options: [args.selectedOption], custom_input: "" }],
      source,
      mode,
      project_dir: args.workspaceDir,
      request_metadata: {
        effective_project_dir: args.workspaceDir,
        source_channel: args.channelId,
      },
    },
  };
}

// ── 静默失败自愈 ──────────────────────────────────────────────────────────────
// jiuwenswarm 的中断状态（InterruptionState）持久化损坏后，同 session 所有请求会
// 静默跳过 LLM 调用（0 token、无错误、瞬间返回）。检测到该特征时自动清除该
// session 在 checkpoint.db 中的 agent state 并重试一次。
// 详见 docs/JIUWENSWARM_PATCHES.md「问题记录 1」。
const JIUWEN_SILENT_FAILURE_MS = Math.max(
  500,
  Number(process.env.JIUWENCLAW_SILENT_FAILURE_MS || 2000) || 2000,
);
const JIUWEN_CHECKPOINT_DB =
  process.env.JIUWENCLAW_CHECKPOINT_DB || path.join(os.homedir(), ".jiuwenswarm/agent/.checkpoint/checkpoint.db");

function shouldCancelPendingPermission(value: unknown): boolean {
  return value === true || value === 1 || /^(1|true|yes)$/i.test(String(value || ""));
}

function rememberAnsweredPermission(sessionId: string, requestId: string): void {
  if (!sessionId || !requestId) return;
  recentlyAnsweredPermissions.set(sessionId, { requestId, answeredAt: Date.now() });
  if (recentlyAnsweredPermissions.size > 500) {
    const cutoff = Date.now() - RECENT_PERMISSION_TTL_MS;
    for (const [key, value] of recentlyAnsweredPermissions) {
      if (value.answeredAt < cutoff) recentlyAnsweredPermissions.delete(key);
    }
  }
}

function isRecentlyAnsweredPermission(sessionId: string, requestId: string): boolean {
  const record = recentlyAnsweredPermissions.get(sessionId);
  if (!record) return false;
  if (Date.now() - record.answeredAt > RECENT_PERMISSION_TTL_MS) {
    recentlyAnsweredPermissions.delete(sessionId);
    return false;
  }
  return record.requestId === requestId;
}

function clearJiuwenSessionCheckpoint(
  sessionId: string,
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  if (!existsSync(JIUWEN_CHECKPOINT_DB)) {
    return Promise.resolve({ ok: true, deleted: 0, error: `checkpoint db not found: ${JIUWEN_CHECKPOINT_DB}` });
  }
  const script = [
    "import sqlite3, sys",
    "db, sid = sys.argv[1], sys.argv[2]",
    "conn = sqlite3.connect(db, timeout=5)",
    "cur = conn.execute(\"DELETE FROM kv_store WHERE key LIKE ? || ':%'\", (sid,))",
    "conn.commit()",
    "print(cur.rowcount)",
    "conn.close()",
  ].join("\n");
  return new Promise((resolve) => {
    execFile(
      "python3",
      ["-c", script, JIUWEN_CHECKPOINT_DB, sessionId],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, deleted: 0, error: String(err.message || err).slice(0, 300) });
        } else {
          resolve({ ok: true, deleted: Number(String(stdout).trim()) || 0 });
        }
      },
    );
  });
}

export function formatJiuwenTextSectionDelta(text: string, shouldSeparate: boolean): string {
  const value = String(text || "");
  if (!value || !shouldSeparate || value.startsWith("\n")) return value;
  return `\n\n${value}`;
}

export async function forwardToJiuwenClaw(
  claw: JiuwenClawRuntimeClaw,
  message: string,
  res: Response,
  opts: JiuwenForwardOptions = {},
): Promise<void> {
  if (!runtimeEnabled()) {
    res.status(503).json({ error: "jiuwenclaw runtime is disabled" });
    return;
  }
  const enterpriseRoute = opts.enterpriseRoute === undefined
    ? await readyEnterpriseRuntimeRoute(claw.adoptId)
    : opts.enterpriseRoute;
  const { enterpriseRuntimeSupportsModel } = await import("./enterprise-runtime-adapter");
  if (enterpriseRoute && enterpriseRuntimeSupportsModel(opts.modelName || opts.model)) {
    const { forwardToJiuwenGateway } = await import("./jiuwenswarm-gateway-client");
    return forwardToJiuwenGateway(claw, message, res, opts, enterpriseRoute);
  }
  if (useJiuwenGatewayTransport()) {
    const { forwardToJiuwenGateway } = await import("./jiuwenswarm-gateway-client");
    return forwardToJiuwenGateway(claw, message, res, opts);
  }
  const msgTrim = String(message || "").trim();
  initSse(res);

  const writeData = (obj: any) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const writeEvent = (event: string, obj: any) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
  };

  let doneEmitted = false;
  const emitDone = (durationMs?: number) => {
    if (doneEmitted) return;
    doneEmitted = true;
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({
        __stream_end: true,
        ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, Math.round(Number(durationMs))) } : {}),
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  };

  if (msgTrim === "/new" || msgTrim === "/reset") {
    const epoch = bumpSessionEpoch(claw.adoptId);
    writeData({
      choices: [{
        delta: { content: `已开始新对话。` },
        index: 0,
      }],
    });
    writeData({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
    appendLogAsync("jiuwenclaw-exec.log", {
      ts: new Date().toISOString(),
      event: "session_reset",
      adoptId: claw.adoptId,
      agentId: claw.agentId,
      userId: claw.userId,
      epoch,
    });
    emitDone();
    return;
  }

  const overallStartedAt = Date.now();

  if (opts.model) writeData({ __model_selected: opts.model });
  if (opts.knowledgeSources?.length) writeData({ __knowledge_sources: opts.knowledgeSources });
  const knowledgeCitationIndexes = (opts.knowledgeSources || [])
    .map((source) => Number(source?.index || 0))
    .filter((index) => Number.isInteger(index) && index > 0);

  const wsUrl = String(process.env.JIUWENCLAW_AGENTSERVER_WS_URL || DEFAULT_AGENTSERVER_WS_URL);
  const serviceId = buildJiuwenServiceId();
  const agentId = buildJiuwenAgentId(claw);
  const sessionId = buildJiuwenSessionId(claw, agentId, opts);
  const channelId = claw.adoptId;
  const workspaceDir = resolveRuntimeWorkspace(claw, claw.adoptId);
  const rawTimeoutMs = String(process.env.JIUWENCLAW_CHAT_TIMEOUT_MS || "180000").trim().toLowerCase();
  const maxRunMs = rawTimeoutMs === "0" || rawTimeoutMs === "off" || rawTimeoutMs === "disabled"
    ? 0
    : Math.max(30_000, Number(rawTimeoutMs) || 180_000);

  if (shouldCancelPendingPermission(opts.cancelPendingPermission)) {
    const clearResult = await clearJiuwenSessionCheckpoint(sessionId);
    appendLogAsync("jiuwenclaw-exec.log", {
      ts: new Date().toISOString(),
      event: "chat_stream_cancel_pending_permission",
      adoptId: claw.adoptId,
      agentId,
      sessionId,
      channelId,
      userId: claw.userId,
      clientRunId: opts.clientRunId || "",
      checkpointDb: JIUWEN_CHECKPOINT_DB,
      clearResult,
    });
  }

  const runAttempt = (attempt: number): Promise<"done" | "silent"> => {
  const startedAt = Date.now();
  const requestId = `linggan-jiuwen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const requestPayload = buildJiuwenAgentServerChatRequest({
    requestId,
    serviceId,
    agentId,
    sessionId,
    channelId,
    message,
    workspaceDir,
    model: opts.model,
    runtimeMode: opts.runtimeMode,
    selectedSkills: opts.selectedSkills,
  });

  writeData({
    __run: buildJiuwenRunDescriptor({
      clientRunId: opts.clientRunId,
      requestId,
      sessionId,
    }),
  });

  appendLogAsync("jiuwenclaw-exec.log", {
    ts: new Date().toISOString(),
    event: "chat_stream_request",
    adoptId: claw.adoptId,
    agentId,
    serviceId,
    sessionId,
    channelId,
    userId: claw.userId,
    clientRunId: opts.clientRunId || "",
    mode: requestPayload.params?.mode || "",
    model: opts.model || "",
    selectedSkillIds: (opts.selectedSkills || []).map((skill) => skill.id).filter(Boolean),
    attempt,
    ...privateMessageLogFields(message),
  });

  return new Promise<"done" | "silent">((resolve) => {
    let settled = false;
    let requestSent = false;
    let sawText = false;
    let memoryAssistantText = "";
    let needsTextSectionBreak = false;
    let clientClosed = false;
    let ackFallbackTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let finalGraceTimer: NodeJS.Timeout | null = null;
    const emittedWorkspaceFiles = new Map<string, JiuwenSessionArtifactFile>();
    const memoryToolNames = new Set<string>();
    const responseEvidence = createResponseEvidenceCollector(claw, agentId, sessionId, requestId);
    const logEnd = (event: string, extra: Record<string, unknown> = {}) => {
      appendLogAsync("jiuwenclaw-exec.log", {
        ts: new Date().toISOString(),
        event,
        adoptId: claw.adoptId,
        agentId,
        serviceId,
        sessionId,
        channelId,
        userId: claw.userId,
        clientRunId: opts.clientRunId || "",
        mode: requestPayload.params?.mode || "",
        requestId,
        attempt,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    };
    let currentStatus = "已连接，正在处理请求...";
    const writeStatus = (label: string) => {
      currentStatus = label;
      writeData({
        __status: label,
        kind: "heartbeat",
        tool: "jiuwenclaw",
        elapsedMs: Date.now() - startedAt,
      });
    };
    const writeTextDelta = (value: string) => {
      const publicText = sanitizePublicRuntimePaths(value, workspaceDir);
      if (!publicText) return;
      opts.onFirstToken?.();
      memoryAssistantText += publicText;
      const formattedText = formatJiuwenTextSectionDelta(publicText, sawText && needsTextSectionBreak);
      currentStatus = "正在生成回复...";
      writeData(buildJiuwenTextDelta(formattedText));
      sawText = true;
      needsTextSectionBreak = false;
    };
    writeStatus("已连接，正在处理请求...");
    res.flush?.();
    const keepalive = setInterval(() => {
      if (res.writableEnded) return;
      writeStatus(currentStatus);
      res.flush?.();
    }, 10_000);
    const cleanup = () => {
      if (ackFallbackTimer) clearTimeout(ackFallbackTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (finalGraceTimer) clearTimeout(finalGraceTimer);
      clearInterval(keepalive);
    };
    const settle = (outcome: "done" | "silent" = "done") => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const fail = (error: string, reasonCode?: string) => {
      const durationMs = Date.now() - overallStartedAt;
      logEnd("chat_stream_failed", { error: error.slice(0, 1000) });
      opts.onRuntimeOutcome?.(reasonCode === "runtime_timeout" ? "timeout" : "error");
      writeData({
        __stream_error: true,
        error,
        durationMs,
        ...(reasonCode ? { reasonCode } : {}),
      });
      emitDone(durationMs);
      settle();
    };
    const complete = () => {
      // 静默失败特征：无任何文本输出且瞬间返回（正常 LLM 调用至少数秒）。
      // 这是 jiuwenswarm 中断状态损坏的表现，交给外层清 checkpoint 后重试。
      if (!sawText && Date.now() - startedAt < JIUWEN_SILENT_FAILURE_MS) {
        logEnd("chat_stream_silent_failure", {});
        settle("silent");
        return;
      }
      opts.onRuntimeOutcome?.("success");
      const recentFiles = collectRecentWorkspaceFiles(workspaceDir, startedAt)
        .filter((file) => !emittedWorkspaceFiles.has(file.path))
        .slice(0, 20);
      for (const file of recentFiles) emittedWorkspaceFiles.set(file.path, file);
      if (recentFiles.length > 0) {
        writeEvent("workspace_files", { adoptId: claw.adoptId, files: recentFiles });
      }
      if (emittedWorkspaceFiles.size > 0) {
        try {
          const globalSessionDir = path.join(JIUWENCLAW_HOME, "agent", "sessions", sessionId);
          const scopedSessionDir = path.join(jiuwenClawSessionsDir(claw.adoptId, agentId), sessionId);
          const sessionDirs = existsSync(globalSessionDir) ? [globalSessionDir] : [scopedSessionDir];
          for (const sessionDir of sessionDirs) {
            writeJiuwenSessionArtifacts({
              sessionDir,
              adoptId: claw.adoptId,
              requestId,
              files: Array.from(emittedWorkspaceFiles.values()),
            });
          }
        } catch (error: any) {
          logEnd("chat_stream_artifact_manifest_failed", { error: String(error?.message || error).slice(0, 500) });
        }
      }
      const citationValidation = validateKnowledgeCitations(memoryAssistantText, knowledgeCitationIndexes);
      const validatedAssistantText = citationValidation.text;
      if (validatedAssistantText && validatedAssistantText !== memoryAssistantText) {
        writeData({ __final_text: validatedAssistantText });
      }
      if (opts.knowledgeSources?.length) {
        writeData({
          __knowledge_sources: filterCitedKnowledgeSources(opts.knowledgeSources, citationValidation.citedIndexes),
        });
      }
      memoryAssistantText = validatedAssistantText;
      const finalizedEvidence = responseEvidence.finalize(memoryAssistantText, opts.knowledgeSources || [], citationValidation.citedIndexes);
      if (finalizedEvidence) writeData({ __context_response_evidence: finalizedEvidence });
      writeData({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
      if (sawText && memoryAssistantText.trim()) {
        void import("./agent-memory").then(({ enqueueAgentMemoryTurn }) => enqueueAgentMemoryTurn({
          userId: claw.userId,
          adoptId: claw.adoptId,
          roleTemplate: claw.roleTemplate || "general-assistant",
          channel: String(opts.channel || "web"),
          sessionId,
          requestId,
          conversationId: String(opts.conversationId || ""),
          messageId: requestId,
          userMessage: opts.memoryUserMessage || message,
          assistantMessage: memoryAssistantText,
          selectedSkillIds: (opts.selectedSkills || []).map((skill) => skill.id).filter(Boolean),
          toolNames: Array.from(memoryToolNames),
        })).catch(() => {});
      }
      emitDone(Date.now() - overallStartedAt);
      logEnd("chat_stream_complete", {
        recentFiles: recentFiles.length,
        sawText,
      });
      settle();
    };
    const sendRequest = (ws: WebSocket) => {
      if (requestSent || ws.readyState !== WebSocket.OPEN) return;
      requestSent = true;
      ws.send(JSON.stringify(requestPayload));
    };
    const completeSoon = (ws: WebSocket) => {
      if (finalGraceTimer || settled) return;
      finalGraceTimer = setTimeout(() => {
        finalGraceTimer = null;
        complete();
        try { ws.close(1000, "complete"); } catch {}
      }, 1200);
    };

    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: process.env.JIUWENCLAW_WS_ORIGIN || wsOriginFromUrl(wsUrl),
      },
    });

    if (maxRunMs <= 0) {
      logEnd("chat_stream_timeout_disabled", {});
    } else {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        const error = "模型或网页服务响应较慢，可重试或切换其他模型。";
        try { ws.close(1000, "timeout"); } catch {}
        fail(error, "runtime_timeout");
      }, maxRunMs);
    }

    const onClientClose = () => {
      if (res.writableEnded || settled) return;
      clientClosed = true;
      opts.onRuntimeOutcome?.("cancelled");
      logEnd("chat_stream_client_closed");
      try { ws.close(1000, "client closed"); } catch {}
      settle();
    };
    res.on("close", onClientClose);

    ws.on("open", () => {
      ackFallbackTimer = setTimeout(() => sendRequest(ws), 2000);
    });

    ws.on("message", (raw) => {
      const frame = parseJsonFrame(raw);
      if (!frame) return;

      if (frame?.event === "connection.ack") {
        sendRequest(ws);
        return;
      }

      const frameRequestId = String(frame?.request_id || frame?.response_id || "");
      if (frameRequestId && frameRequestId !== requestId) return;

      const kind = String(frame?.response_kind || frame?.event || "");
      const status = String(frame?.status || "");
      const body = asJsonObject(frame.body);

      if (status === "failed" || kind === "e2a.error" || kind.endsWith(".error")) {
        fail(pickErrorMessage(frame));
        try { ws.close(1000, "failed"); } catch {}
        return;
      }

      if (kind === "e2a.chunk") {
        if (body?.delta_kind === "text") {
          const text = pickJiuwenText(body?.delta);
          if (text) {
            writeTextDelta(text);
          }
          return;
        }
        if (body?.delta_kind === "reasoning") {
          const reasoning = pickJiuwenText(body?.delta);
          if (reasoning) {
            currentStatus = "正在分析...";
            writeData({ choices: [{ delta: { reasoning_content: sanitizePublicRuntimePaths(reasoning, workspaceDir) }, index: 0 }] });
          }
          return;
        }
        if (body?.delta_kind === "custom") {
          const eventType = String(body.event_type || asJsonObject(body.delta).event_type || "jiuwen.event");
          const text = pickJiuwenText(body?.delta);
          if (eventType === "chat.delta" && text) {
            writeTextDelta(text);
            return;
          }
          if (eventType === "chat.reasoning" && text) {
            currentStatus = "正在分析...";
            writeData({ choices: [{ delta: { reasoning_content: sanitizePublicRuntimePaths(text, workspaceDir) }, index: 0 }] });
            return;
          }
          if (eventType === "chat.final") {
            if (text && !sawText) {
              writeTextDelta(text);
            }
            const finalSnapshot = buildJiuwenFinalSnapshot(text, workspaceDir, knowledgeCitationIndexes);
            if (finalSnapshot) writeData(finalSnapshot);
            completeSoon(ws);
            return;
          }
          if (eventType === "chat.usage_summary") {
            const usageSummary = normalizeJiuwenUsageSummary(body?.delta);
            if (usageSummary) {
              opts.onUsage?.(usageSummary.usage);
              writeData({
                __perf: {
                  usage: usageSummary.usage,
                  ...(usageSummary.model ? { model: usageSummary.model } : {}),
                },
              });
            }
            return;
          }
          if (eventType === "chat.notice" && text) {
            writeStatus(sanitizePublicRuntimePaths(text, workspaceDir));
            return;
          }
          if (eventType === "chat.error") {
            fail(text || pickErrorMessage(frame));
            try { ws.close(1000, "failed"); } catch {}
            return;
          }
          if (isJiuwenHumanApprovalEvent(eventType, body?.delta)) {
            const permissionRequest = normalizeJiuwenPermissionRequest(eventType, body?.delta, requestId);
            logEnd("chat_stream_human_approval_required", {
              eventType,
              deltaSummary: summarizeAuditPayload(body?.delta),
              permissionRequestId: permissionRequest?.requestId || "",
            });
            if (permissionRequest) {
              if (isRecentlyAnsweredPermission(sessionId, permissionRequest.requestId)) {
                clearJiuwenSessionCheckpoint(sessionId).then((clearResult) => {
                  appendLogAsync("jiuwenclaw-exec.log", {
                    ts: new Date().toISOString(),
                    event: "chat_stream_stale_permission_after_answer",
                    adoptId: claw.adoptId,
                    agentId,
                    serviceId,
                    sessionId,
                    channelId,
                    userId: claw.userId,
                    clientRunId: opts.clientRunId || "",
                    mode: requestPayload.params?.mode || "",
                    requestId,
                    permissionRequestId: permissionRequest.requestId,
                    checkpointDb: JIUWEN_CHECKPOINT_DB,
                    clearResult,
                  });
                }).finally(() => {
                  try { ws.close(1000, "stale human approval cleared"); } catch {}
                  settle("silent");
                });
                return;
              }
              writeEvent("jiuwen_permission_request", {
                ...permissionRequest,
                adoptId: claw.adoptId,
                agentId,
                sessionId,
                channelId,
              });
              sawText = true;
              writeData({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
              opts.onRuntimeOutcome?.("success");
              emitDone(Date.now() - overallStartedAt);
              try { ws.close(1000, "human approval required"); } catch {}
              settle();
              return;
            }
            const approvalMessage = summarizeJiuwenApprovalEvent(eventType, body?.delta);
            fail(approvalMessage);
            try { ws.close(1000, "human approval required"); } catch {}
            return;
          }
          if (eventType === "chat.file" || eventType === "chat.media") {
            const files = normalizeJiuwenFileEvent(body?.delta, workspaceDir);
            if (files.length > 0) {
              for (const file of files.slice(0, 20)) emittedWorkspaceFiles.set(file.path, file);
              writeEvent("workspace_files", { adoptId: claw.adoptId, files });
            }
            return;
          }
          if (eventType === "chat.tool_call" || eventType === "chat.tool_result") {
            if (sawText) needsTextSectionBreak = true;
            recordJiuwenToolAudit({
              claw,
              req: opts.req,
              agentId,
              sessionId,
              requestId,
              channelId,
              eventType,
              delta: body?.delta,
            }).catch((error) => {
              console.warn("[jiuwenclaw-audit] tool audit failed", {
                adoptId: claw.adoptId,
                agentId,
                eventType,
                error: error?.message || String(error),
              });
            });
            const tool = normalizeJiuwenToolPayload(eventType, body?.delta);
            if (tool) {
              if (tool.toolName) memoryToolNames.add(tool.toolName);
              const toolCallId = tool.callId || `jiuwen-${sha256(`${requestId}|${tool.toolName}`).slice(0, 16)}`;
              if (tool.isResult) {
                responseEvidence.capture(tool.toolName, tool.resultPayload);
                const governanceApproval = normalizeGovernanceApprovalToolEvent(body?.delta, tool.resultPayload);
                if (governanceApproval) {
                  writeEvent("governance_approval_required", {
                    requestId: governanceApproval.approvalId,
                    source: "governance_approval",
                    kind: "permission",
                    title: "操作确认",
                    question: governanceApproval.reason,
                    toolName: governanceApproval.toolName || tool.toolName,
                    connectorName: governanceApproval.connectorName,
                    demo: governanceApproval.demo,
                    riskLevel: "high",
                    reasonCode: governanceApproval.policyCode || "EA_APPROVAL_REQUIRED",
                    reasonText: governanceApproval.reason,
                    allowAlways: false,
                    expiresAt: governanceApproval.expiresAt,
                    adoptId: claw.adoptId,
                  });
                }
                writeStatus("工具执行完成，正在整理结果...");
                writeEvent("tool_result", {
                  tool_call_id: toolCallId,
                  name: tool.toolName,
                  result: sanitizePublicRuntimePaths(stringifyJiuwenToolPayload(tool.resultPayload), workspaceDir),
                  is_error: tool.isError,
                  executor: "jiuwenswarm",
                  adoptId: claw.adoptId,
                });
              } else {
                writeStatus(`正在调用工具：${tool.toolName}`);
                writeEvent("tool_call", {
                  id: toolCallId,
                  name: tool.toolName,
                  arguments: sanitizePublicRuntimePaths(stringifyJiuwenToolPayload(tool.argumentsPayload) || "{}", workspaceDir),
                  executor: "jiuwenswarm",
                  adoptId: claw.adoptId,
                });
              }
              return;
            }
          }
          writeEvent("jiuwen_event", {
            event_type: eventType,
            delta: body?.delta ?? null,
          });
          return;
        }
      }

      if (frame?.is_final || kind === "e2a.complete") {
        const finalText = pickJiuwenText(body?.result || body);
        if (finalText && !sawText) {
          writeTextDelta(finalText);
        }
        complete();
        try { ws.close(1000, "complete"); } catch {}
      }
    });

    ws.on("error", (err) => {
      if (clientClosed || settled) return;
      fail(String((err as any)?.message || err || "jiuwenclaw websocket error").slice(0, 1000));
    });

    ws.on("close", () => {
      res.off("close", onClientClose);
      if (clientClosed || settled) return;
      if (doneEmitted) {
        settle();
        return;
      }
      fail("jiuwenclaw upstream closed before completion");
    });
  });
  };

  let outcome = await runAttempt(1);
  if (outcome === "silent" && !res.writableEnded) {
    // 静默失败自愈：清除该 session 的损坏 checkpoint state 后重试一次
    const heal = await clearJiuwenSessionCheckpoint(sessionId);
    appendLogAsync("jiuwenclaw-exec.log", {
      ts: new Date().toISOString(),
      event: "chat_stream_self_heal",
      adoptId: claw.adoptId,
      agentId,
      sessionId,
      userId: claw.userId,
      healed: heal.ok,
      deletedKeys: heal.deleted,
      error: heal.error || "",
    });
    writeData({
      __status: "检测到会话状态异常，已自动修复，正在重试...",
      kind: "heartbeat",
      tool: "jiuwenclaw",
      elapsedMs: 0,
    });
    outcome = await runAttempt(2);
    if (outcome === "silent") {
      writeData({
        __stream_error: true,
        error: "JiuwenSwarm 会话状态异常，自动修复未生效。请发送 /new 开始新对话后重试。",
      });
    }
  }
  emitDone(Date.now() - overallStartedAt);
}

export async function answerJiuwenPermission(
  claw: JiuwenClawRuntimeClaw,
  args: {
    permissionRequestId: string;
    selectedOption: string;
    answers?: JiuwenInteractionAnswer[];
    source?: string;
    model?: string;
    channel?: unknown;
    conversationId?: unknown;
    epochLabel?: unknown;
    runtimeMode?: unknown;
  },
): Promise<{ ok: true; text: string } | { ok: false; error: string; text?: string }> {
  if (!runtimeEnabled()) {
    return { ok: false, error: "jiuwenclaw runtime is disabled" };
  }
  const enterpriseRoute = await readyEnterpriseRuntimeRoute(claw.adoptId);
  if (enterpriseRoute) {
    const { answerJiuwenGatewayPermission } = await import("./jiuwenswarm-gateway-client");
    return answerJiuwenGatewayPermission(claw, args, enterpriseRoute);
  }
  if (useJiuwenGatewayTransport()) {
    const { answerJiuwenGatewayPermission } = await import("./jiuwenswarm-gateway-client");
    return answerJiuwenGatewayPermission(claw, args);
  }
  const permissionRequestId = String(args.permissionRequestId || "").trim();
  if (!permissionRequestId) {
    return { ok: false, error: "permissionRequestId required" };
  }

  const wsUrl = String(process.env.JIUWENCLAW_AGENTSERVER_WS_URL || DEFAULT_AGENTSERVER_WS_URL);
  const serviceId = buildJiuwenServiceId();
  const agentId = buildJiuwenAgentId(claw);
  const sessionId = buildJiuwenSessionId(claw, agentId, args);
  const channelId = claw.adoptId;
  const workspaceDir = resolveRuntimeWorkspace(claw, claw.adoptId);
  const envelopeRequestId = `linggan-jiuwen-answer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const requestPayload = buildJiuwenAgentServerPermissionAnswerRequest({
    envelopeRequestId,
    permissionRequestId,
    serviceId,
    agentId,
    sessionId,
    channelId,
    workspaceDir,
    selectedOption: args.selectedOption,
    answers: args.answers,
    source: args.source,
    runtimeMode: args.runtimeMode,
  });

  appendLogAsync("jiuwenclaw-exec.log", {
    ts: new Date().toISOString(),
    event: "permission_answer_request",
    adoptId: claw.adoptId,
    agentId,
    serviceId,
    sessionId,
    channelId,
    userId: claw.userId,
    envelopeRequestId,
    permissionRequestId,
    selectedOption: args.selectedOption,
    answerCount: args.answers?.length || 1,
    source: args.source || "permission_interrupt",
  });

  return new Promise((resolve) => {
    let settled = false;
    let requestSent = false;
    let text = "";
    const timeoutMs = Math.max(15_000, Number(process.env.JIUWENCLAW_PERMISSION_TIMEOUT_MS || 180_000) || 180_000);
    const settle = (result: { ok: true; text: string } | { ok: false; error: string; text?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(1000, "permission answer complete"); } catch {}
      if (result.ok) rememberAnsweredPermission(sessionId, permissionRequestId);
      appendLogAsync("jiuwenclaw-exec.log", {
        ts: new Date().toISOString(),
        event: result.ok ? "permission_answer_complete" : "permission_answer_failed",
        adoptId: claw.adoptId,
        agentId,
        sessionId,
        envelopeRequestId,
        permissionRequestId,
        textBytes: Buffer.byteLength(text, "utf8"),
        ...(!result.ok ? { error: result.error } : {}),
      });
      resolve(result);
    };

    const timeout = setTimeout(() => {
      settle({ ok: false, error: "JiuwenSwarm 权限确认后等待结果超时。", text });
    }, timeoutMs);

    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: process.env.JIUWENCLAW_WS_ORIGIN || wsOriginFromUrl(wsUrl),
      },
    });
    const sendRequest = () => {
      if (requestSent || ws.readyState !== WebSocket.OPEN) return;
      requestSent = true;
      ws.send(JSON.stringify(requestPayload));
    };

    ws.on("open", () => {
      setTimeout(sendRequest, 2000);
    });
    ws.on("message", (raw) => {
      const frame = parseJsonFrame(raw);
      if (!frame) return;
      if (frame?.event === "connection.ack") {
        sendRequest();
        return;
      }
      const frameRequestId = String(frame?.request_id || frame?.response_id || "");
      if (frameRequestId && frameRequestId !== envelopeRequestId) return;

      const kind = String(frame?.response_kind || frame?.event || "");
      const status = String(frame?.status || "");
      const body = asJsonObject(frame.body);
      if (status === "failed" || kind === "e2a.error" || kind.endsWith(".error")) {
        settle({ ok: false, error: pickErrorMessage(frame), text });
        return;
      }
      if (kind === "e2a.chunk") {
        if (body?.delta_kind === "text") {
          const delta = pickJiuwenText(body?.delta);
          if (delta) text += sanitizePublicRuntimePaths(delta, workspaceDir);
          return;
        }
        if (body?.delta_kind === "custom") {
          const eventType = String(body.event_type || asJsonObject(body.delta).event_type || "jiuwen.event");
          if (eventType === "chat.delta" || eventType === "chat.final") {
            const delta = pickJiuwenText(body?.delta);
            if (delta) text += sanitizePublicRuntimePaths(delta, workspaceDir);
            if (eventType === "chat.final") settle({ ok: true, text });
            return;
          }
          if (eventType === "chat.error") {
            settle({ ok: false, error: pickJiuwenText(body?.delta) || pickErrorMessage(frame), text });
            return;
          }
        }
      }
      if (frame?.is_final || kind === "e2a.complete") {
        const finalText = pickJiuwenText(body?.result || body);
        if (finalText && !text) text = sanitizePublicRuntimePaths(finalText, workspaceDir);
        settle({ ok: true, text });
      }
    });
    ws.on("error", (err) => {
      settle({ ok: false, error: String((err as any)?.message || err || "jiuwenclaw websocket error").slice(0, 1000), text });
    });
    ws.on("close", () => {
      if (!settled) settle(text ? { ok: true, text } : { ok: false, error: "jiuwenclaw upstream closed before permission answer completed" });
    });
  });
}
