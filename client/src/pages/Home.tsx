/**
 * Home.tsx — Workforce Agent Platform console
 * Renders the agent console when accessed via /claw/:adoptId or a legacy agent subdomain.
 * The linggan homepage code has been removed (dead code on this server).
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { RuntimeWSClient } from "@/lib/runtime-ws";
import {
  applyAssistantFinalSnapshot,
  mergeAssistantStreamText,
  parseRuntimeRunDescriptor,
} from "@/lib/assistant-stream";
import { toast } from "sonner";
import { useBrand } from "@/lib/useBrand";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useRoute, useLocation } from "wouter";
import { SidebarFooter } from "@/components/SidebarFooter";
import { ChatInput } from "@/components/ChatInput";
import { CustomMcpDialog } from "@/components/CustomMcpDialog";
import { ChatMessage, type ChatMessageAttachment, type JiuwenPermissionRequestCard, type MessageEventEntry, type MessageFeedbackValue, type ToolCallEntry } from "@/components/ChatMessage";
import { ConversationNavigator, buildConversationNavigatorItems } from "@/components/ConversationNavigator";
import { ModelPicker } from "@/components/ModelPicker";
import type { AgentTask } from "@/components/AgentTaskCard";
import { BrandIcon } from "@/components/BrandIcon";
import { Sidebar, isPageKey, type PageKey } from "@/components/console/Sidebar";
import { SessionList } from "@/components/console/SessionList";
import { PanelErrorBoundary } from "@/components/console/PanelErrorBoundary";
import { TopBar } from "@/components/console/TopBar";
import { MainPanel } from "@/components/console/MainPanel";
import { ChatPage } from "@/components/pages/ChatPage";
import { WorkspaceBrowser } from "@/components/pages/WorkspacePage";
import { WorkforceAgentIcon } from "@/components/WorkforceAgentIcon";
import { applySettings as applyUiSettings, getSettings, subscribeSettings } from "@/lib/settings";
import { classifyDisplayError, displayErrorMessage } from "@/lib/errorDisplay";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BrainCircuit, ChevronRight, FolderOpen, History, Link2, LoaderCircle, Menu, Paperclip, Plus, Search, Settings2, Upload, Wand2, X } from "lucide-react";
import { buildUploadedAttachmentRuntimeMessage, parseUploadedAttachmentRuntimeMessage } from "@shared/uploaded-attachment-context";
import { inspectSkillPackage, uploadSkillPackage } from "@/lib/skill-package-upload";
import {
  flattenComposerConnectors,
  type ComposerConnector,
  type ComposerConnectorResponse,
} from "@/lib/composer-connectors";
import {
  expertTaskMessage,
  normalizeExpertAgents,
  type ExpertAgent,
  type ExpertAgentsResponse,
} from "@/lib/expert-agents";


const ENABLE_OPENCLAW_WS_CHAT = true;
const WORKSPACE_PANEL_WIDTH_KEY = "employee_agent_workspace_panel_width";
const WORKSPACE_PANEL_DEFAULT_WIDTH = 400;
const WORKSPACE_PANEL_MIN_WIDTH = 320;
const WORKSPACE_PANEL_MAX_WIDTH = 560;

function initialWorkspacePanelWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(WORKSPACE_PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) {
      return Math.min(WORKSPACE_PANEL_MAX_WIDTH, Math.max(WORKSPACE_PANEL_MIN_WIDTH, saved));
    }
  } catch {}
  return WORKSPACE_PANEL_DEFAULT_WIDTH;
}

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  "investment-researcher": "投顾分析",
  "wealth-manager": "财富经理",
  "credential-compliance": "审核专员",
  "insurance-advisor": "保险顾问",
  "general-assistant": "通用助手",
};

function roleDisplayName(roleTemplate: unknown, roleName?: unknown) {
  const name = String(roleName || "").trim();
  if (name) return name;
  const role = String(roleTemplate || "").trim();
  return ROLE_DISPLAY_NAMES[role] || "通用助手";
}

// reasoning_content 是模型内部推理流。当前产品不直接展示原始推理内容，避免和真实工具调用卡片混淆。
function markThinkingDone(msgs: any[]): any[] {
  return msgs;
}

function toolCallsSignature(toolCalls?: ToolCallEntry[]) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return toolCalls
    .map((tool) => [
      tool.id,
      tool.name,
      tool.status,
      String(tool.arguments || "").slice(0, 80),
      String(tool.result || "").length,
      tool.outputFiles?.length || 0,
    ].join(":"))
    .join("|");
}

function normalizeIncomingToolName(chunk: any): string {
  const fn = chunk?.function && typeof chunk.function === "object" ? chunk.function : {};
  const raw = chunk?.name ?? chunk?.toolName ?? chunk?.tool_name ?? chunk?.tool ?? fn?.name;
  const value = String(raw || "").trim();
  return value || "tool";
}

// 2026-04-28 批次 2 A1：chat messages 加稳定 id，恢复时按 id 替换不按 findLastIndex
// 用于 SSE 截断 recover 时精确匹配目标消息——用户在 recover 期间发新消息也不串
const makeLxMsgId = () => `lx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const makeClientRunId = () => `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const makeConversationId = () => `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
const webConversationStorageKey = (userId: string, adoptId: string) => `agent_web_conversation_${userId}_${adoptId}`;
const legacyWebConversationStorageKeys = (userId: string, adoptId: string) => [
  `lingxia_web_conversation_${userId}_${adoptId}`,
  `lingxia_web_conversation_${adoptId}`,
];
const webMessagesStorageKey = (userId: string, adoptId: string, conversationId: string) => `agent_web_messages_${userId}_${adoptId}_${conversationId}`;
const legacyWebMessagesStorageKeys = (userId: string, adoptId: string, conversationId: string) => [
  `lgc_msgs_${userId}_${adoptId}_${conversationId}`,
  `lgc_msgs_${adoptId}_${conversationId}`,
];
const webDraftStorageKey = (userId: string, adoptId: string, conversationId: string) => `agent_web_draft_${userId}_${adoptId}_${conversationId}`;
const legacyWebDraftStorageKey = (userId: string, adoptId: string, conversationId: string) => `lingxia_web_draft_${userId}_${adoptId}_${conversationId}`;
const webInputHistoryStorageKey = (userId: string, adoptId: string) => `agent_web_input_history_${userId}_${adoptId}`;
const legacyWebInputHistoryStorageKey = (userId: string, adoptId: string) => `lingxia_web_input_history_${userId}_${adoptId}`;
const webSessionIndexStorageKey = (userId: string, adoptId: string) => `agent_web_sessions_${userId}_${adoptId}`;
const legacyWebSessionIndexStorageKey = (userId: string, adoptId: string) => `lingxia_web_sessions_${userId}_${adoptId}`;
const webHiddenSessionsStorageKey = (userId: string, adoptId: string) => `agent_web_sessions_hidden_${userId}_${adoptId}`;
const legacyWebHiddenSessionsStorageKey = (userId: string, adoptId: string) => `lingxia_web_sessions_hidden_${userId}_${adoptId}`;
const clawStatusStorageKey = (userId: string, adoptId: string) => `agent_claw_status_${userId}_${adoptId}`;
const legacyClawStatusStorageKey = (userId: string, adoptId: string) => `lingxia_claw_status_${userId}_${adoptId}`;
const clawModelStorageKey = (userId: string, adoptId: string) => `agent_claw_model_${userId}_${adoptId}`;
const legacyClawModelStorageKey = (userId: string, adoptId: string) => `lingxia_claw_model_${userId}_${adoptId}`;
const clawModelFallbackStorageKey = (adoptId: string) => `agent_claw_model_public_${adoptId}`;
const legacyClawModelFallbackStorageKey = (adoptId: string) => `lingxia_claw_model_public_${adoptId}`;
const JIUWEN_PERMISSION_MARKER_RE = /<!--EA_JIUWEN_PERMISSION:([A-Za-z0-9+/=]+)-->/g;

type ComposerSkillOption = {
  id: string;
  label: string;
  desc: string;
  source: string;
  initial: string;
  requiredMcpServers: string[];
};

function composerSkillInitial(skill: any, id: string): string {
  const candidates = [
    skill?.name,
    skill?.source?.name,
    skill?.source?.skillId,
    id,
  ];
  for (const candidate of candidates) {
    const match = String(candidate || "").match(/[A-Za-z]/);
    if (match) return match[0].toUpperCase();
  }
  return "S";
}

function flattenComposerSkills(groups: any): ComposerSkillOption[] {
  const raw = [
    ...(Array.isArray(groups?.shared) ? groups.shared : []),
    ...(Array.isArray(groups?.system) ? groups.system : []),
    ...(Array.isArray(groups?.private) ? groups.private : []),
  ];
  const seen = new Set<string>();
  const out: ComposerSkillOption[] = [];
  for (const skill of raw) {
    const id = String(skill?.id || "").trim();
    if (!id || seen.has(id)) continue;
    const enabled = skill?.enabled !== false;
    const ready = !skill?.state || skill.state === "ready";
    const runnable = skill?.runnable !== false && skill?.active !== false;
    if (!enabled || !ready || !runnable) continue;
    seen.add(id);
    out.push({
      id,
      label: String(skill?.source?.displayName || skill?.displayName || skill?.label || skill?.name || id).trim() || id,
      desc: String(skill?.desc || skill?.description || skill?.source?.description || "").trim(),
      source: String(skill?.scope || skill?.source || "skill").trim(),
      initial: composerSkillInitial(skill, id),
      requiredMcpServers: Array.isArray(skill?.requirements?.mcpServers)
        ? skill.requirements.mcpServers.map((value: unknown) => String(value || "").trim()).filter(Boolean)
        : [],
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

type WebChatSessionRecord = {
  conversationId: string;
  sessionKey?: string;
  sessionId?: string;
  title: string;
  customTitle?: string;
  autoTitle?: boolean;
  preview: string;
  searchText?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  sourceUpdatedAt?: number;
  sortUpdatedAt?: number;
  pinnedAt?: number;
};

function normalizeSessionText(text: string) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeSessionSearchText(text: string) {
  return normalizeSessionText(text).toLowerCase();
}

function compactSessionSearchText(text: string) {
  return normalizeSessionSearchText(text).replace(/\s+/g, "");
}

function stripSessionMessagePrefix(text: string) {
  return String(text || "")
    .replace(/^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+GMT[+-]\d+\]\s*/g, "")
    .trim();
}

function encodeJiuwenPermissionMarker(permission: JiuwenPermissionRequestCard) {
  try {
    const payload = {
      requestId: permission.requestId,
      source: permission.source || "permission_interrupt",
      title: permission.title || "权限审批",
      question: permission.question || "",
      command: permission.command || "",
      toolName: permission.toolName || "",
      options: permission.options || [],
      state: permission.state || "pending",
    };
    return `\n\n<!--EA_JIUWEN_PERMISSION:${btoa(encodeURIComponent(JSON.stringify(payload)))}-->`;
  } catch {
    return "";
  }
}

function extractJiuwenPermissionMarker(text: string): { text: string; permission?: JiuwenPermissionRequestCard } {
  let permission: JiuwenPermissionRequestCard | undefined;
  const cleanText = String(text || "").replace(JIUWEN_PERMISSION_MARKER_RE, (_match, encoded: string) => {
    try {
      const parsed = JSON.parse(decodeURIComponent(atob(encoded)));
      if (parsed?.requestId) {
        permission = {
          requestId: String(parsed.requestId),
          source: String(parsed.source || "permission_interrupt"),
          title: String(parsed.title || "权限审批"),
          question: String(parsed.question || ""),
          command: parsed.command ? String(parsed.command) : undefined,
          toolName: parsed.toolName ? String(parsed.toolName) : undefined,
          options: Array.isArray(parsed.options) ? parsed.options : undefined,
          state: parsed.state === "approved" || parsed.state === "rejected" || parsed.state === "error" ? parsed.state : "pending",
        };
      }
    } catch {}
    return "";
  }).replace(/\n{4,}/g, "\n\n\n").trim();
  return { text: cleanText, permission };
}

function withJiuwenPermissionMarker(text: string, permission: JiuwenPermissionRequestCard) {
  const extracted = extractJiuwenPermissionMarker(text);
  const visibleText = extracted.text || "需要你的授权才能继续执行。";
  return `${visibleText}${encodeJiuwenPermissionMarker(permission)}`;
}

function truncateSessionText(text: string, max = 28) {
  const normalized = normalizeSessionText(stripSessionMessagePrefix(text));
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function inferSessionTitle(messages: Array<{ role?: string; text?: string }>) {
  const firstUser = messages.find((m) => m.role === "user" && normalizeSessionText(m.text || ""));
  return truncateSessionText(firstUser?.text || "", 24) || "新对话";
}

function inferSessionPreview(messages: Array<{ text?: string }>) {
  const last = [...messages].reverse().find((m) => normalizeSessionText(m.text || ""));
  return truncateSessionText(last?.text || "", 42);
}

function readLocalStorageWithLegacy(primaryKey: string, legacyKeys: string[] = []): string {
  try {
    const primary = localStorage.getItem(primaryKey);
    if (primary) return primary;
    for (const legacyKey of legacyKeys) {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy) {
        localStorage.setItem(primaryKey, legacy);
        return legacy;
      }
    }
  } catch {}
  return "";
}

function removeLocalStorageKeys(keys: Array<string | null | undefined>) {
  try {
    for (const key of keys) {
      if (key) localStorage.removeItem(key);
    }
  } catch {}
}

function readWebSessionIndex(key: string, legacyKeys: string[] = []): WebChatSessionRecord[] {
  try {
    const parsed = JSON.parse(readLocalStorageWithLegacy(key, legacyKeys) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item?.conversationId) : [];
  } catch {
    return [];
  }
}

function writeWebSessionIndex(key: string, sessions: WebChatSessionRecord[]) {
  try {
    localStorage.setItem(key, JSON.stringify(sessions.slice(0, 30)));
  } catch {}
}

function readHiddenWebSessions(key: string, legacyKeys: string[] = []): Set<string> {
  try {
    const parsed = JSON.parse(readLocalStorageWithLegacy(key, legacyKeys) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function writeHiddenWebSessions(key: string, hidden: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(hidden).slice(0, 200)));
  } catch {}
}

function sortWebSessionRecords(sessions: WebChatSessionRecord[]) {
  return [...sessions].sort((a, b) => {
    const aPinned = Number(a.pinnedAt || 0);
    const bPinned = Number(b.pinnedAt || 0);
    if (aPinned || bPinned) return bPinned - aPinned;
    return Number(b.sortUpdatedAt || b.sourceUpdatedAt || b.updatedAt || 0) - Number(a.sortUpdatedAt || a.sourceUpdatedAt || a.updatedAt || 0);
  });
}

function normalizeSessionViewRecord(item: any): WebChatSessionRecord | null {
  const conversationId = String(item?.conversationId || "").trim();
  const sessionKey = String(item?.sessionKey || item?.runtimeSessionKey || "").trim();
  if (!conversationId || !sessionKey) return null;
  const updatedAt = Number(item?.updatedAt || item?.sourceUpdatedAt || item?.sortUpdatedAt || 0) || 0;
  const sourceUpdatedAt = Number(item?.sourceUpdatedAt || updatedAt) || updatedAt;
  const sortUpdatedAt = Number(item?.sortUpdatedAt || sourceUpdatedAt || updatedAt) || sourceUpdatedAt || updatedAt;
  return {
    conversationId,
    sessionKey,
    sessionId: String(item?.sessionId || item?.jiuwenSessionId || "").trim() || undefined,
    title: normalizeSessionText(String(item?.title || "新对话")),
    preview: normalizeSessionText(String(item?.preview || "")),
    searchText: normalizeSessionText(String(item?.searchText || "")),
    messageCount: Number(item?.messageCount || 0) || 0,
    createdAt: Number(item?.createdAt || updatedAt || sourceUpdatedAt || sortUpdatedAt || Date.now()) || Date.now(),
    updatedAt: updatedAt || sourceUpdatedAt || sortUpdatedAt || Date.now(),
    sourceUpdatedAt: sourceUpdatedAt || updatedAt,
    sortUpdatedAt: sortUpdatedAt || sourceUpdatedAt || updatedAt,
  };
}

function visibleWebSessionIndex(
  key: string,
  hiddenKey?: string | null,
  legacyKeys: string[] = [],
  legacyHiddenKeys: string[] = [],
): WebChatSessionRecord[] {
  const hidden = hiddenKey ? readHiddenWebSessions(hiddenKey, legacyHiddenKeys) : new Set<string>();
  return sortWebSessionRecords(readWebSessionIndex(key, legacyKeys)
    .filter((item) => item?.conversationId && !hidden.has(item.conversationId)));
}

function mergeWebSessionRecords(local: WebChatSessionRecord[], remote: WebChatSessionRecord[], hidden: Set<string>) {
  const byConversation = new Map<string, WebChatSessionRecord>();
  for (const item of [...local, ...remote]) {
    if (!item?.conversationId || hidden.has(item.conversationId)) continue;
    const previous = byConversation.get(item.conversationId);
    const itemHasBackendSession = Boolean(item.sessionKey);
    const previousHasBackendSession = Boolean(previous?.sessionKey);
    const itemUpdatedAt = Number(item.updatedAt || 0);
    const previousUpdatedAt = Number(previous?.updatedAt || 0);
    const localMeta = {
      customTitle: previous?.customTitle || item.customTitle,
      autoTitle: Boolean(previous?.autoTitle || item.autoTitle),
      pinnedAt: previous?.pinnedAt || item.pinnedAt,
    };
    if (!previous || itemUpdatedAt >= previousUpdatedAt) {
      byConversation.set(item.conversationId, { ...previous, ...item, ...localMeta });
    } else if (item.sessionKey && !previous.sessionKey) {
      byConversation.set(item.conversationId, { ...previous, ...localMeta, sessionKey: item.sessionKey, sessionId: item.sessionId, searchText: item.searchText || previous.searchText });
    } else if (itemHasBackendSession && !previousHasBackendSession) {
      byConversation.set(item.conversationId, { ...item, ...previous, ...localMeta, sessionKey: item.sessionKey, sessionId: item.sessionId, searchText: item.searchText || previous.searchText });
    }
  }
  return sortWebSessionRecords(Array.from(byConversation.values())).slice(0, 100);
}

type UploadedLingxiaAttachment = {
  name: string;
  path: string;
  size: number;
  runtime?: string;
};

type ComposerAddMenuView = "root" | "connectors" | "skills" | "experts";

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function extractAgentTaskIds(text: unknown): string[] {
  const value = String(text || "");
  return Array.from(value.matchAll(/\bagt_[A-Za-z0-9]{8,64}\b/g), (match) => match[0]);
}

type LxMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timeLabel: string;
  status?: string;
  usage?: { input: number; output: number };
  model?: string;
  contextWindow?: number;
  contextPercent?: number;
  selectedSkillId?: string;
  attachments?: ChatMessageAttachment[];
  toolCalls?: import("@/components/ChatMessage").ToolCallEntry[];
  messageEvents?: MessageEventEntry[];
  jiuwenPermission?: JiuwenPermissionRequestCard;
  // 2026-04-29 批次 2 A3：截断恢复状态（仅 assistant 用）
  recovering?: boolean;
  recovered?: boolean;
  recoveryFailed?: boolean;
  partialText?: string;            // 截断时已显示的内容（恢复失败时保留）
};

function hasPendingJiuwenPermissionMessage(message?: LxMsg | null): boolean {
  return Boolean(
    message?.role === "assistant" &&
    message.jiuwenPermission?.requestId &&
    message.jiuwenPermission.state === "pending"
  );
}

function toolCallToMessageEvent(tool: ToolCallEntry): MessageEventEntry {
  return {
    type: "tool_call",
    id: String(tool.id || ""),
    name: String(tool.name || "tool"),
    arguments: String(tool.arguments || "{}"),
    result: tool.result,
    status: tool.status,
    ts: Number(tool.ts || Date.now()),
    durationMs: tool.durationMs,
    executor: tool.executor,
    truncated: tool.truncated,
    suppressedOriginalResult: tool.suppressedOriginalResult,
    policyDenyReason: tool.policyDenyReason,
    auditId: tool.auditId,
    outputFiles: tool.outputFiles,
    adoptId: tool.adoptId,
    _gateway: tool._gateway,
  };
}

function normalizeMessageToolEvents(message: LxMsg): LxMsg {
  const nonToolEvents = Array.isArray(message.messageEvents)
    ? message.messageEvents.filter((event) => event?.type !== "tool_call")
    : [];
  const toolEvents = Array.isArray(message.toolCalls)
    ? message.toolCalls.filter((tool) => tool?.id && tool?.name).map(toolCallToMessageEvent)
    : [];
  return {
    ...message,
    messageEvents: [...nonToolEvents, ...toolEvents],
  };
}

type ClawReadinessIssue = {
  code: string;
  severity: "warning" | "error";
  message: string;
};

type ClawHealthSummary = {
  ok?: boolean;
  model?: {
    selected?: string;
    defaultModel?: string;
    availableCount?: number;
    sourceError?: string | null;
  };
  readiness?: {
    ok?: boolean;
    status?: "ready" | "degraded" | "blocked" | string;
    summary?: string;
    issues?: ClawReadinessIssue[];
    checkedAt?: string;
  };
  timings?: Record<string, number>;
};

type ClientLoadMetric = {
  key: string;
  label: string;
  status: "pending" | "ok" | "error" | "skip";
  elapsedMs: number;
  requestMs?: number;
  detail?: string;
  at: number;
};

const CLIENT_LOAD_METRIC_LABELS: Record<string, string> = {
  auth: "登录态",
  agent: "智能体实例",
  settings: "智能体设置",
  models: "模型列表",
  health: "健康检查",
  sessions: "历史会话",
  runtimeInfo: "运行时信息",
  skills: "技能列表",
};
const CLIENT_LOAD_PRIMARY_KEYS = new Set(["auth", "agent", "settings", "models", "health", "runtimeInfo", "skills"]);

function clientMetricDisplayMs(metric: ClientLoadMetric): number {
  return metric.requestMs ?? metric.elapsedMs;
}

function ChatStartupSkeleton() {
  return (
    <div className="chat-startup-skeleton max-w-4xl" aria-label="正在加载对话">
      <div className="chat-startup-skeleton__avatar" />
      <div className="chat-startup-skeleton__body">
        <div className="chat-startup-skeleton__bubble">
          <span style={{ width: "54%" }} />
          <span style={{ width: "72%" }} />
          <span style={{ width: "36%" }} />
        </div>
        <div className="chat-startup-skeleton__meta" />
      </div>
    </div>
  );
}

const backfillLxMsgIds = (raw: any): LxMsg[] => {
  if (!Array.isArray(raw)) return [];
  return raw.map((m: any) => {
    const parsed = extractJiuwenPermissionMarker(String(m?.text ?? ""));
    const parsedAttachmentContext = parseUploadedAttachmentRuntimeMessage(parsed.text);
    const rawAttachments = Array.isArray(m?.attachments) && m.attachments.length > 0
      ? m.attachments
      : parsedAttachmentContext.attachments;
    const attachments: ChatMessageAttachment[] = rawAttachments
      .map((file: any) => ({
        name: String(file?.name || "").trim().slice(0, 255),
        size: Math.max(0, Number(file?.size || 0)),
        path: String(file?.path || "").replace(/\\/g, "/").replace(/^workspace\//, "").trim(),
        adoptId: String(file?.adoptId || "").trim(),
      }))
      .filter((file: ChatMessageAttachment) => (
        Boolean(file.name && file.path) &&
        !file.path.startsWith("/") &&
        !file.path.split("/").includes("..")
      ));
    const toolCalls = Array.isArray(m?.toolCalls) ? m.toolCalls : [];
    const existingEvents = Array.isArray(m?.messageEvents) ? m.messageEvents : Array.isArray(m?.events) ? m.events : [];
    const toolEvents: MessageEventEntry[] = toolCalls
      .filter((tool: any) => tool?.id && tool?.name)
      .map((tool: any) => ({
        type: "tool_call" as const,
        id: String(tool.id),
        name: String(tool.name),
        arguments: String(tool.arguments || "{}"),
        result: tool.result != null ? String(tool.result) : undefined,
        status: tool.status === "error" ? "error" : tool.status === "done" ? "done" : "running",
        ts: Number(tool.ts || Date.now()),
        durationMs: typeof tool.durationMs === "number" ? tool.durationMs : undefined,
        executor: tool.executor,
        truncated: Boolean(tool.truncated),
        suppressedOriginalResult: Boolean(tool.suppressedOriginalResult),
        policyDenyReason: tool.policyDenyReason,
        auditId: tool.auditId,
        outputFiles: Array.isArray(tool.outputFiles) ? tool.outputFiles : undefined,
        adoptId: tool.adoptId,
        _gateway: Boolean(tool._gateway),
      }));
    return {
      ...m,
      id: typeof m?.id === "string" && m.id ? m.id : makeLxMsgId(),
      role: m?.role === "assistant" ? "assistant" : "user",
      text: parsedAttachmentContext.text,
      timeLabel: String(m?.timeLabel ?? new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      messageEvents: existingEvents.length > 0 ? existingEvents : toolEvents,
      jiuwenPermission: m?.jiuwenPermission || parsed.permission,
      // 2026-04-29 批次 2 A3：重载后清空 recovering 瞬态——刷新前正在补偿的消息视为失败，避免 UI 卡住
      recovering: false,
    };
  });
};

// ── 2026-04-29 批次 2 A3：SSE 截断后恢复 ────────────────────────────
// 收到 __stream_truncated 事件时启动短轮询 /api/claw/recover-status，
// 拿到 OpenClaw trajectory 完整 assistantTexts 后按 lingxiaMsgs.id 替换。
// 调用方需传入当前 lingxiaMsgs snapshot（来自 ref.current）——不能依赖
// setState updater 闭包来抓 id（React 18 concurrent 下 updater 不保证同步执行）。
async function handleStreamTruncated(
  truncEvt: { adoptId?: string; streamEndMs?: number; chatCompletionId?: string | null },
  currentMsgs: LxMsg[],
  setLingxiaMsgs: React.Dispatch<React.SetStateAction<LxMsg[]>>,
): Promise<void> {
  const { adoptId, streamEndMs, chatCompletionId } = truncEvt;
  if (!adoptId || typeof streamEndMs !== "number") {
    console.warn("[recover] missing fields in __stream_truncated:", truncEvt);
    return;
  }

  // 直接从 currentMsgs (caller 已传 ref.current) 抓最后 assistant id —— 不走 setState 副作用
  const lastIdx = currentMsgs.length - 1;
  if (lastIdx < 0 || currentMsgs[lastIdx].role !== "assistant") {
    console.warn("[recover] no last assistant message in current snapshot");
    return;
  }
  const myId = currentMsgs[lastIdx].id;
  const partialSnapshot = currentMsgs[lastIdx].text;

  // 标 recovering——按 id 找，因为到 updater 跑时数组顺序可能已变（用户瞬时发新消息）
  setLingxiaMsgs((prev) => {
    const idx = prev.findIndex((m) => m.id === myId);
    if (idx < 0) return prev;
    const next = [...prev];
    next[idx] = {
      ...next[idx],
      recovering: true,
      partialText: partialSnapshot,
      text: (partialSnapshot || "") + "\n\n_⏳ 上游连接提前结束，正在从运行时后台补全完整内容（最多 5 分钟）..._",
    };
    return next;
  });
  console.log("[recover] start polling for", myId, { adoptId, streamEndMs, chatCompletionId });

  const MAX_ATTEMPTS = 60;   // 5 分钟 / 5 秒 = 60 次（约束 #4）
  const INTERVAL_MS = 5000;
  let attempts = 0;

  const poll = async () => {
    if (attempts >= MAX_ATTEMPTS) {
      console.warn("[recover] timeout after", MAX_ATTEMPTS, "attempts");
      setLingxiaMsgs((msgs) => msgs.map((m) =>
        m.id === myId
          ? {
              ...m,
              recovering: false,
              recoveryFailed: true,
              text: (m.partialText || m.text) +
                "\n\n_⚠️ 内容补偿超时（5 分钟），可重试或查看 Workspace 产物_",
            }
          : m
      ));
      return;
    }
    attempts++;
    try {
      const r = await fetch("/api/claw/recover-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adoptId,
          streamEndMs,
          chatCompletionId: chatCompletionId ?? null,
        }),
      });
      const d = await r.json();
      if (d.status === "ready") {
        const recovered = String(d.text || "");
        console.log("[recover] ✅ ready, replacing", recovered.length, "chars (matchType=" + d.matchType + ")");
        setLingxiaMsgs((msgs) => msgs.map((m) =>
          m.id === myId
            ? { ...m, recovering: false, recovered: true, text: recovered, partialText: undefined }
            : m
        ));
        return;
      }
      if (d.status === "failed") {
        console.warn("[recover] ❌ failed:", d);
        setLingxiaMsgs((msgs) => msgs.map((m) =>
          m.id === myId
            ? {
                ...m,
                recovering: false,
                recoveryFailed: true,
                text: (m.partialText || m.text) +
                  `\n\n_⚠️ 内容补偿失败：${d.finalStatus || d.reason || "unknown"}，可重试或查看 Workspace 产物_`,
              }
            : m
        ));
        return;
      }
      // pending 继续轮询
      setTimeout(poll, INTERVAL_MS);
    } catch (e: any) {
      console.warn("[recover] poll error:", e?.message);
      setTimeout(poll, INTERVAL_MS);
    }
  };
  // 第一次也等 5s——给运行时写 trace.artifacts 留时间
  setTimeout(poll, INTERVAL_MS);
}

export default function Home() {
  // 岗位智能体子域名聊天态（MVP）
  const brand = useBrand();
  const { confirm, dialog } = useConfirmDialog();
  const clientLoadStartedAtRef = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());
  const clientLoadReportedRef = useRef(false);
  const [clientLoadMetrics, setClientLoadMetrics] = useState<Record<string, ClientLoadMetric>>({});
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(initialWorkspacePanelWidth);
  const [workspacePanelResizing, setWorkspacePanelResizing] = useState(false);
  const workbenchContentRef = useRef<HTMLDivElement | null>(null);
  const markClientLoadMetric = useCallback((
    key: string,
    status: ClientLoadMetric["status"],
    detail?: string,
    requestStartedAt?: number,
  ) => {
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const elapsedMs = Math.round(nowMs - clientLoadStartedAtRef.current);
    const requestMs = requestStartedAt ? Math.round(nowMs - requestStartedAt) : undefined;
    setClientLoadMetrics((previous) => {
      const existing = previous[key];
      if (existing?.status === status && existing?.detail === detail) return previous;
      return {
        ...previous,
        [key]: {
          key,
          label: CLIENT_LOAD_METRIC_LABELS[key] || key,
          status,
          elapsedMs,
          requestMs,
          detail,
          at: Date.now(),
        },
      };
    });
  }, []);
  const [lingxiaInput, setLingxiaInput] = useState("");
  const chatRuntimeMode: "fast" = "fast";
  const [lingxiaMsgs, setLingxiaMsgs] = useState<LxMsg[]>([]);
  // 2026-04-29 批次 2 A3：mirror ref 用于 SSE 异步 handler 拿稳定 snapshot
  // React 18 concurrent 下 setState updater 不保证同步执行，不能在 updater 里抓 id 给外层用
  const lingxiaMsgsRef = useRef<LxMsg[]>(lingxiaMsgs);
  useEffect(() => { lingxiaMsgsRef.current = lingxiaMsgs; }, [lingxiaMsgs]);
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [lingxiaToolCalls, setLingxiaToolCalls] = useState<ToolCallEntry[]>([]);
  const [lingxiaShowToolCalls, setLingxiaShowToolCalls] = useState(true);
  const [lingxiaDisplayName, setLingxiaDisplayName] = useState(brand.name);
    const [lingxiaMemoryEnabled, setLingxiaMemoryEnabled] = useState<"yes" | "no">("yes");
  const [lingxiaContextTurns, setLingxiaContextTurns] = useState(20);
  const [lingxiaModelId, setLingxiaModelId] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(248);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.innerWidth <= 768);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [openclawVersion, setOpenclawVersion] = useState("OpenClaw 2026.5.7");
  const [jiuwenswarmVersion, setJiuwenswarmVersion] = useState("JiuwenSwarm");
  const [runtimeAgentId, setRuntimeAgentId] = useState("");
  const prettyRuntimeAgentName = (agentId: string) => {
    const s = String(agentId || "").trim();
    if (!s) return "";
    return s.replace(/^trial_/, "").replace(/^lgc-/, "");
  };
  const [activePage, setActivePage] = useState<PageKey>(() => {
    // 支持别的页面（例如 CoopSession 返回按钮）通过 sessionStorage 指定首次落地的 page
    try {
      const v = sessionStorage.getItem("home_initial_page");
      if (v) {
        sessionStorage.removeItem("home_initial_page");
        if (v === "agentLab") return "chat";
        if (v === "docs") return "workspace";
        if (v === "weixin") return "channels";
        if (v === "meeting") return "chat";
        if (v === "office") return "chat";
        if (isPageKey(v)) return v;
      }
    } catch {}
    return "chat";
  });
  const [sidebarSelection, setSidebarSelection] = useState<"navigation" | "session">("navigation");

  // Step 6 扩展：主聊天 @ 触发协作的状态
  const [, setLocationCoop] = useLocation();
  const [mentionedUsers, setMentionedUsers] = useState<Array<{userId: number; userName: string; groupName: string | null; orgName: string | null; adoptId: string | null}>>([]);
  const coopCreateFromChatMut = trpc.coop.create.useMutation({
    onSuccess: (r) => {
      setMentionedUsers([]);
      setLingxiaInput("");
      toast.success("已发起协作");
      const suffix = resolvedAdoptId ? `?fromAdoptId=${encodeURIComponent(resolvedAdoptId)}` : "";
      setLocationCoop(`/coop/${r.sessionId}${suffix}`);
    },
    onError: (e) => toast.error(e.message || "协作创建失败"),
  });

    // Step 6: 侧栏协作红点（pendingCount 每 30s 刷新；WS 推入未来版）
  const { data: coopPending } = trpc.coop.pendingCount.useQuery(undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const coopBadgeCount = (coopPending?.pendingMyApproval || 0) + (coopPending?.awaitingMyConsolidation || 0);

  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessionSwitchingId, setSessionSwitchingId] = useState<string | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const initial = getSettings();
    setSidebarCollapsed(initial.navCollapsed);
    setSidebarWidth(initial.navWidth);
    return subscribeSettings((st) => {
      setSidebarCollapsed(st.navCollapsed);
      setSidebarWidth(st.navWidth);
    });
  }, []);

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileSidebarOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileSidebarOpen]);

  useEffect(() => {
    applyUiSettings({ navCollapsed: sidebarCollapsed, navWidth: sidebarWidth });
  }, [sidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_PANEL_WIDTH_KEY, String(Math.round(workspacePanelWidth)));
    } catch {}
  }, [workspacePanelWidth]);

  useEffect(() => {
    if (!workspacePanelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setWorkspacePanelOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [workspacePanelOpen]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 768px)");
    const syncViewport = () => {
      setIsMobileViewport(media.matches);
      if (!media.matches) setMobileSidebarOpen(false);
    };
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    if (!sessionMenuOpen) return;
    const onPointerDown = (event: MouseEvent | PointerEvent) => {
      if (sessionMenuRef.current?.contains(event.target as Node)) return;
      setSessionMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSessionMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sessionMenuOpen]);
  const [lingxiaOpenSections, setLingxiaOpenSections] = useState<Set<string>>(new Set(["soul"]));
  const toggleLingxiaSection = (s: string) => setLingxiaOpenSections(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });

  const { user, loading: authLoading, error: authError, logout } = useAuth({ redirectOnUnauthenticated: false });
  const effectiveSidebarCollapsed = !isMobileViewport && sidebarCollapsed;
  const constrainWorkspacePanelWidth = useCallback((value: number) => {
    const availableWidth = workbenchContentRef.current?.clientWidth || window.innerWidth;
    const responsiveMax = Math.max(
      WORKSPACE_PANEL_MIN_WIDTH,
      Math.min(WORKSPACE_PANEL_MAX_WIDTH, availableWidth - 480),
    );
    return Math.min(responsiveMax, Math.max(WORKSPACE_PANEL_MIN_WIDTH, value));
  }, []);

  const beginWorkspacePanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = workspacePanelWidth;
    setWorkspacePanelResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      setWorkspacePanelWidth(constrainWorkspacePanelWidth(startWidth + startX - moveEvent.clientX));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWorkspacePanelResizing(false);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [constrainWorkspacePanelWidth, workspacePanelWidth]);

  const selectWorkbenchPage = (page: PageKey) => {
    setSidebarSelection("navigation");
    setActivePage(page);
    setMobileSidebarOpen(false);
    if (page !== "chat") setWorkspacePanelOpen(false);
  };
  const handleWorkbenchLogout = async () => {
    try {
      await logout();
      window.location.href = "/login";
    } catch (error: any) {
      toast.error(error?.message || "退出失败，请稍后重试");
    }
  };

  // ── adoptId 提取：/claw/:adoptId 路径模式 ──
  const [isClawRoute, clawRouteParams] = useRoute("/claw/:adoptId");
  const adoptIdFromPath = isClawRoute ? clawRouteParams?.adoptId || null : null;
  const resolvedAdoptId = adoptIdFromPath;
  const isLingxiaSubdomain = !!resolvedAdoptId;
  useEffect(() => {
    if (!resolvedAdoptId || authLoading || user) return;
    const redirect = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.href = `/login?redirect=${encodeURIComponent(redirect)}`;
  }, [resolvedAdoptId, authLoading, user]);
  useEffect(() => {
    if (authLoading) return;
    markClientLoadMetric("auth", authError ? "error" : "ok", authError ? String((authError as any)?.message || authError) : user ? "authenticated" : "anonymous");
  }, [authError, authLoading, markClientLoadMetric, user]);
  const userStorageId = user?.id != null ? String(user.id) : "";
  const [webConversationId, setWebConversationId] = useState("");
  useEffect(() => {
    if (!resolvedAdoptId || !userStorageId) {
      setWebConversationId("");
      return;
    }
    const key = webConversationStorageKey(userStorageId, resolvedAdoptId);
    try {
      const existing = localStorage.getItem(key);
      if (existing) {
        setWebConversationId(existing);
        return;
      }
      const legacyKeys = legacyWebConversationStorageKeys(userStorageId, resolvedAdoptId);
      const legacy = legacyKeys.map((legacyKey) => sessionStorage.getItem(legacyKey) || localStorage.getItem(legacyKey)).find(Boolean);
      const conversationId = legacy || makeConversationId();
      localStorage.setItem(key, conversationId);
      setWebConversationId(conversationId);
    } catch {
      setWebConversationId(makeConversationId());
    }
  }, [resolvedAdoptId, userStorageId]);
  // lgh-* 是历史归档实例，lgj-* 是 JiuwenClaw；二者都不走 OpenClaw WSS，直接走 HTTP SSE。
  const isLegacyArchivedRuntime = String(resolvedAdoptId || "").startsWith("lgh-");
  const isJiuwenRuntime = String(resolvedAdoptId || "").startsWith("lgj-");
  const isDirectHttpRuntime = isLegacyArchivedRuntime || isJiuwenRuntime;

  const { data: clawByAdoptId, isLoading: clawByAdoptLoading, error: clawByAdoptError } = trpc.claw.getByAdoptId.useQuery(
    { adoptId: resolvedAdoptId || "" },
    { enabled: !!resolvedAdoptId && !!user, retry: false }
  );
  const { data: clawSettings, isLoading: clawSettingsLoading, error: clawSettingsError, refetch: refetchClawSettings } = trpc.claw.getSettings.useQuery(
    { adoptId: resolvedAdoptId || "" },
    { enabled: !!resolvedAdoptId && !!user, retry: false }
  );
  const { data: availableModels, isLoading: availableModelsLoading, error: availableModelsError } = trpc.claw.getAvailableModels.useQuery(
    resolvedAdoptId ? { adoptId: resolvedAdoptId } : undefined,
    { enabled: !!resolvedAdoptId && !!user, retry: false, refetchInterval: 30000, refetchOnWindowFocus: true, refetchOnMount: true }
  );
  useEffect(() => {
    if (!resolvedAdoptId || !user || clawByAdoptLoading) return;
    markClientLoadMetric("agent", clawByAdoptError ? "error" : "ok", clawByAdoptError ? String((clawByAdoptError as any)?.message || clawByAdoptError) : clawByAdoptId ? String((clawByAdoptId as any)?.status || "loaded") : "missing");
  }, [clawByAdoptError, clawByAdoptId, clawByAdoptLoading, markClientLoadMetric, resolvedAdoptId, user]);
  useEffect(() => {
    if (!resolvedAdoptId || !user || clawSettingsLoading) return;
    markClientLoadMetric("settings", clawSettingsError ? "error" : "ok", clawSettingsError ? String((clawSettingsError as any)?.message || clawSettingsError) : "loaded");
  }, [clawSettingsError, clawSettingsLoading, markClientLoadMetric, resolvedAdoptId, user]);
  useEffect(() => {
    if (!resolvedAdoptId || !user || availableModelsLoading) return;
    markClientLoadMetric("models", availableModelsError ? "error" : "ok", availableModelsError ? String((availableModelsError as any)?.message || availableModelsError) : `${Array.isArray(availableModels) ? availableModels.length : 0} models`);
  }, [availableModels, availableModelsError, availableModelsLoading, markClientLoadMetric, resolvedAdoptId, user]);
  const MODEL_SELECTION_KEY = resolvedAdoptId && userStorageId ? clawModelStorageKey(userStorageId, resolvedAdoptId) : null;
  const MODEL_SELECTION_FALLBACK_KEY = resolvedAdoptId ? clawModelFallbackStorageKey(resolvedAdoptId) : null;
  const MODEL_SELECTION_LEGACY_KEY = resolvedAdoptId && userStorageId ? legacyClawModelStorageKey(userStorageId, resolvedAdoptId) : "";
  const MODEL_SELECTION_FALLBACK_LEGACY_KEY = resolvedAdoptId ? legacyClawModelFallbackStorageKey(resolvedAdoptId) : "";
  const [cachedLingxiaModelId, setCachedLingxiaModelId] = useState(() => {
    try {
      const key = MODEL_SELECTION_KEY || MODEL_SELECTION_FALLBACK_KEY;
      const legacyKeys = key === MODEL_SELECTION_KEY ? [MODEL_SELECTION_LEGACY_KEY].filter(Boolean) : [MODEL_SELECTION_FALLBACK_LEGACY_KEY].filter(Boolean);
      return key ? readLocalStorageWithLegacy(key, legacyKeys) : "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    if (!MODEL_SELECTION_KEY && !MODEL_SELECTION_FALLBACK_KEY) {
      setCachedLingxiaModelId("");
      return;
    }
    try {
      const modelId =
        (MODEL_SELECTION_KEY ? readLocalStorageWithLegacy(MODEL_SELECTION_KEY, [MODEL_SELECTION_LEGACY_KEY].filter(Boolean)) : "") ||
        (MODEL_SELECTION_FALLBACK_KEY ? readLocalStorageWithLegacy(MODEL_SELECTION_FALLBACK_KEY, [MODEL_SELECTION_FALLBACK_LEGACY_KEY].filter(Boolean)) : "") ||
        "";
      setCachedLingxiaModelId(modelId);
    } catch {
      setCachedLingxiaModelId("");
    }
  }, [MODEL_SELECTION_FALLBACK_KEY, MODEL_SELECTION_FALLBACK_LEGACY_KEY, MODEL_SELECTION_KEY, MODEL_SELECTION_LEGACY_KEY]);
  const defaultLingxiaModelId = useMemo(() => {
    if (!availableModels || availableModels.length === 0) return cachedLingxiaModelId;
    const ids = (availableModels as any[]).map((m: any) => m.id);
    const userPref = (clawSettings as any)?.model;
    if (userPref && ids.includes(userPref)) return userPref;
    const defaultModel = (availableModels as any[]).find((m: any) => m.isDefault);
    if (defaultModel?.id) return defaultModel.id;
    if (cachedLingxiaModelId && ids.includes(cachedLingxiaModelId)) return cachedLingxiaModelId;
    return ids[0] || "";
  }, [availableModels, cachedLingxiaModelId, clawSettings]);
  const effectiveLingxiaModelId = lingxiaModelId || defaultLingxiaModelId || cachedLingxiaModelId;
  const [messageFeedbackById, setMessageFeedbackById] = useState<Record<string, MessageFeedbackValue>>({});
  const [messageFeedbackPendingIds, setMessageFeedbackPendingIds] = useState<Set<string>>(new Set());
  const messageFeedbackQuery = trpc.claw.listMessageFeedback.useQuery(
    { adoptId: resolvedAdoptId || "", conversationId: webConversationId || "" },
    { enabled: !!resolvedAdoptId && !!webConversationId && !!user, retry: false },
  );
  const forgetMemoryMutation = trpc.claw.forgetMemory.useMutation({
    onSuccess: () => toast.success("已撤销这条岗位偏好"),
    onError: (error) => toast.error(error.message || "撤销失败"),
  });
  const setMessageFeedbackMutation = trpc.claw.setMessageFeedback.useMutation();
  useEffect(() => {
    const rows = Array.isArray((messageFeedbackQuery.data as any)?.rows)
      ? (messageFeedbackQuery.data as any).rows
      : [];
    const next: Record<string, MessageFeedbackValue> = {};
    for (const row of rows) {
      const messageId = String(row?.messageId || "");
      if (!messageId || (row?.rating !== "positive" && row?.rating !== "negative")) continue;
      next[messageId] = {
        rating: row.rating,
        reasonCodes: Array.isArray(row.reasonCodes) ? row.reasonCodes : [],
        comment: String(row.comment || "") || undefined,
      };
    }
    setMessageFeedbackById(next);
  }, [messageFeedbackQuery.data, resolvedAdoptId, webConversationId]);

  const updateMessageFeedback = useCallback(async (message: LxMsg, feedback: MessageFeedbackValue | null) => {
    if (!resolvedAdoptId || !webConversationId || message.role !== "assistant") return;
    const previous = messageFeedbackById[message.id];
    setMessageFeedbackById((current) => {
      const next = { ...current };
      if (feedback) next[message.id] = feedback;
      else delete next[message.id];
      return next;
    });
    setMessageFeedbackPendingIds((current) => new Set(current).add(message.id));
    try {
      const tools = (message.toolCalls || [])
        .filter((tool) => tool?.name && tool.name !== "[产出文件]")
        .slice(0, 30)
        .map((tool) => ({
          name: String(tool.name).slice(0, 128),
          status: tool.status,
          ...(typeof tool.durationMs === "number" ? { durationMs: Math.max(0, Math.round(tool.durationMs)) } : {}),
        }));
      const actualModelId = String(message.model || "").trim();
      await setMessageFeedbackMutation.mutateAsync({
        adoptId: resolvedAdoptId,
        conversationId: webConversationId,
        messageId: message.id,
        rating: feedback?.rating ?? null,
        reasonCodes: feedback?.rating === "negative" ? feedback.reasonCodes : [],
        comment: feedback?.rating === "negative" ? feedback.comment : undefined,
        selectedModelId: effectiveLingxiaModelId || undefined,
        actualModelId: actualModelId && actualModelId !== "__auto" ? actualModelId : undefined,
        skillIds: message.selectedSkillId ? [message.selectedSkillId] : [],
        tools,
        inputTokens: message.usage?.input,
        outputTokens: message.usage?.output,
      });
    } catch (error: any) {
      setMessageFeedbackById((current) => {
        const next = { ...current };
        if (previous) next[message.id] = previous;
        else delete next[message.id];
        return next;
      });
      toast.error(error?.message || "反馈提交失败");
    } finally {
      setMessageFeedbackPendingIds((current) => {
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
    }
  }, [effectiveLingxiaModelId, messageFeedbackById, resolvedAdoptId, setMessageFeedbackMutation, webConversationId]);
  // 模型兜底：优先用户在前端选过的偏好（claw-model-overrides.json），其次 isDefault，最后第一个
  // 修复刷新后下拉强制回 GLM5.1 但运行时实际跑用户上次选的 model 的前后端不一致 bug
  useEffect(() => {
    if (!availableModels || availableModels.length === 0) return;
    const ids = (availableModels as any[]).map((m: any) => m.id);
    if (!lingxiaModelId || !ids.includes(lingxiaModelId)) {
      setLingxiaModelId(defaultLingxiaModelId || ids[0]);
    }
  }, [availableModels, defaultLingxiaModelId, lingxiaModelId]);
  useEffect(() => {
    const modelId = lingxiaModelId || defaultLingxiaModelId;
    if ((!MODEL_SELECTION_KEY && !MODEL_SELECTION_FALLBACK_KEY) || !modelId) return;
    setCachedLingxiaModelId(modelId);
    try {
      if (MODEL_SELECTION_KEY) localStorage.setItem(MODEL_SELECTION_KEY, modelId);
      if (MODEL_SELECTION_FALLBACK_KEY) localStorage.setItem(MODEL_SELECTION_FALLBACK_KEY, modelId);
    } catch {}
  }, [MODEL_SELECTION_FALLBACK_KEY, MODEL_SELECTION_KEY, defaultLingxiaModelId, lingxiaModelId]);

  const switchModelMutation = trpc.claw.switchModel.useMutation({
    retry: false,
    onSuccess: (result, variables) => {
      const selectedModelId = String(result.model || variables.modelId);
      setLingxiaModelId(selectedModelId);
      setCachedLingxiaModelId(selectedModelId);
      try {
        if (MODEL_SELECTION_KEY) localStorage.setItem(MODEL_SELECTION_KEY, selectedModelId);
        if (MODEL_SELECTION_FALLBACK_KEY) localStorage.setItem(MODEL_SELECTION_FALLBACK_KEY, selectedModelId);
      } catch {}
      void refetchClawSettings();
      toast.success("模型已切换，下条消息起生效");
    },
    onError: (e) => toast.error(displayErrorMessage(e, "model")),
  });
  const updateClawSettingsMutation = trpc.claw.updateSettings.useMutation({
    retry: false,
    onSuccess: () => {
      refetchClawSettings();
      toast.success("岗位智能体设置已保存");
    },
  });

  // 流式聊天状态（替换原 tRPC mutation）
  const [lingxiaStreaming, setLingxiaStreaming] = useState(false);
  const lingxiaStreamAbortRef = useRef<AbortController | null>(null);
  // 2026-04-19 SSE race fix: 每次 send 自增 seq，handler 用闭包抓 myStreamSeq，
  // 只有 streamSeqRef.current === myStreamSeq 时才写 state；否则视为 stale 事件早退。
  const streamSeqRef = useRef(0);
  const wsClientRef = useRef<RuntimeWSClient | null>(null);
  const restoredSessionKeyRef = useRef<string>("");
  const pendingConversationRestoreRef = useRef<{ conversationId: string; messages: any[] } | null>(null);
  const suppressSessionPersistRef = useRef<string>("");
  const restoredConversationMessageCountsRef = useRef<Record<string, number>>({});
  const MSGS_KEY = resolvedAdoptId && userStorageId && webConversationId ? webMessagesStorageKey(userStorageId, resolvedAdoptId, webConversationId) : null;
  const LEGACY_MSGS_KEY_USER = resolvedAdoptId && userStorageId && webConversationId ? legacyWebMessagesStorageKeys(userStorageId, resolvedAdoptId, webConversationId)[0] : "";
  const LEGACY_MSGS_KEY_ADOPT = resolvedAdoptId && userStorageId && webConversationId ? legacyWebMessagesStorageKeys(userStorageId, resolvedAdoptId, webConversationId)[1] : "";
  const DRAFT_KEY = resolvedAdoptId && userStorageId && webConversationId ? webDraftStorageKey(userStorageId, resolvedAdoptId, webConversationId) : null;
  const LEGACY_DRAFT_KEY = resolvedAdoptId && userStorageId && webConversationId ? legacyWebDraftStorageKey(userStorageId, resolvedAdoptId, webConversationId) : "";
  const INPUT_HISTORY_KEY = resolvedAdoptId && userStorageId ? webInputHistoryStorageKey(userStorageId, resolvedAdoptId) : "";
  const LEGACY_INPUT_HISTORY_KEY = resolvedAdoptId && userStorageId ? legacyWebInputHistoryStorageKey(userStorageId, resolvedAdoptId) : "";
  const SESSION_INDEX_KEY = resolvedAdoptId && userStorageId ? webSessionIndexStorageKey(userStorageId, resolvedAdoptId) : null;
  const LEGACY_SESSION_INDEX_KEY = resolvedAdoptId && userStorageId ? legacyWebSessionIndexStorageKey(userStorageId, resolvedAdoptId) : "";
  const HIDDEN_SESSION_KEY = resolvedAdoptId && userStorageId ? webHiddenSessionsStorageKey(userStorageId, resolvedAdoptId) : null;
  const LEGACY_HIDDEN_SESSION_KEY = resolvedAdoptId && userStorageId ? legacyWebHiddenSessionsStorageKey(userStorageId, resolvedAdoptId) : "";
  const draftHydratingRef = useRef(false);
  const currentDraftKeyRef = useRef("");
  const messagesHydratingRef = useRef(false);
  const currentMessagesKeyRef = useRef("");
  useEffect(() => {
    if (!INPUT_HISTORY_KEY) return;
    readLocalStorageWithLegacy(INPUT_HISTORY_KEY, [LEGACY_INPUT_HISTORY_KEY].filter(Boolean));
  }, [INPUT_HISTORY_KEY, LEGACY_INPUT_HISTORY_KEY]);
  useEffect(() => {
    if (!MSGS_KEY) return;
    try {
      readLocalStorageWithLegacy(MSGS_KEY, [LEGACY_MSGS_KEY_USER, LEGACY_MSGS_KEY_ADOPT].filter(Boolean));
    } catch {}
  }, [MSGS_KEY, LEGACY_MSGS_KEY_ADOPT, LEGACY_MSGS_KEY_USER]);

  useEffect(() => {
    draftHydratingRef.current = true;
    currentDraftKeyRef.current = DRAFT_KEY || "";
    if (!DRAFT_KEY) {
      setLingxiaInput("");
      return;
    }
    try {
      setLingxiaInput(readLocalStorageWithLegacy(DRAFT_KEY, [LEGACY_DRAFT_KEY].filter(Boolean)));
    } catch {
      setLingxiaInput("");
    }
  }, [DRAFT_KEY, LEGACY_DRAFT_KEY]);

  useEffect(() => {
    if (!DRAFT_KEY || currentDraftKeyRef.current !== DRAFT_KEY) return;
    if (draftHydratingRef.current) {
      draftHydratingRef.current = false;
      return;
    }
    try {
      const value = String(lingxiaInput || "");
      if (value.trim()) localStorage.setItem(DRAFT_KEY, value);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {}
  }, [DRAFT_KEY, lingxiaInput]);

  const clearLingxiaDraft = useCallback(() => {
    if (!DRAFT_KEY) return;
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
  }, [DRAFT_KEY]);

  const activeLingxiaMsgs = lingxiaMsgs;
  const activeLingxiaStreaming = lingxiaStreaming;
  const activeAgentTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const msg of activeLingxiaMsgs as LxMsg[]) {
      for (const id of extractAgentTaskIds(msg?.text)) {
        ids.add(id);
      }
    }
    return ids;
  }, [activeLingxiaMsgs]);
  const activeAgentTaskIdKey = useMemo(() => Array.from(activeAgentTaskIds).sort().join(","), [activeAgentTaskIds]);
  const agentTasksById = useMemo(() => {
    const byId = new Map<string, AgentTask>();
    for (const task of agentTasks) {
      const id = String(task.id || "");
      if (id) byId.set(id, task);
    }
    return byId;
  }, [agentTasks]);
  const hasActiveAgentTask = useMemo(
    () => agentTasks.some((task) => {
      const status = String(task.status || "");
      return status === "pending" || status === "running";
    }),
    [agentTasks],
  );
  const refreshAgentTasks = useCallback(async (options?: { silent?: boolean }) => {
    if (!resolvedAdoptId || !clawByAdoptId) {
      setAgentTasks([]);
      return;
    }
    if (!activeAgentTaskIdKey) {
      setAgentTasks([]);
      return;
    }
    try {
      const response = await fetch(`/api/claw/agent-tasks?adoptId=${encodeURIComponent(resolvedAdoptId)}&ids=${encodeURIComponent(activeAgentTaskIdKey)}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const rows = Array.isArray(data?.tasks) ? data.tasks : [];
      const tasks = rows
        .filter((task: AgentTask) => {
          return activeAgentTaskIds.has(String(task.id || ""));
        })
        .slice(0, 64);
      setAgentTasks(tasks);
    } catch (error) {
      if (!options?.silent) {
        console.warn("[agent-tasks] refresh failed", error);
      }
    }
  }, [activeAgentTaskIdKey, activeAgentTaskIds, clawByAdoptId, resolvedAdoptId]);

  useEffect(() => {
    setAgentTasks([]);
  }, [resolvedAdoptId, webConversationId]);

  useEffect(() => {
    if (!activeAgentTaskIdKey) return;
    void refreshAgentTasks({ silent: true });
  }, [activeAgentTaskIdKey, refreshAgentTasks]);

  useEffect(() => {
    if (activePage !== "chat" || !resolvedAdoptId || !clawByAdoptId) return;
    if (!activeAgentTaskIdKey) return;
    if (!activeLingxiaStreaming && !hasActiveAgentTask) return;
    const intervalMs = document.hidden ? 12_000 : 3_000;
    const timer = window.setInterval(() => {
      void refreshAgentTasks({ silent: true });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [activeAgentTaskIdKey, activeLingxiaStreaming, activePage, clawByAdoptId, hasActiveAgentTask, refreshAgentTasks, resolvedAdoptId]);
  const activeLingxiaMsgsRef = useRef<LxMsg[]>([]);
  const webConversationIdRef = useRef("");
  useEffect(() => { activeLingxiaMsgsRef.current = activeLingxiaMsgs as LxMsg[]; }, [activeLingxiaMsgs]);
  useEffect(() => { webConversationIdRef.current = webConversationId; }, [webConversationId]);
  const [webSessions, setWebSessions] = useState<WebChatSessionRecord[]>([]);
  const [webSessionsLoading, setWebSessionsLoading] = useState(false);
  const webSessionsRef = useRef<WebChatSessionRecord[]>([]);
  const backendSessionsRequestSeqRef = useRef(0);
  const autoSessionTitleRequestRef = useRef<Record<string, string>>({});
  const restoreConversationRequestSeqRef = useRef(0);
  const lastBackendHistoryRefreshRef = useRef("");
  const [cachedClawStatus, setCachedClawStatus] = useState<string | null>(null);
  const [clawHealthSummary, setClawHealthSummary] = useState<ClawHealthSummary | null>(null);
  const [clawHealthLoading, setClawHealthLoading] = useState(false);
  const [clawHealthError, setClawHealthError] = useState("");
  const [showSlowReadinessHint, setShowSlowReadinessHint] = useState(false);
  const CLAW_STATUS_KEY = resolvedAdoptId && userStorageId ? clawStatusStorageKey(userStorageId, resolvedAdoptId) : null;

  useEffect(() => {
    webSessionsRef.current = webSessions;
  }, [webSessions]);

  useEffect(() => {
    if (!SESSION_INDEX_KEY) {
      setWebSessions([]);
      return;
    }
    if (isJiuwenRuntime) {
      setWebSessions([]);
      return;
    }
    setWebSessions(visibleWebSessionIndex(
      SESSION_INDEX_KEY,
      HIDDEN_SESSION_KEY,
      [LEGACY_SESSION_INDEX_KEY].filter(Boolean),
      [LEGACY_HIDDEN_SESSION_KEY].filter(Boolean),
    ));
  }, [SESSION_INDEX_KEY, HIDDEN_SESSION_KEY, LEGACY_SESSION_INDEX_KEY, LEGACY_HIDDEN_SESSION_KEY, isJiuwenRuntime]);

  useEffect(() => {
    if (!CLAW_STATUS_KEY) {
      setCachedClawStatus(null);
      return;
    }
    try {
      const legacyKey = resolvedAdoptId && userStorageId ? legacyClawStatusStorageKey(userStorageId, resolvedAdoptId) : "";
      setCachedClawStatus(readLocalStorageWithLegacy(CLAW_STATUS_KEY, [legacyKey].filter(Boolean)));
    } catch {
      setCachedClawStatus(null);
    }
  }, [CLAW_STATUS_KEY, resolvedAdoptId, userStorageId]);

  useEffect(() => {
    const status = String((clawByAdoptId as any)?.status || "");
    if (!CLAW_STATUS_KEY || !status) return;
    setCachedClawStatus(status);
    try {
      localStorage.setItem(CLAW_STATUS_KEY, status);
    } catch {}
  }, [CLAW_STATUS_KEY, clawByAdoptId]);

  const refreshClawHealthSummary = useCallback(async (silent = true) => {
    if (!resolvedAdoptId || !user || isDirectHttpRuntime) {
      setClawHealthSummary(null);
      setClawHealthError("");
      return;
    }
    if (silent && activeLingxiaStreaming) {
      markClientLoadMetric("health", "skip", "聊天处理中，暂停后台健康检查");
      return;
    }
    const apiBase = import.meta.env.VITE_API_URL || "";
    const requestStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!silent) setClawHealthLoading(true);
    try {
      const response = await fetchWithTimeout(`${apiBase}/api/claw/health-summary?adoptId=${encodeURIComponent(resolvedAdoptId)}`, {
        credentials: "include",
        cache: "no-store",
      }, 5000);
      if (!response.ok) throw new Error(`健康检查失败 (${response.status})`);
      const data = await response.json().catch(() => null);
      setClawHealthSummary(data || null);
      setClawHealthError("");
      markClientLoadMetric("health", "ok", data?.readiness?.status || "ready", requestStartedAt);
    } catch (error: any) {
      const classified = classifyDisplayError(error, "runtime");
      setClawHealthError(classified.detail || classified.title);
      markClientLoadMetric("health", "error", classified.title, requestStartedAt);
    } finally {
      if (!silent) setClawHealthLoading(false);
    }
  }, [activeLingxiaStreaming, isDirectHttpRuntime, markClientLoadMetric, resolvedAdoptId, user]);

  useEffect(() => {
    if (!resolvedAdoptId || !user || isDirectHttpRuntime) return;
    let cancelled = false;
    const run = async (silent = true) => {
      if (cancelled) return;
      await refreshClawHealthSummary(silent);
    };
    void run(false);
    const interval = window.setInterval(() => void run(true), 30000);
    const onFocus = () => void run(true);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [isDirectHttpRuntime, refreshClawHealthSummary, resolvedAdoptId, user]);

  useEffect(() => {
    const pending = Boolean(resolvedAdoptId && !isDirectHttpRuntime && ((clawByAdoptLoading && !clawByAdoptId) || clawHealthLoading));
    if (!pending) {
      setShowSlowReadinessHint(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSlowReadinessHint(true), 1500);
    return () => window.clearTimeout(timer);
  }, [clawByAdoptId, clawByAdoptLoading, clawHealthLoading, isDirectHttpRuntime, resolvedAdoptId]);

  const refreshBackendWebSessions = useCallback(async (silent = false) => {
    if (!resolvedAdoptId || !SESSION_INDEX_KEY || isLegacyArchivedRuntime) return [];
    if (silent && activeLingxiaStreaming) {
      markClientLoadMetric("sessions", "skip", "聊天处理中，暂停后台历史同步");
      return webSessionsRef.current;
    }
    const apiBase = import.meta.env.VITE_API_URL || "";
    const requestStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const historyLimit = silent ? 100 : 60;
    const requestSeq = backendSessionsRequestSeqRef.current + 1;
    backendSessionsRequestSeqRef.current = requestSeq;
    const shouldShowLoading = !silent && webSessionsRef.current.length === 0;
    if (shouldShowLoading) setWebSessionsLoading(true);
    const isCurrentRequest = () => backendSessionsRequestSeqRef.current === requestSeq;
    try {
      const response = await fetchWithTimeout(`${apiBase}/api/ea/session-view/chat?adoptId=${encodeURIComponent(resolvedAdoptId)}&limit=${historyLimit}`, {
        credentials: "include",
      }, silent ? 8000 : 6000);
      if (!response.ok) {
        markClientLoadMetric("sessions", "error", classifyDisplayError(new Error(`HTTP ${response.status}`), "history").title, requestStartedAt);
        return webSessionsRef.current;
      }
      const data = await response.json().catch(() => null);
      const remoteRows = Array.isArray(data?.sessions) ? data.sessions : data?.rawSessions;
      if (!remoteRows) {
        markClientLoadMetric("sessions", "error", "empty response", requestStartedAt);
        return webSessionsRef.current;
      }
      if (!isCurrentRequest()) return webSessionsRef.current;
      const hidden = HIDDEN_SESSION_KEY ? readHiddenWebSessions(HIDDEN_SESSION_KEY, [LEGACY_HIDDEN_SESSION_KEY].filter(Boolean)) : new Set<string>();
      const remote = (Array.isArray(remoteRows) ? remoteRows : [])
        .map((item: any) => normalizeSessionViewRecord(item) || item)
        .filter(Boolean) as WebChatSessionRecord[];
      const backendSessions = remote
        .filter((item) => (
          item?.conversationId &&
          item.sessionKey &&
          (isJiuwenRuntime || !hidden.has(item.conversationId)) &&
          Number(item.messageCount || 0) > 0
        ))
        .sort((a, b) => Number(b.sortUpdatedAt || b.sourceUpdatedAt || b.updatedAt || 0) - Number(a.sortUpdatedAt || a.sourceUpdatedAt || a.updatedAt || 0))
        .slice(0, 30);
      if (isJiuwenRuntime) {
        const uiSource = [...readWebSessionIndex(SESSION_INDEX_KEY, [LEGACY_SESSION_INDEX_KEY].filter(Boolean)), ...webSessionsRef.current];
        const uiByConversation = new Map<string, WebChatSessionRecord>();
        for (const item of uiSource) {
          if (!item?.conversationId) continue;
          const previous = uiByConversation.get(item.conversationId);
          uiByConversation.set(item.conversationId, {
            ...previous,
            customTitle: item.customTitle || previous?.customTitle,
            autoTitle: Boolean(item.autoTitle || previous?.autoTitle),
            title: item.autoTitle ? item.title : previous?.title,
            pinnedAt: item.pinnedAt || previous?.pinnedAt,
          } as WebChatSessionRecord);
        }
        const decoratedBackend = backendSessions.map((item) => {
          const ui = uiByConversation.get(item.conversationId);
          return {
            ...item,
            customTitle: ui?.customTitle,
            title: ui?.autoTitle && ui.title ? ui.title : item.title,
            autoTitle: ui?.autoTitle,
            pinnedAt: ui?.pinnedAt,
            updatedAt: Number(item.sourceUpdatedAt || item.updatedAt || 0) || item.updatedAt,
            sortUpdatedAt: Number(item.sourceUpdatedAt || item.sortUpdatedAt || item.updatedAt || 0) || item.updatedAt,
          };
        });
        const backendConversationIds = new Set(decoratedBackend.map((item) => item.conversationId).filter(Boolean));
        const currentLocalSession = uiSource.find((item) =>
          item?.conversationId &&
          item.conversationId === webConversationIdRef.current &&
          !hidden.has(item.conversationId) &&
          !backendConversationIds.has(item.conversationId)
        );
        const nextSessions = sortWebSessionRecords([
          ...(currentLocalSession ? [currentLocalSession] : []),
          ...decoratedBackend,
        ]).slice(0, 30);
        setWebSessions(nextSessions);
        writeWebSessionIndex(SESSION_INDEX_KEY, nextSessions);
        markClientLoadMetric("sessions", "ok", `${backendSessions.length} jiuwen backend sessions`, requestStartedAt);
        return nextSessions;
      }
      const backendConversationIds = new Set(backendSessions.map((item) => item.conversationId).filter(Boolean));
      let mergedSessions: WebChatSessionRecord[] = [];
      setWebSessions((previous) => {
        const localSource = [...readWebSessionIndex(SESSION_INDEX_KEY, [LEGACY_SESSION_INDEX_KEY].filter(Boolean)), ...previous].filter((item) => {
          if (!item?.conversationId || hidden.has(item.conversationId)) return false;
          if (!item.sessionKey) return true;
          if (item.conversationId === webConversationIdRef.current) return true;
          return backendConversationIds.has(item.conversationId);
        });
        mergedSessions = mergeWebSessionRecords(localSource, backendSessions, hidden);
        writeWebSessionIndex(SESSION_INDEX_KEY, mergedSessions);
        return mergedSessions;
      });
      markClientLoadMetric("sessions", "ok", `${backendSessions.length} backend sessions`, requestStartedAt);
      return mergedSessions;
    } catch (error) {
      console.warn("[history] backend sync failed; keeping local session cache", error);
      markClientLoadMetric("sessions", "error", classifyDisplayError(error, "history").title, requestStartedAt);
      return webSessionsRef.current;
    } finally {
      if (shouldShowLoading && isCurrentRequest()) setWebSessionsLoading(false);
    }
  }, [activeLingxiaStreaming, resolvedAdoptId, SESSION_INDEX_KEY, HIDDEN_SESSION_KEY, isLegacyArchivedRuntime, isJiuwenRuntime, markClientLoadMetric]);

  useEffect(() => {
    if (!resolvedAdoptId || !SESSION_INDEX_KEY || isLegacyArchivedRuntime) return;
    let cancelled = false;
    let timer: number | undefined;
    refreshBackendWebSessions(false)
      .then(() => {
        if (cancelled) return;
        timer = window.setTimeout(() => {
          void refreshBackendWebSessions(true).catch(() => {});
        }, 2500);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [resolvedAdoptId, SESSION_INDEX_KEY, HIDDEN_SESSION_KEY, isLegacyArchivedRuntime, refreshBackendWebSessions]);

  useEffect(() => {
    if (!resolvedAdoptId || !SESSION_INDEX_KEY || isLegacyArchivedRuntime) return;
    const onFocus = () => void refreshBackendWebSessions(true).catch(() => {});
    const timer = window.setInterval(() => {
      void refreshBackendWebSessions(true).catch(() => {});
    }, 30000);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [isLegacyArchivedRuntime, refreshBackendWebSessions, resolvedAdoptId, SESSION_INDEX_KEY]);

  useEffect(() => {
    if (!SESSION_INDEX_KEY) return;
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (event.key !== SESSION_INDEX_KEY && event.key !== HIDDEN_SESSION_KEY) return;
      if (isJiuwenRuntime) {
        void refreshBackendWebSessions(true).catch(() => {});
        return;
      }
      setWebSessions(visibleWebSessionIndex(SESSION_INDEX_KEY, HIDDEN_SESSION_KEY, [LEGACY_SESSION_INDEX_KEY].filter(Boolean), [LEGACY_HIDDEN_SESSION_KEY].filter(Boolean)));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [SESSION_INDEX_KEY, HIDDEN_SESSION_KEY, isJiuwenRuntime, refreshBackendWebSessions]);

  useEffect(() => {
    if (isLegacyArchivedRuntime || activeLingxiaStreaming || !webConversationId || activeLingxiaMsgs.length === 0) return;
    const meaningfulMessages = activeLingxiaMsgs.filter((m: any) => normalizeSessionText(m.text || ""));
    if (meaningfulMessages.length === 0) return;
    const refreshKey = `${webConversationId}:${meaningfulMessages.length}`;
    if (lastBackendHistoryRefreshRef.current === refreshKey) return;
    lastBackendHistoryRefreshRef.current = refreshKey;
    const timer = window.setTimeout(() => {
      void refreshBackendWebSessions().catch(() => {});
    }, 800);
    return () => window.clearTimeout(timer);
  }, [activeLingxiaMsgs, activeLingxiaStreaming, isLegacyArchivedRuntime, refreshBackendWebSessions, webConversationId]);

  useEffect(() => {
    if (!isDirectHttpRuntime) return;
    if (!SESSION_INDEX_KEY || !webConversationId || activeLingxiaMsgs.length === 0) return;
    if (suppressSessionPersistRef.current === webConversationId) return;
    const meaningfulMessages = activeLingxiaMsgs.filter((m: any) => normalizeSessionText(m.text || ""));
    if (meaningfulMessages.length === 0) return;
    const now = Date.now();
    const title = inferSessionTitle(activeLingxiaMsgs as any);
    const preview = inferSessionPreview(activeLingxiaMsgs as any);
    const existing = readWebSessionIndex(SESSION_INDEX_KEY, [LEGACY_SESSION_INDEX_KEY].filter(Boolean));
    const previous = existing.find((item) => item.conversationId === webConversationId);
    const shouldPreserveTitle = Boolean(previous?.sessionKey || previous?.customTitle || previous?.autoTitle);
    const nextTitle = shouldPreserveTitle && previous?.title ? previous.title : title;
    const nextPreview = previous?.sessionKey && previous.preview ? previous.preview : preview;
    const restoredBaselineCount = Number(restoredConversationMessageCountsRef.current[webConversationId] || 0) || 0;
    const isRestoredBaseline = Boolean(previous && restoredBaselineCount > 0 && meaningfulMessages.length <= restoredBaselineCount);
    const unchangedExisting =
      previous &&
      Number(previous.messageCount || 0) === meaningfulMessages.length &&
      normalizeSessionText(previous.title || "") === normalizeSessionText(nextTitle || "") &&
      normalizeSessionText(previous.preview || "") === normalizeSessionText(nextPreview || "");
    const nextRecord: WebChatSessionRecord = {
      conversationId: webConversationId,
      sessionKey: previous?.sessionKey,
      sessionId: previous?.sessionId,
      title: nextTitle,
      customTitle: previous?.customTitle,
      autoTitle: previous?.autoTitle,
      preview: nextPreview,
      messageCount: meaningfulMessages.length,
      createdAt: previous?.createdAt || now,
      updatedAt: (unchangedExisting || isRestoredBaseline) ? (previous?.updatedAt || now) : now,
      pinnedAt: previous?.pinnedAt,
    };
    if (restoredBaselineCount > 0 && meaningfulMessages.length > restoredBaselineCount) {
      delete restoredConversationMessageCountsRef.current[webConversationId];
    }
    const next = [
      nextRecord,
      ...existing.filter((item) => item.conversationId !== webConversationId),
    ];
    const sorted = sortWebSessionRecords(next).slice(0, 100);
    writeWebSessionIndex(SESSION_INDEX_KEY, sorted);
    setWebSessions(sorted);
  }, [SESSION_INDEX_KEY, webConversationId, activeLingxiaMsgs, isDirectHttpRuntime]);

  useEffect(() => {
    if (!webConversationId || suppressSessionPersistRef.current !== webConversationId) return;
    if (activeLingxiaMsgs.length === 0) suppressSessionPersistRef.current = "";
  }, [activeLingxiaMsgs.length, webConversationId]);

  const updateWebSessionMeta = useCallback((conversationId: string, patch: Partial<WebChatSessionRecord>) => {
    if (!SESSION_INDEX_KEY) return;
    let nextSessions: WebChatSessionRecord[] = [];
    setWebSessions((previous) => {
      const source = previous.length > 0 ? previous : readWebSessionIndex(SESSION_INDEX_KEY, [LEGACY_SESSION_INDEX_KEY].filter(Boolean));
      nextSessions = sortWebSessionRecords(source.map((item) =>
        item.conversationId === conversationId ? { ...item, ...patch } : item
      ));
      writeWebSessionIndex(SESSION_INDEX_KEY, nextSessions);
      return nextSessions;
    });
  }, [SESSION_INDEX_KEY]);

  useEffect(() => {
    if (!isDirectHttpRuntime || activeLingxiaStreaming) return;
    if (!SESSION_INDEX_KEY || !webConversationId) return;
    const meaningfulMessages = (activeLingxiaMsgs as any[])
      .map((message) => ({
        role: String(message?.role || ""),
        text: normalizeSessionText(String(message?.text || "")),
      }))
      .filter((message) => message.text);
    const hasUser = meaningfulMessages.some((message) => message.role === "user");
    const hasAssistant = meaningfulMessages.some((message) => message.role === "assistant");
    if (!hasUser || !hasAssistant) return;

    const existing = readWebSessionIndex(SESSION_INDEX_KEY, [LEGACY_SESSION_INDEX_KEY].filter(Boolean)).find((item) => item.conversationId === webConversationId);
    if (!existing || existing.customTitle || existing.autoTitle) return;

    const inferredTitle = inferSessionTitle(activeLingxiaMsgs as any);
    if (normalizeSessionText(existing.title || "") !== normalizeSessionText(inferredTitle)) return;

    const requestKey = `${webConversationId}:${meaningfulMessages.length}`;
    if (autoSessionTitleRequestRef.current[webConversationId] === requestKey) return;
    autoSessionTitleRequestRef.current[webConversationId] = requestKey;

    const timer = window.setTimeout(async () => {
      try {
        const apiBase = import.meta.env.VITE_API_URL || "";
        const response = await fetchWithTimeout(`${apiBase}/api/ea/assistant/session-title`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            messages: meaningfulMessages.slice(0, 8),
          }),
        }, 12000);
        if (!response.ok) return;
        const data = await response.json().catch(() => null);
        const title = normalizeSessionText(String(data?.title || "")).slice(0, 60);
        if (!title || title === normalizeSessionText(inferredTitle)) return;
        const latest = readWebSessionIndex(SESSION_INDEX_KEY, [LEGACY_SESSION_INDEX_KEY].filter(Boolean)).find((item) => item.conversationId === webConversationId);
        if (!latest || latest.customTitle || latest.autoTitle) return;
        if (normalizeSessionText(latest.title || "") !== normalizeSessionText(inferredTitle)) return;
        updateWebSessionMeta(webConversationId, { title, autoTitle: true });
      } catch (error) {
        console.warn("[history] auto title failed; keeping inferred title", error);
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [SESSION_INDEX_KEY, activeLingxiaMsgs, activeLingxiaStreaming, isDirectHttpRuntime, updateWebSessionMeta, webConversationId]);

  const ensureEmptyWebSession = useCallback((conversationId: string) => {
    if (!SESSION_INDEX_KEY || !conversationId) return;
    const now = Date.now();
    let nextSessions: WebChatSessionRecord[] = [];
    setWebSessions((previous) => {
      const source = previous.length > 0 ? previous : readWebSessionIndex(SESSION_INDEX_KEY, [LEGACY_SESSION_INDEX_KEY].filter(Boolean));
      const existing = source.find((item) => item.conversationId === conversationId);
      const placeholder: WebChatSessionRecord = {
        conversationId,
        sessionKey: existing?.sessionKey,
        sessionId: existing?.sessionId,
        title: "新对话",
        customTitle: existing?.customTitle,
        autoTitle: existing?.autoTitle,
        preview: "",
        messageCount: 0,
        createdAt: existing?.createdAt || now,
        updatedAt: existing?.updatedAt || now,
        pinnedAt: existing?.pinnedAt,
      };
      nextSessions = sortWebSessionRecords([
        placeholder,
        ...source.filter((item) => item.conversationId !== conversationId),
      ]).slice(0, 100);
      writeWebSessionIndex(SESSION_INDEX_KEY, nextSessions);
      return nextSessions;
    });
  }, [SESSION_INDEX_KEY]);

  const renameLingxiaConversation = useCallback((conversationId: string, title: string) => {
    const customTitle = normalizeSessionText(title).slice(0, 60);
    if (!customTitle) return;
    updateWebSessionMeta(conversationId, { customTitle });
    toast.success("会话已重命名");
  }, [updateWebSessionMeta]);

  const togglePinLingxiaConversation = useCallback((conversationId: string, pinned: boolean) => {
    updateWebSessionMeta(conversationId, { pinnedAt: pinned ? Date.now() : 0 });
    toast.success(pinned ? "会话已置顶" : "已取消置顶");
  }, [updateWebSessionMeta]);

  const mergeCurrentToolCallsIntoHistory = (messages: LxMsg[]) => {
    const current = activeLingxiaMsgsRef.current || [];
    if (!current.length || !messages.length) return messages;

    const currentAssistantWithTools = current
      .filter((msg) => msg.role === "assistant" && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0)
      .reverse();
    if (currentAssistantWithTools.length === 0) return messages;

    const usedCurrentIds = new Set<string>();
    const next = [...messages];
    for (let i = next.length - 1; i >= 0; i -= 1) {
      const msg = next[i];
      if (msg.role !== "assistant" || (msg.toolCalls || []).length > 0) continue;
      const msgText = normalizeSessionText(extractJiuwenPermissionMarker(msg.text || "").text);
      const currentMatch = currentAssistantWithTools.find((candidate) => {
        if (usedCurrentIds.has(candidate.id)) return false;
        const candidateText = normalizeSessionText(extractJiuwenPermissionMarker(candidate.text || "").text);
        return Boolean(candidateText && msgText && candidateText === msgText);
      });
      if (!currentMatch?.toolCalls?.length) continue;
      usedCurrentIds.add(currentMatch.id);
      next[i] = {
        ...msg,
        toolCalls: currentMatch.toolCalls,
      };
    }
    return next;
  };

  const restoreLingxiaMessages = (messages: any[], opts?: { preserveCurrentToolCalls?: boolean }) => {
    const nextMessages = backfillLxMsgIds(messages || []);
    const hydratedMessages = opts?.preserveCurrentToolCalls
      ? mergeCurrentToolCallsIntoHistory(nextMessages)
      : nextMessages;
    setLingxiaToolCalls([]);
    setLingxiaMsgs(hydratedMessages);
  };

  const activateWebConversation = (conversationId: string, restoredMessages?: any[]) => {
    if (!resolvedAdoptId || !userStorageId) return;
    const nextMessages = restoredMessages ? restoredMessages.slice(-100) : [];
    const hasRestoredMessages = Array.isArray(restoredMessages);
    restoreConversationRequestSeqRef.current += 1;
    restoredSessionKeyRef.current = hasRestoredMessages ? restoredSessionKeyRef.current : "";
    if (hasRestoredMessages) {
      const restoredCount = nextMessages.filter((m: any) => normalizeSessionText(m?.text || "")).length;
      restoredConversationMessageCountsRef.current[conversationId] = restoredCount;
    } else {
      suppressSessionPersistRef.current = conversationId;
      delete restoredConversationMessageCountsRef.current[conversationId];
    }
    try {
      localStorage.setItem(webConversationStorageKey(userStorageId, resolvedAdoptId), conversationId);
      if (hasRestoredMessages) {
        localStorage.setItem(webMessagesStorageKey(userStorageId, resolvedAdoptId, conversationId), JSON.stringify(nextMessages));
      } else {
        removeLocalStorageKeys([
          webMessagesStorageKey(userStorageId, resolvedAdoptId, conversationId),
          ...legacyWebMessagesStorageKeys(userStorageId, resolvedAdoptId, conversationId),
        ]);
      }
    } catch {}
    if (conversationId === webConversationId) {
      pendingConversationRestoreRef.current = null;
      restoreLingxiaMessages(nextMessages);
      if (nextMessages.length === 0) suppressSessionPersistRef.current = "";
    } else {
      pendingConversationRestoreRef.current = { conversationId, messages: nextMessages };
    }
    setWebConversationId(conversationId);
    setLingxiaInput("");
    setMentionedUsers([]);
    updateLingxiaNearBottom(true);
  };

  const readCachedWebConversationMessages = useCallback((conversationId: string): any[] => {
    if (!resolvedAdoptId || !userStorageId || !conversationId) return [];
    try {
      const primaryKey = webMessagesStorageKey(userStorageId, resolvedAdoptId, conversationId);
      const raw = readLocalStorageWithLegacy(primaryKey, legacyWebMessagesStorageKeys(userStorageId, resolvedAdoptId, conversationId));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [resolvedAdoptId, userStorageId]);

  const findCachedConversationSnippet = useCallback((conversationId: string, query: string): string => {
    const q = normalizeSessionSearchText(query);
    const compactQ = compactSessionSearchText(query);
    if (!q) return "";
    const messages = readCachedWebConversationMessages(conversationId);
    for (const message of messages) {
      const text = normalizeSessionText(String(message?.text || ""));
      if (!text) continue;
      const normalizedText = normalizeSessionSearchText(text);
      const idx = normalizedText.indexOf(q);
      if (idx < 0 && (!compactQ || !compactSessionSearchText(text).includes(compactQ))) continue;
      if (idx < 0) return text.length > 72 ? `${text.slice(0, 72)}...` : text;
      const start = Math.max(0, idx - 18);
      const end = Math.min(text.length, idx + q.length + 32);
      const prefix = start > 0 ? "..." : "";
      const suffix = end < text.length ? "..." : "";
      return `${prefix}${text.slice(start, end)}${suffix}`;
    }
    return "";
  }, [readCachedWebConversationMessages]);

  const applyCanonicalConversationText = useCallback((args: {
    conversationId: string;
    assistantMessageId: string;
    streamSeq: number;
    messages: any[];
  }) => {
    if (streamSeqRef.current !== args.streamSeq) return false;
    if (webConversationIdRef.current !== args.conversationId) return false;
    const canonical = backfillLxMsgIds(args.messages || []);
    const canonicalLastAssistant = [...canonical].reverse().find((msg) => (
      msg.role === "assistant" &&
      (normalizeSessionText(msg.text || "") || (msg.toolCalls || []).length > 0)
    ));
    if (!canonicalLastAssistant) return false;

    const merge = (current: LxMsg[]) => {
      const idx = current.findIndex((msg) => msg.id === args.assistantMessageId && msg.role === "assistant");
      if (idx < 0 || idx !== current.length - 1) return current;
      const currentMessage = current[idx];
      if (hasPendingJiuwenPermissionMessage(currentMessage)) return current;
      const canonicalText = String(canonicalLastAssistant.text || "");
      const currentText = String(currentMessage.text || "");
      const shouldMergeText =
        Boolean(canonicalText) &&
        canonicalText !== currentText &&
        normalizeSessionText(canonicalText).length >= normalizeSessionText(currentText).length;
      const canonicalToolCalls = canonicalLastAssistant.toolCalls || [];
      const currentToolCalls = currentMessage.toolCalls || [];
      const shouldMergeToolCalls =
        canonicalToolCalls.length > 0 &&
        canonicalToolCalls.length >= currentToolCalls.length &&
        toolCallsSignature(canonicalToolCalls) !== toolCallsSignature(currentToolCalls);
      if (!shouldMergeText && !shouldMergeToolCalls) return current;
      const next = [...current];
      next[idx] = {
        ...currentMessage,
        text: shouldMergeText ? canonicalText : currentText,
        toolCalls: shouldMergeToolCalls ? canonicalToolCalls : currentMessage.toolCalls,
        status: undefined,
        recovering: false,
        recovered: false,
        recoveryFailed: false,
      };
      return next;
    };

    let changed = false;
    setLingxiaMsgs((current) => {
      const next = merge(current);
      changed = next !== current;
      return next;
    });
    return changed;
  }, []);

  const reconcileStreamedConversation = useCallback(async (args: {
    conversationId: string;
    assistantMessageId: string;
    streamSeq: number;
    sessionKey?: string;
  }) => {
    if (!resolvedAdoptId || (isDirectHttpRuntime && !args.sessionKey)) return;
    const delays = [600, 1800, 4000, 8000];
    const apiBase = import.meta.env.VITE_API_URL || "";
    for (const delayMs of delays) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      if (streamSeqRef.current !== args.streamSeq || webConversationIdRef.current !== args.conversationId) return;
      let sessionKey = String(args.sessionKey || "");
      if (!sessionKey) {
        try {
          const sessions = await refreshBackendWebSessions(true);
          sessionKey = String(sessions.find((item) => item.conversationId === args.conversationId)?.sessionKey || "");
        } catch {}
      }
      if (!sessionKey) continue;

      try {
        const response = await fetchWithTimeout(`${apiBase}/api/claw/chat-history/messages?adoptId=${encodeURIComponent(resolvedAdoptId)}&sessionKey=${encodeURIComponent(sessionKey)}`, {
          credentials: "include",
        }, 4000);
        if (!response.ok) continue;
        const payload = await response.json().catch(() => null);
        if (!Array.isArray(payload?.messages)) continue;
        const changed = applyCanonicalConversationText({
          ...args,
          messages: payload.messages,
        });
        if (changed) {
          console.log("[reconcile] canonical conversation text applied", {
            conversationId: args.conversationId,
            sessionKey,
            messageCount: payload.messages.length,
          });
        }
        return;
      } catch {
        // 对账是后台补偿，失败不影响主聊天。
      }
    }
  }, [applyCanonicalConversationText, isDirectHttpRuntime, refreshBackendWebSessions, resolvedAdoptId]);

  useEffect(() => {
    const pending = pendingConversationRestoreRef.current;
    if (!pending || pending.conversationId !== webConversationId) return;
    pendingConversationRestoreRef.current = null;
    restoreLingxiaMessages(pending.messages);
  }, [webConversationId]);

  useEffect(() => {
    if (!resolvedAdoptId || !webConversationId || activeLingxiaStreaming) return;
    const session = webSessions.find((item) => item.conversationId === webConversationId);
    if (!session?.sessionKey || restoredSessionKeyRef.current === session.sessionKey) return;
    const sessionKey = session.sessionKey;
    const apiBase = import.meta.env.VITE_API_URL || "";
    let cancelled = false;
    const requestSeq = restoreConversationRequestSeqRef.current + 1;
    restoreConversationRequestSeqRef.current = requestSeq;
    fetchWithTimeout(`${apiBase}/api/claw/chat-history/messages?adoptId=${encodeURIComponent(resolvedAdoptId)}&sessionKey=${encodeURIComponent(sessionKey)}`, {
      credentials: "include",
    }, 4000)
      .then((r) => r.ok ? r.json() : null)
      .then((payload) => {
        if (cancelled || restoreConversationRequestSeqRef.current !== requestSeq || !Array.isArray(payload?.messages)) return;
        const currentLast = activeLingxiaMsgsRef.current?.[activeLingxiaMsgsRef.current.length - 1];
        if (hasPendingJiuwenPermissionMessage(currentLast)) return;
        restoredSessionKeyRef.current = sessionKey;
        activateWebConversation(webConversationId, payload.messages);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeLingxiaStreaming, resolvedAdoptId, webConversationId, webSessions]);

  useEffect(() => {
    if (!resolvedAdoptId || !isJiuwenRuntime || !webConversationId || activeLingxiaStreaming) return;
    const session = webSessions.find((item) => item.conversationId === webConversationId);
    if (!session?.sessionKey) return;
    const sessionKey = session.sessionKey;
    const apiBase = import.meta.env.VITE_API_URL || "";
    let cancelled = false;

    const shouldApplyHistory = (historyMessages: any[]) => {
      const next = backfillLxMsgIds(historyMessages || []).slice(-100);
      const current = activeLingxiaMsgsRef.current || [];
      const nextTextCount = next.filter((m: any) => normalizeSessionText(m?.text || "")).length;
      const currentTextCount = current.filter((m: any) => normalizeSessionText(m?.text || "")).length;
      const nextLastText = normalizeSessionText(next[next.length - 1]?.text || "");
      const currentLastText = normalizeSessionText(current[current.length - 1]?.text || "");
      const currentLast = current[current.length - 1];
      if (hasPendingJiuwenPermissionMessage(currentLast)) return null;
      if (nextTextCount < currentTextCount) return null;
      if (nextTextCount === currentTextCount && nextLastText === currentLastText) return null;
      return next;
    };

    const poll = async () => {
      try {
        const response = await fetchWithTimeout(`${apiBase}/api/claw/chat-history/messages?adoptId=${encodeURIComponent(resolvedAdoptId)}&sessionKey=${encodeURIComponent(sessionKey)}`, {
          credentials: "include",
        }, 5000);
        if (cancelled || !response.ok) return;
        const payload = await response.json().catch(() => null);
        if (!Array.isArray(payload?.messages)) return;
        const nextMessages = shouldApplyHistory(payload.messages);
        if (!nextMessages) return;
        restoredSessionKeyRef.current = sessionKey;
        restoredConversationMessageCountsRef.current[webConversationId] = nextMessages.filter((m: any) => normalizeSessionText(m?.text || "")).length;
        try {
          if (resolvedAdoptId && userStorageId) {
            localStorage.setItem(webMessagesStorageKey(userStorageId, resolvedAdoptId, webConversationId), JSON.stringify(nextMessages));
          }
        } catch {}
        restoreLingxiaMessages(nextMessages, { preserveCurrentToolCalls: true });
      } catch {
        // Background sync only; keep the active chat usable if history polling fails.
      }
    };

    const initialTimer = window.setTimeout(poll, 1500);
    const interval = window.setInterval(poll, 10000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [activeLingxiaStreaming, isJiuwenRuntime, resolvedAdoptId, userStorageId, webConversationId, webSessions]);

  const startNewLingxiaConversation = () => {
    if (activeLingxiaStreaming) {
      toast.error("请先停止当前回复");
      return;
    }
    if (sessionSwitchingId) return;
    setSidebarSelection("session");
    setActivePage("chat");
    setMobileSidebarOpen(false);
    setSessionMenuOpen(false);
    const conversationId = makeConversationId();
    ensureEmptyWebSession(conversationId);
    activateWebConversation(conversationId);
  };

  const switchLingxiaConversation = async (conversationId: string) => {
    if (sessionSwitchingId) return;
    if (activeLingxiaStreaming) {
      toast.error("请先停止当前回复");
      return;
    }
    const session = webSessions.find((item) => item.conversationId === conversationId);
    const cachedMessages = readCachedWebConversationMessages(conversationId);
    const hasCachedMessages = !isJiuwenRuntime && cachedMessages.length > 0;
    const switchRequestSeq = restoreConversationRequestSeqRef.current + 1;
    restoreConversationRequestSeqRef.current = switchRequestSeq;

    if (!session?.sessionKey || !resolvedAdoptId) {
      activateWebConversation(conversationId, hasCachedMessages ? cachedMessages : undefined);
      setSessionMenuOpen(false);
      setSessionSwitchingId(null);
      return;
    }

    if (hasCachedMessages) {
      restoredSessionKeyRef.current = session.sessionKey;
      activateWebConversation(conversationId, cachedMessages);
      setSessionMenuOpen(false);
      setSessionSwitchingId(null);
    } else {
      setSessionSwitchingId(conversationId);
    }

    const apiBase = import.meta.env.VITE_API_URL || "";
    try {
      const messagesResp = await fetchWithTimeout(`${apiBase}/api/claw/chat-history/messages?adoptId=${encodeURIComponent(resolvedAdoptId)}&sessionKey=${encodeURIComponent(session.sessionKey)}`, {
        credentials: "include",
      }, 6000);
      if (restoreConversationRequestSeqRef.current !== switchRequestSeq) return;
      if (!messagesResp.ok) throw new Error(`读取历史失败 (${messagesResp.status})`);
      const payload = await messagesResp.json();
      restoredSessionKeyRef.current = session.sessionKey;
      activateWebConversation(conversationId, Array.isArray(payload?.messages) ? payload.messages : []);
      setSessionMenuOpen(false);
      if (!isJiuwenRuntime) {
        void fetchWithTimeout(`${apiBase}/api/claw/chat-history/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ adoptId: resolvedAdoptId, sessionKey: session.sessionKey }),
        }, 5000).catch(() => {});
      }
    } catch (error: any) {
      if (!hasCachedMessages) {
        toast.error(displayErrorMessage(error, "history"));
      } else {
        console.warn("[history] background hydrate failed after cached switch", error?.message || error);
      }
    } finally {
      setSessionSwitchingId((current) => current === conversationId ? null : current);
    }
  };

  const deleteLingxiaConversation = async (conversationId: string) => {
    if (sessionSwitchingId) return;
    if (!SESSION_INDEX_KEY || !resolvedAdoptId || !userStorageId) return;
    if (activeLingxiaStreaming) {
      toast.error("请先停止当前回复");
      return;
    }
    const session = webSessions.find((item) => item.conversationId === conversationId);
    const ok = await confirm({
      title: "删除会话？",
      description: `会话「${session?.title || "未命名会话"}」会从当前浏览器历史记录中移除。`,
      confirmText: "删除",
      variant: "danger",
    });
    if (!ok) return;
    setSessionMenuOpen(false);

    const next = webSessions.filter((item) => item.conversationId !== conversationId);
    writeWebSessionIndex(SESSION_INDEX_KEY, next);
    setWebSessions(next);
    if (HIDDEN_SESSION_KEY) {
      const hidden = readHiddenWebSessions(HIDDEN_SESSION_KEY, [LEGACY_HIDDEN_SESSION_KEY].filter(Boolean));
      hidden.add(conversationId);
      writeHiddenWebSessions(HIDDEN_SESSION_KEY, hidden);
    }
    try {
      localStorage.removeItem(webMessagesStorageKey(userStorageId, resolvedAdoptId, conversationId));
      removeLocalStorageKeys(legacyWebMessagesStorageKeys(userStorageId, resolvedAdoptId, conversationId));
    } catch {}
    if (isJiuwenRuntime && session?.sessionKey) {
      const apiBase = import.meta.env.VITE_API_URL || "";
      try {
        await fetchWithTimeout(`${apiBase}/api/claw/chat-history/session`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ adoptId: resolvedAdoptId, sessionKey: session.sessionKey }),
        }, 5000);
      } catch (error) {
        console.warn("[history] backend delete failed; keeping local hidden tombstone", error);
      }
    }
    if (conversationId === webConversationId) {
      const nextSession = next[0];
      if (nextSession?.sessionKey && !isLegacyArchivedRuntime) {
        const apiBase = import.meta.env.VITE_API_URL || "";
        try {
          const response = await fetchWithTimeout(`${apiBase}/api/claw/chat-history/messages?adoptId=${encodeURIComponent(resolvedAdoptId)}&sessionKey=${encodeURIComponent(nextSession.sessionKey)}`, {
            credentials: "include",
          }, 5000);
          const payload = response.ok ? await response.json().catch(() => null) : null;
          restoredSessionKeyRef.current = nextSession.sessionKey;
          activateWebConversation(nextSession.conversationId, Array.isArray(payload?.messages) ? payload.messages : []);
        } catch {
          activateWebConversation(nextSession.conversationId);
        }
      } else {
        activateWebConversation(nextSession?.conversationId || makeConversationId());
      }
    }
    toast.success("会话已删除");
  };

  const uploadLingxiaAttachments = async (files: File[]): Promise<UploadedLingxiaAttachment[]> => {
    if (!files.length) return [];
    if (!resolvedAdoptId) throw new Error("缺少岗位智能体实例 ID");
    const apiBase = import.meta.env.VITE_API_URL || "";
    const uploads: UploadedLingxiaAttachment[] = [];

    for (const file of files) {
      if (file.size > 50 * 1024 * 1024) {
        throw new Error(`${file.name} 超过 50MB 上传限制`);
      }
      const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
      const response = await fetch(`${apiBase}/api/claw/files/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          adoptId: resolvedAdoptId,
          path: "prompt_attachment",
          filename: file.name,
          contentBase64,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `${file.name} 上传失败 (${response.status})`);
      }
      uploads.push({
        name: String(payload.filename || file.name),
        path: String(payload.path || file.name),
        size: Number(payload.size || file.size),
        runtime: payload.runtime ? String(payload.runtime) : undefined,
      });
    }

    return uploads;
  };

  // 初始化 WSS 连接（后台自动尝试，不阻塞 UI）—— 仅存量 lgc-* 运行时
  useEffect(() => {
    if (!ENABLE_OPENCLAW_WS_CHAT || !resolvedAdoptId || !webConversationId || isDirectHttpRuntime) return;
    const apiBase = (import.meta as any).env?.VITE_API_URL || "";
    const ws = new RuntimeWSClient(resolvedAdoptId, apiBase, { channel: "web", conversationId: webConversationId });
    wsClientRef.current = ws;
    void ws.connect();
    return () => { ws.disconnect(); wsClientRef.current = null; };
  }, [resolvedAdoptId, webConversationId, isDirectHttpRuntime]);
  const lingxiaMsgViewportRef = useRef<HTMLDivElement | null>(null);
  const lingxiaMessageNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const lingxiaMessageRefCallbacks = useRef<Map<string, (node: HTMLDivElement | null) => void>>(new Map());
  const lingxiaManualNavigationRef = useRef(false);
  const [lingxiaNearBottom, setLingxiaNearBottom] = useState(true);
  const [activeConversationPromptId, setActiveConversationPromptId] = useState("");
  const lingxiaNearBottomRef = useRef(true);
  const updateLingxiaNearBottom = useCallback((next: boolean) => {
    lingxiaNearBottomRef.current = next;
    setLingxiaNearBottom((prev) => (prev === next ? prev : next));
  }, []);
  const conversationNavigatorItems = useMemo(
    () => buildConversationNavigatorItems(activeLingxiaMsgs),
    [activeLingxiaMsgs],
  );
  const conversationPromptIdsKey = conversationNavigatorItems.map((item) => item.id).join("\n");
  const getLingxiaMessageRef = useCallback((messageId: string) => {
    const existing = lingxiaMessageRefCallbacks.current.get(messageId);
    if (existing) return existing;
    const callback = (node: HTMLDivElement | null) => {
      if (node) {
        lingxiaMessageNodeRefs.current.set(messageId, node);
        return;
      }
      lingxiaMessageNodeRefs.current.delete(messageId);
    };
    lingxiaMessageRefCallbacks.current.set(messageId, callback);
    return callback;
  }, []);
  // 工具执行显性化状态
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [activeToolStartMs, setActiveToolStartMs] = useState<number | null>(null);
  const [activeToolStep, setActiveToolStep] = useState<number | null>(null);    // 第二阶段：当前步骤
  const [activeToolTotal, setActiveToolTotal] = useState<number | null>(null);  // 第二阶段：总步骤
  const [activeToolLabel, setActiveToolLabel] = useState<string | null>(null);  // 第二阶段：当前阶段文案
  const [connStatus, setConnStatus] = useState<'connected' | 'reconnecting' | 'failed'>('connected');
  const lastEventAtRef = useRef<number>(Date.now()); // 追踪最后收到的任意 SSE 事件时间

  // 技能列表
  const { data: lingxiaSkills, isLoading: lingxiaSkillsLoading, error: lingxiaSkillsError, refetch: refetchSkills } = trpc.claw.listSkills.useQuery(
    { adoptId: resolvedAdoptId || "" },
    { enabled: !!resolvedAdoptId, retry: false }
  );
  useEffect(() => {
    if (activePage !== "chat" || !resolvedAdoptId) return;
    void refetchSkills();
  }, [activePage, refetchSkills, resolvedAdoptId]);
  const composerSkills = useMemo(() => flattenComposerSkills(lingxiaSkills), [lingxiaSkills]);
  const [selectedComposerSkillId, setSelectedComposerSkillId] = useState<string>("");
  const [composerAddMenuOpen, setComposerAddMenuOpen] = useState(false);
  const [composerAddMenuView, setComposerAddMenuView] = useState<ComposerAddMenuView>("root");
  const [composerSkillSearch, setComposerSkillSearch] = useState("");
  const composerSkillSearchRef = useRef<HTMLInputElement | null>(null);
  const skillPackageInputRef = useRef<HTMLInputElement | null>(null);
  const [skillPackageUploading, setSkillPackageUploading] = useState(false);
  const [customMcpDialogOpen, setCustomMcpDialogOpen] = useState(false);
  const [customMcpDialogMode, setCustomMcpDialogMode] = useState<"add" | "manage">("manage");
  const probeSkillReadinessMutation = trpc.claw.probeSkillReadiness.useMutation();
  const selectedComposerSkill = useMemo(
    () => composerSkills.find((skill) => skill.id === selectedComposerSkillId) || null,
    [composerSkills, selectedComposerSkillId],
  );
  const filteredComposerSkills = useMemo(() => {
    const query = composerSkillSearch.trim().toLocaleLowerCase();
    if (!query) return composerSkills;
    return composerSkills.filter((skill) => (
      `${skill.label} ${skill.id} ${skill.desc}`.toLocaleLowerCase().includes(query)
    ));
  }, [composerSkillSearch, composerSkills]);
  const [composerConnectors, setComposerConnectors] = useState<ComposerConnector[]>([]);
  const [composerConnectorSearch, setComposerConnectorSearch] = useState("");
  const [composerConnectorsLoading, setComposerConnectorsLoading] = useState(false);
  const [pendingConnectorId, setPendingConnectorId] = useState("");
  const composerConnectorSearchRef = useRef<HTMLInputElement | null>(null);
  const [composerExperts, setComposerExperts] = useState<ExpertAgent[]>([]);
  const [composerExpertsLoading, setComposerExpertsLoading] = useState(false);
  const [composerExpertSearch, setComposerExpertSearch] = useState("");
  const [selectedComposerExpertId, setSelectedComposerExpertId] = useState("");
  const [expertTaskSubmitting, setExpertTaskSubmitting] = useState(false);
  const composerExpertSearchRef = useRef<HTMLInputElement | null>(null);
  const selectedComposerExpert = useMemo(
    () => composerExperts.find((expert) => expert.id === selectedComposerExpertId) || null,
    [composerExperts, selectedComposerExpertId],
  );
  const loadComposerConnectors = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!resolvedAdoptId) return;
    if (!options.silent) setComposerConnectorsLoading(true);
    try {
      const apiBase = (import.meta as any).env?.VITE_API_URL || "";
      const response = await fetchWithTimeout(
        `${apiBase}/api/claw/mcp-tools/status?adoptId=${encodeURIComponent(resolvedAdoptId)}`,
        { credentials: "include" },
        12_000,
      );
      const payload = await response.json().catch(() => ({})) as ComposerConnectorResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || `连接列表加载失败 (${response.status})`);
      setComposerConnectors(flattenComposerConnectors(payload));
    } catch (error) {
      if (!options.silent) toast.error(error instanceof Error ? error.message : "连接列表加载失败");
    } finally {
      if (!options.silent) setComposerConnectorsLoading(false);
    }
  }, [resolvedAdoptId]);
  const loadComposerExperts = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!resolvedAdoptId) return;
    if (!options.silent) setComposerExpertsLoading(true);
    try {
      const apiBase = (import.meta as any).env?.VITE_API_URL || "";
      const response = await fetchWithTimeout(
        `${apiBase}/api/claw/agents/available?adoptId=${encodeURIComponent(resolvedAdoptId)}`,
        { credentials: "include" },
        12_000,
      );
      const payload = await response.json().catch(() => ({})) as ExpertAgentsResponse;
      if (!response.ok) throw new Error(payload.error || `专家列表加载失败 (${response.status})`);
      setComposerExperts(normalizeExpertAgents(payload));
    } catch (error) {
      if (!options.silent) toast.error(error instanceof Error ? error.message : "专家列表加载失败");
    } finally {
      if (!options.silent) setComposerExpertsLoading(false);
    }
  }, [resolvedAdoptId]);
  const showComposerConnectorPanel = useCallback(() => {
    setComposerAddMenuView("connectors");
    void loadComposerConnectors({ silent: composerConnectors.length > 0 });
    window.setTimeout(() => composerConnectorSearchRef.current?.focus(), 0);
  }, [composerConnectors.length, loadComposerConnectors]);
  const showComposerSkillPanel = useCallback(() => {
    setComposerAddMenuView("skills");
    window.setTimeout(() => composerSkillSearchRef.current?.focus(), 0);
  }, []);
  const showComposerExpertPanel = useCallback(() => {
    setComposerAddMenuView("experts");
    void loadComposerExperts({ silent: composerExperts.length > 0 });
    window.setTimeout(() => composerExpertSearchRef.current?.focus(), 0);
  }, [composerExperts.length, loadComposerExperts]);
  const openCustomMcpDialog = useCallback((mode: "add" | "manage") => {
    setComposerAddMenuOpen(false);
    setComposerAddMenuView("root");
    setCustomMcpDialogMode(mode);
    setCustomMcpDialogOpen(true);
  }, []);
  const openSkillManager = useCallback(() => {
    try { window.localStorage.setItem("employee-agent:skills:last-tab", "mine"); } catch {}
    setComposerAddMenuOpen(false);
    setComposerAddMenuView("root");
    selectWorkbenchPage("skills");
  }, []);
  const handleSkillPackageUpload = useCallback(async (file: File) => {
    if (!resolvedAdoptId) return;
    if (!/\.(zip|skill)$/i.test(file.name)) {
      toast.error("请上传 .zip 或 .skill 技能包");
      return;
    }
    setSkillPackageUploading(true);
    try {
      const inspect = await inspectSkillPackage(file, resolvedAdoptId);
      const defaultName = inspect.skill.displayName || inspect.skill.skillId || file.name.replace(/\.(zip|skill)$/i, "");
      const displayName = window.prompt("技能名称", defaultName)?.trim();
      if (!displayName) return;
      if (displayName.length < 2) throw new Error("技能名称至少 2 个字");
      const description = window.prompt("技能说明", inspect.skill.description || "")?.trim() || inspect.skill.description || "";
      const uploaded = await uploadSkillPackage({ file, adoptId: resolvedAdoptId, displayName, description });
      await refetchSkills();
      const warnings = uploaded.warnings?.length || inspect.skill.warnings?.length || 0;
      if (warnings > 0) {
        toast.warning(`技能已上传，静态扫描提示 ${warnings} 项，请在技能管理中确认。`);
      } else {
        const skillId = String(uploaded.item?.id || inspect.skill.skillId || "").trim();
        if (skillId) setSelectedComposerSkillId(skillId);
        toast.success("技能已上传并同步到运行环境");
      }
      setComposerAddMenuOpen(false);
      setComposerAddMenuView("root");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "技能上传失败");
    } finally {
      setSkillPackageUploading(false);
      if (skillPackageInputRef.current) skillPackageInputRef.current.value = "";
    }
  }, [refetchSkills, resolvedAdoptId]);
  useEffect(() => {
    setComposerConnectors([]);
    setComposerExperts([]);
    setComposerConnectorSearch("");
    setComposerExpertSearch("");
    setSelectedComposerExpertId("");
    setComposerAddMenuOpen(false);
    setComposerAddMenuView("root");
    setCustomMcpDialogOpen(false);
    if (activePage === "chat" && resolvedAdoptId) {
      void loadComposerConnectors({ silent: true });
      void loadComposerExperts({ silent: true });
    }
  }, [activePage, loadComposerConnectors, loadComposerExperts, resolvedAdoptId]);
  const filteredComposerConnectors = useMemo(() => {
    const query = composerConnectorSearch.trim().toLocaleLowerCase();
    if (!query) return composerConnectors;
    return composerConnectors.filter((connector) => (
      `${connector.name} ${connector.serverId} ${connector.description} ${connector.category}`
        .toLocaleLowerCase()
        .includes(query)
    ));
  }, [composerConnectorSearch, composerConnectors]);
  const activeComposerConnectorCount = useMemo(
    () => composerConnectors.filter((connector) => connector.enabledForAgent).length,
    [composerConnectors],
  );
  const filteredComposerExperts = useMemo(() => {
    const query = composerExpertSearch.trim().toLocaleLowerCase();
    if (!query) return composerExperts;
    return composerExperts.filter((expert) => (
      `${expert.name} ${expert.description} ${expert.tags || ""} ${expert.capabilities.join(" ")}`
        .toLocaleLowerCase()
        .includes(query)
    ));
  }, [composerExpertSearch, composerExperts]);
  const toggleComposerConnector = useCallback(async (connector: ComposerConnector) => {
    if (!resolvedAdoptId || pendingConnectorId || activeLingxiaStreaming || !connector.configured) return;
    const nextEnabled = !connector.enabledForAgent;
    setPendingConnectorId(connector.serverId);
    try {
      const apiBase = (import.meta as any).env?.VITE_API_URL || "";
      const response = await fetchWithTimeout(`${apiBase}/api/claw/mcp-tools/toggle`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId: resolvedAdoptId, serverId: connector.serverId, enabled: nextEnabled }),
      }, 12_000);
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        enabledServerIds?: string[];
      };
      if (!response.ok) throw new Error(payload.error || `连接切换失败 (${response.status})`);
      const enabledServerIds = new Set(payload.enabledServerIds || []);
      setComposerConnectors((current) => current.map((item) => ({
        ...item,
        enabledForAgent: payload.enabledServerIds
          ? enabledServerIds.has(item.serverId)
          : item.serverId === connector.serverId ? nextEnabled : item.enabledForAgent,
      })));
      if (!nextEnabled && selectedComposerSkill?.requiredMcpServers.includes(connector.serverId)) {
        setSelectedComposerSkillId("");
      }
      toast.success(`${connector.name}已${nextEnabled ? "启用" : "关闭"}，下一轮对话生效`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "连接切换失败");
    } finally {
      setPendingConnectorId("");
    }
  }, [activeLingxiaStreaming, pendingConnectorId, resolvedAdoptId, selectedComposerSkill]);
  const selectComposerSkill = useCallback(async (skill: ComposerSkillOption) => {
    if (skill.requiredMcpServers.length === 0 || !resolvedAdoptId) {
      setSelectedComposerSkillId(skill.id);
      setSelectedComposerExpertId("");
      setComposerAddMenuView("root");
      setComposerAddMenuOpen(false);
      return;
    }
    try {
      const readiness = await probeSkillReadinessMutation.mutateAsync({
        adoptId: resolvedAdoptId,
        skillId: skill.id,
      });
      if (!readiness.canProceed) {
        toast.error(readiness.message);
        return;
      }
      if (readiness.status === "unchecked") toast.warning(readiness.message);
    } catch {
      toast.warning("暂时无法验证技能所需的业务工具，将在发送时再次检查");
    }
    setSelectedComposerSkillId(skill.id);
    setSelectedComposerExpertId("");
    setComposerAddMenuView("root");
    setComposerAddMenuOpen(false);
  }, [probeSkillReadinessMutation, resolvedAdoptId]);
  const selectComposerExpert = useCallback((expert: ExpertAgent) => {
    if (!expert.routeReady) {
      toast.error(expert.reason || "该专家当前不可用");
      return;
    }
    setSelectedComposerExpertId(expert.id);
    setSelectedComposerSkillId("");
    setComposerAddMenuView("root");
    setComposerAddMenuOpen(false);
  }, []);
  useEffect(() => {
    if (selectedComposerSkillId && !composerSkills.some((skill) => skill.id === selectedComposerSkillId)) {
      setSelectedComposerSkillId("");
    }
  }, [composerSkills, selectedComposerSkillId]);
  useEffect(() => {
    if (selectedComposerExpertId && !composerExperts.some((expert) => expert.id === selectedComposerExpertId && expert.routeReady)) {
      setSelectedComposerExpertId("");
    }
  }, [composerExperts, selectedComposerExpertId]);
  useEffect(() => {
    if (!resolvedAdoptId || lingxiaSkillsLoading) return;
    const count = Number((lingxiaSkills as any)?.shared?.length || 0)
      + Number((lingxiaSkills as any)?.system?.length || 0)
      + Number((lingxiaSkills as any)?.private?.length || 0);
    markClientLoadMetric("skills", lingxiaSkillsError ? "error" : "ok", lingxiaSkillsError ? String((lingxiaSkillsError as any)?.message || lingxiaSkillsError) : `${count} skills`);
  }, [lingxiaSkills, lingxiaSkillsError, lingxiaSkillsLoading, markClientLoadMetric, resolvedAdoptId]);
  useEffect(() => {
    if (!resolvedAdoptId || !isDirectHttpRuntime) return;
    markClientLoadMetric("health", "skip", isJiuwenRuntime ? "JiuwenSwarm 直连模式" : "历史实例直连模式");
    markClientLoadMetric("sessions", "skip", isJiuwenRuntime ? "JiuwenSwarm 本地会话缓存" : "历史实例本地会话缓存");
  }, [isDirectHttpRuntime, isJiuwenRuntime, markClientLoadMetric, resolvedAdoptId]);
  const toggleSkillMutation = trpc.claw.toggleSkill.useMutation({
    onSuccess: () => { refetchSkills(); toast.success("技能已更新"); },
    onError: (e) => toast.error(e.message),
  });
  const upsertPrivateSkillMutation = trpc.claw.upsertPrivateSkill.useMutation({
    onSuccess: () => { refetchSkills(); setLingxiaSkillEditor(null); toast.success("技能已保存"); },
    onError: (e) => toast.error(e.message),
  });
  const deletePrivateSkillMutation = trpc.claw.deletePrivateSkill.useMutation({
    onSuccess: () => { refetchSkills(); toast.success("技能已删除"); },
    onError: (e) => toast.error(e.message),
  });
  const [lingxiaSkillEditor, setLingxiaSkillEditor] = useState<{ id: string; content: string } | null>(null);

  // localStorage 会话持久化
  useEffect(() => {
    messagesHydratingRef.current = true;
    currentMessagesKeyRef.current = MSGS_KEY || "";
    if (!MSGS_KEY) {
      setLingxiaMsgs([]);
      return;
    }
    try {
      const saved = readLocalStorageWithLegacy(MSGS_KEY, [LEGACY_MSGS_KEY_USER, LEGACY_MSGS_KEY_ADOPT].filter(Boolean));
      if (saved) {
        const parsed = JSON.parse(saved);
        // backfillLxMsgIds 会保留旧 id（如果有）或生成新 id，并兜底必填字段
        const normalized = backfillLxMsgIds(parsed);
        setLingxiaMsgs(normalized);
      } else {
        setLingxiaMsgs([]);
      }
    } catch {}
  }, [MSGS_KEY, LEGACY_MSGS_KEY_ADOPT, LEGACY_MSGS_KEY_USER]);
  useEffect(() => {
    if (!MSGS_KEY || currentMessagesKeyRef.current !== MSGS_KEY) return;
    if (messagesHydratingRef.current) {
      messagesHydratingRef.current = false;
      return;
    }
    try {
      if (lingxiaMsgs.length === 0) {
        localStorage.removeItem(MSGS_KEY);
      } else {
        // 不持久化 recovering 瞬态——刷新后重新加载时清空，避免 UI 卡在补偿中
        // 同时把 text 还原为 partialText（去掉"正在补全..."提示），避免刷新看到不会推进的虚假提示
        const persisted = lingxiaMsgs.slice(-100).map((m) => {
          if (!m.recovering) return m;
          return {
            ...m,
            recovering: false,
            text: m.partialText ?? m.text,
            partialText: undefined,
          };
        });
        localStorage.setItem(MSGS_KEY, JSON.stringify(persisted));
      }
    } catch {}
  }, [lingxiaMsgs, MSGS_KEY]);


  useEffect(() => {
    if (!clawSettings) return;
    setLingxiaDisplayName(roleDisplayName((clawByAdoptId as any)?.roleTemplate, (clawByAdoptId as any)?.roleName));
    setLingxiaMemoryEnabled(((clawSettings as any).memoryEnabled || "yes") as "yes" | "no");
    setLingxiaContextTurns(Number((clawSettings as any).contextTurns || 20));
    // 模型选择由 availableModels useEffect 统一管理
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clawSettings, clawByAdoptId]);


  const stopLingxiaStreaming = () => {
    streamSeqRef.current += 1;
    if (lingxiaStreamAbortRef.current) {
      lingxiaStreamAbortRef.current.abort();
      lingxiaStreamAbortRef.current = null;
    }
    try { wsClientRef.current?.setRawHandler(null); } catch {}
    setLingxiaStreaming(false);
    setConnStatus("connected");
    setActiveToolName(null);
    setActiveToolStartMs(null);
  };

  // 断连检测：任意 SSE 事件超过 25 秒未到达 → 进入"重连中"
  useEffect(() => {
    if (!lingxiaStreaming) return;
    const id = setInterval(() => {
      if (Date.now() - lastEventAtRef.current > 90_000) {
        streamSeqRef.current += 1;
        if (lingxiaStreamAbortRef.current) {
          lingxiaStreamAbortRef.current.abort();
          lingxiaStreamAbortRef.current = null;
        }
        setConnStatus("reconnecting");
        setLingxiaStreaming(false);
        setActiveToolName(null);
        setActiveToolStartMs(null);
        setActiveToolStep(null);
        setActiveToolTotal(null);
        setActiveToolLabel(null);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [lingxiaStreaming]);

  const attachJiuwenPermissionToLastAssistant = (permission: JiuwenPermissionRequestCard) => {
    setLingxiaMsgs((prev) => {
      const next = [...prev];
      const lastIdx = next.length - 1;
      if (lastIdx < 0 || next[lastIdx].role !== "assistant") return prev;
      const nextPermission = { ...permission, state: "pending" as const };
      next[lastIdx] = {
        ...next[lastIdx],
        text: withJiuwenPermissionMarker(next[lastIdx].text || "需要你的授权才能继续执行。", nextPermission),
        jiuwenPermission: nextPermission,
        status: undefined,
      };
      return next;
    });
  };

  const handleJiuwenPermissionAnswer = async (
    messageId: string,
    permission: JiuwenPermissionRequestCard,
    action: "allow_once" | "reject",
  ) => {
    if (!resolvedAdoptId || !permission?.requestId) return;
    const nextState: JiuwenPermissionRequestCard["state"] = action === "reject" ? "rejected" : "approved";
    setLingxiaMsgs((prev) => prev.map((msg) => (
      msg.id === messageId
        ? { ...msg, jiuwenPermission: { ...permission, state: "submitting", error: undefined } }
        : msg
    )));
    try {
      const apiBase = import.meta.env.VITE_API_URL || "";
      const resp = await fetch(`${apiBase}/api/claw/jiuwen/permission-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          adoptId: resolvedAdoptId,
          requestId: permission.requestId,
          action,
          source: permission.source || "permission_interrupt",
          channel: "web",
          conversationId: webConversationId,
          runtimeMode: chatRuntimeMode,
        }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || payload?.ok === false) {
        throw new Error(payload?.error || `授权提交失败 (${resp.status})`);
      }
      const continuedText = String(payload?.text || "").trim();
      setLingxiaMsgs((prev) => prev.map((msg) => {
        if (msg.id !== messageId) return msg;
        const current = msg.text || "";
        const nextPermission = { ...permission, state: nextState };
        const mergedText = continuedText
          ? (current ? `${extractJiuwenPermissionMarker(current).text}\n\n${continuedText}` : continuedText)
          : current;
        return {
          ...msg,
          text: withJiuwenPermissionMarker(mergedText, nextPermission),
          jiuwenPermission: nextPermission,
        };
      }));
    } catch (error: any) {
      const errorText = error?.message || "授权提交失败";
      setLingxiaMsgs((prev) => prev.map((msg) => (
        msg.id === messageId
          ? { ...msg, jiuwenPermission: { ...permission, state: "error", error: errorText } }
          : msg
      )));
      toast.error(errorText);
    }
  };

  const submitExpertTask = async (args: {
    expert: ExpertAgent;
    text: string;
    displayText: string;
    attachments?: ChatMessageAttachment[];
  }): Promise<boolean> => {
    if (!resolvedAdoptId || !args.text.trim() || expertTaskSubmitting) return false;
    const nowLabel = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const userMessageId = makeLxMsgId();
    const assistantMessageId = makeLxMsgId();
    const conversationIdAtSend = webConversationId;
    const currentSession = webSessionsRef.current.find((session) => session.conversationId === conversationIdAtSend);
    setExpertTaskSubmitting(true);
    setLingxiaMsgs((previous) => [
      ...previous,
      {
        id: userMessageId,
        role: "user",
        text: args.displayText,
        timeLabel: nowLabel,
        ...(args.attachments?.length ? { attachments: args.attachments } : {}),
      },
      {
        id: assistantMessageId,
        role: "assistant",
        text: "",
        status: `正在提交给${args.expert.name}...`,
        timeLabel: nowLabel,
        model: effectiveLingxiaModelId,
      },
    ]);
    clearLingxiaDraft();
    setLingxiaInput("");
    updateLingxiaNearBottom(true);

    try {
      const apiBase = import.meta.env.VITE_API_URL || "";
      const response = await fetchWithTimeout(`${apiBase}/api/claw/agent-tasks/submit`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adoptId: resolvedAdoptId,
          agentId: args.expert.id,
          task: args.text,
          conversationId: conversationIdAtSend,
          sessionId: currentSession?.sessionKey || currentSession?.sessionId || undefined,
          sourceMessageId: userMessageId,
        }),
      }, 12_000);
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        taskId?: string;
        task?: AgentTask;
      };
      if (!response.ok || !payload.taskId) {
        throw new Error(payload.error || `专家任务提交失败 (${response.status})`);
      }
      setLingxiaMsgs((previous) => previous.map((message) => (
        message.id === assistantMessageId
          ? { ...message, text: expertTaskMessage(args.expert.name, payload.taskId || ""), status: undefined }
          : message
      )));
      if (payload.task) {
        setAgentTasks((previous) => [payload.task as AgentTask, ...previous.filter((task) => task.id !== payload.task?.id)].slice(0, 8));
      }
      setSelectedComposerExpertId("");
      toast.success(`${args.expert.name}已接收任务`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "专家任务提交失败";
      setLingxiaMsgs((previous) => previous.map((item) => (
        item.id === assistantMessageId
          ? { ...item, text: `专家任务提交失败：${message}`, status: undefined }
          : item
      )));
      toast.error(message);
      return false;
    } finally {
      setExpertTaskSubmitting(false);
    }
  };

  const sendLingxiaMessage = async (
    messageOverride?: string,
    opts?: {
      selectedSkillId?: string;
      displayText?: string;
      attachments?: ChatMessageAttachment[];
    },
  ) => {
    const sourceText = messageOverride ?? lingxiaInput;
    if (!resolvedAdoptId || !sourceText.trim() || lingxiaStreaming) return;
    if (switchModelMutation.isPending) {
      toast.info("模型正在切换，请稍候");
      return;
    }
    const lastAssistantBeforeSend = [...activeLingxiaMsgsRef.current].reverse().find((msg) => msg.role === "assistant");
    const shouldCancelPendingJiuwenPermission =
      isJiuwenRuntime &&
      Boolean(lastAssistantBeforeSend?.jiuwenPermission?.requestId) &&
      lastAssistantBeforeSend?.jiuwenPermission?.state !== "rejected";
    // 2026-04-17 SSE race fix: 强制 abort 上一次的流，避免 WS 重连/网络抖动后旧 reader 还在
    // setLingxiaMsgs 写 delta，跟新流字符级交错（典型现象：英文 narrative + 中文技能列表混合）
    if (lingxiaStreamAbortRef.current) {
      try { lingxiaStreamAbortRef.current.abort(); } catch {}
      lingxiaStreamAbortRef.current = null;
    }
    // 2026-04-19 SSE race fix: 本次 send 的 seq，闭包下传所有 handler
    streamSeqRef.current += 1;
    const myStreamSeq = streamSeqRef.current;
    const isStale = () => streamSeqRef.current !== myStreamSeq;
    const text = sourceText.trim();
    const userDisplayText = opts?.displayText !== undefined ? opts.displayText.trim() : text;
    const nowLabel = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const assistantTimeLabel = nowLabel;
    lingxiaManualNavigationRef.current = false;
    updateLingxiaNearBottom(true);

    if (text.toLowerCase() === "/help" || text.toLowerCase() === "/commands") {
      const helpMd = "## \u53ef\u7528\u547d\u4ee4\n\n" +
        "| \u547d\u4ee4 | \u8bf4\u660e |\n|---|---|\n" +
        "| \`/help\` | \u67e5\u770b\u53ef\u7528\u547d\u4ee4 |\n" +
        "| \`/status\` | \u67e5\u770b\u5f53\u524d\u72b6\u6001 |\n" +
        "| \`/tools\` | \u67e5\u770b\u53ef\u7528\u5de5\u5177 |\n" +
        "| \`/model\` | \u5207\u6362\u6a21\u578b |\n" +
        "| \`/dreaming status\` | \u68a6\u5883\u8bb0\u5fc6\u72b6\u6001 |\n" +
        "| \`/context\` | \u4e0a\u4e0b\u6587\u4fe1\u606f |\n" +
        "| \`/usage\` | \u7528\u91cf\u7edf\u8ba1 |\n" +
        "| \`/whoami\` | \u5f53\u524d\u8eab\u4efd |\n" +
        "| \`/new\` | \u65b0\u4f1a\u8bdd |\n" +
        "| \`/reset\` | \u91cd\u7f6e\u4e0a\u4e0b\u6587 |\n" +
        "| \`/think\` | \u6df1\u5ea6\u601d\u8003 |\n" +
        "| \`/fast\` | \u5feb\u901f\u6a21\u5f0f |\n" +
        "| \`/compact\` | \u538b\u7f29\u4e0a\u4e0b\u6587 |\n" +
        "| \`/tasks\` | \u4efb\u52a1\u5217\u8868 |\n\n" +
        "> \u4e5f\u53ef\u4ee5\u76f4\u63a5\u7528\u81ea\u7136\u8bed\u8a00\u5bf9\u8bdd";
      setLingxiaMsgs((prev) => [...prev,
        { id: makeLxMsgId(), role: "user" as const, text, timeLabel: nowLabel },
        { id: makeLxMsgId(), role: "assistant" as const, text: helpMd, timeLabel: assistantTimeLabel },
      ]);
      clearLingxiaDraft();
      setLingxiaInput("");
      return;
    }

    const userMessageId = makeLxMsgId();
    const assistantMessageId = makeLxMsgId();
    const clientRunId = makeClientRunId();
    const conversationIdAtSend = webConversationId;
    setLingxiaMsgs((prev) => [
      ...prev.map((msg) => {
        if (msg.id !== lastAssistantBeforeSend?.id || msg.role !== "assistant" || !msg.jiuwenPermission?.requestId || msg.jiuwenPermission.state === "rejected") return msg;
        const nextPermission = {
          ...msg.jiuwenPermission,
          state: "rejected" as const,
          error: "已因发送新消息取消上一轮授权",
        };
        return {
          ...msg,
          text: withJiuwenPermissionMarker(extractJiuwenPermissionMarker(msg.text || "").text, nextPermission),
          jiuwenPermission: nextPermission,
        };
      }),
      {
        id: userMessageId,
        role: "user",
        text: userDisplayText,
        timeLabel: nowLabel,
        ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      },
      {
        id: assistantMessageId,
        role: "assistant",
        text: "",
        status: "正在连接...",
        timeLabel: assistantTimeLabel,
        model: effectiveLingxiaModelId,
        ...(opts?.selectedSkillId ? { selectedSkillId: opts.selectedSkillId } : {}),
      },
    ]);
    clearLingxiaDraft();
    setLingxiaInput("");
    setLingxiaStreaming(true);
    setClawHealthError("");
    updateLingxiaNearBottom(true);
    setLingxiaToolCalls([]);

    let wsOk = false;
    let runtimeSessionKey = "";
    try {
      const apiBase = import.meta.env.VITE_API_URL || "";
      const perf: Record<string, number> = { clientSendMs: Date.now() };
      const controller = new AbortController();
      lingxiaStreamAbortRef.current = controller;
      // ── WSS 优先路径（仅 OpenClaw runtime） ──
      // 历史归档实例/JiuwenClaw 跳过 WSS 尝试，直接走 HTTP SSE（server 侧按 prefix 分叉）。
      const runtimeName = isJiuwenRuntime ? "jiuwenclaw" : isLegacyArchivedRuntime ? "legacy_archived" : "openclaw";
      let wsClient = ENABLE_OPENCLAW_WS_CHAT && !isDirectHttpRuntime ? wsClientRef.current : null;
      if (!wsClient && ENABLE_OPENCLAW_WS_CHAT && !isDirectHttpRuntime && resolvedAdoptId && webConversationId) {
        wsClient = new RuntimeWSClient(resolvedAdoptId, apiBase, { channel: "web", conversationId: webConversationId });
        wsClientRef.current = wsClient;
      }
      if (wsClient && wsClient.state !== "connected") {
        console.log(`[DIAG] runtime=${runtimeName}, wsClient.state = ${wsClient.state}, connecting before send`);
        const connected = await wsClient.connect().catch(() => false);
        if (!connected) {
          wsClient = null;
        }
      }
      console.log(`[DIAG] runtime=${runtimeName}, wsClient.state = ${wsClient?.state ?? "null"}, will ${wsClient?.state === "connected" ? "try WSS first" : "use HTTP SSE directly"}`);
      if (wsClient?.state === "connected") {
        console.log("[WS] sending via WebSocket");
        // WS 消息处理：后端 WS 代理已转成与 HTTP SSE 一致的格式
        // _event 字段 = SSE 的 event: 行，其余字段 = SSE 的 data: JSON
        // 用 setRawHandler 代替 addEventListener，跨重连自动保持
          const wsHandler = (chunk: any) => {
            try {
              // SSE race fix: 老流的 chunk 直接早退，不写新 placeholder
              if (isStale()) return;
              if (chunk.type === "connected") return;
              lastEventAtRef.current = Date.now();

              const runDescriptor = parseRuntimeRunDescriptor(chunk);
              if (runDescriptor) {
                runtimeSessionKey = runDescriptor.sessionId;
                return;
              }

              if (typeof chunk.__final_text === "string") {
                setLingxiaMsgs((prev) => applyAssistantFinalSnapshot(prev, assistantMessageId, chunk.__final_text));
                return;
              }

              // ── 统一语义：流结束 ──
              if (chunk.__stream_end) {
                console.log("[DIAG] ✅ WSS 收到 __stream_end，流结束");
                setLingxiaStreaming(false);
                wsClient.setRawHandler(null);
                if (conversationIdAtSend) void reconcileStreamedConversation({ conversationId: conversationIdAtSend, assistantMessageId, streamSeq: myStreamSeq, sessionKey: runtimeSessionKey || undefined });
                return;
              }
              // ── 2026-04-29 批次 2 A3：上游 EOF 但 runtime 未确认完成 ──
              if (chunk.__stream_truncated) {
                console.log("[DIAG] ⚠️ WSS 收到 __stream_truncated，启动 recover:", chunk);
                handleStreamTruncated(chunk, lingxiaMsgsRef.current, setLingxiaMsgs);
                setLingxiaStreaming(false);
                wsClient.setRawHandler(null);
                return;
              }
              // ── 长度上限达到（finish_reason: length）──
              if (chunk.__stream_end_length) {
                console.log("[DIAG] ⚠️ WSS 收到 __stream_end_length");
                setLingxiaMsgs((prev) => { const n = [...prev]; const last = n[n.length-1]; if (last?.role === "assistant") n[n.length-1] = { ...last, text: last.text + "\n\n_⚠️ 已达模型长度上限，输出可能不完整_" }; return n; });
                setLingxiaStreaming(false);
                wsClient.setRawHandler(null);
                return;
              }
              // ── 统一语义：终止性错误 ──
              if (chunk.__stream_error) {
                console.log("[DIAG] ❌ WSS 收到 __stream_error:", chunk.error);
                setLingxiaMsgs((prev) => { const n = [...prev]; const last = n[n.length-1]; if (last?.role === "assistant") n[n.length-1] = { ...last, text: `（${chunk.error || "连接异常"}）` }; return n; });
                setLingxiaStreaming(false);
                wsClient.setRawHandler(null);
                return;
              }
              // 错误（旧兼容）
              if (chunk.error) {
                setLingxiaMsgs((prev) => { const n = [...prev]; const last = n[n.length-1]; if (last?.role === "assistant") n[n.length-1] = { ...last, text: `（${chunk.error}）` }; return n; });
                setLingxiaStreaming(false);
                return;
              }

              if (chunk._event === "jiuwen_permission_request") {
                attachJiuwenPermissionToLastAssistant({
                  requestId: String(chunk.requestId || ""),
                  source: String(chunk.source || "permission_interrupt"),
                  title: String(chunk.title || "权限审批"),
                  question: String(chunk.question || ""),
                  command: chunk.command ? String(chunk.command) : undefined,
                  toolName: chunk.toolName ? String(chunk.toolName) : undefined,
                  options: Array.isArray(chunk.options) ? chunk.options : undefined,
                  state: "pending",
                });
                setLingxiaStreaming(false);
                wsClient.setRawHandler(null);
                return;
              }

              // ── tool_call 事件（与 HTTP SSE event:tool_call 一致）──

              // ── Agent Team 事件 ──
              if (chunk._event === "agent_dispatch") {
                const tasks = (chunk.agents || []).map((a: any) => ({
                  id: a.id, agentId: a.agentId, agentName: a.name, prompt: a.prompt || "",
                  status: "running", steps: [], result: undefined, durationMs: undefined,
                }));
                setAgentTasks(tasks);
                return;
              }
              if (chunk._event === "agent_tool_update") {
                setAgentTasks((prev) => prev.map((t) =>
                  t.id === chunk.taskId ? {
                    ...t,
                    steps: chunk.toolStatus === "started"
                      ? [...(t.steps || []), { name: chunk.toolName || "tool", status: "running" }]
                      : (t.steps || []).map((s) => s.name === (chunk.toolName || "tool") && s.status === "running"
                          ? { ...s, status: "done", durationMs: chunk.durationMs } : s),
                  } : t
                ));
                return;
              }
              if (chunk._event === "agent_complete") {
                setAgentTasks((prev) => prev.map((t) =>
                  t.id === chunk.taskId ? {
                    ...t, status: "done", result: chunk.result || "", durationMs: chunk.durationMs,
                    steps: (t.steps || []).map((s) => s.status === "running" ? { ...s, status: "done" } : s),
                  } : t
                ));
                return;
              }
              if (chunk._event === "tool_call") {
                const toolName = normalizeIncomingToolName(chunk);
                const toolTs = Date.now();
                const isGateway = Boolean(chunk._gateway);
                const executor = chunk.executor as ToolCallEntry["executor"] | undefined;
                setLingxiaMsgs((prev) => {
                  const next = [...prev]; const lastIdx = next.length - 1;
                  if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                    const existing = next[lastIdx].toolCalls || [];
                    next[lastIdx] = normalizeMessageToolEvents({ ...next[lastIdx], status: `正在调用工具：${toolName}`, toolCalls: [...existing, { id: String(chunk.id || ""), name: toolName, arguments: String(chunk.arguments || "{}"), status: "running" as const, ts: toolTs, _gateway: isGateway, executor: isGateway ? "gateway" : executor }] });
                  }
                  return next;
                });
                if (!isGateway) {
                  setActiveToolName(toolName);
                  setActiveToolStartMs(toolTs);
                  setActiveToolStep(null); setActiveToolTotal(null); setActiveToolLabel(null);
                }
                return;
              }

              // ── tool_result 事件（与 HTTP SSE event:tool_result 一致）──
              if (chunk._event === "tool_result") {
                const toolCallId = String(chunk.tool_call_id || "");
                const result = String(chunk.result ?? "");
                const isGateway = Boolean(chunk._gateway);
                const status = chunk.is_error ? "error" : "done";
                if (isGateway) {
                  setLingxiaMsgs((prev) => {
                    const next = [...prev]; const lastIdx = next.length - 1;
                    if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                      const tcs = next[lastIdx].toolCalls || [];
                      const gwIdx = tcs.findLastIndex((tc: any) => tc._gateway && tc.status === "running");
                      if (gwIdx >= 0) { const updated = [...tcs]; updated[gwIdx] = { ...updated[gwIdx], status: "done", durationMs: Date.now() - updated[gwIdx].ts }; next[lastIdx] = normalizeMessageToolEvents({ ...next[lastIdx], status: "正在整理结果...", toolCalls: updated }); }
                    }
                    return next;
                  });
                } else {
                  setLingxiaMsgs((prev) => {
                    const next = [...prev]; const lastIdx = next.length - 1;
                    if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                      const tcs = next[lastIdx].toolCalls || [];
                      next[lastIdx] = normalizeMessageToolEvents({ ...next[lastIdx], status: "正在整理结果...", toolCalls: tcs.map((tc: any) => tc.id === toolCallId ? { ...tc, result, status, durationMs: Date.now() - tc.ts, executor: chunk.executor, truncated: Boolean(chunk.truncated), outputFiles: chunk.outputFiles, adoptId: resolvedAdoptId ?? undefined } : tc) });
                    }
                    return next;
                  });
                  setActiveToolName(null); setActiveToolStartMs(null);
                  setActiveToolStep(null); setActiveToolTotal(null); setActiveToolLabel(null);
                }
                return;
              }

              // ── workspace_files 事件 ──
              if (chunk._event === "workspace_files") {
                const wsFiles = Array.isArray(chunk.files) ? chunk.files : [];
                const wsAdoptId = String(chunk.adoptId || "");
                if (wsFiles.length > 0) {
                  const pseudoTc: any = { id: `ws-files-${Date.now()}`, name: "[产出文件]", arguments: "{}", result: wsFiles.map((f: any) => f.name).join(", "), status: "done", ts: Date.now(), executor: "native", outputFiles: wsFiles.map((f: any) => ({ name: f.name, size: f.size, wsPath: f.path })), adoptId: wsAdoptId };
                  setLingxiaMsgs((prev) => { const next = [...prev]; const lastIdx = next.length - 1; if (lastIdx >= 0 && next[lastIdx].role === "assistant") { const existing = next[lastIdx].toolCalls || []; next[lastIdx] = normalizeMessageToolEvents({ ...next[lastIdx], toolCalls: [...existing, pseudoTc] }); } return next; });
                }
                return;
              }

              // ── agent_status 事件（进度条）──
              if (chunk._event === "agent_status") {
                if (chunk.kind === "heartbeat") {
                  if (chunk.tool) setActiveToolName(String(chunk.tool));
                  if (chunk.elapsedMs) setActiveToolStartMs(Date.now() - Number(chunk.elapsedMs));
                } else if (chunk.kind === "progress") {
                  if (chunk.tool) setActiveToolName(String(chunk.tool));
                  if (chunk.step != null) setActiveToolStep(Number(chunk.step));
                  if (chunk.total != null) setActiveToolTotal(Number(chunk.total));
                  if (chunk.label) setActiveToolLabel(String(chunk.label));
                  if (chunk.elapsedMs) setActiveToolStartMs(Date.now() - Number(chunk.elapsedMs));
                }
                return;
              }

              // ── __perf 事件（token 用量）──
              if (chunk.__perf && typeof chunk.__perf === "object") {
                setLingxiaMsgs(prev => {
                  if (!prev.length || prev[prev.length - 1].role !== "assistant") return prev;
                  const last = prev[prev.length - 1];
                  const input = chunk.__perf.usage?.input ?? chunk.__perf.usage?.inputTokens ?? last.usage?.input ?? 0;
                  const output = chunk.__perf.usage?.output ?? chunk.__perf.usage?.outputTokens ?? last.usage?.output ?? 0;
                  const contextWindow = chunk.__perf.usage?.contextWindow ?? last.contextWindow;
                  const nextModel = chunk.__perf.model && chunk.__perf.model !== "gateway-injected" ? chunk.__perf.model : last.model;
                  return [...prev.slice(0, -1), { ...last, usage: { input, output }, model: nextModel, contextWindow, contextPercent: contextWindow && input > 0 ? Math.min(Math.round((input / contextWindow) * 100), 100) : last.contextPercent }];
                });
                return;
              }

              // __status（纯文本状态）
              if (chunk.__status) {
                setLingxiaMsgs((prev) => { const n = [...prev]; const last = n[n.length-1]; if (last?.role === "assistant") n[n.length-1] = { ...last, status: chunk.__status }; return n; });
                return;
              }

              // reasoning_content delta：不展示原始推理内容，避免伪装成工具调用。
              const reasoningDelta = chunk?.choices?.[0]?.delta?.reasoning_content;
              if (typeof reasoningDelta === "string" && reasoningDelta) {
                setLingxiaMsgs((prev) => {
                  const n = [...prev];
                  const last = n[n.length - 1];
                  if (last?.role !== "assistant" || last.status === "正在分析...") return prev;
                  n[n.length - 1] = { ...last, status: "正在分析..." };
                  return n;
                });
                return;
              }
              // 文本 delta
              const delta = chunk?.choices?.[0]?.delta?.content;
              if (delta) {
                // 收到 content delta → reasoning 阶段结束，mark thinking done
                setLingxiaMsgs((prev) => markThinkingDone(prev));
                const textMode = chunk.__text_mode === "snapshot" ? "snapshot" : "delta";
                setLingxiaMsgs((prev) => { const n = [...prev]; const last = n[n.length-1]; if (last?.role === "assistant") n[n.length-1] = { ...last, text: mergeAssistantStreamText(last.text, delta, textMode), status: undefined }; return n; });
              }
              // 完成
              if (chunk?.choices?.[0]?.finish_reason === "stop") {
                // 双保险：finish_reason=stop 也兜底 mark thinking done
                setLingxiaMsgs((prev) => markThinkingDone(prev));
                console.log("[DIAG] ✅ WSS finish_reason=stop，流结束");
                setLingxiaStreaming(false);
                wsClient.setRawHandler(null);
                if (conversationIdAtSend) void reconcileStreamedConversation({ conversationId: conversationIdAtSend, assistantMessageId, streamSeq: myStreamSeq, sessionKey: runtimeSessionKey || undefined });
              }
            } catch {}
          };
          wsClient.setRawHandler(wsHandler);
        const sent = wsClient.sendChat(text, undefined, { clientRunId, userMessageId, channel: "web", conversationId: webConversationId, runtimeMode: chatRuntimeMode });
        if (sent) {
          // WSS 响应超时检测：企业代理可能静默拦截 WSS 数据
          // 等待第一个有效事件，超时则降级到 HTTP SSE
          const WSS_FIRST_EVENT_TIMEOUT_MS = 15000;
          const firstEventOk = await new Promise<boolean>((resolve) => {
            let resolved = false;
            const timeout = setTimeout(() => {
              if (!resolved) { resolved = true; resolve(false); }
            }, WSS_FIRST_EVENT_TIMEOUT_MS);
            const origHandler = wsHandler;
            wsClient.setRawHandler((chunk: any) => {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve(true);
              }
              origHandler(chunk);
            });
          });

          if (!firstEventOk) {
            // OpenClaw 2026.4.29 can take 60-120s before the first stream event.
            // Once WSS send succeeds, do not HTTP-fallback and submit the same turn twice.
            console.warn("[WS] first event wait elapsed; keeping WSS active", { clientRunId });
          }
          // WSS submitted successfully; subsequent events are handled by wsHandler.
          wsOk = true;
          return;
        } else {
          console.log("[WS] send failed, falling back to HTTP");
        }
      }

      // ── HTTP SSE 路径（fallback）──
      console.log("[DIAG] 📡 进入 HTTP SSE 路径");
      const resp = await fetch(`${apiBase}/api/claw/chat-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({
          adoptId: resolvedAdoptId,
          message: text,
          model: effectiveLingxiaModelId,
          clientRunId,
          channel: "web",
          conversationId: webConversationId,
          runtimeMode: chatRuntimeMode,
          ...(shouldCancelPendingJiuwenPermission ? { cancelPendingPermission: true } : {}),
          ...(opts?.selectedSkillId ? { selectedSkillId: opts.selectedSkillId } : {}),
        }),
      });

      if (!resp.ok) {
        const payload = await resp.json().catch(() => null);
        throw new Error(String(payload?.error || `请求失败 (${resp.status})`));
      }
      if (!resp.body) throw new Error("请求失败：服务器未返回流式响应");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pendingDelta = "";
      let flushTimer: number | null = null;
      let firstChunkFlushed = false;
      let finalSnapshotReceived = false;

      const flushDelta = () => {
        // SSE race fix: 老流的累积 delta 扔掉，不污染新 placeholder
        if (isStale()) { pendingDelta = ""; return; }
        if (finalSnapshotReceived) { pendingDelta = ""; return; }
        if (!pendingDelta) return;
        if (!perf.firstPaintMs) perf.firstPaintMs = Date.now();
        const delta = pendingDelta;
        pendingDelta = "";
        setLingxiaMsgs((prev) => {
          const next = [...prev];
          if (next.length === 0 || next[next.length - 1].role !== "assistant") return prev;
          next[next.length - 1] = {
            ...next[next.length - 1],
            text: mergeAssistantStreamText(next[next.length - 1].text, delta),
            status: undefined,
          };
          return next;
        });
      };

      const scheduleFlush = () => {
        if (!firstChunkFlushed) {
          firstChunkFlushed = true;
          flushDelta();
          return;
        }
        if (flushTimer !== null) return;
        flushTimer = window.setTimeout(() => {
          flushTimer = null;
          flushDelta();
        }, 16);
      };

      let currentEvent = ""; // fix: 跨 chunk 保持 SSE event 状态
      let sseDone = false;
      let shouldReconcileCanonical = false;
      while (!sseDone) {
        const { done, value } = await reader.read();
        if (done) break;
        // SSE race fix: 已被新 send 踢掉，立刻停止解析
        if (isStale()) { sseDone = true; break; }
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";


        for (const line of lines) {
          // SSE event 标签行
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") {
            console.log("[DIAG] ✅ 收到 [DONE]，流结束");
            flushDelta();
            shouldReconcileCanonical = true;
            sseDone = true;
            break;
          }
          try {
            const chunk = JSON.parse(raw);
            lastEventAtRef.current = Date.now(); // 任意事件进来，重置断连计时
            const runDescriptor = parseRuntimeRunDescriptor(chunk);
            if (runDescriptor) {
              runtimeSessionKey = runDescriptor.sessionId;
              continue;
            }
            if (chunk.__model_selected) {
              const selectedModel = String(chunk.__model_selected);
              setLingxiaMsgs((prev) => {
                if (!prev.length || prev[prev.length - 1].role !== "assistant") return prev;
                const last = prev[prev.length - 1];
                return [...prev.slice(0, -1), { ...last, model: selectedModel }];
              });
              continue;
            }
            if (typeof chunk.__final_text === "string") {
              flushDelta();
              finalSnapshotReceived = true;
              setLingxiaMsgs((prev) => applyAssistantFinalSnapshot(prev, assistantMessageId, chunk.__final_text));
              continue;
            }
            if (currentEvent === "jiuwen_permission_request") {
              flushDelta();
              attachJiuwenPermissionToLastAssistant({
                requestId: String(chunk.requestId || ""),
                source: String(chunk.source || "permission_interrupt"),
                title: String(chunk.title || "权限审批"),
                question: String(chunk.question || ""),
                command: chunk.command ? String(chunk.command) : undefined,
                toolName: chunk.toolName ? String(chunk.toolName) : undefined,
                options: Array.isArray(chunk.options) ? chunk.options : undefined,
                state: "pending",
              });
              setLingxiaStreaming(false);
              currentEvent = "";
              continue;
            }
            if (currentEvent === "agent_status") {
              if (chunk.kind === "heartbeat") {
                if (chunk.tool) setActiveToolName(String(chunk.tool));
                if (chunk.elapsedMs) {
                  setActiveToolStartMs(Date.now() - Number(chunk.elapsedMs));
                }
              } else if (chunk.kind === "progress") {
                // 第二阶段：进度信号 → 更新 step/total/label
                if (chunk.tool) setActiveToolName(String(chunk.tool));
                if (chunk.step != null) setActiveToolStep(Number(chunk.step));
                if (chunk.total != null) setActiveToolTotal(Number(chunk.total));
                if (chunk.label) setActiveToolLabel(String(chunk.label));
                if (chunk.elapsedMs) {
                  setActiveToolStartMs(Date.now() - Number(chunk.elapsedMs));
                }
              }
              currentEvent = "";
              continue;
            }
            if (chunk.__status) {
              const status = String(chunk.__status);
              setLingxiaMsgs((prev) => {
                const next = [...prev];
                const lastIdx = next.length - 1;
                if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                  next[lastIdx] = { ...next[lastIdx], status };
                }
                return next;
              });
              if (chunk.tool) setActiveToolName(String(chunk.tool));
              if (chunk.elapsedMs) setActiveToolStartMs(Date.now() - Number(chunk.elapsedMs));
              continue;
            }
            if (chunk?.__perf && typeof chunk.__perf === "object") {
              Object.assign(perf, chunk.__perf);
              // 改动3: 不可写回 message（usage/model/context）
              setLingxiaMsgs(prev => {
                if (!prev.length || prev[prev.length - 1].role !== "assistant") return prev;
                const last = prev[prev.length - 1];
                const input =
                  chunk.__perf.usage?.input ?? chunk.__perf.usage?.inputTokens ?? last.usage?.input ?? 0;
                const output =
                  chunk.__perf.usage?.output ?? chunk.__perf.usage?.outputTokens ?? last.usage?.output ?? 0;
                const contextWindow =
                  chunk.__perf.usage?.contextWindow ?? last.contextWindow;
                const nextModel =
                  chunk.__perf.model && chunk.__perf.model !== "gateway-injected"
                    ? chunk.__perf.model
                    : last.model;
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    usage: { input, output },
                    model: nextModel,
                    contextWindow,
                    contextPercent:
                      contextWindow && input > 0
                        ? Math.min(Math.round((input / contextWindow) * 100), 100)
                        : last.contextPercent,
                  },
                ];
              });
              continue;
            }
            if (currentEvent === "tool_call") {
              const toolName = normalizeIncomingToolName(chunk);
              const toolTs = Date.now();
              const isGateway = Boolean(chunk._gateway);
              const executor = chunk.executor as ToolCallEntry["executor"] | undefined;
              // Gateway 内部工具：内联到消息卡片，不设顶部横幅
              if (isGateway) {
                setLingxiaMsgs((prev) => {
                  const next = [...prev];
                  const lastIdx = next.length - 1;
                  if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                    const existing = next[lastIdx].toolCalls || [];
                    next[lastIdx] = normalizeMessageToolEvents({ ...next[lastIdx], status: `正在调用工具：${toolName}`, toolCalls: [...existing, { id: String(chunk.id || ""), name: toolName, arguments: "{}", status: "running" as const, ts: toolTs, _gateway: true, executor: "gateway" }] });
                  }
                  return next;
                });
              } else {
                // exec 等服务端工具：设横幅 + 插卡片
                setActiveToolName(toolName);
                setActiveToolStartMs(toolTs);
                setActiveToolStep(null);
                setActiveToolTotal(null);
                setActiveToolLabel(null);
                setLingxiaMsgs((prev) => {
                  const next = [...prev];
                  const lastIdx = next.length - 1;
                  if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                    const existing = next[lastIdx].toolCalls || [];
                    next[lastIdx] = normalizeMessageToolEvents({ ...next[lastIdx], status: `正在调用工具：${toolName}`, toolCalls: [...existing, { id: String(chunk.id || ""), name: toolName, arguments: String(chunk.arguments || ""), status: "running" as const, ts: toolTs, executor }] });
                  }
                  return next;
                });
              }
              currentEvent = "";
              continue;
            }
            if (currentEvent === "tool_result") {
              const toolCallId = String(chunk.tool_call_id || "");
              const result = String(chunk.result ?? "");
              const isTimeout = chunk.policyDenyReason === "tool_timeout";
              const isGateway = Boolean(chunk._gateway);
              const status = chunk.is_error ? "error" : "done";
              const executor = chunk.executor as ToolCallEntry["executor"] | undefined;
              const truncated = Boolean(chunk.truncated);
              const suppressedOriginalResult = Boolean(chunk.suppressedOriginalResult);
              const policyDenyReason = chunk.policyDenyReason as string | undefined;
              const auditId = chunk.auditId as string | undefined;
              const outputFiles = Array.isArray(chunk.outputFiles) ? chunk.outputFiles as Array<{ name: string; size: number }> : undefined;
              // Gateway 内部工具完成：更新内联卡片状态
              if (isGateway) {
                setLingxiaMsgs((prev) => {
                  const next = [...prev];
                  const lastIdx = next.length - 1;
                  if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                    const tcs = next[lastIdx].toolCalls || [];
                    // 找到最后一个 gateway running 的卡片
                    const gwIdx = tcs.findLastIndex((tc) => tc._gateway && tc.status === "running");
                    if (gwIdx >= 0) {
                      const updated = [...tcs];
                      updated[gwIdx] = { ...updated[gwIdx], status: "done", durationMs: Date.now() - updated[gwIdx].ts };
                      next[lastIdx] = normalizeMessageToolEvents({ ...next[lastIdx], status: "正在整理结果...", toolCalls: updated });
                    }
                  }
                  return next;
                });
                currentEvent = "";
                continue;
              }
              setLingxiaMsgs((prev) => {
                const next = [...prev];
                const lastIdx = next.length - 1;
                if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                  const tcs = next[lastIdx].toolCalls || [];
                  next[lastIdx] = normalizeMessageToolEvents({ ...next[lastIdx], status: "正在整理结果...", toolCalls: tcs.map((tc) => tc.id === toolCallId ? { ...tc, result, status, durationMs: Date.now() - tc.ts, executor, truncated, suppressedOriginalResult, policyDenyReason, auditId, outputFiles, adoptId: resolvedAdoptId ?? undefined } : tc) as import("@/components/ChatMessage").ToolCallEntry[] });
                }
                return next;
              });
              // 超时时显示警告 3 秒后自动消失；普通完成后立即清除
              if (isTimeout) {
                setActiveToolName(`⏱️ 超时已中断（${Math.round((Date.now() - (activeToolStartMs ?? Date.now())) / 1000)}秒）`);
                setTimeout(() => { setActiveToolName(null); setActiveToolStartMs(null); setActiveToolStep(null); setActiveToolTotal(null); setActiveToolLabel(null); }, 3000);
              } else {
                setActiveToolName(null);
                setActiveToolStartMs(null);
                setActiveToolStep(null);
                setActiveToolTotal(null);
                setActiveToolLabel(null);
              }
              currentEvent = "";
              continue;
            }
            if (currentEvent === "workspace_files") {
              // 技能产出文件（workspace/output/）-> 下载卡片
              const wsFiles = Array.isArray(chunk.files) ? chunk.files as Array<{ name: string; size: number; path: string }> : [];
              const wsAdoptId = String(chunk.adoptId || "");
              if (wsFiles.length > 0) {
                const pseudoTc: import("@/components/ChatMessage").ToolCallEntry = {
                  id: `ws-files-${Date.now()}`,
                  name: "[产出文件]",
                  arguments: "{}",
                  result: wsFiles.map((f) => f.name).join(", "),
                  status: "done",
                  ts: Date.now(),
                  executor: "native",
                  outputFiles: wsFiles.map((f) => ({ name: f.name, size: f.size, wsPath: f.path })) as any,
                  adoptId: wsAdoptId,
                };
                setLingxiaMsgs((prev) => {
                  const next = [...prev];
                  const lastIdx = next.length - 1;
                  if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                    const existing = next[lastIdx].toolCalls || [];
                    next[lastIdx] = normalizeMessageToolEvents({ ...next[lastIdx], toolCalls: [...existing, pseudoTc] });
                  }
                  return next;
                });
              }
              currentEvent = "";
              continue;
            }
            // ── 统一语义：流结束 ──
            if (chunk.__stream_end) {
              console.log("[DIAG] ✅ 收到 __stream_end，流结束");
              flushDelta();
              shouldReconcileCanonical = true;
              sseDone = true;
              break;
            }
            // ── 2026-04-29 批次 2 A3：上游 EOF 但 runtime 未确认完成 ──
            if (chunk.__stream_truncated) {
              console.log("[DIAG] ⚠️ 收到 __stream_truncated，启动 recover:", chunk);
              flushDelta();
              handleStreamTruncated(chunk, lingxiaMsgsRef.current, setLingxiaMsgs);
              sseDone = true;
              break;
            }
            // ── 长度上限达到（finish_reason: length）──
            if (chunk.__stream_end_length) {
              console.log("[DIAG] ⚠️ 收到 __stream_end_length");
              flushDelta();
              setLingxiaMsgs((prev) => {
                const next = [...prev];
                if (next.length === 0 || next[next.length - 1].role !== "assistant") return prev;
                next[next.length - 1] = { ...next[next.length - 1], text: next[next.length - 1].text + "\n\n_⚠️ 已达模型长度上限，输出可能不完整_" };
                return next;
              });
              sseDone = true;
              break;
            }
            // ── 统一语义：终止性错误 ──
            if (chunk.__stream_error) {
              console.log("[DIAG] ❌ 收到 __stream_error:", chunk.error);
              flushDelta();
              setLingxiaMsgs((prev) => {
                const next = [...prev];
                if (next.length === 0 || next[next.length - 1].role !== "assistant") return prev;
                next[next.length - 1] = { ...next[next.length - 1], text: `（${chunk.error || "连接异常"}）` };
                return next;
              });
              sseDone = true;
              break;
            }
            if (chunk.error) {
              flushDelta();
              setLingxiaMsgs((prev) => {
                const next = [...prev];
                if (next.length === 0 || next[next.length - 1].role !== "assistant") return prev;
                next[next.length - 1] = { ...next[next.length - 1], text: `（${chunk.error}）` };
                return next;
              });
              continue;
            }
            // reasoning_content delta：不展示原始推理内容，避免伪装成工具调用。
            const httpReasoningDelta = chunk?.choices?.[0]?.delta?.reasoning_content;
            if (typeof httpReasoningDelta === "string" && httpReasoningDelta) {
              setLingxiaMsgs((prev) => {
                const next = [...prev];
                const lastIdx = next.length - 1;
                if (lastIdx < 0 || next[lastIdx].role !== "assistant" || next[lastIdx].status === "正在分析...") return prev;
                next[lastIdx] = { ...next[lastIdx], status: "正在分析..." };
                return next;
              });
              continue;
            }
            const deltaRaw = chunk?.choices?.[0]?.delta?.content;
            // content 有时是对象数组（MiniMax/GLM 等模型），需提取文本
            const delta = Array.isArray(deltaRaw)
              ? deltaRaw.map((c: any) => (typeof c === "string" ? c : (c?.text ?? ""))).join("")
              : (typeof deltaRaw === "string" ? deltaRaw : (deltaRaw != null ? String(deltaRaw) : ""));
            if (delta && !finalSnapshotReceived) {
              // 收到 content delta → reasoning 阶段结束，mark thinking done
              setLingxiaMsgs((prev) => markThinkingDone(prev));
              if (chunk.__text_mode === "snapshot") {
                flushDelta();
                setLingxiaMsgs((prev) => {
                  const next = [...prev];
                  const last = next[next.length - 1];
                  if (last?.role === "assistant") {
                    next[next.length - 1] = {
                      ...last,
                      text: mergeAssistantStreamText(last.text, delta, "snapshot"),
                      status: undefined,
                    };
                  }
                  return next;
                });
              } else {
                pendingDelta += delta;
                scheduleFlush();
              }
            }
            // HTTP 路径 finish_reason=stop 兜底 mark thinking done
            if (chunk?.choices?.[0]?.finish_reason === "stop") {
              setLingxiaMsgs((prev) => markThinkingDone(prev));
            }
          } catch {
            // 忽略非 JSON 行
          }
        }
      }

      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushDelta();

      perf.clientDoneMs = Date.now();
      const toDur = (a?: number, b?: number) => (a && b ? Math.max(0, b - a) : null);
      // 工作台最小埋点：用于定位慢在模型/后端首包/前端首刷
      console.table({
        totalMs: toDur(perf.clientSendMs, perf.clientDoneMs),
        clientToServerEnterMs: toDur(perf.clientSendMs, perf.routeEnterMs),
        serverEnterToGatewayReqMs: toDur(perf.routeEnterMs, perf.gatewayRequestStartMs),
        gatewayReqToFirstUpstreamChunkMs: toDur(perf.gatewayRequestStartMs, perf.upstreamFirstChunkMs),
        firstUpstreamChunkToFirstPaintMs: toDur(perf.upstreamFirstChunkMs, perf.firstPaintMs),
        firstPaintToDoneMs: toDur(perf.firstPaintMs, perf.clientDoneMs),
      });
      if (shouldReconcileCanonical && !isStale() && conversationIdAtSend) {
        void reconcileStreamedConversation({ conversationId: conversationIdAtSend, assistantMessageId, streamSeq: myStreamSeq, sessionKey: runtimeSessionKey || undefined });
      }
    } catch (error: any) {
      // SSE race fix: stale 流的 AbortError / 网络错误都不要写 state，否则会污染新流
      if (isStale()) return;
      if (error?.name === "AbortError") {
        setLingxiaMsgs((prev) => {
          const next = [...prev];
          if (next.length > 0 && next[next.length - 1].role === "assistant" && next[next.length - 1].text === "") {
            next[next.length - 1] = { ...next[next.length - 1], text: "（已停止生成）" };
          }
          return next;
        });
        return;
      }
      // 网络错误 / fetch 失败 → 进入"重连中"状态，不直接判任务失败
      if (conversationIdAtSend && runtimeSessionKey) {
        void reconcileStreamedConversation({
          conversationId: conversationIdAtSend,
          assistantMessageId,
          streamSeq: myStreamSeq,
          sessionKey: runtimeSessionKey,
        });
      }
      setConnStatus("reconnecting");
      setLingxiaMsgs((prev) => {
        const next = [...prev];
        const msg = error?.message || "实时连接中断，正在尝试恢复…";
        if (next.length > 0 && next[next.length - 1].role === "assistant" && next[next.length - 1].text === "") {
          next[next.length - 1] = { ...next[next.length - 1], text: msg };
        } else {
          next.push({ id: makeLxMsgId(), role: "assistant", text: msg, timeLabel: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) });
        }
        return next;
      });
    } finally {
      // SSE race fix: stale 流不要清 abortRef / streaming / activeTool，否则会误杀新流
      if (!isStale()) {
        lingxiaStreamAbortRef.current = null;
        if (!wsOk) setLingxiaStreaming(false);
        setConnStatus("connected");
        setActiveToolName(null);
        setActiveToolStartMs(null);
        setActiveToolStep(null);
        setActiveToolTotal(null);
        setActiveToolLabel(null);
      }
    }
  };


  const resetLingxiaSession = async () => {
    if (!resolvedAdoptId || activeLingxiaStreaming) return;
    const ok = await confirm({
      title: "重置会话？",
      description: "确认重置会话？将清空当前会话上下文。",
      confirmText: "重置",
      variant: "danger",
    });
    if (!ok) return;

    try {
      setLingxiaStreaming(true);
      const apiBase = import.meta.env.VITE_API_URL || "";
      const resp = await fetch(`${apiBase}/api/claw/chat-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ adoptId: resolvedAdoptId, message: "/reset", channel: "web", conversationId: webConversationId, runtimeMode: chatRuntimeMode }),
      });

      if (!resp.ok) throw new Error(`重置失败 (${resp.status})`);
      setLingxiaMsgs([]);
      localStorage.removeItem("lingxia-chat-history");
      if (MSGS_KEY) localStorage.removeItem(MSGS_KEY);
      if (resolvedAdoptId && userStorageId) {
        const nextConversationId = makeConversationId();
        localStorage.setItem(webConversationStorageKey(userStorageId, resolvedAdoptId), nextConversationId);
        setWebConversationId(nextConversationId);
      }
      // 后端已重置旧会话；前端同时切到新的 conversationId，避免下次打开继续命中旧本地历史。
      toast.success("会话已重置（新会话）");
    } catch (error: any) {
      toast.error(error?.message || "重置会话失败");
    } finally {
      setLingxiaStreaming(false);
    }
  };

  const saveLingxiaSettings = async () => {
    if (!resolvedAdoptId || !user) {
      toast.error("请先登录后再保存设置");
      return;
    }
    await updateClawSettingsMutation.mutateAsync({
      adoptId: resolvedAdoptId,
      memoryEnabled: lingxiaMemoryEnabled,
      contextTurns: lingxiaContextTurns,
    });
  };

  useEffect(() => {
    if (!isLingxiaSubdomain) return;

    let cancelled = false;

    fetchWithTimeout("/api/meta/runtime-versions", {}, 3000)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const openclaw = (d?.openclaw || "").toString().trim();
        const jiuwenswarm = (d?.jiuwenswarm || "").toString().trim();
        if (openclaw) setOpenclawVersion(openclaw);
        if (jiuwenswarm && jiuwenswarm !== "unknown") setJiuwenswarmVersion(`JiuwenSwarm v${jiuwenswarm}`);
      })
      .catch(() => {
        fetchWithTimeout("/api/meta/openclaw-version", {}, 3000)
          .then(r => r.json())
          .then(d => {
            if (cancelled) return;
            const v = (d?.version || "").toString().trim();
            if (v) setOpenclawVersion(v);
          })
          .catch(() => {});
      });

    if (resolvedAdoptId && user) {
      const requestStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      fetchWithTimeout(`/api/claw/runtime-info?adoptId=${encodeURIComponent(resolvedAdoptId)}`, {}, 4000)
        .then(r => r.json())
        .then(d => {
          if (!cancelled) setRuntimeAgentId(String(d?.runtimeAgentId || ""));
          if (!cancelled) markClientLoadMetric("runtimeInfo", "ok", String(d?.runtimeAgentId || "loaded"), requestStartedAt);
        })
        .catch(() => {
          if (!cancelled) setRuntimeAgentId("");
          if (!cancelled) markClientLoadMetric("runtimeInfo", "error", "request failed", requestStartedAt);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [isLingxiaSubdomain, markClientLoadMetric, resolvedAdoptId, user]);

  // 岗位智能体聊天消息区：仅在接近底部时自动跟随
  const lingxiaMsgsEndRef = useRef<HTMLDivElement>(null);
  const isLingxiaNearBottom = useCallback(() => {
    const el = lingxiaMsgViewportRef.current;
    if (!el) return true;
    const threshold = 100;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);
  const scrollLingxiaToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = lingxiaMsgViewportRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const navigateToConversationPrompt = useCallback((messageId: string) => {
    const viewport = lingxiaMsgViewportRef.current;
    const target = lingxiaMessageNodeRefs.current.get(messageId);
    if (!viewport || !target) return;

    lingxiaManualNavigationRef.current = true;
    updateLingxiaNearBottom(false);
    setActiveConversationPromptId(messageId);

    const viewportRect = viewport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = viewport.scrollTop + targetRect.top - viewportRect.top - 24;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? "auto" : "smooth" });
  }, [updateLingxiaNearBottom]);

  useEffect(() => {
    lingxiaManualNavigationRef.current = false;
    setActiveConversationPromptId("");
  }, [webConversationId]);

  useEffect(() => {
    const viewport = lingxiaMsgViewportRef.current;
    const promptIds = conversationPromptIdsKey ? conversationPromptIdsKey.split("\n") : [];
    const promptIdSet = new Set(promptIds);
    for (const messageId of lingxiaMessageRefCallbacks.current.keys()) {
      if (!promptIdSet.has(messageId)) lingxiaMessageRefCallbacks.current.delete(messageId);
    }
    if (!viewport || promptIds.length === 0) {
      setActiveConversationPromptId("");
      return;
    }

    const updateActivePrompt = () => {
      const viewportRect = viewport.getBoundingClientRect();
      const guideY = viewportRect.top + viewportRect.height * 0.28;
      let nextActiveId = promptIds[0];
      for (const promptId of promptIds) {
        const node = lingxiaMessageNodeRefs.current.get(promptId);
        if (!node) continue;
        if (node.getBoundingClientRect().top <= guideY) nextActiveId = promptId;
        else break;
      }
      setActiveConversationPromptId((current) => current === nextActiveId ? current : nextActiveId);
    };

    updateActivePrompt();
    const observer = new IntersectionObserver(updateActivePrompt, {
      root: viewport,
      rootMargin: "-22% 0px -70% 0px",
      threshold: [0, 0.01],
    });
    for (const promptId of promptIds) {
      const node = lingxiaMessageNodeRefs.current.get(promptId);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [conversationPromptIdsKey, webConversationId]);

  useEffect(() => {
    const el = lingxiaMsgViewportRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = isLingxiaNearBottom();
      if (nearBottom) lingxiaManualNavigationRef.current = false;
      updateLingxiaNearBottom(nearBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [isLingxiaNearBottom, updateLingxiaNearBottom]);

  useEffect(() => {
    const lastMessage = activeLingxiaMsgs[activeLingxiaMsgs.length - 1];
    const userJustSent = lastMessage?.role === "user";
    if (userJustSent) {
      lingxiaManualNavigationRef.current = false;
      updateLingxiaNearBottom(true);
    }
    if (userJustSent || (!lingxiaManualNavigationRef.current && lingxiaNearBottomRef.current)) {
      scrollLingxiaToBottom(activeLingxiaStreaming ? "auto" : "smooth");
    }
  }, [activeLingxiaMsgs, activeLingxiaStreaming, scrollLingxiaToBottom, updateLingxiaNearBottom]);

  // 技能行子组件
  // 技能行组件（内联，避免 Hook 规则问题）
  const SkillRow = ({ sk, onToggle, pending }: { sk: { id: string; emoji: string; label: string; desc: string; active: boolean }; onToggle: () => void; pending: boolean }) => (
    <div className="flex items-center px-4 py-2 gap-2">
      <span style={{ fontSize: 14 }}>{sk.emoji}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate" style={{ color: sk.active ? "var(--oc-text-primary)" : "#70788e" }}>{sk.label}</p>
        <p className="text-xs truncate" style={{ color: "var(--oc-text-tertiary)" }}>{sk.desc}</p>
      </div>
      <button onClick={onToggle} disabled={pending}
        className="shrink-0 relative rounded-full transition-colors"
        style={{ width: 30, height: 16, background: sk.active ? "#9e1822" : "rgba(255,255,255,0.08)", border: "none", cursor: "pointer", flexShrink: 0 }}>
        <span className="absolute top-[2px] rounded-full transition-all"
          style={{ width: 12, height: 12, background: "#fff", left: sk.active ? 16 : 2, opacity: sk.active ? 1 : 0.4 }} />
      </button>
    </div>
  );

  const sidebarClawStatus = String((clawByAdoptId as any)?.status || cachedClawStatus || "");
  const sidebarClawOnline = sidebarClawStatus === "active";
  const clientLoadMetricList = useMemo(() => (
    Object.values(clientLoadMetrics).sort((a, b) => clientMetricDisplayMs(a) - clientMetricDisplayMs(b))
  ), [clientLoadMetrics]);
  const primaryClientLoadMetricList = useMemo(() => (
    clientLoadMetricList.filter((metric) => CLIENT_LOAD_PRIMARY_KEYS.has(metric.key))
  ), [clientLoadMetricList]);
  const clientLoadTotalMs = useMemo(() => {
    // 优先统计各探针的真实请求往返耗时(requestMs)，没有 requestMs 的早期 TRPC/auth 探针
    // 使用首次完成时相对页面加载的 elapsedMs 作为首屏耗时近似值。
    // 旧实现用 (now - 页面加载时刻)，但探针每 30s 定时重测、切回标签页(focus)也重测，
    // 每次重测都把 elapsedMs 刷成"自页面打开以来的时长"，导致数值随页面停留时间无限增长，
    // 首屏之后就退化成"页面开了多久"，表现为忽高忽低（刚打开~200ms，开一会儿跳到几千ms）。
    return primaryClientLoadMetricList.reduce((max, metric) => Math.max(max, clientMetricDisplayMs(metric)), 0);
  }, [primaryClientLoadMetricList]);
  const reportClientLoadMetrics = useCallback(async (reason: string) => {
    if (!resolvedAdoptId || !user || clientLoadReportedRef.current || clientLoadMetricList.length === 0) return;
    clientLoadReportedRef.current = true;
    const payload = {
      adoptId: resolvedAdoptId,
      reason,
      path: `${window.location.pathname}${window.location.search}`,
      totalMs: clientLoadTotalMs,
      metrics: clientLoadMetricList,
    };
    console.info("[client-load]", payload);
    try {
      await fetchWithTimeout("/api/claw/client-load-metrics", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, 2500);
    } catch {}
  }, [clientLoadMetricList, clientLoadTotalMs, resolvedAdoptId, user]);
  useEffect(() => {
    if (!resolvedAdoptId || !user || clientLoadReportedRef.current) return;
    const coreKeys = ["auth", "agent", "models", "health", "skills"];
    if (coreKeys.every((key) => clientLoadMetrics[key])) {
      void reportClientLoadMetrics("core-ready");
    }
  }, [clientLoadMetrics, reportClientLoadMetrics, resolvedAdoptId, user]);
  useEffect(() => {
    if (!resolvedAdoptId || !user || clientLoadReportedRef.current) return;
    const timer = window.setTimeout(() => void reportClientLoadMetrics("timeout"), 8500);
    return () => window.clearTimeout(timer);
  }, [reportClientLoadMetrics, resolvedAdoptId, user]);
  const chatReadinessBanner = useMemo(() => {
    if (!resolvedAdoptId || isDirectHttpRuntime) return null;
    if (activeLingxiaStreaming && clawHealthError) return null;
    if (showSlowReadinessHint && clawByAdoptLoading && !clawByAdoptId) {
      return { severity: "info" as const, text: "正在连接 OpenClaw…", detail: "" };
    }
    if (!clawByAdoptLoading && !clawByAdoptId) {
      return { severity: "error" as const, text: "未找到当前岗位智能体实例", detail: "请确认实例仍有效，或切换到有权限的工作台。" };
    }
    if (clawHealthError) {
      return { severity: "warning" as const, text: "健康检查暂时不可用", detail: clawHealthError };
    }
    const readiness = clawHealthSummary?.readiness;
    if (!readiness && clawHealthLoading && showSlowReadinessHint) {
      return { severity: "info" as const, text: "正在检查模型与 OpenClaw 配置…", detail: "" };
    }
    if (!readiness) return null;
    const selectedModel = String(clawHealthSummary?.model?.selected || effectiveLingxiaModelId || "").trim();
    const elapsed = Number(clawHealthSummary?.timings?.total || 0);
    const elapsedText = elapsed > 0 ? ` · ${elapsed}ms` : "";
    if (readiness.status === "blocked" || readiness.ok === false) {
      return {
        severity: "error" as const,
        text: readiness.summary || "当前智能体配置不可用",
        detail: selectedModel ? `当前模型：${selectedModel}${elapsedText}` : elapsedText.replace(/^ · /, ""),
      };
    }
    if (readiness.status === "degraded" || (readiness.issues || []).length > 0) {
      return {
        severity: "warning" as const,
        text: readiness.summary || "部分配置需要检查",
        detail: selectedModel ? `当前模型：${selectedModel}${elapsedText}` : elapsedText.replace(/^ · /, ""),
      };
    }
    return null;
  }, [
    clawByAdoptId,
    clawByAdoptLoading,
    activeLingxiaStreaming,
    clawHealthError,
    clawHealthLoading,
    clawHealthSummary,
    effectiveLingxiaModelId,
    isDirectHttpRuntime,
    resolvedAdoptId,
    showSlowReadinessHint,
  ]);

  const accessGateShell = (title: string, desc: string, action?: any) => (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <BrandIcon size={36} animate={false} />
        <h1 className="mt-5 text-xl font-semibold text-slate-950">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">{desc}</p>
        {action ? <div className="mt-6">{action}</div> : null}
      </div>
    </div>
  );

  if (resolvedAdoptId && !authLoading && !user) {
    return accessGateShell("请先登录", "登录后才能访问岗位智能体工作台，未登录状态不会展示实例页面。");
  }

  if (resolvedAdoptId && user && (clawByAdoptError || (!clawByAdoptLoading && !clawByAdoptId))) {
    return accessGateShell(
      "无权访问该工作台",
      "当前账号没有该岗位智能体实例的访问权限。请切换到实例所属账号，或返回自己的工作台。",
      <button
        type="button"
        onClick={() => setLocationCoop("/")}
        className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        返回首页
      </button>,
    );
  }

  if (isLingxiaSubdomain) {
    return (
      <>
      {dialog}
      <CustomMcpDialog
        open={customMcpDialogOpen}
        initialMode={customMcpDialogMode}
        adoptId={resolvedAdoptId || ""}
        onOpenChange={setCustomMcpDialogOpen}
        onChanged={() => loadComposerConnectors({ silent: true })}
      />
      <input
        ref={skillPackageInputRef}
        type="file"
        accept=".zip,.skill,application/zip"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleSkillPackageUpload(file);
        }}
      />
      <div className="h-screen overflow-hidden flex flex-col lingxia-shell" style={{ background: "var(--oc-bg)", color: "var(--oc-text-primary)" }}>

        {/* ── Body ── */}
        <div
          className="flex-1 min-h-0 flex overflow-hidden"
          style={
            {
              "--lingxia-sidebar-width": `${effectiveSidebarCollapsed ? 72 : sidebarWidth}px`,
              "--lingxia-topbar-height": "52px",
            } as CSSProperties
          }
        >

          {isMobileViewport && mobileSidebarOpen ? (
            <button
              type="button"
              className="workbench-mobile-sidebar-backdrop"
              aria-label="关闭导航"
              onClick={() => setMobileSidebarOpen(false)}
            />
          ) : null}

          {/* ── 左侧：折叠面板 ── */}
          <aside
            id="workbench-navigation"
            aria-hidden={isMobileViewport && !mobileSidebarOpen ? true : undefined}
            className={`lingxia-sidebar-panel relative flex-none flex flex-col overflow-hidden shrink-0 hide-all-scrollbars ${mobileSidebarOpen ? "is-mobile-open" : ""}`}
            style={{ width: effectiveSidebarCollapsed ? 72 : sidebarWidth, transition: "width 0.2s ease, transform 0.2s ease" }}
          >
            <button
              type="button"
              title={effectiveSidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
              onClick={() => setSidebarCollapsed(v => !v)}
              className="workbench-sidebar-collapse absolute right-2 top-[20px] z-40 flex items-center justify-center rounded-md"
              style={{ width: 22, height: 22, background: "transparent", border: "none", color: "var(--oc-text-tertiary)", fontSize: 16 }}
            >
              {effectiveSidebarCollapsed ? "»" : "«"}
            </button>

            {/* 实例信息头 */}
            <div className="shrink-0 flex items-center gap-2.5" style={{ padding: "10px 8px 14px", borderBottom: "1px solid var(--oc-border-subtle)" }}>
              <div
                className="rounded-full shrink-0 flex items-center justify-center relative"
                style={{ width: 38, height: 38, background: "var(--oc-sidebar-avatar-bg)", color: "var(--oc-sidebar-muted)" }}
              >
                <WorkforceAgentIcon size={26} animate={false} breathe={false} />
                {sidebarClawOnline ? (
                  <span
                    aria-hidden="true"
                    className="absolute rounded-full"
                    style={{
                      width: 9,
                      height: 9,
                      right: 1,
                      bottom: 1,
                      background: "#1D9E75",
                      border: "1.5px solid var(--oc-sidebar-bg)",
                    }}
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 pr-5" style={{ display: effectiveSidebarCollapsed ? "none" : "block" }}>
                <p className="truncate" style={{ color: "var(--oc-sidebar-text)", fontSize: 14, fontWeight: 600, lineHeight: "20px" }}>岗位智能体</p>
                <p className="truncate" style={{ color: "var(--oc-sidebar-subtle)", fontSize: 12, fontWeight: 400, lineHeight: "17px" }} title={lingxiaDisplayName || brand.name}>
                  {lingxiaDisplayName || brand.name}
                </p>
              </div>
            </div>

            {/* 工作台导航（Phase A） */}
              <Sidebar
                activePage={activePage}
                setActivePage={selectWorkbenchPage}
                navigationSelectionActive={sidebarSelection === "navigation"}
                collapsed={effectiveSidebarCollapsed}
                coopBadge={coopBadgeCount}
                sessions={webSessions}
              currentConversationId={sidebarSelection === "session" ? webConversationId : undefined}
              sessionSwitchingId={sessionSwitchingId}
              messageSearchProvider={findCachedConversationSnippet}
              onSwitchConversation={(conversationId) => {
                setSidebarSelection("session");
                setActivePage("chat");
                setMobileSidebarOpen(false);
                void switchLingxiaConversation(conversationId);
              }}
              onDeleteConversation={(conversationId) => void deleteLingxiaConversation(conversationId)}
              onRenameConversation={renameLingxiaConversation}
              onTogglePinConversation={togglePinLingxiaConversation}
              onNewConversation={startNewLingxiaConversation}
              sessionsLoading={webSessionsLoading && webSessions.length === 0}
              footer={(
                <SidebarFooter
                  version={isJiuwenRuntime ? jiuwenswarmVersion : isLegacyArchivedRuntime ? "Legacy runtime" : openclawVersion}
                  userName={String((user as any)?.name || "")}
                  userEmail={String((user as any)?.email || "")}
                  collapsed={effectiveSidebarCollapsed}
                  onOpenGrowth={() => {
                    setSidebarSelection("navigation");
                    setActivePage("agent");
                    setMobileSidebarOpen(false);
                  }}
                  onReturnHome={() => setLocationCoop("/")}
                  onLogout={() => void handleWorkbenchLogout()}
                />
              )}
            />

            <div
              onMouseDown={(e) => {
                e.preventDefault();
                const onMove = (ev: MouseEvent) => {
                  const w = Math.min(Math.max(ev.clientX, 248), 520);
                  setSidebarWidth(w);
                };
                const onUp = () => {
                  document.removeEventListener("mousemove", onMove);
                  document.removeEventListener("mouseup", onUp);
                  document.body.style.cursor = "";
                  document.body.style.userSelect = "";
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
              }}
              className="absolute top-0 right-0 w-2 h-full cursor-col-resize z-30 border-l border-dashed border-transparent hover:border-primary/30 hover:bg-white/5 transition-colors"
              style={{ display: effectiveSidebarCollapsed || isMobileViewport ? "none" : "block" }}
            />
          </aside>


          {/* ── 右侧主面板 ── */}
          <div className="lingxia-main-panel flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* 全局顶部栏 */}
          <TopBar
            activePage={activePage}
            leading={isMobileViewport ? (
              <button
                type="button"
                className="workbench-mobile-menu-trigger"
                aria-label="打开导航"
                aria-controls="workbench-navigation"
                aria-expanded={mobileSidebarOpen}
                onClick={() => setMobileSidebarOpen(true)}
              >
                <Menu size={18} />
              </button>
            ) : undefined}
            right={isLingxiaSubdomain ? (
              <div className="workbench-topbar-actions">
              {activePage === "chat" && resolvedAdoptId ? (
                <button
                  type="button"
                  className={`workbench-workspace-trigger ${workspacePanelOpen ? "is-active" : ""}`}
                  onClick={() => setWorkspacePanelOpen((open) => !open)}
                  title={workspacePanelOpen ? "关闭工作空间" : "打开工作空间"}
                  aria-label={workspacePanelOpen ? "关闭工作空间" : "打开工作空间"}
                  aria-expanded={workspacePanelOpen}
                >
                  <FolderOpen size={16} />
                </button>
              ) : null}
              </div>
            ) : undefined}
          />

          <div
            ref={workbenchContentRef}
            className={`workbench-content-row ${workspacePanelResizing ? "is-resizing" : ""}`}
            data-workspace-open={workspacePanelOpen && activePage === "chat" ? "true" : "false"}
          >
          <div className="workbench-primary-pane">
          {activePage === "chat" ? (
          <ChatPage>
          <PanelErrorBoundary
            resetKey={`chat:${resolvedAdoptId || ""}:${webConversationId}`}
            title="主对话暂时不可用"
            description="聊天区域渲染时出现异常，历史会话和其他功能仍可继续使用。"
          >
          <main className="relative flex-1 min-w-0 flex flex-col overflow-hidden">
            <div className="md:hidden relative flex-none px-3 py-2" style={{ borderBottom: "1px solid var(--oc-border-subtle)", background: "var(--oc-bg)" }}>
              <div ref={sessionMenuRef} className="relative flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSessionMenuOpen((v) => !v)}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm"
                  style={{
                    border: "1px solid var(--oc-border-subtle)",
                    background: "var(--oc-bg-surface)",
                    color: "var(--oc-text-primary)",
                  }}
                >
                  <History size={15} />
                  <span>历史</span>
                  <span style={{ color: "var(--oc-text-tertiary)" }}>{webSessions.length}</span>
                </button>
                {sessionMenuOpen ? (
                  <div
                    className="absolute left-0 right-0 top-[44px] z-50 rounded-lg p-3 shadow-xl"
                    style={{
                      maxHeight: "62vh",
                      border: "1px solid var(--oc-border-subtle)",
                      background: "var(--oc-bg-surface)",
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    <SessionList
                      sessions={webSessions}
                      currentConversationId={sidebarSelection === "session" ? webConversationId : undefined}
                      sessionSwitchingId={sessionSwitchingId}
                      messageSearchProvider={findCachedConversationSnippet}
                      onSwitchConversation={(conversationId) => {
                        setSidebarSelection("session");
                        setActivePage("chat");
                        void switchLingxiaConversation(conversationId);
                      }}
                      onDeleteConversation={(conversationId) => void deleteLingxiaConversation(conversationId)}
                      onRenameConversation={renameLingxiaConversation}
                      onTogglePinConversation={togglePinLingxiaConversation}
                      onNewConversation={startNewLingxiaConversation}
                      variant="mobile"
                      searchable
                      title="会话"
                      loading={webSessionsLoading && webSessions.length === 0}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            {/* 消息区 */}
            <div
              ref={lingxiaMsgViewportRef}
              className="flex-1 min-h-0 overflow-y-auto pt-6 stealth-scrollbar" style={{ paddingBottom: 100 }}
            >
              <div className="mx-auto w-full max-w-[880px] px-6 space-y-5">

              {clawByAdoptLoading && activeLingxiaMsgs.length === 0 ? <ChatStartupSkeleton /> : null}

              {!clawByAdoptLoading && !clawByAdoptId && (
                <div className="max-w-4xl rounded-xl p-4 text-sm" style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", color: "#d4a030" }}>
                  未找到该岗位智能体实例，可能已过期或尚未完成创建。
                </div>
              )}

              {!clawByAdoptLoading && clawByAdoptId && activeLingxiaMsgs.length === 0 && (
                <div className="max-w-4xl py-2 lingxia-msg-fade lingxia-welcome-message">
                  你好，我是 <span>{lingxiaDisplayName || brand.name}</span>，有什么想聊的？
                </div>
              )}

              {activeLingxiaMsgs.map((m, idx) => {
                const isLast = idx === activeLingxiaMsgs.length - 1;
                const isPlaceholder = isLast && m.role === "assistant" && m.text === "" && activeLingxiaStreaming;
                const messageAgentTasks = m.role === "assistant"
                  ? extractAgentTaskIds(m.text)
                      .map((id) => agentTasksById.get(id))
                      .filter((task): task is AgentTask => Boolean(task))
                  : [];
                return (
                  <div
                    key={m.id || `${m.role}-${idx}`}
                    ref={m.role === "user" ? getLingxiaMessageRef(m.id) : undefined}
                    data-conversation-prompt={m.role === "user" ? m.id : undefined}
                  >
                  <ChatMessage
                    role={m.role as "user" | "assistant"}
                    text={m.text}
                    status={m.status}
                    isLast={isLast}
                    isPlaceholder={isPlaceholder}
                    streaming={isLast && activeLingxiaStreaming}
                    displayName={lingxiaDisplayName || brand.name}
                    modelId={m.model || effectiveLingxiaModelId || "default"}
                    timeLabel={m.timeLabel}
                    attachments={m.attachments?.map((file) => ({
                      ...file,
                      adoptId: file.adoptId || resolvedAdoptId,
                    }))}
                    toolCalls={m.role === "assistant" ? (m.toolCalls ?? (isLast && lingxiaStreaming ? lingxiaToolCalls : [])) : undefined}
                    messageEvents={m.role === "assistant" ? (m as LxMsg).messageEvents : undefined}
                    agentTasks={messageAgentTasks}
                    showToolCalls={lingxiaShowToolCalls}
                    usage={m.usage}
                    contextPercent={m.contextPercent}
                    feedback={m.role === "assistant" ? messageFeedbackById[m.id] || null : null}
                    feedbackPending={messageFeedbackPendingIds.has(m.id)}
                    onFeedback={m.role === "assistant" ? (feedback) => updateMessageFeedback(m, feedback) : undefined}
                    onForgetMemory={m.role === "assistant" && resolvedAdoptId
                      ? (memoryId) => forgetMemoryMutation.mutateAsync({ adoptId: resolvedAdoptId, id: memoryId }).then(() => undefined)
                      : undefined}
                    jiuwenPermission={m.role === "assistant" ? (m as LxMsg).jiuwenPermission : undefined}
                    onJiuwenPermissionAnswer={(permission, action) => void handleJiuwenPermissionAnswer(m.id, permission, action)}
                    onDelete={m.role === "assistant" ? () => { setLingxiaMsgs(prev => prev.filter((_, i) => i !== idx)); } : undefined}
                  />
                  </div>
                );
              })}

              <div ref={lingxiaMsgsEndRef} />
              </div>
            </div>

            <ConversationNavigator
              items={conversationNavigatorItems}
              activeId={activeConversationPromptId}
              onNavigate={navigateToConversationPrompt}
            />

            {!lingxiaNearBottom && (
              <div className="pointer-events-none absolute right-8 bottom-24 z-20">
                <button
                  className="pointer-events-auto text-xs px-3 py-1.5 rounded-full shadow-md"
                  style={{ background: "var(--oc-bg-surface)", border: "1px solid var(--oc-border-strong)", color: "var(--oc-text-primary)" }}
                  onClick={() => {
                    lingxiaManualNavigationRef.current = false;
                    updateLingxiaNearBottom(true);
                    scrollLingxiaToBottom("smooth");
                  }}
                >
                  回到底部
                </button>
              </div>
            )}

            {/* 输入区 */}
            {chatReadinessBanner ? (
              <div className={`lingxia-readiness-banner lingxia-readiness-banner--${chatReadinessBanner.severity}`}>
                <span className="lingxia-readiness-banner__dot" />
                <span className="lingxia-readiness-banner__text">{chatReadinessBanner.text}</span>
                {chatReadinessBanner.detail ? (
                  <span className="lingxia-readiness-banner__detail">{chatReadinessBanner.detail}</span>
                ) : null}
              </div>
            ) : null}
            <ChatInput
              value={lingxiaInput}
              onChange={setLingxiaInput}
              onSend={async (files = []) => {
                const text = (lingxiaInput || "").trim();
                if (!text && files.length === 0) return false;
                const selectedExpert = selectedComposerExpert;
                if (selectedExpert && files.length > 0) {
                  toast.error("专家任务暂不支持附件，请先发送文字任务");
                  return false;
                }
                let finalText = text;
                let messageAttachments: ChatMessageAttachment[] = [];
                if (files.length > 0) {
                  try {
                    const uploaded = await uploadLingxiaAttachments(files);
                    finalText = buildUploadedAttachmentRuntimeMessage(text, uploaded);
                    messageAttachments = uploaded.map((file) => ({
                      name: file.name,
                      size: file.size,
                      path: file.path,
                      adoptId: resolvedAdoptId,
                    }));
                    toast.success(`已上传 ${uploaded.length} 个附件`);
                  } catch (error: any) {
                    toast.error(error?.message || "附件上传失败");
                    return false;
                  }
                }
                const selectedSkillId = selectedComposerSkill?.id;
                setSelectedComposerSkillId("");
                if (selectedExpert) {
                  return submitExpertTask({
                    expert: selectedExpert,
                    text: finalText,
                    displayText: text,
                    attachments: messageAttachments,
                  });
                }
                // 重扫 text 里实际还有的 @userName，过滤掉用户已删除的 mention（防 mentionedUsers 状态 ghost）
                // 既有限制：textarea 是 plain text，不是 chip，删除标签靠这里 reconcile 兜底
                const liveMentions = mentionedUsers.filter((u) => text.includes(`@${u.userName}`));
                if (liveMentions.length === 0) {
                  // 没 @ 任何人 → 普通消息
                  if (mentionedUsers.length > 0) setMentionedUsers([]);
                  void sendLingxiaMessage(finalText, {
                    selectedSkillId,
                    displayText: text || (messageAttachments.length > 0 ? "请查看我上传的附件。" : ""),
                    attachments: messageAttachments,
                  });
                  return true;
                }
                if (!text) { toast.error("请先输入任务内容再发起协作"); return; }
                if (liveMentions.length === 1) {
	                  // 1:1 协作 → 直接 coop.create，跳 /coop/:sessionId（保持原行为）
	                  coopCreateFromChatMut.mutate({
	                    title: text.slice(0, 80).split(/\n/)[0] || "主聊天发起的协作",
	                    originMessage: finalText,
	                    creatorAdoptId: resolvedAdoptId || "lgc-creator",
	                    members: liveMentions.map((u) => ({
	                      userId: u.userId,
	                      targetAdoptId: u.adoptId || `mock:${u.userId}`,
	                      subtask: finalText,
	                    })),
	                  });
                    clearLingxiaDraft();
                    setMentionedUsers([]);
                    setLingxiaInput("");
	                  return true;
	                }
                coopCreateFromChatMut.mutate({
                  title: text.slice(0, 80).split(/\n/)[0] || "主聊天发起的协作",
                  originMessage: finalText,
                  creatorAdoptId: resolvedAdoptId || "lgc-creator",
                  members: liveMentions.map((u) => ({
                    userId: u.userId,
                    targetAdoptId: u.adoptId || `mock:${u.userId}`,
                    subtask: finalText,
                  })),
                });
	                setMentionedUsers([]);
                  clearLingxiaDraft();
	                setLingxiaInput("");
	                return true;
	              }}
              onStop={stopLingxiaStreaming}
              streaming={activeLingxiaStreaming}
              disabled={expertTaskSubmitting}
              placeholder={`Message ${lingxiaDisplayName || brand.name}…`}
              maxLength={4000}
              historyStorageKey={INPUT_HISTORY_KEY}
              voiceOnRight
              showUtilityButtons={false}
              onUserMention={(u) => {
                setMentionedUsers((prev) => prev.some((x) => x.userId === u.userId) ? prev : [...prev, u]);
              }}
              renderAddMenu={({ openFilePicker, disabled: attachmentDisabled }) => (
                <DropdownMenu
                  open={composerAddMenuOpen}
                  onOpenChange={(open) => {
                    setComposerAddMenuOpen(open);
                    if (!open) {
                      setComposerAddMenuView("root");
                      setComposerConnectorSearch("");
                      setComposerSkillSearch("");
                      setComposerExpertSearch("");
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="lingxia-toolbar-icon lingxia-composer-add-trigger"
                      aria-label="添加"
                      title="添加"
                    >
                      <Plus size={17} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="lingxia-composer-add-menu"
                    align="start"
                    side="top"
                    sideOffset={7}
                  >
                    <DropdownMenuItem
                      className="lingxia-composer-add-item"
                      disabled={attachmentDisabled}
                      onPointerEnter={() => setComposerAddMenuView("root")}
                      onSelect={openFilePicker}
                    >
                      <Paperclip aria-hidden="true" />
                      <span>上传附件</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="lingxia-composer-add-separator" />

                    <DropdownMenuItem
                      className="lingxia-composer-add-item"
                      data-state={composerAddMenuView === "connectors" ? "open" : "closed"}
                      onPointerEnter={showComposerConnectorPanel}
                      onSelect={(event) => {
                        event.preventDefault();
                        showComposerConnectorPanel();
                      }}
                    >
                      <Link2 aria-hidden="true" />
                      <span>连接</span>
                      {composerConnectors.length > 0 ? (
                        <span className="lingxia-composer-add-item__meta">
                          {activeComposerConnectorCount}/{composerConnectors.length}
                        </span>
                      ) : null}
                      <ChevronRight className="lingxia-composer-add-item__chevron" aria-hidden="true" />
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      className="lingxia-composer-add-item"
                      data-state={composerAddMenuView === "skills" ? "open" : "closed"}
                      disabled={activeLingxiaStreaming || skillPackageUploading}
                      onPointerEnter={showComposerSkillPanel}
                      onSelect={(event) => {
                        event.preventDefault();
                        showComposerSkillPanel();
                      }}
                    >
                      <Wand2 aria-hidden="true" />
                      <span>技能</span>
                      {composerSkills.length > 0 ? (
                        <span className="lingxia-composer-add-item__meta">{composerSkills.length}</span>
                      ) : null}
                      <ChevronRight className="lingxia-composer-add-item__chevron" aria-hidden="true" />
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      className="lingxia-composer-add-item"
                      data-state={composerAddMenuView === "experts" ? "open" : "closed"}
                      disabled={activeLingxiaStreaming || expertTaskSubmitting}
                      onPointerEnter={showComposerExpertPanel}
                      onSelect={(event) => {
                        event.preventDefault();
                        showComposerExpertPanel();
                      }}
                    >
                      <BrainCircuit aria-hidden="true" />
                      <span>专家</span>
                      {composerExperts.length > 0 ? (
                        <span className="lingxia-composer-add-item__meta">
                          {composerExperts.filter((expert) => expert.routeReady).length}
                        </span>
                      ) : null}
                      <ChevronRight className="lingxia-composer-add-item__chevron" aria-hidden="true" />
                    </DropdownMenuItem>

                    {composerAddMenuView === "connectors" ? (
                      <div
                        key="connectors"
                        className="lingxia-skill-menu lingxia-composer-submenu lingxia-composer-side-panel lingxia-connector-menu"
                        role="menu"
                        aria-label="连接"
                      >
                        <div
                          className="lingxia-skill-menu__search"
                          onKeyDown={(event) => {
                            if (event.key !== "Escape") event.stopPropagation();
                          }}
                        >
                          <Search aria-hidden="true" />
                          <input
                            ref={composerConnectorSearchRef}
                            value={composerConnectorSearch}
                            onChange={(event) => setComposerConnectorSearch(event.target.value)}
                            placeholder="搜索连接"
                            aria-label="搜索连接"
                          />
                        </div>
                        <div className="lingxia-skill-menu__results lingxia-connector-menu__results">
                          {composerConnectorsLoading && composerConnectors.length === 0 ? (
                            <div className="lingxia-skill-menu__empty lingxia-connector-loading">
                              <LoaderCircle aria-hidden="true" />
                              <span>正在加载</span>
                            </div>
                          ) : filteredComposerConnectors.length === 0 ? (
                            <div className="lingxia-skill-menu__empty">没有匹配的连接</div>
                          ) : filteredComposerConnectors.map((connector) => {
                            const pending = pendingConnectorId === connector.serverId;
                            const unavailable = !connector.configured;
                            return (
                              <DropdownMenuItem
                                key={connector.serverId}
                                role="menuitemcheckbox"
                                aria-checked={connector.enabledForAgent}
                                className="lingxia-connector-item"
                                data-enabled={connector.enabledForAgent ? "true" : "false"}
                                disabled={unavailable || Boolean(pendingConnectorId) || activeLingxiaStreaming}
                                onSelect={(event) => {
                                  event.preventDefault();
                                  void toggleComposerConnector(connector);
                                }}
                              >
                                <span className="lingxia-connector-item__icon" aria-hidden="true">
                                  <Link2 />
                                </span>
                                <span className="lingxia-connector-item__main">
                                  <span className="lingxia-connector-item__name">{connector.name}</span>
                                  <span className="lingxia-connector-item__meta">
                                    {unavailable
                                      ? "未配置"
                                      : connector.enabledForAgent
                                        ? connector.liveStatus === "unavailable" ? "连接异常" : "已连接"
                                        : "已关闭"}
                                  </span>
                                </span>
                                <span
                                  className="lingxia-connector-switch"
                                  data-checked={connector.enabledForAgent ? "true" : "false"}
                                  aria-hidden="true"
                                >
                                  {pending ? <LoaderCircle className="lingxia-connector-switch__loader" /> : <span />}
                                </span>
                              </DropdownMenuItem>
                            );
                          })}
                        </div>
                        <div className="lingxia-composer-submenu__footer">
                          <button type="button" className="lingxia-composer-submenu__action" onClick={() => openCustomMcpDialog("add")}>
                            <Plus aria-hidden="true" />
                            <span>添加 MCP</span>
                          </button>
                          <button type="button" className="lingxia-composer-submenu__action" onClick={() => openCustomMcpDialog("manage")}>
                            <Settings2 aria-hidden="true" />
                            <span>管理连接</span>
                          </button>
                        </div>
                      </div>
                    ) : composerAddMenuView === "skills" ? (
                      <div
                        key="skills"
                        className="lingxia-skill-menu lingxia-composer-submenu lingxia-composer-side-panel"
                        role="menu"
                        aria-label="技能"
                      >
                        <div
                          className="lingxia-skill-menu__search"
                          onKeyDown={(event) => {
                            if (event.key !== "Escape") event.stopPropagation();
                          }}
                        >
                          <Search aria-hidden="true" />
                          <input
                            ref={composerSkillSearchRef}
                            value={composerSkillSearch}
                            onChange={(event) => setComposerSkillSearch(event.target.value)}
                            placeholder="搜索技能"
                            aria-label="搜索技能"
                          />
                        </div>
                        <div className="lingxia-skill-menu__results">
                          {filteredComposerSkills.length === 0 ? (
                            <div className="lingxia-skill-menu__empty">没有匹配的技能</div>
                          ) : filteredComposerSkills.map((skill) => (
                            <DropdownMenuItem
                              key={skill.id}
                              className="lingxia-skill-select-item"
                              data-selected={skill.id === selectedComposerSkillId ? "true" : "false"}
                              disabled={probeSkillReadinessMutation.isPending}
                              onSelect={(event) => {
                                if (skill.requiredMcpServers.length > 0) event.preventDefault();
                                void selectComposerSkill(skill);
                              }}
                            >
                              <span className="lingxia-skill-select-item__content">
                                <span className="lingxia-skill-select-item__icon" aria-hidden="true">
                                  {skill.initial}
                                </span>
                                <span className="lingxia-skill-select-item__main">
                                  <span className="lingxia-skill-select-item__name">{skill.label}</span>
                                  {skill.desc ? <span className="lingxia-skill-select-item__desc">{skill.desc}</span> : null}
                                </span>
                              </span>
                            </DropdownMenuItem>
                          ))}
                        </div>
                        <div className="lingxia-composer-submenu__footer">
                          <button
                            type="button"
                            className="lingxia-composer-submenu__action"
                            disabled={skillPackageUploading || activeLingxiaStreaming}
                            onClick={() => {
                              setComposerAddMenuOpen(false);
                              skillPackageInputRef.current?.click();
                            }}
                          >
                            {skillPackageUploading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
                            <span>上传技能包</span>
                          </button>
                          <button type="button" className="lingxia-composer-submenu__action" onClick={openSkillManager}>
                            <Settings2 aria-hidden="true" />
                            <span>管理技能</span>
                          </button>
                        </div>
                      </div>
                    ) : composerAddMenuView === "experts" ? (
                      <div
                        key="experts"
                        className="lingxia-skill-menu lingxia-composer-submenu lingxia-composer-side-panel lingxia-expert-menu"
                        role="menu"
                        aria-label="专家"
                      >
                        <div
                          className="lingxia-skill-menu__search"
                          onKeyDown={(event) => {
                            if (event.key !== "Escape") event.stopPropagation();
                          }}
                        >
                          <Search aria-hidden="true" />
                          <input
                            ref={composerExpertSearchRef}
                            value={composerExpertSearch}
                            onChange={(event) => setComposerExpertSearch(event.target.value)}
                            placeholder="搜索专家"
                            aria-label="搜索专家"
                          />
                        </div>
                        <div className="lingxia-skill-menu__results lingxia-expert-menu__results">
                          {composerExpertsLoading && composerExperts.length === 0 ? (
                            <div className="lingxia-skill-menu__empty lingxia-connector-loading">
                              <LoaderCircle aria-hidden="true" />
                              <span>正在加载</span>
                            </div>
                          ) : filteredComposerExperts.length === 0 ? (
                            <div className="lingxia-skill-menu__empty">暂无可用专家</div>
                          ) : filteredComposerExperts.map((expert) => (
                            <DropdownMenuItem
                              key={expert.id}
                              className="lingxia-expert-item"
                              data-selected={expert.id === selectedComposerExpertId ? "true" : "false"}
                              disabled={!expert.routeReady}
                              onSelect={() => selectComposerExpert(expert)}
                            >
                              <span className="lingxia-expert-item__icon" aria-hidden="true">
                                <BrainCircuit />
                              </span>
                              <span className="lingxia-expert-item__main">
                                <span className="lingxia-expert-item__name">{expert.name}</span>
                                <span className="lingxia-expert-item__desc">
                                  {expert.routeReady ? expert.description || "异步处理专业任务" : expert.reason || "暂不可用"}
                                </span>
                              </span>
                              <span className="lingxia-expert-item__status" data-ready={expert.routeReady ? "true" : "false"}>
                                {expert.routeReady ? "可调用" : "待配置"}
                              </span>
                            </DropdownMenuItem>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              leftControls={selectedComposerExpert ? (
                <span className="lingxia-composer-skill-chip lingxia-composer-expert-chip" title={`本轮咨询：${selectedComposerExpert.name}`}>
                  <BrainCircuit size={13} strokeWidth={1.8} />
                  <span>{selectedComposerExpert.name}</span>
                  <button
                    type="button"
                    aria-label="取消选择专家"
                    onClick={() => setSelectedComposerExpertId("")}
                  >
                    <X size={12} strokeWidth={1.8} />
                  </button>
                </span>
              ) : selectedComposerSkill ? (
                <span className="lingxia-composer-skill-chip" title={`本轮优先使用：${selectedComposerSkill.label}`}>
                  <Wand2 size={13} strokeWidth={1.8} />
                  <span>{selectedComposerSkill.label}</span>
                  <button
                    type="button"
                    aria-label="取消选择技能"
                    onClick={() => setSelectedComposerSkillId("")}
                  >
                    <X size={12} strokeWidth={1.8} />
                  </button>
                </span>
              ) : null}
              rightControls={(
                <ModelPicker
                  models={availableModels || []}
                  value={effectiveLingxiaModelId}
                  pending={switchModelMutation.isPending}
                  disabled={activeLingxiaStreaming || switchModelMutation.isPending}
                  onValueChange={(modelId) => {
                    if (!user || !resolvedAdoptId) { toast.error("请先登录"); return; }
                    switchModelMutation.mutate({ adoptId: resolvedAdoptId, modelId });
                  }}
                />
              )}
            />

          </main>
          </PanelErrorBoundary>
          </ChatPage>
          ) : (
            <MainPanel
              activePage={activePage as Exclude<PageKey, "chat">}
              adoptId={resolvedAdoptId || ""}
              skills={{
                data: lingxiaSkills as any,
                canEdit: !!user,
                pending: toggleSkillMutation.isPending,
                onChanged: async () => {
                  await refetchSkills();
                },
                onToggle: (skillId, enable, source) => {
                  if (!user) { toast.error("请先登录"); return; }
                  toggleSkillMutation.mutate({ adoptId: resolvedAdoptId!, skillId, enable, source });
                },
              }}
            />
          )}
          </div>

          <div
            className={`workspace-split-handle ${workspacePanelOpen && activePage === "chat" ? "is-open" : ""}`}
            role="separator"
            aria-label="调整工作空间宽度"
            aria-orientation="vertical"
            aria-valuemin={WORKSPACE_PANEL_MIN_WIDTH}
            aria-valuemax={WORKSPACE_PANEL_MAX_WIDTH}
            aria-valuenow={workspacePanelWidth}
            tabIndex={workspacePanelOpen && activePage === "chat" ? 0 : -1}
            onPointerDown={beginWorkspacePanelResize}
            onDoubleClick={() => setWorkspacePanelWidth(WORKSPACE_PANEL_DEFAULT_WIDTH)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? 16 : -16;
              setWorkspacePanelWidth((width) => constrainWorkspacePanelWidth(width + delta));
            }}
          />

          <aside
            className={`workbench-workspace-panel ${workspacePanelOpen && activePage === "chat" ? "is-open" : ""}`}
            style={{
              "--workspace-panel-width": `${workspacePanelWidth}px`,
              width: workspacePanelOpen && activePage === "chat" ? workspacePanelWidth : 0,
            } as CSSProperties}
            aria-hidden={workspacePanelOpen && activePage === "chat" ? undefined : true}
            inert={workspacePanelOpen && activePage === "chat" ? undefined : true}
          >
            <WorkspaceBrowser
              adoptId={resolvedAdoptId || ""}
              variant="panel"
              active={workspacePanelOpen && activePage === "chat"}
            />
          </aside>
          </div>
          </div>
        </div>
      </div>
      </>
    );
  }

  // Linggan homepage code removed — this route always resolves to lingxia console
  return null;

}
