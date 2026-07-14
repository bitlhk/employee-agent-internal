import type { Request, Response } from "express";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import os from "os";
import path from "path";
import { WebSocket, type RawData } from "ws";
import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";
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
import { writeJiuwenSessionArtifacts, type JiuwenSessionArtifactFile } from "./jiuwen-session-artifacts";

export { bumpSessionEpoch } from "./helpers";

export type JiuwenClawRuntimeClaw = {
  adoptId: string;
  agentId: string;
  userId: number;
};

export type JiuwenForwardOptions = {
  model?: string;
  req?: Request;
  channel?: unknown;
  conversationId?: unknown;
  epochLabel?: unknown;
  clientRunId?: string | null;
  runtimeMode?: unknown;
  cancelPendingPermission?: unknown;
  selectedSkills?: JiuwenSelectedSkillMetadata[];
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

export type JiuwenPermissionRequest = {
  requestId: string;
  source: string;
  title: string;
  question: string;
  command?: string;
  toolName?: string;
  options: Array<{ label: string; description?: string; value?: string }>;
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

function parseJsonFrame(raw: RawData): any | null {
  try {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : String(raw);
    return JSON.parse(text);
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

export function inferMcpServerForJiuwenTool(toolName: string): string | null {
  const name = String(toolName || "").trim();
  if (!name) return null;
  const mcpTool = name.match(/^mcp_([a-zA-Z0-9_]+)__[a-zA-Z0-9_]+$/);
  if (mcpTool?.[1]) return mcpTool[1];
  return null;
}

function pickFirstString(obj: any, keys: string[]): string {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function finiteNumber(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

export function normalizeJiuwenUsageSummary(delta: any): { usage: Record<string, number>; model?: string } | null {
  const usage = delta?.usage && typeof delta.usage === "object" ? delta.usage : null;
  if (!usage) return null;

  const input = finiteNumber(usage.input_tokens ?? usage.input ?? usage.inputTokens ?? usage.prompt_tokens);
  const output = finiteNumber(usage.output_tokens ?? usage.output ?? usage.outputTokens ?? usage.completion_tokens);
  const total = finiteNumber(usage.total_tokens ?? usage.total ?? usage.totalTokens);
  const contextWindow = finiteNumber(delta?.context_window_tokens ?? usage.context_window_tokens ?? usage.contextWindow);
  const contextPercent = finiteNumber(delta?.usage_percent ?? usage.usage_percent ?? usage.contextPercent);

  if (input == null && output == null && total == null && contextWindow == null && contextPercent == null) return null;

  return {
    usage: {
      input: input ?? 0,
      output: output ?? 0,
      ...(total != null ? { total } : {}),
      ...(contextWindow != null ? { contextWindow } : {}),
      ...(contextPercent != null ? { contextPercent } : {}),
    },
    model: typeof delta?.model === "string" && delta.model.trim() ? delta.model.trim() : undefined,
  };
}

export function normalizeJiuwenToolPayload(eventType: string, delta: any): {
  isResult: boolean;
  callId: string;
  toolName: string;
  argumentsPayload: unknown;
  resultPayload: unknown;
  isError: boolean;
} | null {
  if (eventType !== "chat.tool_call" && eventType !== "chat.tool_result") return null;
  const isResult = eventType === "chat.tool_result";
  const nested = delta?.[isResult ? "tool_result" : "tool_call"] && typeof delta?.[isResult ? "tool_result" : "tool_call"] === "object"
    ? delta[isResult ? "tool_result" : "tool_call"]
    : delta;
  const fn = nested?.function && typeof nested.function === "object" ? nested.function : {};
  const toolName = pickFirstString(nested, ["name", "toolName", "tool_name", "tool"]) || pickFirstString(fn, ["name"]);
  if (!toolName) return null;
  return {
    isResult,
    callId: pickFirstString(nested, ["id", "tool_call_id", "toolCallId", "call_id"]) || pickFirstString(delta, ["tool_call_id", "toolCallId", "id"]),
    toolName,
    argumentsPayload: nested.arguments ?? nested.args ?? fn.arguments ?? delta?.arguments ?? delta?.args ?? null,
    resultPayload: nested.result ?? nested.content ?? nested.output ?? delta?.result ?? delta?.content ?? null,
    isError: Boolean(nested.is_error || nested.isError || nested.error || nested.status === "failed" || delta?.error),
  };
}

export function stringifyJiuwenToolPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isJiuwenHumanApprovalEvent(eventType: string, delta: unknown): boolean {
  const normalizedEventType = String(eventType || "").toLowerCase();
  if (normalizedEventType === "chat.tool_call" || normalizedEventType === "chat.tool_result") return false;
  if (normalizedEventType === "chat.ask_user_question") return true;
  if (!delta || typeof delta !== "object") return false;

  const source = String((delta as Record<string, unknown>).source || "").trim().toLowerCase();
  return source === "permission_interrupt"
    || source === "confirm_interrupt"
    || source === "ask_user_interrupt";
}

function summarizeJiuwenApprovalEvent(eventType: string, delta: unknown): string {
  const payload = stableJson(delta);
  const trimmedPayload = payload.length > 800 ? `${payload.slice(0, 800)}...` : payload;
  return `JiuwenSwarm 运行时请求人工确认，EA 当前未接入原生确认回传。event=${eventType}; payload=${trimmedPayload}`;
}

function normalizePermissionOptions(rawOptions: unknown): Array<{ label: string; description?: string; value?: string }> {
  if (!Array.isArray(rawOptions)) return [
    { label: "本次允许", value: "本次允许", description: "仅本次允许执行" },
    { label: "拒绝", value: "拒绝", description: "拒绝本次执行" },
  ];
  const options = rawOptions
    .map((item) => {
      if (typeof item === "string") return { label: item, value: item };
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      const label = String(obj.label || obj.value || "").trim();
      if (!label) return null;
      const description = String(obj.description || "").trim();
      const value = String(obj.value || label).trim();
      return {
        label,
        value,
        ...(description ? { description } : {}),
      };
    })
    .filter(Boolean) as Array<{ label: string; description?: string; value?: string }>;
  return options.length > 0 ? options : [
    { label: "本次允许", value: "本次允许", description: "仅本次允许执行" },
    { label: "拒绝", value: "拒绝", description: "拒绝本次执行" },
  ];
}

function extractCommandFromQuestion(question: string): string {
  const fencedJson = question.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fencedJson) {
    try {
      const parsed = JSON.parse(fencedJson);
      const command = String(parsed?.command || parsed?.cmd || "").trim();
      if (command) return command;
    } catch {}
  }
  const fenced = question.match(/```\s*([\s\S]*?)```/)?.[1]?.trim();
  if (fenced && fenced.length <= 2000) return fenced;
  const inline = question.match(/工具\s*`?([^`\s]+)`?\s*需要授权/)?.[1];
  return inline ? `tool: ${inline}` : "";
}

export function normalizeJiuwenPermissionRequest(eventType: string, delta: any, fallbackRequestId: string): JiuwenPermissionRequest | null {
  if (!isJiuwenHumanApprovalEvent(eventType, delta)) return null;
  const source = String(delta?.source || "").trim() || (String(eventType).toLowerCase() === "chat.ask_user_question" ? "permission_interrupt" : "");
  if (source && !["permission_interrupt", "confirm_interrupt", "ask_user_interrupt"].includes(source)) return null;
  const questions = Array.isArray(delta?.questions) ? delta.questions : [];
  const firstQuestion = questions.find((item: any) => item && typeof item === "object") || {};
  const requestId = String(
    delta?.request_id
    || delta?.requestId
    || delta?.id
    || firstQuestion?.request_id
    || firstQuestion?.id
    || fallbackRequestId
  ).trim();
  if (!requestId) return null;
  const question = String(firstQuestion?.question || delta?.question || delta?.message || delta?.query || "").trim();
  const title = String(firstQuestion?.header || delta?.header || "权限审批").trim() || "权限审批";
  const command = extractCommandFromQuestion(question || stableJson(delta));
  const toolName = String(delta?.tool_name || delta?.toolName || firstQuestion?.tool_name || "").trim()
    || (command.startsWith("tool: ") ? command.slice(6).trim() : "");
  return {
    requestId,
    source: source || "permission_interrupt",
    title,
    question: question || "JiuwenSwarm 请求授权后继续执行。",
    ...(command ? { command } : {}),
    ...(toolName ? { toolName } : {}),
    options: normalizePermissionOptions(firstQuestion?.options || delta?.options),
  };
}

export async function recordJiuwenToolAudit(args: {
  claw: JiuwenClawRuntimeClaw;
  req?: Request;
  agentId: string;
  sessionId: string;
  requestId: string;
  channelId: string;
  eventType: string;
  delta: any;
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

  const mcpServer = inferMcpServerForJiuwenTool(tool.toolName);
  if (mcpServer) {
    const mcpEventId = `jw_mcp_${sha256(`${baseRaw}|${mcpServer}`).slice(0, 56)}`;
    if (!seenJiuwenAuditEventIds.has(mcpEventId)) {
      seenJiuwenAuditEventIds.add(mcpEventId);
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

function pickText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const obj = value as any;
  for (const key of ["content", "text", "message", "delta"]) {
    if (typeof obj[key] === "string") return obj[key];
  }
  return "";
}

function pickErrorMessage(frame: any): string {
  const body = frame?.body || {};
  const delta = body?.delta || {};
  return String(
    body?.message
      || body?.error
      || body?.content
      || body?.text
      || delta?.error
      || delta?.message
      || delta?.content
      || delta?.text
      || body?.details?.message
      || body?.details?.error
      || frame?.message
      || "jiuwenclaw runtime error"
  ).slice(0, 1000);
}

export function collectRecentWorkspaceFiles(workspaceDir: string, sinceMs: number): Array<{ name: string; size: number; path: string }> {
  if (!workspaceDir || !existsSync(workspaceDir)) return [];
  const skipDirs = new Set(["skills", "memory", "prompt_attachment", "node_modules", ".git", ".dreams", "dist", "build", ".openclaw", ".agent_history"]);
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
            if (st.mtimeMs >= sinceMs) files.push({ name: entry, size: st.size, path: rel });
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

function normalizeWorkspaceFilePayload(file: any, workspaceDir: string): { name: string; size: number; path: string } | null {
  const rawPath = String(file?.path || file?.file_path || file?.full_path || file?.filepath || "").trim();
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

  if (!relPath) return null;
  const absFile = path.join(workspaceDir, relPath);
  let size = Number(file?.size || 0);
  try {
    const st = statSync(absFile);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {}

  const name = String(file?.name || path.basename(relPath)).trim() || path.basename(relPath);
  return { name, size, path: relPath };
}

export function normalizeJiuwenFileEvent(delta: any, workspaceDir: string): Array<{ name: string; size: number; path: string }> {
  const candidates = Array.isArray(delta?.files)
    ? delta.files
    : Array.isArray(delta?.file_list)
      ? delta.file_list
      : delta?.file
        ? [delta.file]
        : delta?.path
          ? [delta]
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
      answers: [{ selected_options: [args.selectedOption], custom_input: "" }],
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
  const emitDone = () => {
    if (doneEmitted) return;
    doneEmitted = true;
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ __stream_end: true })}\n\n`);
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
    selectedSkillIds: (opts.selectedSkills || []).map((skill) => skill.id).filter(Boolean),
    attempt,
    ...privateMessageLogFields(message),
  });

  return new Promise<"done" | "silent">((resolve) => {
    let settled = false;
    let requestSent = false;
    let sawText = false;
    let clientClosed = false;
    let ackFallbackTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let finalGraceTimer: NodeJS.Timeout | null = null;
    const emittedWorkspaceFiles = new Map<string, JiuwenSessionArtifactFile>();

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
    const fail = (error: string) => {
      logEnd("chat_stream_failed", { error: error.slice(0, 1000) });
      writeData({ __stream_error: true, error });
      emitDone();
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
      writeData({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
      emitDone();
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
        const seconds = Math.round(maxRunMs / 1000);
        const error = `JiuwenClaw 本次任务执行超过 ${seconds} 秒，已停止以避免连接超时。请缩小问题范围，或切换“快速”模式后重试。`;
        try { ws.close(1000, "timeout"); } catch {}
        fail(error);
      }, maxRunMs);
    }

    const onClientClose = () => {
      if (res.writableEnded || settled) return;
      clientClosed = true;
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
      const body = frame?.body || {};

      if (status === "failed" || kind === "e2a.error" || kind.endsWith(".error")) {
        fail(pickErrorMessage(frame));
        try { ws.close(1000, "failed"); } catch {}
        return;
      }

      if (kind === "e2a.chunk") {
        if (body?.delta_kind === "text") {
          const text = pickText(body?.delta);
          if (text) {
            currentStatus = "正在生成回复...";
            sawText = true;
            writeData({ choices: [{ delta: { content: sanitizePublicRuntimePaths(text, workspaceDir) }, index: 0 }] });
          }
          return;
        }
        if (body?.delta_kind === "reasoning") {
          const reasoning = pickText(body?.delta);
          if (reasoning) {
            currentStatus = "正在分析...";
            writeData({ choices: [{ delta: { reasoning_content: sanitizePublicRuntimePaths(reasoning, workspaceDir) }, index: 0 }] });
          }
          return;
        }
        if (body?.delta_kind === "custom") {
          const eventType = String(body?.event_type || body?.delta?.event_type || "jiuwen.event");
          const text = pickText(body?.delta);
          if (eventType === "chat.delta" && text) {
            currentStatus = "正在生成回复...";
            sawText = true;
            writeData({ choices: [{ delta: { content: sanitizePublicRuntimePaths(text, workspaceDir) }, index: 0 }] });
            return;
          }
          if (eventType === "chat.reasoning" && text) {
            currentStatus = "正在分析...";
            writeData({ choices: [{ delta: { reasoning_content: sanitizePublicRuntimePaths(text, workspaceDir) }, index: 0 }] });
            return;
          }
          if (eventType === "chat.final") {
            if (text && !sawText) {
              sawText = true;
              writeData({ choices: [{ delta: { content: sanitizePublicRuntimePaths(text, workspaceDir) }, index: 0 }] });
            }
            completeSoon(ws);
            return;
          }
          if (eventType === "chat.usage_summary") {
            const usageSummary = normalizeJiuwenUsageSummary(body?.delta);
            if (usageSummary) {
              writeData({
                __perf: {
                  usage: usageSummary.usage,
                  ...(usageSummary.model ? { model: usageSummary.model } : {}),
                },
              });
            }
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
              emitDone();
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
              const toolCallId = tool.callId || `jiuwen-${sha256(`${requestId}|${tool.toolName}`).slice(0, 16)}`;
              if (tool.isResult) {
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
        const finalText = pickText(body?.result || body);
        if (finalText && !sawText) {
          sawText = true;
          writeData({ choices: [{ delta: { content: sanitizePublicRuntimePaths(finalText, workspaceDir) }, index: 0 }] });
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
  emitDone();
}

export async function answerJiuwenPermission(
  claw: JiuwenClawRuntimeClaw,
  args: {
    permissionRequestId: string;
    selectedOption: string;
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
      const body = frame?.body || {};
      if (status === "failed" || kind === "e2a.error" || kind.endsWith(".error")) {
        settle({ ok: false, error: pickErrorMessage(frame), text });
        return;
      }
      if (kind === "e2a.chunk") {
        if (body?.delta_kind === "text") {
          const delta = pickText(body?.delta);
          if (delta) text += sanitizePublicRuntimePaths(delta, workspaceDir);
          return;
        }
        if (body?.delta_kind === "custom") {
          const eventType = String(body?.event_type || body?.delta?.event_type || "jiuwen.event");
          if (eventType === "chat.delta" || eventType === "chat.final") {
            const delta = pickText(body?.delta);
            if (delta) text += sanitizePublicRuntimePaths(delta, workspaceDir);
            if (eventType === "chat.final") settle({ ok: true, text });
            return;
          }
          if (eventType === "chat.error") {
            settle({ ok: false, error: pickText(body?.delta) || pickErrorMessage(frame), text });
            return;
          }
        }
      }
      if (frame?.is_final || kind === "e2a.complete") {
        const finalText = pickText(body?.result || body);
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
