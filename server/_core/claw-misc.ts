import express from "express";
import { COOKIE_NAME } from "@shared/const";
import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, statSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { strictLimiter } from "./security";
import {
  APP_ROOT,
  JIUWENCLAW_HOME,
  OPENCLAW_HOME,
  OPENCLAW_JSON_PATH,
  buildSessionRegistryScope,
  isJiuwenClawAdoptId,
  jiuwenClawAgentId,
  jiuwenClawSessionsDir,
  jiuwenClawWorkspaceDir,
  openClawAgentDir,
  openClawWorkspaceDir,
  readSessionEpoch,
  resolveRuntimeAgentId,
  resolveRuntimeWorkspace,
  requireClawOwner,
  upsertSessionRegistry,
} from "./helpers";
import { createContext } from "./context";
import { clearSessionCookieVariants, setLogoutLockCookieVariants } from "./cookies";
import { sessionAuthVersion } from "./sdk";
import { skillInstaller } from "./skills/skill-installer";
import { MAX_SKILL_PACKAGE_BYTES, parseSkillPackageBuffer } from "./skills/skill-source";
import { skillStoreMarketplaceDir } from "./skills/skill-store";
import { readJiuwenSessionArtifacts, type JiuwenSessionArtifactFile } from "./jiuwen-session-artifacts";

type UsageBucket = { total: number; days: Record<string, number>; lastTs: string; userId: number };
type ChatHistoryToolCall = {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "running" | "done" | "error";
  ts: number;
  executor?: "gateway" | "jiuwenswarm";
  _gateway?: boolean;
  outputFiles?: Array<{ name: string; size: number; wsPath: string }>;
  adoptId?: string;
};
type ChatHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timeLabel: string;
  timestamp: number;
  toolCalls?: ChatHistoryToolCall[];
};
type HistoryRunMessages = { source: string; runAt: number; messages: ChatHistoryMessage[] };
type ChatHistorySessionSummary = {
  title: string;
  preview: string;
  searchText?: string;
  messageCount: number;
};
type ChatHistorySummaryCache = {
  version: 1;
  entries: Record<string, {
    fingerprint: string;
    summary: ChatHistorySessionSummary;
    cachedAt: number;
  }>;
};
const iosLoadDebugEnabled = process.env.IOS_LOAD_DEBUG === "1";
const CHAT_HISTORY_SUMMARY_CACHE_FILE = ".employee-agent-chat-history-summary-cache.json";

function logIosLoadDebug(message: string, fields: Record<string, unknown> = {}): void {
  if (!iosLoadDebugEnabled) return;
  console.log(`[IOS-LOAD] ${message}`, fields);
}

function normalizeHistoryText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateHistoryText(value: unknown, max = 28): string {
  const text = normalizeHistoryText(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatHistoryTimeLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function stripPlatformLanguagePolicy(text: string): string {
  const legacyLanguagePolicyLabel = ["Employee", "Agent", "Platform", "Language", "Policy"].join(" ");
  return text
    .replace(/\[[^\]]*Workforce Agent Platform Language Policy\][\s\S]*?\[\/Workforce Agent Platform Language Policy\]\s*/g, "")
    .replace(new RegExp(`\\[[^\\]]*${legacyLanguagePolicyLabel}\\][\\s\\S]*?\\[\\/${legacyLanguagePolicyLabel}\\]\\s*`, "g"), "")
    .replace(/^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+GMT[+-]\d+\]\s*/g, "")
    .trim();
}

function stripEaJiuwenConversationContext(text: string): string {
  return String(text || "")
    .replace(
      /^【EA平台会话上下文】\s*\ncurrentConversationId:\s*[^\n]*\ncurrentJiuwenSessionId:\s*[^\n]*\n如果本轮需要创建定时任务且投递到当前对话，请在 create_scheduled_task 参数中传 conversation_id=currentConversationId、session_id=currentJiuwenSessionId、delivery_channel=conversation。\s*\n*/g,
      "",
    )
    .trim();
}

function stripEaSelectedSkillContext(text: string): string {
  const value = String(text || "").trim();
  if (!value.startsWith("【本轮已由用户在输入框选择技能 Chip】")) return value;
  const marker = "\n用户问题：";
  const idx = value.lastIndexOf(marker);
  if (idx < 0) return value;
  return value.slice(idx + marker.length).trim();
}

function stripEaJiuwenUserInternalContext(text: string): string {
  return stripEaSelectedSkillContext(stripEaJiuwenConversationContext(text));
}

function textFromOpenClawContent(content: unknown, role: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content as any[]) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "");
    if (type === "thinking" || type === "tool_use" || type === "tool_result") continue;
    if (typeof item.text === "string") parts.push(item.text);
    else if (role === "assistant" && typeof item.content === "string" && (type === "output_text" || type === "text")) parts.push(item.content);
  }
  return parts.join("\n\n").trim();
}

function compactHistoryJson(value: unknown, max = 6000): string {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value ?? {}, null, 2);
    } catch {
      text = String(value || "");
    }
  }
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

function textFromToolResultContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return compactHistoryJson(value);
}

function toolCallsFromOpenClawContent(content: unknown, timestamp: number): ChatHistoryToolCall[] {
  if (!Array.isArray(content)) return [];
  const calls: ChatHistoryToolCall[] = [];
  const byId = new Map<string, ChatHistoryToolCall>();
  for (const item of content as any[]) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "");
    if (type === "thinking") {
      const text = String(item.text || item.content || "").trim();
      if (!text) continue;
      calls.push({
        id: `thinking-${calls.length}`,
        name: "thinking",
        arguments: "{}",
        result: text.length > 6000 ? `${text.slice(0, 6000)}\n...` : text,
        status: "done",
        ts: timestamp || Date.now(),
        executor: "gateway",
        _gateway: true,
      });
      continue;
    }
    if (type === "tool_use") {
      const id = String(item.id || item.tool_use_id || `tool-${calls.length}`);
      const name = String(item.name || item.tool_name || "tool");
      const call: ChatHistoryToolCall = {
        id,
        name,
        arguments: compactHistoryJson(item.input ?? item.arguments ?? {}),
        status: "running",
        ts: timestamp || Date.now(),
      };
      byId.set(id, call);
      calls.push(call);
      continue;
    }
    if (type === "tool_result") {
      const id = String(item.tool_use_id || item.tool_call_id || item.id || "");
      const result = textFromToolResultContent(item.content ?? item.result ?? item.text).trim();
      const existing = id ? byId.get(id) : undefined;
      if (existing) {
        existing.result = result.length > 6000 ? `${result.slice(0, 6000)}\n...` : result;
        existing.status = item.is_error || item.error ? "error" : "done";
      } else {
        calls.push({
          id: id || `tool-result-${calls.length}`,
          name: String(item.name || item.tool_name || "tool_result"),
          arguments: "{}",
          result: result.length > 6000 ? `${result.slice(0, 6000)}\n...` : result,
          status: item.is_error || item.error ? "error" : "done",
          ts: timestamp || Date.now(),
        });
      }
    }
  }
  return calls.map((call) => call.status === "running" ? { ...call, status: "done" as const } : call);
}

function historyToolCallsSignature(toolCalls?: ChatHistoryToolCall[]): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return toolCalls
    .map((tool) => [
      tool.id,
      tool.name,
      tool.status,
      String(tool.arguments || "").slice(0, 120),
      String(tool.result || "").slice(0, 120),
    ].join(":"))
    .join("|");
}

function extractOpenClawChatMessages(sessionFile: string, maxMessages = 200): ChatHistoryMessage[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  const messages: ChatHistoryMessage[] = [];
  const lines = readFileSync(sessionFile, "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== "message") continue;
    const role = String(event?.message?.role || "");
    if (role !== "user" && role !== "assistant") continue;
    let text = textFromOpenClawContent(event?.message?.content, role);
    if (role === "user") text = stripPlatformLanguagePolicy(text);
    text = text.trim();
    const timestamp = Number(event?.message?.timestamp || event?.timestamp || 0) || 0;
    const toolCalls = role === "assistant" ? toolCallsFromOpenClawContent(event?.message?.content, timestamp) : [];
    if (!text && toolCalls.length === 0) continue;
    messages.push({
      id: `hist-${String(event?.id || messages.length)}`,
      role,
      text,
      timeLabel: formatHistoryTimeLabel(timestamp),
      timestamp,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }
  return messages.slice(-maxMessages);
}

function chatHistoryMessageFromOpenClawMessage(raw: any, fallbackTimestamp: number, idPrefix: string, index: number): ChatHistoryMessage | null {
  const role = String(raw?.role || "");
  if (role !== "user" && role !== "assistant") return null;
  let text = textFromOpenClawContent(raw?.content, role);
  if (role === "user") text = stripPlatformLanguagePolicy(text);
  text = text.trim();
  const timestamp = Number(raw?.timestamp || fallbackTimestamp || 0) || 0;
  const toolCalls = role === "assistant" ? toolCallsFromOpenClawContent(raw?.content, timestamp) : [];
  if (!text && toolCalls.length === 0) return null;
  return {
    id: `hist-${idPrefix}-${index}`,
    role,
    text,
    timeLabel: formatHistoryTimeLabel(timestamp),
    timestamp,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function extractTrajectoryRunMessages(trajectoryFile: string, expectedSessionKey: string): HistoryRunMessages | null {
  if (!trajectoryFile || !existsSync(trajectoryFile)) return null;
  let matched = false;
  let runAt = 0;
  let latestSnapshot: any[] | null = null;
  let latestSnapshotAt = 0;
  const source = path.basename(trajectoryFile).replace(/\.trajectory\.jsonl$/, "");

  for (const line of readFileSync(trajectoryFile, "utf8").split("\n")) {
    if (!line) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.sessionKey === expectedSessionKey) matched = true;
    if (!matched && event?.sessionKey) continue;
    const eventAt = typeof event?.ts === "string" ? Date.parse(event.ts) : Number(event?.ts || 0);
    if (Number.isFinite(eventAt) && eventAt > runAt) runAt = eventAt;
    const snapshot = event?.data?.messagesSnapshot;
    if (Array.isArray(snapshot)) {
      latestSnapshot = snapshot;
      latestSnapshotAt = Number.isFinite(eventAt) && eventAt > 0 ? eventAt : latestSnapshotAt;
    }
  }

  if (!matched || !latestSnapshot) return null;
  const fallbackTimestamp = latestSnapshotAt || runAt;
  const messages = latestSnapshot
    .map((message, index) => chatHistoryMessageFromOpenClawMessage(message, fallbackTimestamp, source, index))
    .filter(Boolean) as ChatHistoryMessage[];
  if (messages.length === 0) return null;
  return { source, runAt: runAt || fallbackTimestamp || 0, messages };
}

function trajectoryFileForSessionFile(sessionFile: string): string {
  const value = String(sessionFile || "");
  return value.endsWith(".jsonl") ? value.replace(/\.jsonl$/, ".trajectory.jsonl") : "";
}

function listTrajectoryRunsForSessionKey(args: {
  sessionsDir: string;
  sessionKey: string;
  currentSessionFile?: string;
  scanFallback?: boolean;
}): HistoryRunMessages[] {
  const runs: HistoryRunMessages[] = [];
  const preferredTrajectoryFile = trajectoryFileForSessionFile(args.currentSessionFile || "");
  if (preferredTrajectoryFile && existsSync(preferredTrajectoryFile)) {
    const run = extractTrajectoryRunMessages(preferredTrajectoryFile, args.sessionKey);
    if (run) runs.push(run);
  }
  if (runs.length > 0 || !args.scanFallback) {
    return runs.sort((a, b) => a.runAt - b.runAt);
  }

  let entries: ReturnType<typeof readdirSync> = [];
  try {
    entries = readdirSync(args.sessionsDir, { withFileTypes: true }) as any;
  } catch {
    return runs;
  }
  for (const entry of entries as any[]) {
    if (!entry.isFile() || !entry.name.endsWith(".trajectory.jsonl")) continue;
    const trajectoryFile = path.join(args.sessionsDir, entry.name);
    if (preferredTrajectoryFile && path.resolve(trajectoryFile) === path.resolve(preferredTrajectoryFile)) continue;
    const run = extractTrajectoryRunMessages(trajectoryFile, args.sessionKey);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => a.runAt - b.runAt);
}

function dedupeHistoryMessages(messages: ChatHistoryMessage[], maxMessages: number): ChatHistoryMessage[] {
  const seen = new Set<string>();
  const deduped: ChatHistoryMessage[] = [];
  for (const message of messages) {
    const normalizedText = normalizeHistoryText(message.text);
    const toolSignature = historyToolCallsSignature(message.toolCalls);
    if (!normalizedText && !toolSignature) continue;
    const timeBucket = message.timestamp > 0 ? String(message.timestamp) : "no-ts";
    const fingerprint = `${message.role}|${timeBucket}|${normalizedText || toolSignature}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    deduped.push({
      ...message,
      id: `hist-merged-${deduped.length}`,
      timeLabel: formatHistoryTimeLabel(message.timestamp),
    });
  }
  return deduped
    .sort((a, b) => {
      if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return 0;
    })
    .slice(-maxMessages);
}

function collectOpenClawChatHistoryMessages(args: {
  sessionsDir: string;
  sessionKey: string;
  currentSessionFile?: string;
  maxMessages?: number;
  scanTrajectoryFallback?: boolean;
}): ChatHistoryMessage[] {
  const maxMessages = args.maxMessages || 200;
  const runs = listTrajectoryRunsForSessionKey({
    sessionsDir: args.sessionsDir,
    sessionKey: args.sessionKey,
    currentSessionFile: args.currentSessionFile,
    scanFallback: args.scanTrajectoryFallback === true,
  });
  const merged: ChatHistoryMessage[] = [];
  for (const run of runs) merged.push(...run.messages);

  const currentSessionFile = args.currentSessionFile ? path.resolve(args.currentSessionFile) : "";
  if (currentSessionFile) {
    merged.push(...extractOpenClawChatMessages(currentSessionFile, maxMessages));
  }

  return dedupeHistoryMessages(merged, maxMessages);
}

function normalizeJiuwenHistoryTimestamp(value: unknown): number {
  const raw = Number(value || 0) || 0;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 10_000_000_000 ? raw * 1000 : raw;
}

function jiuwenConversationIdFromSessionId(sessionId: string, adoptId: string): string {
  const prefix = `sess_${adoptId}_web_`;
  const value = String(sessionId || "").trim();
  if (!value.startsWith(prefix)) return recoveredConversationId(value || "jiuwen");
  const rest = value.slice(prefix.length);
  const lastUnderscore = rest.lastIndexOf("_");
  const conversationId = lastUnderscore > 0 ? rest.slice(0, lastUnderscore) : rest;
  return conversationId || recoveredConversationId(value);
}

function safeJiuwenSessionId(value: unknown): string {
  const sessionId = String(value || "").trim();
  return /^[a-zA-Z0-9._-]{8,160}$/.test(sessionId) ? sessionId : "";
}

function isListableJiuwenWebSession(sessionId: string, adoptId: string): boolean {
  const value = String(sessionId || "").trim();
  if (!value.startsWith(`sess_${adoptId}_web_`)) return false;
  if (value.includes("_conv_linggan_channel_")) return false;
  if (/\.bak(?:-|$)/i.test(value)) return false;
  return !/(?:^|[_-])(smoke|debug|test|bench|bash_approval)(?:[_-]|$)/i.test(value);
}

function jiuwenHistoryFileForSession(sessionsDir: string, sessionId: string): string | null {
  const safeSessionId = safeJiuwenSessionId(sessionId);
  if (!safeSessionId) return null;
  const sessionsRoot = path.resolve(sessionsDir);
  const files = ["history.jsonl", "history.json"]
    .map((name) => path.resolve(path.join(sessionsDir, safeSessionId, name)))
    .filter((file) => file.startsWith(sessionsRoot + path.sep) && existsSync(file))
    .map((file) => {
      try {
        return { file, mtimeMs: statSync(file).mtimeMs };
      } catch {
        return { file, mtimeMs: 0 };
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.file || null;
}

function readJiuwenSessionMetadata(sessionsDir: string, sessionId: string): any {
  const safeSessionId = safeJiuwenSessionId(sessionId);
  if (!safeSessionId) return {};
  const sessionsRoot = path.resolve(sessionsDir);
  const file = path.resolve(path.join(sessionsDir, safeSessionId, "metadata.json"));
  if (!file.startsWith(sessionsRoot + path.sep) || !existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8") || "{}") || {};
  } catch {
    return {};
  }
}

function jiuwenHistoryContent(raw: any): string {
  const value = raw?.content ?? raw?.text ?? raw?.message?.content ?? "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

function shouldUseJiuwenAssistantHistoryEvent(eventType: string): boolean {
  const type = String(eventType || "").toLowerCase();
  if (!type) return true;
  if (type.includes("reasoning") || type.includes("thinking")) return false;
  if (type.includes("tool") || type.includes("usage")) return false;
  if (type === "chat.delta" || type === "chat.final" || type === "chat.message") return true;
  return type.startsWith("chat.");
}

function mergeJiuwenAssistantText(previous: string, next: string, eventType: string): string {
  const text = String(next || "");
  if (!text) return previous;
  if (eventType === "chat.final") return text;
  if (!previous) return text;
  if (text.includes(previous) && text.length > previous.length) return text;
  if (previous.includes(text)) return previous;
  return `${previous}${text}`;
}

function compactJiuwenToolPayload(value: unknown, max = 6000): string {
  const text = compactHistoryJson(value, max);
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function jiuwenToolNameFromPayload(payload: any): string {
  const nested = payload && typeof payload === "object" ? payload : {};
  const fn = nested?.function && typeof nested.function === "object" ? nested.function : {};
  const direct = firstNonEmptyString(nested?.name, nested?.toolName, nested?.tool_name, nested?.tool, fn?.name);
  if (direct) return direct;

  const args = nested?.arguments ?? nested?.args ?? fn?.arguments;
  if (typeof args === "string") {
    if (args.includes('"tool_names"') || args.includes("'tool_names'")) return "load_tools";
    return "";
  }
  if (args && typeof args === "object") {
    if (Array.isArray((args as any).tool_names) || Array.isArray((args as any).toolNames)) return "load_tools";
  }
  return "";
}

function jiuwenToolCallIdFromPayload(payload: any, fallback = ""): string {
  const nested = payload && typeof payload === "object" ? payload : {};
  return firstNonEmptyString(nested?.tool_call_id, nested?.toolCallId, nested?.id, nested?.call_id, fallback);
}

function jiuwenToolArgumentsFromPayload(payload: any): unknown {
  const nested = payload && typeof payload === "object" ? payload : {};
  const fn = nested?.function && typeof nested.function === "object" ? nested.function : {};
  return nested?.arguments ?? nested?.args ?? fn?.arguments ?? {};
}

function jiuwenToolCallsFromAssistantEvent(event: any, timestamp: number): ChatHistoryToolCall[] {
  const rawCalls = Array.isArray(event?.tool_calls)
    ? event.tool_calls
    : Array.isArray(event?.message?.tool_calls)
      ? event.message.tool_calls
      : Array.isArray(event?.toolCalls)
        ? event.toolCalls
        : [];
  const calls: ChatHistoryToolCall[] = [];
  for (const raw of rawCalls) {
    if (!raw || typeof raw !== "object") continue;
    const nested = raw?.tool_call && typeof raw.tool_call === "object" ? raw.tool_call : raw;
    const name = jiuwenToolNameFromPayload(nested);
    if (!name) continue;
    calls.push({
      id: jiuwenToolCallIdFromPayload(nested, `jiuwen-tool-${timestamp || Date.now()}-${calls.length}`),
      name,
      arguments: compactJiuwenToolPayload(jiuwenToolArgumentsFromPayload(nested)),
      status: "running",
      ts: timestamp || Date.now(),
      executor: "jiuwenswarm",
    });
  }
  return calls;
}

function jiuwenToolCallFromEvent(event: any, timestamp: number, fallbackIndex: number): ChatHistoryToolCall | null {
  const eventType = String(event?.event_type || event?.type || "").toLowerCase();
  if (eventType !== "chat.tool_call") return null;
  const nested = event?.tool_call && typeof event.tool_call === "object" ? event.tool_call : event;
  const fn = nested?.function && typeof nested.function === "object" ? nested.function : {};
  const name = jiuwenToolNameFromPayload({ ...nested, function: fn });
  if (!name) return null;
  const id = jiuwenToolCallIdFromPayload({ ...nested, tool_call_id: nested?.tool_call_id || event?.tool_call_id })
    || `jiuwen-tool-${timestamp || Date.now()}-${fallbackIndex}`;
  return {
    id,
    name,
    arguments: compactJiuwenToolPayload(jiuwenToolArgumentsFromPayload({ ...nested, arguments: nested?.arguments ?? event?.arguments, args: nested?.args ?? event?.args, function: fn })),
    status: "running",
    ts: timestamp || Date.now(),
    executor: "jiuwenswarm",
  };
}

function applyJiuwenToolResultToCalls(calls: ChatHistoryToolCall[], event: any, timestamp: number): ChatHistoryToolCall[] {
  const eventType = String(event?.event_type || event?.type || "").toLowerCase();
  if (eventType !== "chat.tool_result") return calls;
  const nested = event?.tool_result && typeof event.tool_result === "object" ? event.tool_result : event;
  const id = String(nested?.tool_call_id || nested?.toolCallId || nested?.id || nested?.call_id || event?.tool_call_id || "").trim();
  const result = nested?.result ?? nested?.content ?? nested?.output ?? event?.result ?? event?.content ?? "";
  const isError = Boolean(nested?.is_error || nested?.isError || nested?.error || nested?.status === "failed" || event?.error);
  const resultText = result == null || result === "" ? "" : compactJiuwenToolPayload(result);
  const updateAt = id ? calls.findIndex((call) => call.id === id) : [...calls].reverse().findIndex((call) => call.status === "running");
  const idx = id ? updateAt : (updateAt >= 0 ? calls.length - 1 - updateAt : -1);
  if (idx >= 0) {
    const next = [...calls];
    next[idx] = {
      ...next[idx],
      ...(resultText ? { result: resultText } : {}),
      status: isError ? "error" : "done",
    };
    return next;
  }
  return [
    ...calls,
    {
      id: id || `jiuwen-tool-result-${timestamp || Date.now()}-${calls.length}`,
      name: String(nested?.name || nested?.toolName || nested?.tool_name || "tool_result"),
      arguments: "{}",
      ...(resultText ? { result: resultText } : {}),
      status: isError ? "error" : "done",
      ts: timestamp || Date.now(),
      executor: "jiuwenswarm",
    },
  ];
}

const GENERATED_FILE_TOOL_NAMES = new Set(["write", "write_file", "edit", "edit_file"]);
const GENERATED_FILE_SKIP_ROOTS = new Set(["skills", "memory", "prompt_attachment", "node_modules", ".git"]);

function jiuwenWorkspaceFromHistoryFile(historyFile: string): string {
  return path.join(path.resolve(path.dirname(historyFile), "../.."), "jiuwenclaw_workspace");
}

function generatedFilesFromToolCalls(calls: ChatHistoryToolCall[], workspaceDir: string): JiuwenSessionArtifactFile[] {
  const candidates: string[] = [];
  for (const call of calls) {
    if (!GENERATED_FILE_TOOL_NAMES.has(String(call.name || "").toLowerCase())) continue;
    try {
      const parsed = JSON.parse(call.arguments || "{}");
      const direct = parsed?.file_path ?? parsed?.filePath ?? parsed?.path;
      if (typeof direct === "string") candidates.push(direct);
    } catch {}
    for (const text of [call.arguments, call.result || ""]) {
      for (const match of String(text || "").matchAll(/(?:file_path|filePath|fullPath|path)["']?\s*[:=]\s*["']([^"']+)["']/g)) {
        candidates.push(match[1]);
      }
    }
  }

  const workspaceRoot = path.resolve(workspaceDir);
  const files = new Map<string, JiuwenSessionArtifactFile>();
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspaceRoot, candidate);
    const relative = path.relative(workspaceRoot, absolute).split(path.sep).join("/");
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) continue;
    if (GENERATED_FILE_SKIP_ROOTS.has(relative.split("/")[0])) continue;
    try {
      const stats = statSync(absolute);
      if (!stats.isFile()) continue;
      files.set(relative, { name: path.basename(relative), size: Number(stats.size), path: relative });
    } catch {}
  }
  return Array.from(files.values()).slice(0, 20);
}

export function extractJiuwenChatMessages(historyFile: string, maxMessages = 200, adoptId = "", workspaceDirRaw = ""): ChatHistoryMessage[] {
  if (!historyFile || !existsSync(historyFile)) return [];
  const messages: ChatHistoryMessage[] = [];
  const assistantByRequest = new Map<string, {
    id: string;
    finalText: string;
    fallbackText: string;
    timestamp: number;
    toolCalls: ChatHistoryToolCall[];
  }>();
  const rawHistory = readFileSync(historyFile, "utf8");
  const artifactRuns = readJiuwenSessionArtifacts(historyFile);
  const workspaceDir = workspaceDirRaw || jiuwenWorkspaceFromHistoryFile(historyFile);
  const trimmedHistory = rawHistory.trim();
  let events: any[] | null = null;
  if (trimmedHistory.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedHistory);
      if (Array.isArray(parsed)) events = parsed;
    } catch {}
  }
  const rows = events || rawHistory.split("\n");
  for (const row of rows) {
    if (typeof row === "string" && !row.trim()) continue;
    let event: any;
    if (typeof row === "string") {
      try { event = JSON.parse(row); } catch { continue; }
    } else {
      event = row;
    }
    const role = String(event?.role || event?.message?.role || "");
    if (role !== "user" && role !== "assistant") continue;
    const eventType = String(event?.event_type || event?.type || "").toLowerCase();
    const timestamp = normalizeJiuwenHistoryTimestamp(event?.timestamp || event?.created_at || event?.time);
    const text = role === "user"
      ? stripEaJiuwenUserInternalContext(stripPlatformLanguagePolicy(jiuwenHistoryContent(event))).trim()
      : jiuwenHistoryContent(event).trim();

    if (role === "user") {
      if (!text) continue;
      messages.push({
        id: `jiuwen-${String(event?.id || messages.length)}`,
        role,
        text,
        timeLabel: formatHistoryTimeLabel(timestamp),
        timestamp,
      });
      continue;
    }

    const requestId = String(event?.request_id || event?.id || `${timestamp}-${messages.length}`);
    let existing = assistantByRequest.get(requestId);
    if (!existing) {
      existing = {
        id: `jiuwen-${requestId}`,
        finalText: "",
        fallbackText: "",
        timestamp,
        toolCalls: [],
      };
      assistantByRequest.set(requestId, existing);
    }
    const toolCall = jiuwenToolCallFromEvent(event, timestamp, existing.toolCalls.length);
    if (toolCall) {
      existing.toolCalls.push(toolCall);
      if (!existing.timestamp && timestamp) existing.timestamp = timestamp;
      continue;
    }
    const embeddedToolCalls = jiuwenToolCallsFromAssistantEvent(event, timestamp);
    if (embeddedToolCalls.length > 0) {
      existing.toolCalls.push(...embeddedToolCalls);
      if (!existing.timestamp && timestamp) existing.timestamp = timestamp;
    }
    if (eventType === "chat.tool_result") {
      existing.toolCalls = applyJiuwenToolResultToCalls(existing.toolCalls, event, timestamp);
      if (!existing.timestamp && timestamp) existing.timestamp = timestamp;
      continue;
    }
    if (!text) continue;
    if (!shouldUseJiuwenAssistantHistoryEvent(eventType)) continue;
    if (eventType === "chat.final") {
      existing.finalText = text;
    } else {
      existing.fallbackText = mergeJiuwenAssistantText(existing.fallbackText, text, eventType);
    }
    if (!existing.timestamp && timestamp) {
      existing.timestamp = timestamp;
    }
  }

  for (const [requestId, entry] of assistantByRequest.entries()) {
    const persistedRun = artifactRuns.get(requestId);
    const generatedFiles = new Map<string, JiuwenSessionArtifactFile>();
    for (const file of persistedRun?.files || []) generatedFiles.set(file.path, file);
    for (const file of generatedFilesFromToolCalls(entry.toolCalls, workspaceDir)) generatedFiles.set(file.path, file);
    if (generatedFiles.size > 0) {
      const files = Array.from(generatedFiles.values()).slice(0, 20);
      entry.toolCalls.push({
        id: `jiuwen-artifacts-${requestId}`,
        name: "[产出文件]",
        arguments: "{}",
        result: files.map((file) => file.name).join(", "),
        status: "done",
        ts: entry.timestamp || Date.now(),
        executor: "jiuwenswarm",
        outputFiles: files.map((file) => ({ name: file.name, size: file.size, wsPath: file.path })),
        adoptId: persistedRun?.adoptId || adoptId || undefined,
      });
    }
    const text = sanitizePublicRuntimePaths(entry.finalText || entry.fallbackText);
    const toolCalls = entry.toolCalls.map((call) => ({
      ...call,
      arguments: sanitizePublicRuntimePaths(call.arguments),
      ...(call.result != null ? { result: sanitizePublicRuntimePaths(call.result) } : {}),
      status: call.status === "running" ? "done" as const : call.status,
    }));
    if (!text.trim() && toolCalls.length === 0) continue;
    messages.push({
      id: entry.id,
      role: "assistant",
      text,
      timeLabel: formatHistoryTimeLabel(entry.timestamp),
      timestamp: entry.timestamp,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }

  return dedupeHistoryMessages(
    messages
      .filter((message) => normalizeHistoryText(message.text) || (message.toolCalls || []).length > 0)
      .sort((a, b) => {
        const at = typeof a.timestamp === "number" && Number.isFinite(a.timestamp) ? a.timestamp : 0;
        const bt = typeof b.timestamp === "number" && Number.isFinite(b.timestamp) ? b.timestamp : 0;
        return at - bt;
      }),
    maxMessages,
  );
}

export function listJiuwenChatHistorySessions(args: {
  adoptId: string;
  dbAgentId: string;
  limit: number;
}): any[] {
  const sessionDirs = [
    jiuwenClawSessionsDir(args.adoptId, args.dbAgentId),
    path.join(JIUWENCLAW_HOME, "agent", "sessions"),
  ];
  const candidates: any[] = [];
  const seen = new Set<string>();
  for (const sessionsDir of sessionDirs) {
    const sessionsRoot = path.resolve(sessionsDir);
    let entries: ReturnType<typeof readdirSync> = [];
    try {
      entries = readdirSync(sessionsDir, { withFileTypes: true }) as any;
    } catch {
      continue;
    }

    for (const entry of entries as any[]) {
      if (!entry.isDirectory()) continue;
      const sessionId = safeJiuwenSessionId(entry.name);
      if (!sessionId || seen.has(sessionId)) continue;
      if (!isListableJiuwenWebSession(sessionId, args.adoptId)) continue;
      const historyFile = jiuwenHistoryFileForSession(sessionsDir, sessionId);
      if (!historyFile || !historyFile.startsWith(sessionsRoot + path.sep) || !existsSync(historyFile)) continue;
      const metadata = readJiuwenSessionMetadata(sessionsDir, sessionId);
      const channelId = String(metadata?.channel_id || "");
      if (channelId && channelId !== "web" && channelId !== args.adoptId) continue;
      let st: ReturnType<typeof statSync> | null = null;
      try { st = statSync(historyFile); } catch { st = null; }
      const updatedAt = normalizeJiuwenHistoryTimestamp(metadata?.last_message_at) || Number(st?.mtimeMs || 0) || 0;
      const createdAt = normalizeJiuwenHistoryTimestamp(metadata?.created_at) || Number(st?.birthtimeMs || updatedAt || 0) || updatedAt;
      const conversationId = jiuwenConversationIdFromSessionId(sessionId, args.adoptId);
      candidates.push({ conversationId, sessionId, historyFile, metadata, updatedAt, createdAt });
      seen.add(sessionId);
    }
  }

  const byConversation = new Map<string, any>();
  for (const candidate of candidates) {
    const previous = byConversation.get(candidate.conversationId);
    if (!previous || Number(candidate.updatedAt || 0) > Number(previous.updatedAt || 0)) {
      byConversation.set(candidate.conversationId, candidate);
    }
  }

  return Array.from(byConversation.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, args.limit)
    .map((entry) => {
      const messages = extractJiuwenChatMessages(
        entry.historyFile,
        80,
        args.adoptId,
        jiuwenClawWorkspaceDir(args.adoptId, args.dbAgentId),
      );
      const firstUser = messages.find((m) => m.role === "user");
      const last = [...messages].reverse().find((m) => normalizeHistoryText(m.text));
      return {
        conversationId: entry.conversationId,
        sessionKey: entry.sessionId,
        sessionId: entry.sessionId,
        title: truncateHistoryText(entry.metadata?.title || firstUser?.text || "", 24) || "新对话",
        preview: truncateHistoryText(last?.text || "", 42),
        searchText: normalizeHistoryText(messages.map((message) => message.text || "").join(" ")).slice(0, 12000),
        messageCount: messages.length,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    })
    .filter((entry) => entry.messageCount > 0);
}

export function resolveJiuwenHistorySession(args: {
  adoptId: string;
  dbAgentId: string;
  sessionKey: string;
}): { conversationId: string; sessionId: string; historyFile: string; sessionsDir: string } | null {
  const sessionId = safeJiuwenSessionId(args.sessionKey);
  if (!sessionId) return null;
  const sessionDirs = [
    jiuwenClawSessionsDir(args.adoptId, args.dbAgentId),
    path.join(JIUWENCLAW_HOME, "agent", "sessions"),
  ];
  for (const sessionsDir of sessionDirs) {
    const historyFile = jiuwenHistoryFileForSession(sessionsDir, sessionId);
    if (!historyFile || !existsSync(historyFile)) continue;
    return {
      conversationId: jiuwenConversationIdFromSessionId(sessionId, args.adoptId),
      sessionId,
      historyFile,
      sessionsDir,
    };
  }
  return null;
}

function deleteJiuwenHistorySession(args: {
  adoptId: string;
  dbAgentId: string;
  sessionKey: string;
}): { conversationId: string; sessionId: string; deleted: number } | null {
  const sessionId = safeJiuwenSessionId(args.sessionKey);
  if (!sessionId || !isListableJiuwenWebSession(sessionId, args.adoptId)) return null;
  const sessionDirs = [
    jiuwenClawSessionsDir(args.adoptId, args.dbAgentId),
    path.join(JIUWENCLAW_HOME, "agent", "sessions"),
  ];
  let deleted = 0;
  for (const sessionsDir of sessionDirs) {
    const sessionsRoot = path.resolve(sessionsDir);
    const sessionDir = path.resolve(path.join(sessionsDir, sessionId));
    if (!sessionDir.startsWith(sessionsRoot + path.sep) || !existsSync(sessionDir)) continue;
    rmSync(sessionDir, { recursive: true, force: true });
    deleted += 1;
  }
  return {
    conversationId: jiuwenConversationIdFromSessionId(sessionId, args.adoptId),
    sessionId,
    deleted,
  };
}

function parseWebSessionKey(sessionKey: string, runtimeAgentId: string): { conversationId: string; epoch?: number } | null {
  const parts = String(sessionKey || "").split(":");
  if (parts[0] !== "agent" || parts[1] !== runtimeAgentId || parts[2] !== "web" || !parts[3]) return null;
  const epochPart = parts[4] || "";
  const epochMatch = /^e(\d+)$/.exec(epochPart);
  return { conversationId: parts[3], epoch: epochMatch ? Number(epochMatch[1]) : undefined };
}

const RECOVERED_WEB_CONVERSATION_PREFIX = "hist_";

function recoveredConversationId(sessionId: string): string {
  return `${RECOVERED_WEB_CONVERSATION_PREFIX}${sessionId}`;
}

function recoveredSessionIdFromConversationId(conversationId: string): string | null {
  const value = String(conversationId || "").trim();
  if (!value.startsWith(RECOVERED_WEB_CONVERSATION_PREFIX)) return null;
  const sessionId = value.slice(RECOVERED_WEB_CONVERSATION_PREFIX.length);
  return /^[a-zA-Z0-9._-]{12,80}$/.test(sessionId) ? sessionId : null;
}

function isRecoverableHistoryMessages(messages: ChatHistoryMessage[]): boolean {
  const firstUser = messages.find((message) => message.role === "user" && normalizeHistoryText(message.text));
  if (!firstUser) return false;
  const firstText = normalizeHistoryText(firstUser.text).toLowerCase();
  if (!firstText) return false;
  if (firstText.includes("[openclaw heartbeat poll]")) return false;
  if (firstText.startsWith("[cron:")) return false;
  if (firstText.includes("reply with exactly: pong")) return false;
  if (firstText.includes("smoke测试") || firstText.includes("smoke_ok")) return false;
  if (firstText.includes("测试流式输出") || firstText.includes("测试前端流式输出")) return false;
  if (firstText.includes("测试文章") && firstText.includes("不少于")) return false;
  if (firstText.includes("沙箱验收")) return false;
  return true;
}

function resolveRecoveredSessionFile(sessionsDir: string, conversationId: string): { sessionId: string; sessionFile: string } | null {
  const sessionId = recoveredSessionIdFromConversationId(conversationId);
  if (!sessionId) return null;
  const sessionsRoot = path.resolve(sessionsDir);
  const sessionFile = path.resolve(path.join(sessionsDir, `${sessionId}.jsonl`));
  if (!sessionFile.startsWith(sessionsRoot + path.sep) || !existsSync(sessionFile)) return null;
  return { sessionId, sessionFile };
}

function listRecoveredWebSessions(args: {
  sessionsDir: string;
  runtimeAgentId: string;
  indexedSessionIds: Set<string>;
  limit: number;
}): any[] {
  const out: any[] = [];
  let entries: ReturnType<typeof readdirSync> = [];
  try {
    entries = readdirSync(args.sessionsDir, { withFileTypes: true }) as any;
  } catch {
    return out;
  }
  const sessionsRoot = path.resolve(args.sessionsDir);
  const candidates: Array<{ sessionId: string; sessionFile: string; mtimeMs: number; birthtimeMs: number }> = [];
  for (const entry of entries as any[]) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".trajectory")) continue;
    if (entry.name.includes(".codex-app-server")) continue;
    const sessionId = entry.name.replace(/\.jsonl$/, "");
    if (!sessionId || args.indexedSessionIds.has(sessionId)) continue;
    const sessionFile = path.resolve(path.join(args.sessionsDir, entry.name));
    if (!sessionFile.startsWith(sessionsRoot + path.sep)) continue;
    try {
      const st = statSync(sessionFile);
      candidates.push({
        sessionId,
        sessionFile,
        mtimeMs: Number(st.mtimeMs || 0),
        birthtimeMs: Number(st.birthtimeMs || 0),
      });
    } catch {}
  }

  const maxCandidates = Math.max(args.limit * 3, 30);
  for (const candidate of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxCandidates)) {
    const messages = extractOpenClawChatMessages(candidate.sessionFile, 80);
    if (!isRecoverableHistoryMessages(messages)) continue;
    const firstTs = messages.find((message) => message.timestamp > 0)?.timestamp || 0;
    const lastTs = [...messages].reverse().find((message) => message.timestamp > 0)?.timestamp || 0;
    const updatedAt = lastTs || candidate.mtimeMs || 0;
    const createdAt = firstTs || candidate.birthtimeMs || updatedAt;
    const conversationId = recoveredConversationId(candidate.sessionId);
    out.push({
      conversationId,
      sessionKey: `agent:${args.runtimeAgentId}:web:${conversationId}`,
      sessionId: candidate.sessionId,
      sessionFile: candidate.sessionFile,
      updatedAt,
      createdAt,
      messageCount: messages.length,
      title: "新对话",
      preview: "",
      recovered: true,
    });
    if (out.length >= args.limit) break;
  }
  return out
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, args.limit);
}

function addUsageEvent(params: {
  byAdopt: Record<string, UsageBucket>;
  dailyAll: Record<string, number>;
  seen: Set<string>;
  key: string;
  adoptId: string;
  ts: string;
  userId?: number;
}) {
  const aid = String(params.adoptId || "").trim();
  const ts = String(params.ts || "").trim();
  const day = ts.slice(0, 10);
  if (!aid || !day || params.seen.has(params.key)) return;
  params.seen.add(params.key);

  const uid = Number(params.userId || 0);
  if (!params.byAdopt[aid]) params.byAdopt[aid] = { total: 0, days: {}, lastTs: "", userId: uid };
  params.byAdopt[aid].total += 1;
  params.byAdopt[aid].days[day] = (params.byAdopt[aid].days[day] || 0) + 1;
  if (ts > params.byAdopt[aid].lastTs) {
    params.byAdopt[aid].lastTs = ts;
    params.byAdopt[aid].userId = uid;
  }
  params.dailyAll[day] = (params.dailyAll[day] || 0) + 1;
}

function addJiuwenUsageEvents(params: {
  byAdopt: Record<string, UsageBucket>;
  dailyAll: Record<string, number>;
  seen: Set<string>;
  adoptId: string;
  dbAgentId: string;
  userId: number;
}) {
  const adoptId = String(params.adoptId || "").trim();
  if (!adoptId || !isJiuwenClawAdoptId(adoptId)) return;
  const maxSessions = Math.min(Math.max(Number(process.env.WORKFORCE_AGENT_USAGE_JIUWEN_MAX_SESSIONS || process.env.LINGXIA_USAGE_JIUWEN_MAX_SESSIONS || 2000), 1), 50000);
  let scanned = 0;
  const sessionDirs = [
    jiuwenClawSessionsDir(adoptId, params.dbAgentId),
    path.join(JIUWENCLAW_HOME, "agent", "sessions"),
  ];
  const seenSessionIds = new Set<string>();

  for (const sessionsDir of sessionDirs) {
    let entries: ReturnType<typeof readdirSync> = [];
    try {
      entries = readdirSync(sessionsDir, { withFileTypes: true }) as any;
    } catch {
      continue;
    }

    for (const entry of entries as any[]) {
      if (!entry.isDirectory()) continue;
      if (scanned >= maxSessions) break;
      const sessionId = safeJiuwenSessionId(entry.name);
      if (!sessionId || seenSessionIds.has(sessionId)) continue;
      if (!isListableJiuwenWebSession(sessionId, adoptId)) continue;
      const historyFile = jiuwenHistoryFileForSession(sessionsDir, sessionId);
      if (!historyFile || !existsSync(historyFile)) continue;
      const metadata = readJiuwenSessionMetadata(sessionsDir, sessionId);
      const channelId = String(metadata?.channel_id || "");
      if (channelId && channelId !== "web" && channelId !== adoptId) continue;
      seenSessionIds.add(sessionId);
      scanned += 1;

      let userMessageCount = 0;
      let fallbackTs = normalizeJiuwenHistoryTimestamp(metadata?.last_message_at)
        || normalizeJiuwenHistoryTimestamp(metadata?.created_at);
      try {
        if (!fallbackTs) fallbackTs = statSync(historyFile).mtimeMs;
      } catch {}

      try {
        const lines = readFileSync(historyFile, "utf8").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (!line.trim() || !line.includes('"role"')) continue;
          let event: any;
          try { event = JSON.parse(line); } catch { continue; }
          const role = String(event?.role || event?.message?.role || "");
          if (role !== "user") continue;
          const text = stripPlatformLanguagePolicy(jiuwenHistoryContent(event)).trim();
          if (!text) continue;
          const tsMs = normalizeJiuwenHistoryTimestamp(event?.timestamp || event?.created_at || event?.time) || fallbackTs;
          if (!tsMs) continue;
          userMessageCount += 1;
          addUsageEvent({
            byAdopt: params.byAdopt,
            dailyAll: params.dailyAll,
            seen: params.seen,
            key: ["jiuwen", adoptId, sessionId, event?.id || index].join("|"),
            adoptId,
            ts: new Date(tsMs).toISOString(),
            userId: params.userId,
          });
        }
      } catch {}

      if (userMessageCount === 0 && fallbackTs) {
        addUsageEvent({
          byAdopt: params.byAdopt,
          dailyAll: params.dailyAll,
          seen: params.seen,
          key: ["jiuwen-session", adoptId, sessionId].join("|"),
          adoptId,
          ts: new Date(fallbackTs).toISOString(),
          userId: params.userId,
        });
      }
    }
  }
}

function runtimeAgentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(String(sessionKey || ""));
  return match?.[1] || "";
}

function adoptIdFromRuntimeAgentId(runtimeAgentId: string): string {
  return String(runtimeAgentId || "").startsWith("trial_")
    ? String(runtimeAgentId).slice("trial_".length)
    : "";
}

function listTrajectoryFiles(rootDir: string, maxFiles: number): string[] {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const visit = (dir: string) => {
    let entries: ReturnType<typeof readdirSync> = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as any;
    } catch {
      return;
    }
    for (const entry of entries as any[]) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".trajectory.jsonl")) {
        try {
          files.push({ path: fullPath, mtimeMs: statSync(fullPath).mtimeMs });
        } catch {
          files.push({ path: fullPath, mtimeMs: 0 });
        }
      }
    }
  };
  visit(rootDir);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .map((item) => item.path);
}

function sessionSummaryCachePath(sessionsDir: string): string {
  return path.join(sessionsDir, CHAT_HISTORY_SUMMARY_CACHE_FILE);
}

function readSessionSummaryCache(sessionsDir: string): ChatHistorySummaryCache {
  try {
    const cachePath = sessionSummaryCachePath(sessionsDir);
    if (!existsSync(cachePath)) return { version: 1, entries: {} };
    const parsed = JSON.parse(readFileSync(cachePath, "utf8") || "{}");
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return { version: 1, entries: parsed.entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeSessionSummaryCache(sessionsDir: string, cache: ChatHistorySummaryCache): void {
  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(sessionSummaryCachePath(sessionsDir), JSON.stringify(cache, null, 2), "utf8");
  } catch (error: any) {
    console.warn("[chat-history] summary cache write failed", error?.message || error);
  }
}

function sessionFileFingerprint(sessionFile: string): string {
  try {
    if (!sessionFile || !existsSync(sessionFile)) return "missing";
    const st = statSync(sessionFile);
    return `${Math.round(st.mtimeMs || 0)}:${Number(st.size || 0)}`;
  } catch {
    return "error";
  }
}

function sessionTrajectoryFingerprint(sessionFile: string): string {
  return sessionFileFingerprint(trajectoryFileForSessionFile(sessionFile));
}

function buildSessionSummaryFingerprint(entry: any): string {
  return [
    String(entry?.sessionId || ""),
    String(entry?.sessionKey || ""),
    Math.round(Number(entry?.updatedAt || 0) || 0),
    sessionFileFingerprint(String(entry?.sessionFile || "")),
    sessionTrajectoryFingerprint(String(entry?.sessionFile || "")),
  ].join("|");
}

function summarizeChatHistorySession(args: {
  sessionsDir: string;
  entry: any;
  cache: ChatHistorySummaryCache;
  stats: { hits: number; misses: number };
}): ChatHistorySessionSummary {
  const cacheKey = String(args.entry?.sessionKey || args.entry?.conversationId || "");
  const fingerprint = buildSessionSummaryFingerprint(args.entry);
  const cached = cacheKey ? args.cache.entries[cacheKey] : null;
  if (cached?.fingerprint === fingerprint && typeof cached.summary?.searchText === "string") {
    args.stats.hits += 1;
    return cached.summary;
  }

  args.stats.misses += 1;
  const messages = collectOpenClawChatHistoryMessages({
    sessionsDir: args.sessionsDir,
    sessionKey: args.entry.sessionKey,
    currentSessionFile: args.entry.sessionFile,
    maxMessages: 80,
    scanTrajectoryFallback: false,
  });
  const firstUser = messages.find((m) => m.role === "user");
  const last = [...messages].reverse().find((m) => normalizeHistoryText(m.text));
  const summary = {
    title: truncateHistoryText(firstUser?.text || "", 24) || "新对话",
    preview: truncateHistoryText(last?.text || "", 42),
    searchText: normalizeHistoryText(messages.map((message) => message.text || "").join(" ")).slice(0, 12000),
    messageCount: messages.length,
  };
  if (cacheKey) {
    args.cache.entries[cacheKey] = {
      fingerprint,
      summary,
      cachedAt: Date.now(),
    };
  }
  return summary;
}

export async function listClawChatHistorySessionRecords(args: {
  adoptId: string;
  claw: any;
  limit?: number;
  startedAt?: number;
}) {
  const startedAt = args.startedAt || Date.now();
  const adoptId = String(args.adoptId || "").trim();
  const claw = args.claw;
  const limit = Math.min(Math.max(Number(args.limit || 50) || 50, 1), 100);
  const dbAgentId = String((claw as any).agentId || "").trim();

  if (isJiuwenClawAdoptId(adoptId)) {
    const sessions = listJiuwenChatHistorySessions({ adoptId, dbAgentId, limit });
    logIosLoadDebug("chat_history_sessions_done_jiuwen", {
      adoptId,
      runtimeAgentId: jiuwenClawAgentId(adoptId, dbAgentId),
      returnedCount: sessions.length,
      ms: Date.now() - startedAt,
    });
    return {
      sessions,
      meta: {
        runtime: "jiuwenswarm",
        timings: { totalMs: Date.now() - startedAt },
      },
    };
  }

  const trialAgentId = `trial_${adoptId}`;
  const runtimeAgentId = existsSync(openClawAgentDir(trialAgentId)) ? trialAgentId : dbAgentId;
  const sessionsPath = path.join(openClawAgentDir(runtimeAgentId), "sessions", "sessions.json");
  if (!existsSync(sessionsPath)) {
    logIosLoadDebug("chat_history_sessions_missing_index", {
      adoptId,
      runtimeAgentId,
      sessionsPath,
      ms: Date.now() - startedAt,
    });
    return { sessions: [], meta: { timings: { totalMs: Date.now() - startedAt } } };
  }

  const rawIndex = JSON.parse(readFileSync(sessionsPath, "utf8") || "{}") || {};
  const rawIndexCount = Object.keys(rawIndex).length;
  const byConversation = new Map<string, any>();
  const sessionsDir = path.join(openClawAgentDir(runtimeAgentId), "sessions");
  const resolvedSessionsDir = path.resolve(sessionsDir);
  const indexedSessionIds = new Set<string>();
  for (const [sessionKey, raw] of Object.entries(rawIndex) as Array<[string, any]>) {
    const parsed = parseWebSessionKey(sessionKey, runtimeAgentId);
    if (!parsed) continue;
    const sessionId = String(raw?.sessionId || "").trim();
    if (!sessionId) continue;
    indexedSessionIds.add(sessionId);
    const sessionFile = String(raw?.sessionFile || path.join(sessionsDir, `${sessionId}.jsonl`));
    const resolvedSessionFile = path.resolve(sessionFile);
    if (!resolvedSessionFile.startsWith(resolvedSessionsDir + path.sep)) continue;
    const updatedAt = Number(raw?.updatedAt || raw?.lastInteractionAt || raw?.endedAt || raw?.startedAt || 0) || 0;
    const existing = byConversation.get(parsed.conversationId);
    if (!existing || updatedAt > existing.updatedAt) {
      byConversation.set(parsed.conversationId, {
        conversationId: parsed.conversationId,
        sessionKey,
        sessionId,
        sessionFile: resolvedSessionFile,
        updatedAt,
        createdAt: Number(raw?.sessionStartedAt || raw?.startedAt || updatedAt || 0) || updatedAt,
        messageCount: 0,
        title: "新对话",
        preview: "",
      });
    }
  }
  for (const recovered of listRecoveredWebSessions({
    sessionsDir,
    runtimeAgentId,
    indexedSessionIds,
    limit,
  })) {
    if (!byConversation.has(recovered.conversationId)) {
      byConversation.set(recovered.conversationId, recovered);
    }
  }

  const summaryStartedAt = Date.now();
  const summaryCache = readSessionSummaryCache(sessionsDir);
  const summaryCacheStats = { hits: 0, misses: 0 };
  const sessions = Array.from(byConversation.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((entry) => {
      const summary = summarizeChatHistorySession({
        sessionsDir,
        entry,
        cache: summaryCache,
        stats: summaryCacheStats,
      });
      return {
        conversationId: entry.conversationId,
        sessionKey: entry.sessionKey,
        sessionId: entry.sessionId,
        title: summary.title,
        preview: summary.preview,
        searchText: summary.searchText || "",
        messageCount: summary.messageCount,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    })
    .filter((entry) => entry.messageCount > 0);
  if (summaryCacheStats.misses > 0) {
    writeSessionSummaryCache(sessionsDir, summaryCache);
  }

  logIosLoadDebug("chat_history_sessions_done", {
    adoptId,
    runtimeAgentId,
    rawIndexCount,
    conversationCount: byConversation.size,
    returnedCount: sessions.length,
    summaryCacheHits: summaryCacheStats.hits,
    summaryCacheMisses: summaryCacheStats.misses,
    summaryMs: Date.now() - summaryStartedAt,
    ms: Date.now() - startedAt,
  });
  return {
    sessions,
    meta: {
      cache: summaryCacheStats,
      timings: {
        summaryMs: Date.now() - summaryStartedAt,
        totalMs: Date.now() - startedAt,
      },
    },
  };
}

export function registerMiscRoutes(app: express.Express) {

  // ── Runtime info ──────────────────────────────────────
  app.get("/api/claw/runtime-info", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const dbAgentId = String((claw as any).agentId || "").trim();
      const trialAgentId = `trial_${String(adoptId)}`;
      const trialAgentDir = openClawAgentDir(trialAgentId);
      const runtimeAgentId = existsSync(trialAgentDir) ? trialAgentId : dbAgentId;
      const skillsDir = `${openClawWorkspaceDir(runtimeAgentId)}/skills`;
      res.json({ adoptId, dbAgentId, runtimeAgentId, skillsDir, trialAgentDirExists: existsSync(trialAgentDir) });
    } catch (e) {
      res.status(500).json({ error: "runtime info failed" });
    }
  });

  app.post("/api/claw/client-load-metrics", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const rawMetrics = Array.isArray(req.body?.metrics) ? req.body.metrics.slice(0, 24) : [];
      type SanitizedClientLoadMetric = {
        key: string;
        label: string;
        status: string;
        elapsedMs: number;
        requestMs?: number;
        detail: string;
      };
      const metrics: SanitizedClientLoadMetric[] = rawMetrics.map((metric: any) => ({
        key: String(metric?.key || "").slice(0, 48),
        label: String(metric?.label || "").slice(0, 48),
        status: String(metric?.status || "").slice(0, 16),
        elapsedMs: Math.max(0, Math.min(Number(metric?.elapsedMs || 0) || 0, 10 * 60 * 1000)),
        requestMs: metric?.requestMs == null ? undefined : Math.max(0, Math.min(Number(metric.requestMs || 0) || 0, 10 * 60 * 1000)),
        detail: String(metric?.detail || "").replace(/\s+/g, " ").slice(0, 160),
      }));
      const totalMs = Math.max(0, Math.min(Number(req.body?.totalMs || 0) || 0, 10 * 60 * 1000));
      const slowest = metrics
        .slice()
        .sort((a: SanitizedClientLoadMetric, b: SanitizedClientLoadMetric) => Number(b.elapsedMs || 0) - Number(a.elapsedMs || 0))
        .slice(0, 3)
        .map((metric: SanitizedClientLoadMetric) => `${metric.key}:${metric.elapsedMs}ms:${metric.status}`)
        .join(",");

      console.log("[CLIENT-LOAD]", {
        adoptId,
        userId: Number((claw as any).userId || 0),
        path: String(req.body?.path || "").slice(0, 160),
        totalMs,
        metricCount: metrics.length,
        slowest,
        metrics,
      });
      res.json({ ok: true });
    } catch (error: any) {
      console.warn("[CLIENT-LOAD] failed", error?.message || error);
      res.status(500).json({ error: "client_load_metrics_failed" });
    }
  });

  app.get("/api/claw/health-summary", async (req, res) => {
    const startedAt = Date.now();
    const timings: Record<string, number> = {};
    let stepStartedAt = startedAt;
    const mark = (name: string) => {
      timings[name] = Date.now() - stepStartedAt;
      stepStartedAt = Date.now();
    };
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      mark("auth");
      if (!claw) return;

      const dbAgentId = String((claw as any).agentId || "").trim();
      const runtimeAgentId = resolveRuntimeAgentId(adoptId, dbAgentId);
      const agentDir = openClawAgentDir(runtimeAgentId);
      const workspaceDir = openClawWorkspaceDir(runtimeAgentId);
      const sessionsDir = path.join(agentDir, "sessions");
      const sessionsPath = path.join(sessionsDir, "sessions.json");
      const trialAgentDir = openClawAgentDir(`trial_${adoptId}`);
      mark("runtime");

      let rawIndexCount = 0;
      let sessionIndexReadable = false;
      try {
        if (existsSync(sessionsPath)) {
          const rawIndex = JSON.parse(readFileSync(sessionsPath, "utf8") || "{}") || {};
          rawIndexCount = Object.keys(rawIndex).length;
          sessionIndexReadable = true;
        }
      } catch {}
      const cachePath = sessionSummaryCachePath(sessionsDir);
      let cacheEntryCount = 0;
      let cacheMtimeMs = 0;
      try {
        const cache = readSessionSummaryCache(sessionsDir);
        cacheEntryCount = Object.keys(cache.entries || {}).length;
        cacheMtimeMs = existsSync(cachePath) ? Math.round(statSync(cachePath).mtimeMs || 0) : 0;
      } catch {}
      mark("history");

      let models: Array<{ id: string; name: string; desc?: string; isDefault?: boolean }> = [];
      let modelSourceError = "";
      try {
        const { getAvailableClawModelsFromConfig } = await import("../routers/helpers");
        models = getAvailableClawModelsFromConfig();
      } catch (error: any) {
        modelSourceError = String(error?.message || error);
      }
      let profileModel = "";
      let modelOverride = "";
      try {
        const { getClawProfileSettings } = await import("../db");
        const settings = await getClawProfileSettings(Number((claw as any).id || 0));
        profileModel = String((settings as any)?.model || "");
      } catch {}
      try {
        const overridesPath = path.join(APP_ROOT, "data", "claw-model-overrides.json");
        const overrides = existsSync(overridesPath)
          ? JSON.parse(readFileSync(overridesPath, "utf8") || "{}")
          : {};
        modelOverride = String(overrides?.[adoptId] || "");
      } catch {}
      const defaultModel = models.find((model) => model.isDefault)?.id || models[0]?.id || "";
      const storedModel = modelOverride || profileModel || "";
      const modelIds = new Set(models.map((model) => model.id));
      const storedModelAvailable = storedModel ? modelIds.has(storedModel) : true;
      const effectiveModel = storedModel && storedModelAvailable ? storedModel : defaultModel;
      const readinessIssues: Array<{ code: string; severity: "warning" | "error"; message: string }> = [];
      if (!existsSync(OPENCLAW_JSON_PATH)) {
        readinessIssues.push({ code: "openclaw_config_missing", severity: "error", message: "OpenClaw 配置文件不存在" });
      }
      if (!existsSync(agentDir)) {
        readinessIssues.push({ code: "agent_dir_missing", severity: "error", message: "OpenClaw agent 目录不存在" });
      }
      if (!existsSync(workspaceDir)) {
        readinessIssues.push({ code: "workspace_dir_missing", severity: "warning", message: "OpenClaw workspace 目录不存在" });
      }
      if (models.length === 0) {
        readinessIssues.push({ code: "models_empty", severity: "error", message: "未读取到可用模型" });
      }
      if (modelSourceError) {
        readinessIssues.push({ code: "model_source_error", severity: "warning", message: `模型配置读取异常：${modelSourceError}` });
      }
      const readinessOk = !readinessIssues.some((issue) => issue.severity === "error");
      mark("model");

      timings.total = Date.now() - startedAt;
      res.json({
        ok: true,
        adoptId,
        runtime: {
          dbAgentId,
          runtimeAgentId,
          trialAgentDirExists: existsSync(trialAgentDir),
          agentDirExists: existsSync(agentDir),
          workspaceDirExists: existsSync(workspaceDir),
        },
        openclaw: {
          home: OPENCLAW_HOME,
          configPath: OPENCLAW_JSON_PATH,
          configExists: existsSync(OPENCLAW_JSON_PATH),
        },
        model: {
          selected: effectiveModel,
          effectiveModel,
          storedModel,
          storedModelAvailable,
          defaultModel,
          profileModel,
          overrideModel: modelOverride,
          availableCount: models.length,
          availableModels: models.slice(0, 20),
          sourceError: modelSourceError || null,
        },
        readiness: {
          ok: readinessOk,
          status: readinessOk ? (readinessIssues.length > 0 ? "degraded" : "ready") : "blocked",
          summary: readinessOk
            ? (readinessIssues.length > 0 ? readinessIssues[0]?.message || "部分配置需要检查" : "ready")
            : readinessIssues[0]?.message || "当前智能体不可用",
          issues: readinessIssues,
          checkedAt: new Date(startedAt).toISOString(),
        },
        history: {
          sessionsPath,
          sessionsDirExists: existsSync(sessionsDir),
          sessionIndexReadable,
          rawIndexCount,
          summaryCachePath: cachePath,
          summaryCacheExists: existsSync(cachePath),
          summaryCacheEntryCount: cacheEntryCount,
          summaryCacheMtimeMs: cacheMtimeMs,
        },
        timings,
      });
    } catch (error: any) {
      console.warn("[health-summary] failed", error?.message || error);
      res.status(500).json({ error: "health_summary_failed" });
    }
  });

  app.get("/api/claw/chat-history/sessions", async (req, res) => {
    const startedAt = Date.now();
    let adoptId = "";
    try {
      adoptId = String(req.query.adoptId || "").trim();
      const limit = Math.min(Math.max(Number(req.query.limit || 50) || 50, 1), 100);
      if (!adoptId) {
        logIosLoadDebug("chat_history_sessions_bad_request", {
          ms: Date.now() - startedAt,
          ip: req.ip,
        });
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) {
        logIosLoadDebug("chat_history_sessions_owner_denied", {
          adoptId,
          ms: Date.now() - startedAt,
          statusCode: res.statusCode,
        });
        return;
      }

      const payload = await listClawChatHistorySessionRecords({ adoptId, claw, limit, startedAt });
      res.json(payload);
    } catch (error: any) {
      console.warn("[chat-history] list failed", error?.message || error);
      logIosLoadDebug("chat_history_sessions_error", {
        adoptId,
        error: String(error?.message || error),
        ms: Date.now() - startedAt,
      });
      res.status(500).json({ error: "chat_history_list_failed" });
    }
  });

  app.get("/api/claw/chat-history/messages", async (req, res) => {
    const startedAt = Date.now();
    let adoptId = "";
    let sessionKey = "";
    try {
      adoptId = String(req.query.adoptId || "").trim();
      sessionKey = String(req.query.sessionKey || "").trim();
      if (!adoptId || !sessionKey) {
        logIosLoadDebug("chat_history_messages_bad_request", {
          adoptId,
          hasSessionKey: Boolean(sessionKey),
          ms: Date.now() - startedAt,
        });
        res.status(400).json({ error: "adoptId and sessionKey required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) {
        logIosLoadDebug("chat_history_messages_owner_denied", {
          adoptId,
          ms: Date.now() - startedAt,
          statusCode: res.statusCode,
        });
        return;
      }

      const dbAgentId = String((claw as any).agentId || "").trim();
      if (isJiuwenClawAdoptId(adoptId)) {
        const resolved = resolveJiuwenHistorySession({ adoptId, dbAgentId, sessionKey });
        if (!resolved) {
          res.status(404).json({ error: "session_missing" });
          return;
        }
        const messages = extractJiuwenChatMessages(
          resolved.historyFile,
          200,
          adoptId,
          resolveRuntimeWorkspace(claw, adoptId),
        );
        logIosLoadDebug("chat_history_messages_done_jiuwen", {
          adoptId,
          runtimeAgentId: jiuwenClawAgentId(adoptId, dbAgentId),
          sessionKey,
          messageCount: messages.length,
          ms: Date.now() - startedAt,
        });
        res.json({
          conversationId: resolved.conversationId,
          sessionKey,
          sessionId: resolved.sessionId,
          messages,
        });
        return;
      }

      const trialAgentId = `trial_${adoptId}`;
      const runtimeAgentId = existsSync(openClawAgentDir(trialAgentId)) ? trialAgentId : dbAgentId;
      const parsed = parseWebSessionKey(sessionKey, runtimeAgentId);
      if (!parsed) {
        res.status(403).json({ error: "session_not_allowed" });
        return;
      }

      const sessionsPath = path.join(openClawAgentDir(runtimeAgentId), "sessions", "sessions.json");
      if (!existsSync(sessionsPath)) {
        res.status(404).json({ error: "sessions_index_missing" });
        return;
      }
      const rawIndex = JSON.parse(readFileSync(sessionsPath, "utf8") || "{}") || {};
      const raw = rawIndex[sessionKey];
      const sessionsDir = path.join(openClawAgentDir(runtimeAgentId), "sessions");
      const recovered = raw?.sessionId ? null : resolveRecoveredSessionFile(sessionsDir, parsed.conversationId);
      const sessionId = String(raw?.sessionId || recovered?.sessionId || "").trim();
      if (!sessionId) {
        res.status(404).json({ error: "session_missing" });
        return;
      }
      const fallbackSessionFile = path.join(openClawAgentDir(runtimeAgentId), "sessions", `${sessionId}.jsonl`);
      const sessionFile = String(raw?.sessionFile || recovered?.sessionFile || fallbackSessionFile);
      const resolvedFile = path.resolve(sessionFile);
      if (!resolvedFile.startsWith(path.resolve(sessionsDir) + path.sep)) {
        res.status(403).json({ error: "session_file_not_allowed" });
        return;
      }
      const messages = collectOpenClawChatHistoryMessages({
        sessionsDir,
        sessionKey,
        currentSessionFile: resolvedFile,
        maxMessages: 200,
      });
      logIosLoadDebug("chat_history_messages_done", {
        adoptId,
        runtimeAgentId,
        sessionKey,
        messageCount: messages.length,
        ms: Date.now() - startedAt,
      });
      res.json({ conversationId: parsed.conversationId, sessionKey, sessionId, messages });
    } catch (error: any) {
      console.warn("[chat-history] messages failed", error?.message || error);
      logIosLoadDebug("chat_history_messages_error", {
        adoptId,
        sessionKey,
        error: String(error?.message || error),
        ms: Date.now() - startedAt,
      });
      res.status(500).json({ error: "chat_history_messages_failed" });
    }
  });

  app.delete("/api/claw/chat-history/session", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      const sessionKey = String(req.body?.sessionKey || "").trim();
      if (!adoptId || !sessionKey) {
        res.status(400).json({ error: "adoptId and sessionKey required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const dbAgentId = String((claw as any).agentId || "").trim();
      if (isJiuwenClawAdoptId(adoptId)) {
        const result = deleteJiuwenHistorySession({ adoptId, dbAgentId, sessionKey });
        if (!result) {
          res.status(404).json({ error: "session_missing" });
          return;
        }
        res.json({
          ok: true,
          runtime: "jiuwenswarm",
          conversationId: result.conversationId,
          sessionId: result.sessionId,
          deleted: result.deleted,
        });
        return;
      }

      res.status(400).json({ error: "unsupported_runtime" });
    } catch (error: any) {
      console.warn("[chat-history] delete failed", error?.message || error);
      res.status(500).json({ error: "chat_history_delete_failed" });
    }
  });

  app.post("/api/claw/chat-history/activate", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      const sessionKey = String(req.body?.sessionKey || "").trim();
      if (!adoptId || !sessionKey) {
        res.status(400).json({ error: "adoptId and sessionKey required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const dbAgentId = String((claw as any).agentId || "").trim();
      if (isJiuwenClawAdoptId(adoptId)) {
        const resolved = resolveJiuwenHistorySession({ adoptId, dbAgentId, sessionKey });
        if (!resolved) {
          res.status(404).json({ error: "session_missing" });
          return;
        }
        const runtimeAgentId = jiuwenClawAgentId(adoptId, dbAgentId);
        const currentEpoch = readSessionEpoch(adoptId);
        const scope = buildSessionRegistryScope("web", resolved.conversationId);
        upsertSessionRegistry(adoptId, runtimeAgentId, sessionKey, currentEpoch, scope);
        res.json({
          ok: true,
          conversationId: resolved.conversationId,
          sessionKey,
          epoch: currentEpoch,
          runtime: "jiuwenswarm",
        });
        return;
      }

      const trialAgentId = `trial_${adoptId}`;
      const runtimeAgentId = existsSync(openClawAgentDir(trialAgentId)) ? trialAgentId : dbAgentId;
      const parsed = parseWebSessionKey(sessionKey, runtimeAgentId);
      if (!parsed) {
        res.status(403).json({ error: "session_not_allowed" });
        return;
      }

      const sessionsPath = path.join(openClawAgentDir(runtimeAgentId), "sessions", "sessions.json");
      const rawIndex = existsSync(sessionsPath) ? JSON.parse(readFileSync(sessionsPath, "utf8") || "{}") || {} : {};
      const sessionsDir = path.join(openClawAgentDir(runtimeAgentId), "sessions");
      const recovered = rawIndex[sessionKey]?.sessionId ? null : resolveRecoveredSessionFile(sessionsDir, parsed.conversationId);
      if (!rawIndex[sessionKey]?.sessionId && !recovered?.sessionId) {
        res.status(404).json({ error: "session_missing" });
        return;
      }
      if (!rawIndex[sessionKey]?.sessionId && recovered) {
        rawIndex[sessionKey] = {
          sessionId: recovered.sessionId,
          sessionFile: recovered.sessionFile,
          updatedAt: statSync(recovered.sessionFile).mtimeMs,
          sessionStartedAt: statSync(recovered.sessionFile).birthtimeMs,
          recovered: true,
        };
        writeFileSync(sessionsPath, JSON.stringify(rawIndex, null, 2), "utf8");
      }

      const currentEpoch = readSessionEpoch(adoptId);
      const scope = buildSessionRegistryScope("web", parsed.conversationId);
      upsertSessionRegistry(adoptId, runtimeAgentId, sessionKey, currentEpoch, scope);
      res.json({ ok: true, conversationId: parsed.conversationId, sessionKey, epoch: currentEpoch });
    } catch (error: any) {
      console.warn("[chat-history] activate failed", error?.message || error);
      res.status(500).json({ error: "chat_history_activate_failed" });
    }
  });

  // ── 每日洞察 API ──────────────────────────────────────
  app.get("/api/insights/latest", async (_req, res) => {
    try {
      const { getLatestDailyInsight } = await import("../db");
      const insight = await getLatestDailyInsight();
      if (!insight) {
        res.status(404).json({ error: "No insight found" });
        return;
      }
      res.json({
        id: insight.id,
        date: insight.date,
        title: insight.title,
        summary: insight.summary,
        content: insight.content,
        source: insight.source,
        updatedAt: insight.updatedAt,
      });
    } catch (error) {
      console.error("[Insights] Failed to get latest insight:", error);
      res.status(500).json({ error: "Failed to get latest insight" });
    }
  });

  app.post("/api/insights/upsert", strictLimiter, async (req, res) => {
    try {
      const expectedToken = process.env.INSIGHTS_PUSH_TOKEN;
      const tokenFromHeader = req.header("x-insights-token") || req.header("authorization")?.replace(/^Bearer\s+/i, "");

      if (!expectedToken || tokenFromHeader !== expectedToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body || {};
      const date = typeof body.date === "string" ? body.date.trim() : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const content = typeof body.content === "string" ? body.content.trim() : "";
      const summary = typeof body.summary === "string" ? body.summary.trim() : "";
      const source = typeof body.source === "string" ? body.source.trim() : "openclaw";

      if (!date || !title || !content) {
        res.status(400).json({ error: "date/title/content are required" });
        return;
      }

      const { upsertDailyInsight } = await import("../db");
      await upsertDailyInsight({ date, title, summary, content, source });

      res.json({ success: true });
    } catch (error) {
      console.error("[Insights] Failed to upsert insight:", error);
      res.status(500).json({ error: "Failed to upsert insight" });
    }
  });

  // ── Logout all sessions/cookies ───────────────────────
  app.post("/api/auth/logout-all", async (req, res) => {
    try {
      clearSessionCookieVariants(req, res);

      // lock sso-bridge for 3 minutes to avoid immediate auto-login after logout
      setLogoutLockCookieVariants(req, res);

      // best-effort site data clear (supported browsers only)
      res.setHeader("Clear-Site-Data", '"cookies", "storage"');
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ success: false });
    }
  });

  // ── Embed auth probe for nginx auth_request ───────────
  app.get("/api/embed/auth-check", async (req, res) => {
    try {
      const context = await createContext({ req, res, info: {} as any });
      if (context.user) {
        res.status(204).end();
      } else {
        res.status(401).json({ error: "UNAUTHORIZED" });
      }
    } catch (e) {
      res.status(401).json({ error: "UNAUTHORIZED" });
    }
  });

  // ── SSO bridge ────────────────────────────────────────
  app.get("/api/embed/sso-bridge", async (req, res) => {
    try {
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5180/";
      const cookieDomain = process.env.COOKIE_DOMAIN || "";
      const nextRaw = typeof req.query.next === "string" ? req.query.next : frontendUrl;
      let nextUrl: URL;
      try {
        nextUrl = new URL(nextRaw);
      } catch {
        return res.redirect(frontendUrl);
      }

      // only allow configured domain destinations; without COOKIE_DOMAIN, stay on FRONTEND_URL origin.
      const frontend = new URL(frontendUrl);
      const allowedDomain = cookieDomain.replace(/^\./, "").toLowerCase();
      const nextHost = nextUrl.hostname.toLowerCase();
      const allowedByCookieDomain = allowedDomain
        ? (nextHost === allowedDomain || nextHost.endsWith(`.${allowedDomain}`))
        : false;
      const allowedByFrontendOrigin = nextUrl.origin === frontend.origin;
      if (!allowedByFrontendOrigin && !allowedByCookieDomain) {
        return res.redirect(frontendUrl);
      }

      // If user just logged out, skip auto-bridge to avoid immediate re-login loop
      if ((req as any).cookies?.logout_lock === "1") {
        return res.redirect(frontendUrl);
      }

      const context = await createContext({ req, res, info: {} as any });
      if (!context.user) {
        return res.redirect(frontendUrl);
      }

      const { sdk } = await import("./sdk");

      const token = await sdk.signSession({
        userId: context.user.id,
        name: context.user.name ?? "",
        authVersion: sessionAuthVersion(context.user),
      });

      // shared cookie for subdomains
      res.cookie(COOKIE_NAME, token, {
        ...(cookieDomain ? { domain: cookieDomain } : {}),
        httpOnly: true,
        path: "/",
        sameSite: "none",
        secure: true,
      });

      return res.redirect(nextUrl.toString());
    } catch (e) {
      return res.redirect(process.env.FRONTEND_URL || "http://localhost:5180/");
    }
  });

  // ── AI 审核技能包 ───────────────────────────────────
  app.post("/api/claw/admin/ai-review-skill", async (req, res) => {
    try {
      const context = await createContext({ req, res, info: {} as any });
      if (!context.user || context.user.role !== "admin") {
        res.status(403).json({ error: "admin only" });
        return;
      }

      const { getSkillMarketItem: getSMI } = await import("../db");

      const { skillMarketId } = req.body || {};
      if (!skillMarketId) { res.status(400).json({ error: "Missing skillMarketId" }); return; }

      const item = await getSMI(Number(skillMarketId));
      if (!item) { res.status(404).json({ error: "技能不存在" }); return; }

      // 读取源码
      const dir = item.packagePath || "";
      let skillMd = "";
      let scriptFiles: string[] = [];
      let scriptContent = "";
      try { skillMd = readFileSync(`${dir}/SKILL.md`, "utf8"); } catch {}
      try {
        if (existsSync(`${dir}/scripts`)) {
          scriptFiles = readdirSync(`${dir}/scripts`);
          // 读取前 3 个脚本内容
          for (const f of scriptFiles.slice(0, 3)) {
            try {
              const c = readFileSync(`${dir}/scripts/${f}`, "utf8");
              scriptContent += `\n--- ${f} ---\n${c.slice(0, 2000)}\n`;
            } catch {}
          }
        }
      } catch {}

      const prompt = `审核此技能包，简要回答（200字内）：1.安全性 2.描述准确性 3.建议(通过/拒绝/需修改)\n\nSKILL.md(摘要):\n${skillMd.slice(0, 1000)}\n\n脚本: ${scriptFiles.join(",")}\n${scriptContent.slice(0, 1500)}`;

      // 调用 OpenClaw 的模型
      const OPENCLAW_JSON = OPENCLAW_JSON_PATH;
      let apiBase = "";
      let apiToken = "";
      let modelId = "";
      try {
        const cfg = JSON.parse(readFileSync(OPENCLAW_JSON, "utf8"));
        const providers = cfg?.models?.providers || {};
        for (const [pid, prov] of Object.entries<any>(providers)) {
          if ((prov?.baseURL || prov?.baseUrl) && prov?.apiKey) {
            apiBase = String(prov.baseURL || prov.baseUrl).replace(/\/$/, "");
            apiToken = String(prov.apiKey);
            const models = Array.isArray(prov.models) ? prov.models : [];
            modelId = models[0]?.id || models[0] || `${pid}/default`;
            if (typeof modelId === "object") modelId = (modelId as any).id || "";
            break;
          }
        }
      } catch {}

      if (!apiBase || !apiToken) {
        res.status(503).json({ error: "未配置模型，无法 AI 审核" });
        return;
      }

      // SSE 流式输出
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const chatUrl = apiBase.match(/\/v[0-9]/) ? `${apiBase}/chat/completions` : `${apiBase}/v1/chat/completions`;
      const apiRes = await fetch(chatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          stream: true,
          max_tokens: 500,
        }),
      });

      if (!apiRes.ok || !apiRes.body) {
        res.write(`data: ${JSON.stringify({ error: "LLM 调用失败: " + apiRes.status })}\n\n`);
        res.end();
        return;
      }

      const reader = (apiRes.body as any).getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); continue; }
          try {
            const d = JSON.parse(payload);
            const chunk = d.choices?.[0]?.delta?.content || "";
            if (chunk) res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
          } catch {}
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err: any) {
      console.error("[ai-review]", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else { try { res.end(); } catch {} }
    }
  });

  // ── 管理员上传开源社区技能包（zip）────────────────────
  app.post("/api/claw/skill-market/upload", async (req, res) => {
    try {
      const ctx = await createContext({ req, res } as any);
      if (!ctx.user || ctx.user.role !== "admin") {
        res.status(403).json({ error: "admin only" });
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        try {
          const buf = Buffer.concat(chunks);
          if (buf.length === 0) { res.status(400).json({ error: "No data" }); return; }
          if (buf.length > MAX_SKILL_PACKAGE_BYTES) { res.status(413).json({ error: "File too large (max 50MB)" }); return; }

          const filename = decodeURIComponent(String(req.header("x-skill-filename") || "uploaded.zip")).trim() || "uploaded.zip";
          const parsed = await parseSkillPackageBuffer(buf, filename);
          const marketDir = skillStoreMarketplaceDir();
          const uploadId = `upload-${Date.now()}`;
          const tmpZip = path.join("/tmp", `${uploadId}.zip`);
          const finalDir = path.join(marketDir, "pending", `${parsed.skillId}-${uploadId}`);

          writeFileSync(tmpZip, buf);
          try {
            skillInstaller.installFromSource(tmpZip, finalDir);
          } finally {
            try { rmSync(tmpZip, { force: true }); } catch {}
          }

          const { insertSkillMarketItem } = await import("../db");
          const marketItemId = await insertSkillMarketItem({
            skillId: parsed.skillId,
            name: parsed.displayName || parsed.skillId,
            description: parsed.description || null,
            author: "管理员上传",
            authorUserId: ctx.user!.id,
            version: String(parsed.manifest?.version || "1.0.0"),
            category: "general",
            origin: "opensource",
            status: "pending",
            license: String(parsed.manifest?.license || "MIT"),
            packagePath: finalDir,
          });

          res.json({
            ok: true,
            uploadId: parsed.skillId,
            name: parsed.displayName || parsed.skillId,
            description: parsed.description || "",
            path: finalDir,
            marketItemId,
            warnings: parsed.warnings,
          });
        } catch (err: any) {
          console.error("[skill-market upload] failed", err);
          res.status(400).json({ error: String(err?.message || "技能包解析失败") });
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // ── 智能体使用量统计（从聊天日志解析）──
  app.get("/api/claw/admin/usage-stats", async (req, res) => {
    try {
      // 简单鉴权
      const { createContext } = await import("./context");
      const ctx = await createContext({ req, res } as any);
      if (!ctx.user || ctx.user.role !== "admin") {
        return res.status(403).json({ error: "admin only" });
      }

      const logPaths = [
        APP_ROOT + "/logs/claw-exec-detail.log",
        APP_ROOT + "/logs/claw-exec.log",
      ];
      const lines = logPaths.flatMap((logPath) => {
        if (!existsSync(logPath)) return [] as string[];
        return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
      });
      // 按 adoptId 统计
      const byAdopt: Record<string, UsageBucket> = {};
      const dailyAll: Record<string, number> = {};
      const seen = new Set<string>();
      const isChatUsageEvent = (d: any) => {
        if (d?.event === "chat_stream_response" || d?.event === "ws_chat_response") return true;
        // 兼容旧 tRPC claw.chat 日志；排除管理操作，例如 admin_delete_claw。
        if (d?.event === "claw_exec" && d?.messageType === "user_input") return true;
        if (d?.event === "claw_exec" && d?.message && d?.message !== "admin_delete_claw") return true;
        return false;
      };
      const usageKey = (d: any) => {
        const sessionKey = d?.sessionKey ? String(d.sessionKey) : "";
        const chatId = d?.chatCompletionId ? String(d.chatCompletionId) : "";
        return [
          d?.event || "",
          d?.adoptId || "",
          d?.ts || "",
          sessionKey,
          chatId,
        ].join("|");
      };

      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (!isChatUsageEvent(d)) continue;
          addUsageEvent({
            byAdopt,
            dailyAll,
            seen,
            key: usageKey(d),
            adoptId: d.adoptId || "",
            ts: d.ts || "",
            userId: d.userId || 0,
          });
        } catch {}
      }

      // 查用户名和 runtime agent 映射。OpenClaw 微信 channel 直接进 gateway，
      // 不经过 employee-agent 的聊天接口，所以需要从 trajectory 里补统计。
      let userMap: Record<number, string> = {};
      const agentToAdopt: Record<string, { adoptId: string; userId: number }> = {};
      const adoptionRows: Array<{ adoptId: string; agentId: string; userId: number; runtime: string }> = [];
      const adoptRuntimeMap: Record<string, string> = {};
      const currentAdoptIds = new Set<string>();
      try {
        const { getDb } = await import("../db");
        const { users, clawAdoptions } = await import("../../drizzle/schema");
        const db = await getDb();
        if (db) {
          const allUsers = await db.select({ id: users.id, name: users.name, email: users.email }).from(users);
          for (const u of allUsers) userMap[u.id] = u.name || u.email || String(u.id);
          const claws = await db.select({
            adoptId: clawAdoptions.adoptId,
            agentId: clawAdoptions.agentId,
            userId: clawAdoptions.userId,
            runtime: clawAdoptions.runtime,
          }).from(clawAdoptions);
          for (const claw of claws) {
            const adoptId = String(claw.adoptId || "").trim();
            const userId = Number(claw.userId || 0);
            const configuredAgentId = String(claw.agentId || "").trim();
            const runtime = String(claw.runtime || "").trim() || (isJiuwenClawAdoptId(adoptId) ? "jiuwenswarm" : "openclaw");
            adoptionRows.push({ adoptId, agentId: configuredAgentId, userId, runtime });
            if (adoptId) currentAdoptIds.add(adoptId);
            if (adoptId) adoptRuntimeMap[adoptId] = runtime;
            if (configuredAgentId) agentToAdopt[configuredAgentId] = { adoptId, userId };
            if (adoptId) agentToAdopt[`trial_${adoptId}`] = { adoptId, userId };
          }
        }
      } catch {}

      for (const claw of adoptionRows) {
        if (claw.runtime !== "jiuwenswarm" && !isJiuwenClawAdoptId(claw.adoptId)) continue;
        addJiuwenUsageEvents({
          byAdopt,
          dailyAll,
          seen,
          adoptId: claw.adoptId,
          dbAgentId: claw.agentId,
          userId: claw.userId,
        });
      }

      try {
        const jiuwenLogPath = APP_ROOT + "/logs/jiuwenclaw-exec.log";
        if (existsSync(jiuwenLogPath)) {
          const maxLines = Math.min(Math.max(Number(process.env.WORKFORCE_AGENT_USAGE_JIUWEN_LOG_MAX_LINES || process.env.LINGXIA_USAGE_JIUWEN_LOG_MAX_LINES || 20000), 100), 500000);
          const jiuwenLines = readFileSync(jiuwenLogPath, "utf8").split("\n").filter(Boolean).slice(-maxLines);
          for (const line of jiuwenLines) {
            try {
              const d = JSON.parse(line);
              if (d?.event !== "chat_stream_request") continue;
              const adoptId = String(d?.adoptId || "").trim();
              if (!adoptId || !isJiuwenClawAdoptId(adoptId)) continue;
              addUsageEvent({
                byAdopt,
                dailyAll,
                seen,
                key: [
                  "jiuwen-log",
                  adoptId,
                  d?.clientRunId || "",
                  d?.sessionId || "",
                  d?.ts || "",
                ].join("|"),
                adoptId,
                ts: d?.ts || "",
                userId: d?.userId || 0,
              });
            } catch {}
          }
        }
      } catch {}

      try {
        const maxFiles = Math.min(Math.max(Number(process.env.WORKFORCE_AGENT_USAGE_TRAJECTORY_MAX_FILES || process.env.LINGXIA_USAGE_TRAJECTORY_MAX_FILES || 5000), 1), 50000);
        const trajectoryFiles = listTrajectoryFiles(path.join(OPENCLAW_HOME, "agents"), maxFiles);
        for (const filePath of trajectoryFiles) {
          let raw = "";
          try {
            raw = readFileSync(filePath, "utf8");
          } catch {
            continue;
          }
          for (const line of raw.split("\n")) {
            if (!line.includes('"type":"trace.artifacts"') || !line.includes("openclaw-weixin")) continue;
            try {
              const d = JSON.parse(line);
              const sessionKey = String(d?.sessionKey || "");
              if (!sessionKey.includes(":openclaw-weixin:")) continue;
              const runtimeAgentId = runtimeAgentIdFromSessionKey(sessionKey);
              const mapped = agentToAdopt[runtimeAgentId];
              const adoptId = mapped?.adoptId || adoptIdFromRuntimeAgentId(runtimeAgentId);
              if (!adoptId) continue;
              addUsageEvent({
                byAdopt,
                dailyAll,
                seen,
                key: ["trajectory", d?.traceId || "", d?.runId || "", d?.seq || "", sessionKey].join("|"),
                adoptId,
                ts: d?.ts || "",
                userId: mapped?.userId || 0,
              });
            } catch {}
          }
        }
      } catch {}

      // 构建排行
      const adoptions = Object.entries(byAdopt)
        .filter(([adoptId]) => currentAdoptIds.has(adoptId))
        .map(([adoptId, stat]) => ({
          adoptId,
          total: stat.total,
          userId: stat.userId,
          userName: userMap[stat.userId] || String(stat.userId),
          runtime: adoptRuntimeMap[adoptId] || (isJiuwenClawAdoptId(adoptId) ? "jiuwenswarm" : "openclaw"),
          lastActivity: stat.lastTs,
          recent7d: Object.entries(stat.days)
            .filter(([d]) => d >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
            .reduce((s, [, c]) => s + c, 0),
          dailyBreakdown: Object.entries(stat.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14)
            .map(([date, count]) => ({ date, count })),
        }))
        .sort((a, b) => b.total - a.total);

      // 每日全局趋势（最近14天）
      const daily = Object.entries(dailyAll)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 14)
        .map(([date, count]) => ({ date, count }))
        .reverse();

      let installations = {
        summary: {
          commandCopied: 0,
          downloaded: 0,
          started: 0,
          succeeded: 0,
          failed: 0,
          succeeded30d: 0,
          successRate: 0,
        },
        daily: [] as Array<{ date: string; downloaded: number; started: number; succeeded: number; failed: number }>,
        failureStages: [] as Array<{ stage: string; count: number }>,
      };
      try {
        const { getInstallTelemetrySummary } = await import("../db/install-telemetry");
        installations = await getInstallTelemetrySummary();
      } catch (error) {
        console.error("[usage-stats] failed to load installer telemetry", error);
      }

      return res.json({
        adoptions,
        daily,
        installations,
        summary: {
          totalClaws: adoptions.length,
          totalChats: seen.size,
          activeToday: adoptions.filter(a => a.dailyBreakdown.some(d => d.date === new Date().toISOString().slice(0, 10))).length,
        },
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

}
