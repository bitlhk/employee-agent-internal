import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";
import { parseUploadedAttachmentRuntimeMessage } from "@shared/uploaded-attachment-context";
import { stripExpertHandoffRuntimeMessage } from "@shared/expert-handoff-context";
import { stripEaInternalRuntimeContext } from "@shared/ea-runtime-context";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import path from "path";
import { usageDateKey } from "./usage-events";
import {
  JIUWENCLAW_HOME,
  isJiuwenClawAdoptId,
  jiuwenClawAgentId,
  jiuwenClawSessionsDir,
  jiuwenClawWorkspaceDir,
} from "./helpers";
import {
  isUserVisibleJiuwenArtifactPath,
  readJiuwenSessionArtifacts,
  type JiuwenSessionArtifactFile,
} from "./jiuwen-session-artifacts";
import {
  listAgentTasksByConversation,
  listAgentTasksForHistory,
} from "../db/agents";
import {
  buildExpertTaskHistoryMessages,
  buildExpertTaskHistorySessions,
  expertConversationIdFromSessionKey,
  mergeExpertTaskHistorySessions,
} from "./expert-task-history";
import { createChatSessionListCache } from "./chat-session-list-cache";
import { logDebug, logWarn } from "./observability/logger";
import {
  listEnterpriseRuntimeHistorySessions,
  readEnterpriseRuntimeHistoryRecords,
  type EnterpriseRuntimeHistorySession,
} from "./enterprise-runtime-history";

export type UsageBucket = { total: number; days: Record<string, number>; lastTs: string; userId: number };
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
export type ChatHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timeLabel: string;
  timestamp: number;
  agentTaskIds?: string[];
  attachments?: Array<{ name: string; size: number; path: string; adoptId?: string }>;
  toolCalls?: ChatHistoryToolCall[];
};
const iosLoadDebugEnabled = process.env.IOS_LOAD_DEBUG === "1";
const configuredChatSessionListTtl = Number(
  process.env.CHAT_SESSION_LIST_CACHE_TTL_MS || 2_500,
);
const chatSessionListCache = createChatSessionListCache<
  ReturnType<typeof mergeExpertTaskHistorySessions>
>({
  ttlMs: Number.isFinite(configuredChatSessionListTtl)
    ? Math.min(300_000, Math.max(500, configuredChatSessionListTtl))
    : 2_500,
});

export function invalidateChatHistorySessionList(adoptId: string): void {
  const normalized = String(adoptId || "").trim();
  if (normalized) chatSessionListCache.invalidatePrefix(`${normalized}\u0000`);
}

export function bindHistoryAttachmentOwner(messages: ChatHistoryMessage[], adoptId: string): ChatHistoryMessage[] {
  return messages.map((message) => (
    message.attachments?.length
      ? { ...message, attachments: message.attachments.map((file) => ({ ...file, adoptId })) }
      : message
  ));
}

export function logIosLoadDebug(message: string, fields: Record<string, unknown> = {}): void {
  if (!iosLoadDebugEnabled) return;
  logDebug(`ios.load.${message}`, fields);
}

function normalizeHistoryText(value: unknown): string {
  return stripExpertHandoffRuntimeMessage(value).replace(/\s+/g, " ").trim();
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

function stripEaJiuwenUserInternalContext(text: string): string {
  return stripEaInternalRuntimeContext(stripEaJiuwenConversationContext(text));
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

export function dedupeHistoryMessages(messages: ChatHistoryMessage[], maxMessages: number): ChatHistoryMessage[] {
  const seen = new Set<string>();
  const deduped: ChatHistoryMessage[] = [];
  for (const message of messages) {
    const normalizedText = normalizeHistoryText(message.text);
    const toolSignature = historyToolCallsSignature(message.toolCalls);
    const attachmentSignature = (message.attachments || [])
      .map((file) => `${file.name}:${file.size}:${file.path}`)
      .join("|");
    if (!normalizedText && !toolSignature && !attachmentSignature) continue;
    const timeBucket = message.timestamp > 0 ? String(message.timestamp) : "no-ts";
    const fingerprint = `${message.role}|${timeBucket}|${normalizedText || toolSignature || attachmentSignature}`;
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

export function normalizeEnterpriseHistorySessions(args: {
  sessions: EnterpriseRuntimeHistorySession[];
  adoptId: string;
  limit: number;
}): any[] {
  const grouped = new Map<string, EnterpriseRuntimeHistorySession[]>();
  for (const session of args.sessions) {
    const sessionId = safeJiuwenSessionId(session?.session_id);
    if (!sessionId || !isListableJiuwenWebSession(sessionId, args.adoptId)) continue;
    const channelId = String(session?.channel_id || "").trim();
    if (channelId && channelId !== "web" && channelId !== args.adoptId) continue;
    const conversationId = jiuwenConversationIdFromSessionId(sessionId, args.adoptId);
    const entries = grouped.get(conversationId) || [];
    entries.push({ ...session, session_id: sessionId });
    grouped.set(conversationId, entries);
  }
  return Array.from(grouped.entries())
    .map(([conversationId, segments]) => {
      const ordered = segments.slice().sort((left, right) => (
        normalizeJiuwenHistoryTimestamp(left.last_message_at) - normalizeJiuwenHistoryTimestamp(right.last_message_at)
      ));
      const latest = ordered[ordered.length - 1];
      const oldest = ordered[0];
      const updatedAt = normalizeJiuwenHistoryTimestamp(latest?.last_message_at || latest?.created_at);
      const createdAt = normalizeJiuwenHistoryTimestamp(oldest?.created_at || oldest?.last_message_at);
      return {
        conversationId,
        sessionKey: String(latest?.session_id || ""),
        sessionId: String(latest?.session_id || ""),
        title: truncateHistoryText(oldest?.title || latest?.title || "", 24) || "新对话",
        preview: "",
        searchText: normalizeHistoryText(segments.map((segment) => segment.title || "").join(" ")).slice(0, 12_000),
        messageCount: segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.message_count || 0)), 0),
        createdAt,
        updatedAt,
        runtime: "jiuwenswarm-enterprise",
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, args.limit);
}

function mergeRuntimeHistorySessions(primary: any[], fallback: any[], limit: number): any[] {
  const byConversation = new Map<string, any>();
  for (const session of [...primary, ...fallback]) {
    const key = String(session?.conversationId || session?.sessionKey || "").trim();
    if (!key) continue;
    const previous = byConversation.get(key);
    if (!previous || Number(session?.updatedAt || 0) > Number(previous?.updatedAt || 0)) {
      byConversation.set(key, session);
    }
  }
  return Array.from(byConversation.values())
    .sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0))
    .slice(0, limit);
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
  if (!previous) return text;
  if (eventType === "chat.delta") return `${previous}${text}`;
  if (text === previous) return previous;
  if (text.includes(previous) && text.length > previous.length) return text;
  if (previous.includes(text)) return previous;
  if (eventType === "chat.final") return `${previous.trimEnd()}\n\n${text.trimStart()}`;
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
    if (!isUserVisibleJiuwenArtifactPath(relative)) continue;
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
  return extractJiuwenChatMessagesFromRecords(rows, maxMessages, adoptId, workspaceDir, artifactRuns);
}

export function extractJiuwenChatMessagesFromRecords(
  rows: any[],
  maxMessages = 200,
  adoptId = "",
  workspaceDir = "",
  artifactRuns = new Map<string, { adoptId?: string; files?: JiuwenSessionArtifactFile[] }>(),
): ChatHistoryMessage[] {
  const messages: ChatHistoryMessage[] = [];
  const assistantByRequest = new Map<string, {
    id: string;
    finalText: string;
    fallbackText: string;
    timestamp: number;
    toolCalls: ChatHistoryToolCall[];
  }>();
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
    const historyContent = jiuwenHistoryContent(event);
    const rawText = role === "user"
      ? stripEaJiuwenUserInternalContext(stripPlatformLanguagePolicy(historyContent)).trim()
      : historyContent;
    const attachmentContext = role === "user"
      ? parseUploadedAttachmentRuntimeMessage(rawText)
      : { text: rawText, attachments: [] };
    const text = attachmentContext.text;

    if (role === "user") {
      if (!text && attachmentContext.attachments.length === 0) continue;
      messages.push({
        id: `jiuwen-${String(event?.id || messages.length)}`,
        role,
        text,
        timeLabel: formatHistoryTimeLabel(timestamp),
        timestamp,
        ...(attachmentContext.attachments.length > 0 ? {
          attachments: attachmentContext.attachments.map((file) => ({ ...file, adoptId: adoptId || undefined })),
        } : {}),
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
      existing.finalText = mergeJiuwenAssistantText(existing.finalText, text, eventType);
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
      .filter((message) => normalizeHistoryText(message.text) || (message.toolCalls || []).length > 0 || (message.attachments || []).length > 0)
      .sort((a, b) => {
        const at = typeof a.timestamp === "number" && Number.isFinite(a.timestamp) ? a.timestamp : 0;
        const bt = typeof b.timestamp === "number" && Number.isFinite(b.timestamp) ? b.timestamp : 0;
        return at - bt;
      }),
    maxMessages,
  );
}

type JiuwenHistoryCandidate = {
  conversationId: string;
  sessionId: string;
  historyFile: string;
  sessionsDir: string;
  metadata: any;
  updatedAt: number;
  createdAt: number;
};

function collectJiuwenHistoryCandidates(args: {
  adoptId: string;
  dbAgentId: string;
}): JiuwenHistoryCandidate[] {
  const sessionDirs = [
    jiuwenClawSessionsDir(args.adoptId, args.dbAgentId),
    path.join(JIUWENCLAW_HOME, "agent", "sessions"),
  ];
  const candidates: JiuwenHistoryCandidate[] = [];
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
      candidates.push({ conversationId, sessionId, historyFile, sessionsDir, metadata, updatedAt, createdAt });
      seen.add(sessionId);
    }
  }
  return candidates;
}

export function mergeJiuwenHistoryCandidates(args: {
  candidates: JiuwenHistoryCandidate[];
  adoptId: string;
  dbAgentId: string;
  maxMessages: number;
  workspaceDir?: string;
}): ChatHistoryMessage[] {
  const workspaceDir = args.workspaceDir || jiuwenClawWorkspaceDir(args.adoptId, args.dbAgentId);
  const messages = args.candidates
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt)
    .flatMap((candidate) => extractJiuwenChatMessages(
      candidate.historyFile,
      args.maxMessages,
      args.adoptId,
      workspaceDir,
    ));
  return dedupeHistoryMessages(messages, args.maxMessages);
}

export function listJiuwenChatHistorySessions(args: {
  adoptId: string;
  dbAgentId: string;
  limit: number;
}): any[] {
  const candidates = collectJiuwenHistoryCandidates(args);

  const byConversation = new Map<string, { latest: JiuwenHistoryCandidate; segments: JiuwenHistoryCandidate[] }>();
  for (const candidate of candidates) {
    const previous = byConversation.get(candidate.conversationId);
    if (!previous) {
      byConversation.set(candidate.conversationId, { latest: candidate, segments: [candidate] });
      continue;
    }
    previous.segments.push(candidate);
    if (Number(candidate.updatedAt || 0) > Number(previous.latest.updatedAt || 0)) previous.latest = candidate;
  }

  return Array.from(byConversation.values())
    .sort((a, b) => b.latest.updatedAt - a.latest.updatedAt)
    .slice(0, args.limit)
    .map(({ latest, segments }) => {
      const messages = mergeJiuwenHistoryCandidates({
        candidates: segments,
        adoptId: args.adoptId,
        dbAgentId: args.dbAgentId,
        maxMessages: 80,
      });
      const firstUser = messages.find((m) => m.role === "user");
      const last = [...messages].reverse().find((m) => normalizeHistoryText(m.text));
      const createdAt = Math.min(...segments.map((segment) => segment.createdAt).filter((value) => value > 0));
      const oldest = segments.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
      return {
        conversationId: latest.conversationId,
        sessionKey: latest.sessionId,
        sessionId: latest.sessionId,
        title: truncateHistoryText(oldest?.metadata?.title || firstUser?.text || "", 24) || "新对话",
        preview: truncateHistoryText(last?.text || "", 42),
        searchText: normalizeHistoryText(messages.map((message) => message.text || "").join(" ")).slice(0, 12000),
        messageCount: messages.length,
        createdAt: Number.isFinite(createdAt) ? createdAt : latest.createdAt,
        updatedAt: latest.updatedAt,
      };
    })
    .filter((entry) => entry.messageCount > 0);
}

export function resolveJiuwenHistorySession(args: {
  adoptId: string;
  dbAgentId: string;
  sessionKey: string;
}): { conversationId: string; sessionId: string; historyFile: string; sessionsDir: string; segments: JiuwenHistoryCandidate[] } | null {
  const sessionId = safeJiuwenSessionId(args.sessionKey);
  if (!sessionId) return null;
  const sessionDirs = [
    jiuwenClawSessionsDir(args.adoptId, args.dbAgentId),
    path.join(JIUWENCLAW_HOME, "agent", "sessions"),
  ];
  for (const sessionsDir of sessionDirs) {
    const historyFile = jiuwenHistoryFileForSession(sessionsDir, sessionId);
    if (!historyFile || !existsSync(historyFile)) continue;
    const conversationId = jiuwenConversationIdFromSessionId(sessionId, args.adoptId);
    const segments = collectJiuwenHistoryCandidates(args)
      .filter((candidate) => candidate.conversationId === conversationId);
    return {
      conversationId,
      sessionId,
      historyFile,
      sessionsDir,
      segments,
    };
  }
  return null;
}

export async function readModernChatHistorySessionMessages(args: {
  adoptId: string;
  dbAgentId: string;
  sessionKey: string;
  workspaceDir?: string;
  maxMessages?: number;
}) {
  const maxMessages = Math.min(Math.max(Number(args.maxMessages || 200), 1), 500);
  const expertConversationId = expertConversationIdFromSessionKey(args.sessionKey);
  if (expertConversationId) {
    const expertTasks = await listAgentTasksByConversation(args.adoptId, expertConversationId, 100);
    const messages = buildExpertTaskHistoryMessages(expertTasks, maxMessages);
    if (messages.length === 0) return null;
    return {
      conversationId: expertConversationId,
      sessionKey: args.sessionKey,
      sessionId: args.sessionKey,
      runtime: "ea-expert" as const,
      messages,
    };
  }

  if (!isJiuwenClawAdoptId(args.adoptId)) return null;
  const enterpriseSessionId = safeJiuwenSessionId(args.sessionKey);
  if (enterpriseSessionId && isListableJiuwenWebSession(enterpriseSessionId, args.adoptId)) {
    try {
      const records = await readEnterpriseRuntimeHistoryRecords({
        adoptId: args.adoptId,
        agentId: args.dbAgentId,
        sessionId: enterpriseSessionId,
        maxMessages,
      });
      if (records) {
        const conversationId = jiuwenConversationIdFromSessionId(enterpriseSessionId, args.adoptId);
        const runtimeMessages = extractJiuwenChatMessagesFromRecords(
          records,
          maxMessages,
          args.adoptId,
          args.workspaceDir,
        );
        const expertTasks = await listAgentTasksByConversation(args.adoptId, conversationId, 100).catch(() => []);
        const messages = bindHistoryAttachmentOwner(dedupeHistoryMessages([
          ...runtimeMessages,
          ...buildExpertTaskHistoryMessages(expertTasks, maxMessages),
        ], maxMessages), args.adoptId);
        if (messages.length > 0) {
          return {
            conversationId,
            sessionKey: args.sessionKey,
            sessionId: enterpriseSessionId,
            runtime: "jiuwenswarm-enterprise" as const,
            messages,
          };
        }
      }
    } catch (error) {
      logWarn("chat.history.enterprise_messages_fallback", {
        adoptId: args.adoptId,
        sessionId: enterpriseSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const resolved = resolveJiuwenHistorySession({
    adoptId: args.adoptId,
    dbAgentId: args.dbAgentId,
    sessionKey: args.sessionKey,
  });
  if (!resolved) return null;

  const runtimeMessages = mergeJiuwenHistoryCandidates({
    candidates: resolved.segments,
    adoptId: args.adoptId,
    dbAgentId: args.dbAgentId,
    maxMessages,
    workspaceDir: args.workspaceDir,
  });
  const expertTasks = await listAgentTasksByConversation(
    args.adoptId,
    resolved.conversationId,
    100,
  ).catch(() => []);
  const messages = bindHistoryAttachmentOwner(dedupeHistoryMessages([
    ...runtimeMessages,
    ...buildExpertTaskHistoryMessages(expertTasks, maxMessages),
  ], maxMessages), args.adoptId);
  return {
    conversationId: resolved.conversationId,
    sessionKey: args.sessionKey,
    sessionId: resolved.sessionId,
    runtime: "jiuwenswarm" as const,
    messages,
  };
}

export function deleteJiuwenHistorySession(args: {
  adoptId: string;
  dbAgentId: string;
  sessionKey: string;
}): { conversationId: string; sessionId: string; deleted: number } | null {
  const sessionId = safeJiuwenSessionId(args.sessionKey);
  if (!sessionId || !isListableJiuwenWebSession(sessionId, args.adoptId)) return null;
  const resolved = resolveJiuwenHistorySession(args);
  if (!resolved) return null;
  let deleted = 0;
  for (const segment of resolved.segments) {
    const sessionsRoot = path.resolve(segment.sessionsDir);
    const sessionDir = path.resolve(path.join(segment.sessionsDir, segment.sessionId));
    if (!sessionDir.startsWith(sessionsRoot + path.sep) || !existsSync(sessionDir)) continue;
    rmSync(sessionDir, { recursive: true, force: true });
    deleted += 1;
  }
  return {
    conversationId: resolved.conversationId,
    sessionId,
    deleted,
  };
}

const RECOVERED_WEB_CONVERSATION_PREFIX = "hist_";

function recoveredConversationId(sessionId: string): string {
  return `${RECOVERED_WEB_CONVERSATION_PREFIX}${sessionId}`;
}

export function addUsageEvent(params: {
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
  const day = usageDateKey(ts);
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

export function addJiuwenUsageEvents(params: {
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

  if (!isJiuwenClawAdoptId(adoptId)) {
    return {
      sessions: [],
      meta: {
        runtime: "unsupported",
        timings: { totalMs: Date.now() - startedAt },
      },
    };
  }

  const cacheKey = `${adoptId}\u0000${dbAgentId}\u0000${limit}`;
  const sessions = await chatSessionListCache.getOrLoad(cacheKey, async () => {
    const expertTasks = await listAgentTasksForHistory(adoptId, 1000).catch((error: any) => {
      logWarn("chat.history.expert_merge_skipped", {
        error: error?.message || String(error),
      });
      return [];
    });
    const expertSessions = buildExpertTaskHistorySessions(expertTasks);
    const localSessions = listJiuwenChatHistorySessions({ adoptId, dbAgentId, limit });
    let enterpriseSessions: any[] = [];
    try {
      const rawEnterpriseSessions = await listEnterpriseRuntimeHistorySessions({
        adoptId,
        agentId: dbAgentId,
        limit,
      });
      if (rawEnterpriseSessions) {
        enterpriseSessions = normalizeEnterpriseHistorySessions({
          sessions: rawEnterpriseSessions,
          adoptId,
          limit,
        });
      }
    } catch (error) {
      logWarn("chat.history.enterprise_list_fallback", {
        adoptId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const runtimeSessions = mergeRuntimeHistorySessions(enterpriseSessions, localSessions, limit);
    return mergeExpertTaskHistorySessions(runtimeSessions, expertSessions, limit);
  });
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
