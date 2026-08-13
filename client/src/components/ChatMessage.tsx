import { memo, useEffect, useMemo, useState, useRef } from "react";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { AgentTaskCard, type AgentTask } from "@/components/AgentTaskCard";
import type { AgentArtifactView } from "@/components/AgentArtifactPanel";
import { MessageAttachments } from "@/components/MessageAttachments";
import { ContextReceiptPanel } from "@/components/ContextReceiptPanel";
import { ToolDetailRenderer } from "@/components/tool-cards/ToolDetailRenderer";
import { WebSourceCard } from "@/components/WebSourceCard";
import { cleanLeakedToolTags } from "@/lib/clean-leaked-tags";
import { classifyToolName, type ToolVisualKind } from "@/lib/tool-presentation";
import { extractChatWebSources } from "@/lib/web-sources";
import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";
import {
  filterCitedKnowledgeSources,
  formatKnowledgeCitations,
  validateKnowledgeCitations,
} from "@shared/knowledge-citations";
import { streamingMarkdownRenderDelay } from "@/lib/streaming-markdown";
import { extractContextInteractionGrants, extractContextReceipts } from "@/lib/context-receipt";
import type { TaskReceiptBundleV1 } from "@shared/context-evidence";
import {
  MESSAGE_FEEDBACK_REASON_CODES,
  MESSAGE_FEEDBACK_REASON_LABELS,
  type MessageFeedbackRating,
  type MessageFeedbackReasonCode,
} from "@shared/message-feedback";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import {
  Bot,
  BookOpen,
  BookPlus,
  Brain,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Database,
  FileText,
  Globe2,
  Image as ImageIcon,
  Loader2,
  Plug,
  Puzzle,
  Search,
  ShieldCheck,
  Square,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Volume2,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type ToolCallEntry = {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  ts: number;
  executor?: "sandbox" | "native" | "none" | "gateway" | "jiuwenswarm" | "timeout";
  truncated?: boolean;
  suppressedOriginalResult?: boolean;
  policyDenyReason?: string;
  auditId?: string;
  outputFiles?: Array<{ name: string; size: number; wsPath?: string }>;
  adoptId?: string;
  _gateway?: boolean;
};

export type ChatMessageAttachment = {
  name: string;
  size: number;
  path: string;
  adoptId: string;
};

export type ChatKnowledgeSource = {
  index: number;
  chunkId: string;
  parentId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  documentName: string;
  documentVersion?: string;
  position: string;
  headingPath?: string[];
  page?: number | null;
  sourceDepartment?: string;
  authority?: string;
};

export type MessageEventEntry =
  | {
      type: "text";
      id?: string;
      content: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments?: string;
      result?: string;
      status?: "running" | "done" | "error";
      ts?: number;
      durationMs?: number;
      executor?: ToolCallEntry["executor"];
      truncated?: boolean;
      suppressedOriginalResult?: boolean;
      policyDenyReason?: string;
      auditId?: string;
      outputFiles?: ToolCallEntry["outputFiles"];
      adoptId?: string;
      _gateway?: boolean;
    }
  | {
      type: "permission_request";
      id: string;
      permission: JiuwenPermissionRequestCard;
    };

export type JiuwenPermissionRequestCard = {
  requestId: string;
  source: string;
  kind?: "permission" | "question";
  title: string;
  question: string;
  command?: string;
  toolName?: string;
  connectorName?: string;
  demo?: boolean;
  options?: Array<{ label: string; description?: string; value?: string }>;
  questions?: Array<{
    header: string;
    question: string;
    options: Array<{ label: string; description?: string; value?: string }>;
    multiSelect: boolean;
  }>;
  riskLevel?: "low" | "medium" | "high";
  reasonCode?: string;
  reasonText?: string;
  allowAlways?: boolean;
  expiresAt?: string;
  state?: "pending" | "submitting" | "approved" | "rejected" | "answered" | "error";
  error?: string;
};

type GovernanceEvidence = {
  approval?: { approvalId?: string; status?: string; createdAt?: string };
  identity?: { user?: string; roleKey?: string; adoptionId?: string; workspace?: string };
  decision?: {
    policyCode?: string;
    ruleVersion?: string;
    payloadFingerprint?: string;
    operation?: string;
    reason?: string;
  };
  confirmation?: {
    status?: string;
    decidedBy?: string;
    approvedAt?: string;
    rejectedAt?: string;
    consumedAt?: string;
  };
  connector?: { name?: string; type?: string; demo?: boolean };
  receipt?: {
    requestId?: string;
    status?: string;
    toolName?: string;
    idempotencyFingerprint?: string;
    externalRequestId?: string;
    durationMs?: number;
    completedAt?: string;
  } | null;
  businessOutcome?: {
    recordId?: string;
    status?: string;
    customerRef?: string;
    createdAt?: string;
    demo?: boolean;
  } | null;
};

function governanceEvidenceTime(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function governanceStatusLabel(value?: string): string {
  if (value === "pending") return "待确认";
  if (value === "approved") return "已确认，待执行";
  if (value === "rejected") return "已拒绝";
  if (value === "consumed" || value === "succeeded" || value === "completed") return "已执行";
  if (value === "failed") return "执行失败";
  if (value === "expired") return "已过期";
  return value || "-";
}

const TOOL_VISUAL_ICONS: Record<ToolVisualKind, LucideIcon> = {
  agent: Bot,
  browser: Globe2,
  code: Code2,
  database: Database,
  file: FileText,
  image: ImageIcon,
  mcp: Plug,
  skill: Puzzle,
  terminal: Terminal,
  web: Search,
  generic: Wrench,
};

function ToolTypeIcon({ name, className = "" }: { name: string; className?: string }) {
  const Icon = TOOL_VISUAL_ICONS[classifyToolName(name)];
  return <Icon className={className} size={13} strokeWidth={1.9} aria-hidden="true" />;
}

type ChatMessageProps = {
  messageId?: string;
  adoptId?: string;
  role: "user" | "assistant";
  text: string;
  status?: string;
  isLast: boolean;
  isPlaceholder: boolean;
  streaming: boolean;
  displayName: string;
  modelId: string;
  timeLabel: string;
  attachments?: ChatMessageAttachment[];
  knowledgeSources?: ChatKnowledgeSource[];
  receiptBundle?: TaskReceiptBundleV1;
  toolCalls?: ToolCallEntry[];
  messageEvents?: MessageEventEntry[];
  processingDurationMs?: number;
  agentTasks?: AgentTask[];
  showToolCalls?: boolean;
  usage?: { input: number; output: number };
  contextPercent?: number | null;
  onDelete?: () => void;
  feedback?: MessageFeedbackValue | null;
  feedbackPending?: boolean;
  onFeedback?: (feedback: MessageFeedbackValue | null) => void | Promise<void>;
  onForgetMemory?: (memoryId: number) => void | Promise<void>;
  onContextMemoryFeedback?: (input: {
    memoryId: number;
    memoryVersion: number;
    receiptId: string;
    feedbackToken: string;
    action: "correct" | "update" | "hide";
    content?: string;
  }) => void | Promise<void>;
  onLoadContextMemoryPreviews?: (input: {
    receiptId: string;
    feedbackToken: string;
    memories: Array<{ memoryId: number; memoryVersion: number }>;
  }) => Promise<Array<{ memoryId: number; version: number; safePreview: string; sourceType: string; asOf: string }>>;
  onCaptureKnowledge?: (input: { messageId?: string; text: string; modelId: string }) => void;
  onOpenKnowledgeSource?: (source: ChatKnowledgeSource) => void;
  jiuwenPermission?: JiuwenPermissionRequestCard;
  onJiuwenPermissionAnswer?: (request: JiuwenPermissionRequestCard, action: "allow_once" | "allow_always" | "reject") => void;
  onOpenAgentArtifact?: (artifacts: AgentArtifactView[], artifactId?: string) => void;
  onResumeExpert?: (task: AgentTask) => void;
  onCancelExpert?: (task: AgentTask) => Promise<void> | void;
  onRetryExpert?: (task: AgentTask) => Promise<void> | void;
};

export type MessageFeedbackValue = {
  rating: MessageFeedbackRating;
  reasonCodes: MessageFeedbackReasonCode[];
  comment?: string;
};

function useThrottledText(value: string, delayMs: number, enabled: boolean) {
  const [throttled, setThrottled] = useState(value);
  const lastUpdateRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setThrottled(value);
      lastUpdateRef.current = Date.now();
      return;
    }

    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;
    const run = () => {
      setThrottled(value);
      lastUpdateRef.current = Date.now();
      timerRef.current = null;
    };

    if (elapsed >= delayMs) {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      run();
    } else if (timerRef.current == null) {
      timerRef.current = window.setTimeout(run, delayMs - elapsed);
    }

    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, delayMs, enabled]);

  return enabled ? throttled : value;
}

// ── Gateway 内部工具内联状态（web_search / memory_search 等）──
const GATEWAY_TOOL_META: Record<string, { icon: string; label: string }> = {
  web_search:    { icon: "🔍", label: "搜索网页" },
  web_fetch:     { icon: "🌐", label: "获取网页" },
  memory_search: { icon: "🧠", label: "查找记忆" },
  read:          { icon: "📄", label: "读取文件" },
  read_file:     { icon: "📄", label: "读取文件" },
  thinking:      { icon: "💭", label: "深度思考" },
  bash:          { icon: "⌘", label: "执行命令" },
  shell:         { icon: "⌘", label: "执行命令" },
  write:         { icon: "✎", label: "写入文件" },
  write_file:    { icon: "✎", label: "写入文件" },
  edit:          { icon: "✎", label: "编辑文件" },
  edit_file:     { icon: "✎", label: "编辑文件" },
  list_files:    { icon: "📂", label: "列出文件" },
  grep:          { icon: "⌕", label: "搜索文件" },
  glob:          { icon: "⌕", label: "查找路径" },
};

function toolResultSnippet(tc: ToolCallEntry): string {
  if (!tc.result || tc.status === "running") return "";
  const text = sanitizePublicRuntimePaths(tc.result)
    .replace(/\s+/g, " ")
    .replace(/[{}"]/g, "")
    .trim();
  if (!text) return "";
  return text.length > 78 ? `${text.slice(0, 78)}...` : text;
}

export function ToolExecutionReceipt({ toolCalls }: { toolCalls: ToolCallEntry[] }) {
  const identityBound = toolCalls.some((tool) => Boolean(tool.adoptId));
  const sandboxed = toolCalls.some((tool) => tool.executor === "sandbox");
  const auditCount = toolCalls.filter((tool) => Boolean(tool.auditId)).length;
  const policyBlocked = toolCalls.some((tool) => Boolean(tool.policyDenyReason));

  if (!identityBound && !sandboxed && auditCount === 0 && !policyBlocked) return null;

  return (
    <div className="lingxia-tool-receipt" aria-label="执行凭据">
      <span className="lingxia-tool-receipt__title">
        <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
        执行凭据
      </span>
      <span className="lingxia-tool-receipt__items">
        {identityBound ? <span>实例身份已绑定</span> : null}
        {sandboxed ? <span>沙箱隔离</span> : null}
        {auditCount > 0 ? <span>审计留痕 {auditCount} 条</span> : null}
        {policyBlocked ? <span className="is-blocked">安全策略已阻断</span> : null}
      </span>
    </div>
  );
}

function toolCallLabel(tc: ToolCallEntry): string {
  const rawName = String(tc.name || "tool");
  const lower = rawName.toLowerCase();
  if (GATEWAY_TOOL_META[rawName]) return GATEWAY_TOOL_META[rawName].label;
  if (GATEWAY_TOOL_META[lower]) return GATEWAY_TOOL_META[lower].label;
  if (rawName === "[产出文件]" || lower.includes("workspace_files")) return "产出文件";
  if (lower.includes("remember_preference")) return "记住岗位偏好";
  if (lower.includes("forget_preference")) return "忘记岗位偏好";
  if (lower.includes("list_learned_preferences")) return "查看岗位偏好";
  if (lower === "load_tools") return "加载工具";
  if (lower.includes("weather")) return "查询天气";
  if (lower.includes("search")) return "检索信息";
  if (lower.includes("skill")) return "调用技能";
  if (lower.includes("mcp")) return "调用 MCP 工具";
  if (lower.includes("bash") || lower.includes("shell")) return "执行命令";
  return rawName.replace(/[_-]+/g, " ");
}

type MemoryReceipt = {
  action: "remembered" | "forgotten";
  id: number;
  content: string;
  status?: string;
};

function parseMemoryReceipt(result: string | undefined): MemoryReceipt | null {
  const value = String(result || "");
  const marker = "EA_MEMORY_RECEIPT:";
  try {
    const parsed = JSON.parse(value);
    const queue: unknown[] = [parsed];
    let inspected = 0;
    while (queue.length && inspected < 100) {
      const current = queue.shift();
      inspected += 1;
      if (typeof current === "string" && current.includes(marker)) {
        return parseMemoryReceipt(current);
      }
      if (Array.isArray(current)) queue.push(...current);
      else if (current && typeof current === "object") queue.push(...Object.values(current));
    }
  } catch {}
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = value.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(value.slice(start, index + 1));
          const id = Number(parsed?.id || 0);
          const action = parsed?.action === "forgotten" ? "forgotten" : "remembered";
          const content = String(parsed?.content || "").trim();
          return id > 0 && content ? { action, id, content, status: String(parsed?.status || "") } : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function toolCallDurationLabel(tc: ToolCallEntry): string {
  const duration = tc.durationMs ?? (tc.status === "running" ? Date.now() - tc.ts : 0);
  if (!duration || duration < 1000) return "";
  const seconds = Math.round(duration / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function toolCallStatusLabel(status: ToolCallEntry["status"]): string {
  return status === "running" ? "执行中" : status === "error" ? "失败" : "完成";
}

function toolTimelineActivityLabel(status: string | undefined, calls: ToolCallEntry[]): string {
  const clean = String(status || "").trim();
  if (!clean || calls.some((tc) => tc.status === "running")) return "";
  if (/^正在调用工具\s*[:：]/.test(clean)) return "";
  return clean;
}

function toolTimelineDurationLabel(
  calls: ToolCallEntry[],
  now: number,
  processingDurationMs?: number,
): string {
  if (Number.isFinite(processingDurationMs) && Number(processingDurationMs) > 0) {
    const seconds = Math.max(0, Math.round(Number(processingDurationMs) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  const startedAt = Math.min(...calls.map((call) => Number(call.ts || now)).filter(Number.isFinite));
  if (!Number.isFinite(startedAt)) return "";
  const running = calls.some((call) => call.status === "running");
  const endedAt = running
    ? now
    : Math.max(...calls.map((call) => Number(call.ts || startedAt) + Math.max(0, Number(call.durationMs || 0))));
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (seconds < 1) return "";
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function toolCallSummaryLabel(
  calls: ToolCallEntry[],
  activityLabel: string,
  now: number,
  processingDurationMs?: number,
): string {
  const running = calls.filter((tc) => tc.status === "running").length;
  const errors = calls.filter((tc) => tc.status === "error").length;
  const currentCall = [...calls].reverse().find((call) => call.status === "running");
  const stage = activityLabel
    || (currentCall ? `正在${toolCallLabel(currentCall).replace(/^正在/, "")}` : "")
    || (errors ? "处理遇到问题" : `处理完成 · ${calls.length} 个步骤`);
  const duration = toolTimelineDurationLabel(calls, now, processingDurationMs);
  return [
    stage,
    running > 1 ? `${running} 个步骤执行中` : "",
    errors ? `${errors} 个步骤失败` : "",
    duration,
  ].filter(Boolean).join(" · ");
}

function ToolTimelineStep({ tc, index, total }: { tc: ToolCallEntry; index: number; total: number }) {
  const [expanded, setExpanded] = useState(false);
  const reduceMotion = Boolean(useReducedMotion());
  const duration = toolCallDurationLabel(tc);
  const snippet = toolResultSnippet(tc);
  const meta = [
    toolCallStatusLabel(tc.status),
    duration,
    tc.outputFiles?.length ? `${tc.outputFiles.length} 个文件` : "",
    snippet,
  ].filter(Boolean).join(" · ");
  const rowContent = (
    <>
      <span className="lingxia-tool-step__rail" aria-hidden="true">
        <span className="lingxia-tool-step__dot" />
        {index < total - 1 ? <span className="lingxia-tool-step__line" /> : null}
      </span>
      <span className="lingxia-tool-step__body">
        <span className="lingxia-tool-step__title-row">
          <ToolTypeIcon name={tc.name} className="lingxia-tool-step__icon" />
          <span className="lingxia-tool-step__title">{toolCallLabel(tc)}</span>
        </span>
        <span className="lingxia-tool-step__meta">{meta}</span>
      </span>
    </>
  );

  if (tc._gateway) {
    return (
      <div className={`lingxia-tool-step is-${tc.status}`}>
        {rowContent}
      </div>
    );
  }

  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <div
      className={`lingxia-tool-step-detail is-${tc.status}`}
      data-expanded={expanded ? "true" : "false"}
    >
      <button
        type="button"
        className="lingxia-tool-step-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {rowContent}
        <ChevronDown className="lingxia-tool-step__chevron" size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="tool-step-detail"
            className="lingxia-tool-step-detail__collapse"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
          >
            <div className="lingxia-tool-step-detail__body">
              <ToolDetailRenderer tool={tc} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ToolCallTimeline({
  toolCalls,
  status,
  contentStarted = false,
  processingDurationMs,
}: {
  toolCalls: ToolCallEntry[];
  status?: string;
  contentStarted?: boolean;
  processingDurationMs?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const autoExpandedRef = useRef(false);
  const reduceMotion = Boolean(useReducedMotion());
  const visibleCalls = toolCalls.filter((tc) => tc?.id && tc?.name);
  const hasError = visibleCalls.some((tc) => tc.status === "error");
  const hasRunning = visibleCalls.some((tc) => tc.status === "running");
  const activityLabel = toolTimelineActivityLabel(status, visibleCalls);
  const isActive = hasRunning || Boolean(activityLabel);
  const shouldAutoExpand = isActive && !contentStarted;
  useEffect(() => {
    if (!isActive) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);
  useEffect(() => {
    if (shouldAutoExpand) {
      autoExpandedRef.current = true;
      setExpanded(true);
      return;
    }
    if (autoExpandedRef.current) {
      autoExpandedRef.current = false;
      setExpanded(false);
    }
  }, [shouldAutoExpand]);
  if (visibleCalls.length === 0) return null;
  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <div className="lingxia-tool-timeline-wrap" data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        className={`lingxia-tool-summary ${isActive ? "is-running" : hasError ? "is-error" : "is-done"}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="lingxia-tool-summary__icon" aria-hidden="true">
          {isActive ? (
            <Loader2 className="lingxia-tool-summary__loader" size={13} strokeWidth={2} />
          ) : visibleCalls.length === 1 ? (
            <ToolTypeIcon name={visibleCalls[0].name} />
          ) : (
            <Wrench size={13} strokeWidth={1.9} />
          )}
        </span>
        <span className="lingxia-tool-summary__text" aria-live="polite">
          {toolCallSummaryLabel(visibleCalls, activityLabel, now, processingDurationMs)}
        </span>
        <ChevronDown className="lingxia-tool-summary__chevron" size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="tool-timeline-panel"
            className="lingxia-tool-timeline-panel"
            initial={{ height: 0, opacity: 0, y: -2 }}
            animate={{ height: "auto", opacity: 1, y: 0 }}
            exit={{ height: 0, opacity: 0, y: -2 }}
            transition={transition}
          >
            <div className="lingxia-tool-timeline" aria-label="工具调用记录">
              {visibleCalls.map((tc, index) => (
                <ToolTimelineStep key={tc.id} tc={tc} index={index} total={visibleCalls.length} />
              ))}
            </div>
            <ToolExecutionReceipt toolCalls={visibleCalls} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function toolCallsRenderSignature(toolCalls?: ToolCallEntry[]): string {
  if (!toolCalls?.length) return "";
  return toolCalls
    .map((tc) => [
      tc.id,
      tc.name,
      tc.status,
      tc.durationMs ?? "",
      tc.result ? tc.result.length : 0,
      tc.outputFiles?.length ?? 0,
      tc.executor || "",
      tc.auditId || "",
      tc.adoptId || "",
      tc.truncated ? "truncated" : "",
      tc.policyDenyReason || "",
    ].join(":"))
    .join("|");
}

function toolCallFromMessageEvent(event: MessageEventEntry): ToolCallEntry | null {
  if (event.type !== "tool_call") return null;
  const id = String(event.id || "").trim();
  const name = String(event.name || "").trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    arguments: String(event.arguments || "{}"),
    result: event.result,
    status: event.status || (event.result != null ? "done" : "running"),
    ts: Number(event.ts || Date.now()),
    durationMs: event.durationMs,
    executor: event.executor,
    truncated: event.truncated,
    suppressedOriginalResult: event.suppressedOriginalResult,
    policyDenyReason: event.policyDenyReason,
    auditId: event.auditId,
    outputFiles: event.outputFiles,
    adoptId: event.adoptId,
    _gateway: event._gateway,
  };
}

function toolCallsFromMessageEvents(events?: MessageEventEntry[]): ToolCallEntry[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const byId = new Map<string, ToolCallEntry>();
  for (const event of events) {
    const toolCall = toolCallFromMessageEvent(event);
    if (!toolCall) continue;
    const existing = byId.get(toolCall.id);
    byId.set(toolCall.id, existing ? { ...existing, ...toolCall } : toolCall);
  }
  return Array.from(byId.values());
}

function messageEventsRenderSignature(events?: MessageEventEntry[]): string {
  if (!events?.length) return "";
  return events
    .map((event) => {
      if (event.type === "tool_call") {
        return [
          event.type,
          event.id,
          event.name,
          event.status || "",
          event.durationMs ?? "",
          event.result ? event.result.length : 0,
          event.outputFiles?.length ?? 0,
        ].join(":");
      }
      if (event.type === "permission_request") return `${event.type}:${event.id}:${event.permission.state || ""}`;
      return `${event.type}:${event.content.length}`;
    })
    .join("|");
}

function agentTasksRenderSignature(tasks?: AgentTask[]): string {
  if (!tasks?.length) return "";
  return tasks
    .map((task) => [
      task.id,
      task.status,
      task.resultMarkdown || task.result_markdown || task.result || "",
      task.errorMessage || task.error_message || "",
      task.remoteTaskId || task.remote_task_id || "",
      task.artifactsJson || task.artifacts_json || "",
      task.updatedAt || task.updated_at || "",
    ].join(":"))
    .join("|");
}

function ChatMessageInner({
  messageId,
  adoptId,
  role,
  text,
  status,
  isLast,
  isPlaceholder,
  streaming,
  modelId,
  timeLabel,
  attachments,
  knowledgeSources,
  receiptBundle,
  toolCalls,
  messageEvents,
  processingDurationMs,
  agentTasks,
  showToolCalls = true,
  onDelete,
  feedback,
  feedbackPending = false,
  onFeedback,
  onForgetMemory,
  onContextMemoryFeedback,
  onLoadContextMemoryPreviews,
  onCaptureKnowledge,
  onOpenKnowledgeSource,
  jiuwenPermission,
  onJiuwenPermissionAnswer,
  onOpenAgentArtifact,
  onResumeExpert,
  onCancelExpert,
  onRetryExpert,
}: ChatMessageProps) {
  const eventToolCalls = toolCallsFromMessageEvents(messageEvents);
  const effectiveToolCalls = toolCalls && toolCalls.length > 0 ? toolCalls : eventToolCalls;
  const timelineToolCalls = effectiveToolCalls.filter((tool) => tool.name !== "[产出文件]");
  const webSources = useMemo(() => extractChatWebSources(timelineToolCalls), [timelineToolCalls]);
  const memoryReceipt = useMemo(() => {
    for (let index = effectiveToolCalls.length - 1; index >= 0; index -= 1) {
      const receipt = parseMemoryReceipt(effectiveToolCalls[index]?.result);
      if (receipt) return receipt;
    }
    return null;
  }, [effectiveToolCalls]);
  const contextReceipts = useMemo(() => {
    const receipts = extractContextReceipts(effectiveToolCalls.map((tool) => ({ name: tool.name, result: tool.result })));
    if (!receiptBundle) return receipts;
    const byId = new Map(receipts.map((receipt) => [receipt.receiptId, receipt]));
    return receiptBundle.stages
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map((stage) => byId.get(stage.receiptId))
      .filter((receipt): receipt is NonNullable<typeof receipt> => Boolean(receipt));
  }, [effectiveToolCalls, receiptBundle]);
  const contextInteractionGrants = useMemo(
    () => extractContextInteractionGrants(effectiveToolCalls.map((tool) => ({ name: tool.name, result: tool.result }))),
    [effectiveToolCalls],
  );
  const [memoryReceiptDismissed, setMemoryReceiptDismissed] = useState(false);
  const [memoryUndoPending, setMemoryUndoPending] = useState(false);
  useEffect(() => {
    setMemoryReceiptDismissed(false);
    setMemoryUndoPending(false);
  }, [memoryReceipt?.id, memoryReceipt?.action]);
  const showToolTimeline = showToolCalls && timelineToolCalls.length > 0;
  const [copied, setCopied] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [feedbackReasonDraft, setFeedbackReasonDraft] = useState<MessageFeedbackReasonCode[]>([]);
  const [feedbackCommentDraft, setFeedbackCommentDraft] = useState("");
  const [governanceEvidenceOpen, setGovernanceEvidenceOpen] = useState(false);
  const [governanceEvidenceLoading, setGovernanceEvidenceLoading] = useState(false);
  const [governanceEvidenceError, setGovernanceEvidenceError] = useState("");
  const [governanceEvidence, setGovernanceEvidence] = useState<GovernanceEvidence | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsUrlRef = useRef<string | null>(null);

  const openGovernanceEvidence = async () => {
    if (!adoptId || !jiuwenPermission?.requestId) return;
    setGovernanceEvidenceOpen(true);
    setGovernanceEvidenceLoading(true);
    setGovernanceEvidenceError("");
    try {
      const response = await fetch(`/api/claw/governance/approvals/${encodeURIComponent(jiuwenPermission.requestId)}/evidence?adoptId=${encodeURIComponent(adoptId)}`, {
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.item) throw new Error(payload?.error || `执行依据加载失败 (${response.status})`);
      setGovernanceEvidence(payload.item);
    } catch (error) {
      setGovernanceEvidenceError(error instanceof Error ? error.message : "执行依据加载失败");
    } finally {
      setGovernanceEvidenceLoading(false);
    }
  };
  useEffect(() => () => {
    ttsAudioRef.current?.pause();
    if (ttsUrlRef.current) URL.revokeObjectURL(ttsUrlRef.current);
  }, []);
  const throttleStreamingText = Boolean(isLast && streaming);
  const throttledSourceText = useThrottledText(
    text,
    streamingMarkdownRenderDelay(text),
    throttleStreamingText,
  );
  const displayedSourceText = throttleStreamingText ? throttledSourceText : text;
  const knowledgeSourceIndexes = useMemo(
    () => (knowledgeSources || [])
      .map((source) => source.index)
      .filter((index) => Number.isInteger(index) && index > 0),
    [knowledgeSources],
  );
  const citationValidation = useMemo(() => {
    const publicText = sanitizePublicRuntimePaths(cleanLeakedToolTags(displayedSourceText));
    return streaming
      ? { text: publicText, citedIndexes: [] as number[] }
      : validateKnowledgeCitations(publicText, knowledgeSourceIndexes);
  }, [displayedSourceText, knowledgeSourceIndexes, streaming]);
  const displayText = citationValidation.text;
  const citedKnowledgeSources = useMemo(
    () => filterCitedKnowledgeSources(knowledgeSources || [], citationValidation.citedIndexes),
    [citationValidation.citedIndexes, knowledgeSources],
  );
  const knowledgeSourceGroups = useMemo(() => {
    const groups = new Map<string, { source: ChatKnowledgeSource; indexes: number[]; knowledgeBaseNames: string[] }>();
    for (const source of citedKnowledgeSources) {
      const key = `${source.documentName.trim().toLocaleLowerCase("zh-CN")}\u0000${source.position.trim().toLocaleLowerCase("zh-CN")}`;
      const existing = groups.get(key);
      if (existing) {
        if (!existing.indexes.includes(source.index)) existing.indexes.push(source.index);
        if (!existing.knowledgeBaseNames.includes(source.knowledgeBaseName)) existing.knowledgeBaseNames.push(source.knowledgeBaseName);
        continue;
      }
      groups.set(key, { source, indexes: [source.index], knowledgeBaseNames: [source.knowledgeBaseName] });
    }
    return Array.from(groups.values());
  }, [citedKnowledgeSources]);
  const knowledgeCitationLabels = useMemo(() => {
    const labels: Record<number, string> = {};
    for (const source of knowledgeSources || []) {
      if (!Number.isInteger(source.index) || source.index < 1) continue;
      if (source.page && source.page > 0) labels[source.index] = `第 ${source.page} 页`;
      else if (source.position && source.position !== "正文") labels[source.index] = source.position.slice(0, 32);
    }
    return labels;
  }, [knowledgeSources]);
  const knowledgeCitationUrls = useMemo(() => {
    const urls: Record<number, string> = {};
    if (!adoptId) return urls;
    for (const source of knowledgeSources || []) {
      if (!Number.isInteger(source.index) || source.index < 1) continue;
      if (!source.knowledgeBaseId || !source.documentId) continue;
      const query = new URLSearchParams({
        adoptId,
        knowledgeBaseId: source.knowledgeBaseId,
      });
      const fragment = new URLSearchParams();
      if (source.page && source.page > 0) fragment.set("page", String(source.page));
      const searchText = (source.headingPath?.at(-1) || source.position || "").trim();
      if (searchText && searchText !== "正文") fragment.set("search", searchText.slice(0, 80));
      urls[source.index] = `/api/knowledge/documents/${encodeURIComponent(source.documentId)}/content?${query.toString()}${fragment.size ? `#${fragment.toString()}` : ""}`;
    }
    return urls;
  }, [adoptId, knowledgeSources]);
  const onCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(formatKnowledgeCitations(displayText, knowledgeCitationLabels));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const submitPositiveFeedback = () => {
    if (!onFeedback || feedbackPending) return;
    void onFeedback(feedback?.rating === "positive" ? null : {
      rating: "positive",
      reasonCodes: [],
    });
  };
  const openNegativeFeedback = () => {
    if (!onFeedback || feedbackPending) return;
    const existingReasons = feedback?.rating === "negative" ? feedback.reasonCodes : [];
    const existingComment = feedback?.rating === "negative" ? feedback.comment || "" : "";
    setFeedbackReasonDraft(existingReasons);
    setFeedbackCommentDraft(existingComment);
    if (feedback?.rating !== "negative") {
      void onFeedback({ rating: "negative", reasonCodes: [] });
    }
    setFeedbackDialogOpen(true);
  };
  const toggleFeedbackReason = (reason: MessageFeedbackReasonCode) => {
    setFeedbackReasonDraft((current) => current.includes(reason)
      ? current.filter((item) => item !== reason)
      : [...current, reason]);
  };
  const saveNegativeFeedbackDetails = () => {
    if (!onFeedback || feedbackPending) return;
    void onFeedback({
      rating: "negative",
      reasonCodes: feedbackReasonDraft,
      comment: feedbackCommentDraft.trim() || undefined,
    });
    setFeedbackDialogOpen(false);
  };

  if (role === "user") {
    return (
      <div className="flex justify-end lingxia-msg-fade lingxia-message-user">
        <div
          className="lingxia-user-bubble"
          aria-label={timeLabel ? `你的消息，发送于 ${timeLabel}` : "你的消息"}
        >
          <MessageAttachments attachments={attachments} variant="user" onOpenArtifacts={onOpenAgentArtifact} />
          {text ? (
            <div className="rounded-2xl rounded-tr-sm px-4 py-3 text-sm whitespace-pre-wrap lingxia-user-msg-text lingxia-bubble-user">
              {text}
            </div>
          ) : null}
          {timeLabel ? <time className="lingxia-user-message-time">{timeLabel}</time> : null}
        </div>
      </div>
    );
  }

  if (isPlaceholder) {
    return (
      <div className="lingxia-ai-bubble-wrap lingxia-msg-fade">
        <div className="min-w-0 w-full">
          {showToolTimeline && (
            <div className="mb-2">
              <ToolCallTimeline
                toolCalls={timelineToolCalls}
                status={streaming ? status : undefined}
                processingDurationMs={processingDurationMs}
              />
            </div>
          )}
          {!showToolTimeline ? (
            <div className="py-2 text-sm flex items-center gap-2 lingxia-bubble-ai" style={{ color: "var(--oc-text-tertiary)" }}>
              <span className="lingxia-typing-dots flex items-center gap-1.5" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {status ? <span>{status}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="lingxia-ai-bubble-wrap lingxia-msg-fade">
      <div className="min-w-0 w-full">
        {showToolTimeline && (
          <div className="mb-2">
            <ToolCallTimeline
              toolCalls={timelineToolCalls}
              status={streaming ? status : undefined}
              contentStarted={Boolean(displayText.trim())}
              processingDurationMs={processingDurationMs}
            />
          </div>
        )}
        {streaming && status && !showToolTimeline ? (
          <div className="mb-2 text-xs" style={{ color: "var(--oc-text-tertiary)" }} role="status">
            {status}
          </div>
        ) : null}
        <div className="relative group">
          <div
            className={`relative py-1.5 text-sm leading-relaxed lingxia-bubble-ai ${(isLast && streaming && text) ? "lingxia-token-active" : ""}`}
          >
            <ChatMarkdown
              content={displayText}
              phase={isLast && streaming ? "streaming" : "final"}
              knowledgeSourceIndexes={knowledgeSourceIndexes}
              knowledgeCitationLabels={knowledgeCitationLabels}
              knowledgeCitationUrls={knowledgeCitationUrls}
              knowledgeCitationScope={messageId}
              onOpenKnowledgeCitation={onOpenKnowledgeSource ? (index) => {
                const source = (knowledgeSources || []).find((item) => item.index === index);
                if (source?.chunkId && source.parentId) onOpenKnowledgeSource(source);
              } : undefined}
            />
            {isLast && streaming && <span className="animate-pulse ml-0.5" style={{ color: "var(--oc-text-tertiary)" }}>▌</span>}
          </div>
        </div>
        <MessageAttachments
          toolCalls={effectiveToolCalls}
          attachments={attachments}
          onOpenArtifacts={onOpenAgentArtifact}
        />
        {!streaming && webSources.length > 0 ? <WebSourceCard sources={webSources} /> : null}
        {!streaming && citedKnowledgeSources.length ? (
          <div className="lingxia-knowledge-sources" aria-label="知识来源">
            <span className="lingxia-knowledge-sources__label"><BookOpen />参考资料</span>
            {knowledgeSourceGroups.map(({ source, indexes, knowledgeBaseNames }) => (
              <a
                id={`ea-knowledge-source-${String(messageId || "message").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80) || "message"}-${source.index}`}
                key={`${source.knowledgeBaseId}:${source.documentId}:${source.index}`}
                className="lingxia-knowledge-source"
                href={knowledgeCitationUrls[source.index] || `#ea-knowledge-source-${String(messageId || "message").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80) || "message"}-${source.index}`}
                target={knowledgeCitationUrls[source.index] && !(onOpenKnowledgeSource && source.chunkId && source.parentId) ? "_blank" : undefined}
                rel={knowledgeCitationUrls[source.index] && !(onOpenKnowledgeSource && source.chunkId && source.parentId) ? "noopener noreferrer" : undefined}
                onClick={onOpenKnowledgeSource && source.chunkId && source.parentId ? (event) => {
                  event.preventDefault();
                  onOpenKnowledgeSource(source);
                } : undefined}
                title={`${knowledgeBaseNames.join("、")} · ${source.documentName}${source.documentVersion && source.documentVersion !== "1.0" ? ` · ${source.documentVersion}` : ""} · ${source.headingPath?.length ? source.headingPath.join(" / ") : source.position}`}
              >
                {indexes.slice(1).map((index) => (
                  <i
                    key={index}
                    id={`ea-knowledge-source-${String(messageId || "message").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80) || "message"}-${index}`}
                    className="lingxia-knowledge-source__anchor"
                    aria-hidden="true"
                  />
                ))}
                <b>{indexes.length > 1 ? `${source.index}+` : source.index}</b>
                <span>{source.documentName}{source.documentVersion && source.documentVersion !== "1.0" ? ` · ${source.documentVersion}` : ""}</span>
                <small>{source.headingPath?.length ? source.headingPath.join(" / ") : source.position}{source.page && source.headingPath?.length ? ` · 第 ${source.page} 页` : ""}{indexes.length > 1 ? ` · ${indexes.length} 处` : ""}</small>
              </a>
            ))}
          </div>
        ) : null}
        {!streaming && contextReceipts.length ? (
          <div className="context-receipt-bundle" aria-label={contextReceipts.length > 1 ? `本任务包含 ${contextReceipts.length} 个依据阶段` : undefined}>
            {contextReceipts.length > 1 ? <div className="context-receipt-bundle__label">本任务包含 {contextReceipts.length} 个依据阶段</div> : null}
            {contextReceipts.map((receipt) => (
              <ContextReceiptPanel
                key={receipt.receiptId}
                receipt={receipt}
                interactionGrant={contextInteractionGrants.get(receipt.receiptId)}
                citedKnowledge={citedKnowledgeSources}
                onMemoryFeedback={onContextMemoryFeedback}
                onLoadMemoryPreviews={onLoadContextMemoryPreviews}
              />
            ))}
          </div>
        ) : null}
        {!streaming && memoryReceipt && !memoryReceiptDismissed ? (
          <div className="lingxia-memory-receipt" data-action={memoryReceipt.action}>
            <Brain aria-hidden="true" />
            <span>
              <strong>{memoryReceipt.action === "forgotten" ? "已忘记" : "已记住"}</strong>
              <small>{memoryReceipt.content}</small>
            </span>
            {memoryReceipt.action === "remembered" && onForgetMemory ? (
              <button
                type="button"
                disabled={memoryUndoPending}
                onClick={async () => {
                  setMemoryUndoPending(true);
                  try {
                    await onForgetMemory(memoryReceipt.id);
                    setMemoryReceiptDismissed(true);
                  } catch {
                    // The mutation reports its own user-facing error.
                  } finally {
                    setMemoryUndoPending(false);
                  }
                }}
              >
                {memoryUndoPending ? "撤销中..." : "撤销"}
              </button>
            ) : null}
          </div>
        ) : null}
        {jiuwenPermission && jiuwenPermission.kind !== "question" && (
          <div
            className="mt-2 rounded-xl px-3 py-3 text-xs"
            style={{
              background: "color-mix(in oklab, var(--oc-card) 72%, transparent)",
              border: "1px solid var(--oc-border)",
              color: "var(--oc-text-primary)",
              maxWidth: 720,
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 600 }}>
                  <span>{jiuwenPermission.title || "权限确认"}</span>
                  {jiuwenPermission.demo ? (
                    <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "rgba(217,119,6,0.10)", color: "#a16207" }}>Demo</span>
                  ) : null}
                </div>
                <div className="mt-0.5 truncate" style={{ color: "var(--oc-text-secondary)" }}>
                  {jiuwenPermission.connectorName
                    ? `${jiuwenPermission.connectorName}${jiuwenPermission.toolName ? ` · ${jiuwenPermission.toolName}` : ""}`
                    : jiuwenPermission.toolName ? `工具：${jiuwenPermission.toolName}` : "JiuwenSwarm 请求授权后继续执行"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {jiuwenPermission.riskLevel ? (
                  <span
                    className="rounded-full px-2 py-0.5"
                    style={{
                      background: jiuwenPermission.riskLevel === "high" ? "rgba(239,68,68,0.10)" : jiuwenPermission.riskLevel === "medium" ? "rgba(217,119,6,0.10)" : "rgba(29,158,117,0.10)",
                      color: jiuwenPermission.riskLevel === "high" ? "#dc2626" : jiuwenPermission.riskLevel === "medium" ? "#a16207" : "#15803d",
                      fontSize: 11,
                    }}
                  >
                    {jiuwenPermission.riskLevel === "high" ? "高风险" : jiuwenPermission.riskLevel === "medium" ? "需确认" : "低风险"}
                  </span>
                ) : null}
                <span
                  className="rounded-full px-2 py-0.5"
                  style={{
                    background: "color-mix(in oklab, var(--oc-bg-secondary) 80%, transparent)",
                    color: "var(--oc-text-tertiary)",
                    fontSize: 11,
                  }}
                >
                  {jiuwenPermission.state === "approved" ? "已允许" : jiuwenPermission.state === "rejected" ? "已拒绝" : jiuwenPermission.state === "submitting" ? "提交中" : "待确认"}
                </span>
              </div>
            </div>
            {jiuwenPermission.reasonText ? (
              <div className="mt-2" style={{ color: "var(--oc-text-secondary)", lineHeight: 1.5 }}>
                {jiuwenPermission.reasonText}
              </div>
            ) : null}
            {jiuwenPermission.command ? (
              <pre
                className="mt-2 overflow-auto rounded-lg px-2.5 py-2"
                style={{
                  background: "color-mix(in oklab, var(--oc-bg) 78%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--oc-border) 72%, transparent)",
                  color: "var(--oc-text-secondary)",
                  maxHeight: 140,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {sanitizePublicRuntimePaths(jiuwenPermission.command)}
              </pre>
            ) : null}
            {jiuwenPermission.error ? (
              <div className="mt-2" style={{ color: "#ef4444" }}>{jiuwenPermission.error}</div>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={jiuwenPermission.state === "submitting" || jiuwenPermission.state === "approved" || jiuwenPermission.state === "rejected"}
                onClick={() => onJiuwenPermissionAnswer?.(jiuwenPermission, "allow_once")}
                className="rounded-lg px-3 py-1.5"
                style={{
                  background: jiuwenPermission.state === "approved" ? "rgba(29,158,117,0.12)" : "var(--oc-text-primary)",
                  color: jiuwenPermission.state === "approved" ? "#1d9e75" : "var(--oc-bg)",
                  border: "1px solid transparent",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: jiuwenPermission.state === "submitting" || jiuwenPermission.state === "approved" || jiuwenPermission.state === "rejected" ? "default" : "pointer",
                }}
              >
                {jiuwenPermission.state === "approved" ? "已允许" : jiuwenPermission.state === "submitting" ? "提交中..." : "本次允许"}
              </button>
              {jiuwenPermission.allowAlways ? (
                <button
                  type="button"
                  disabled={jiuwenPermission.state === "submitting" || jiuwenPermission.state === "approved" || jiuwenPermission.state === "rejected"}
                  onClick={() => onJiuwenPermissionAnswer?.(jiuwenPermission, "allow_always")}
                  className="rounded-lg px-3 py-1.5"
                  style={{
                    background: "transparent",
                    color: "var(--oc-text-primary)",
                    border: "1px solid var(--oc-border)",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: jiuwenPermission.state === "submitting" || jiuwenPermission.state === "approved" || jiuwenPermission.state === "rejected" ? "default" : "pointer",
                  }}
                >
                  以后允许
                </button>
              ) : null}
              <button
                type="button"
                disabled={jiuwenPermission.state === "submitting" || jiuwenPermission.state === "approved" || jiuwenPermission.state === "rejected"}
                onClick={() => onJiuwenPermissionAnswer?.(jiuwenPermission, "reject")}
                className="rounded-lg px-3 py-1.5"
                style={{
                  background: "transparent",
                  color: jiuwenPermission.state === "rejected" ? "#ef4444" : "var(--oc-text-secondary)",
                  border: "1px solid var(--oc-border)",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: jiuwenPermission.state === "submitting" || jiuwenPermission.state === "approved" || jiuwenPermission.state === "rejected" ? "default" : "pointer",
                }}
              >
                {jiuwenPermission.state === "rejected" ? "已拒绝" : "拒绝"}
              </button>
              {jiuwenPermission.source === "governance_approval" ? (
                <button
                  type="button"
                  onClick={() => void openGovernanceEvidence()}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
                  style={{
                    background: "transparent",
                    color: "var(--oc-text-secondary)",
                    border: "1px solid var(--oc-border)",
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  <ShieldCheck size={14} aria-hidden="true" />
                  执行依据
                </button>
              ) : null}
            </div>
          </div>
        )}
        <Dialog open={governanceEvidenceOpen} onOpenChange={setGovernanceEvidenceOpen}>
          <DialogContent className="max-w-xl" aria-describedby="governance-evidence-description">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldCheck size={18} aria-hidden="true" />
                执行依据
                {governanceEvidence?.connector?.demo ? (
                  <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "rgba(217,119,6,0.10)", color: "#a16207" }}>
                    Demo
                  </span>
                ) : null}
              </DialogTitle>
              <DialogDescription id="governance-evidence-description">
                展示本次操作的身份、治理判断和执行回执，不包含原始敏感参数。
              </DialogDescription>
            </DialogHeader>
            {governanceEvidenceLoading ? (
              <div className="flex min-h-32 items-center justify-center gap-2 text-sm" style={{ color: "var(--oc-text-secondary)" }}>
                <Loader2 className="animate-spin" size={16} /> 正在加载
              </div>
            ) : governanceEvidenceError ? (
              <div className="py-6 text-sm" style={{ color: "#dc2626" }}>{governanceEvidenceError}</div>
            ) : governanceEvidence ? (
              <div className="max-h-[60vh] overflow-y-auto text-sm">
                {[
                  ["操作", governanceEvidence.decision?.operation || governanceEvidence.receipt?.toolName],
                  ["连接", governanceEvidence.connector?.name || "待执行"],
                  ["状态", governanceStatusLabel(governanceEvidence.receipt?.status || governanceEvidence.confirmation?.status)],
                  ["操作人", governanceEvidence.identity?.user],
                  ["岗位", governanceEvidence.identity?.roleKey],
                  ["岗位实例", governanceEvidence.identity?.adoptionId],
                  ["治理规则", governanceEvidence.decision?.policyCode],
                  ["规则版本", governanceEvidence.decision?.ruleVersion],
                  ["确认人", governanceEvidence.confirmation?.decidedBy],
                  ["确认时间", governanceEvidenceTime(governanceEvidence.confirmation?.approvedAt || governanceEvidence.confirmation?.rejectedAt)],
                  ["参数指纹", governanceEvidence.decision?.payloadFingerprint],
                  ["幂等指纹", governanceEvidence.receipt?.idempotencyFingerprint],
                  ["执行耗时", governanceEvidence.receipt?.durationMs != null ? `${governanceEvidence.receipt.durationMs} ms` : undefined],
                  ["业务回执", governanceEvidence.businessOutcome?.recordId || governanceEvidence.receipt?.externalRequestId],
                ].filter((row) => row[1]).map(([label, value]) => (
                  <div key={String(label)} className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-b py-2.5 last:border-b-0" style={{ borderColor: "var(--oc-border)" }}>
                    <span style={{ color: "var(--oc-text-tertiary)" }}>{label}</span>
                    <span className="break-all" style={{ color: "var(--oc-text-primary)" }}>{String(value)}</span>
                  </div>
                ))}
                {governanceEvidence.businessOutcome?.demo ? (
                  <p className="mt-3 text-xs leading-5" style={{ color: "var(--oc-text-secondary)" }}>
                    本次结果仅写入隔离演示表，未连接真实 CRM，也未修改真实客户数据。
                  </p>
                ) : null}
              </div>
            ) : null}
            <DialogFooter>
              <button
                type="button"
                onClick={() => setGovernanceEvidenceOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm"
                style={{ border: "1px solid var(--oc-border)", color: "var(--oc-text-primary)" }}
              >
                关闭
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {agentTasks && agentTasks.length > 0 ? (
          <div className="agent-task-card-list agent-task-card-list--inline">
            {agentTasks.map((task) => (
              <AgentTaskCard
                key={task.id}
                task={task}
                onOpenArtifact={onOpenAgentArtifact}
                onResumeExpert={onResumeExpert}
                onCancel={onCancelExpert}
                onRetry={onRetryExpert}
              />
            ))}
          </div>
        ) : null}
        {!streaming && text && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1" aria-label="回复操作">
              <button
                onClick={onCopyMarkdown}
                type="button"
                title={copied ? "已复制" : "复制"}
                className="lingxia-msg-footer-action"
                data-state={copied ? "copied" : "idle"}
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </button>
              {onCaptureKnowledge ? (
                <button
                  onClick={() => onCaptureKnowledge({ messageId, text: displayText, modelId })}
                  type="button"
                  title="沉淀为知识"
                  className="lingxia-msg-footer-action"
                >
                  <BookPlus aria-hidden="true" />
                </button>
              ) : null}
              <button
                onClick={async () => {
                  if (ttsPlaying) { ttsAudioRef.current?.pause(); setTtsPlaying(false); return; }
                  if (ttsLoading) return;
                  setTtsLoading(true);
                  try {
                    const response = await fetch("/api/claw/voice/tts", {
                      method: "POST",
                      credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ text: text.slice(0, 2000) }),
                    });
                    if (!response.ok) {
                      const payload = await response.json().catch(() => null);
                      throw new Error(String(payload?.error || `语音生成失败 (${response.status})`));
                    }
                    const blob = await response.blob();
                    if (blob.size === 0) throw new Error("语音服务未返回音频");
                    if (ttsUrlRef.current) URL.revokeObjectURL(ttsUrlRef.current);
                    const url = URL.createObjectURL(blob);
                    ttsUrlRef.current = url;
                    const audio = new Audio(url);
                    ttsAudioRef.current = audio;
                    audio.onended = () => {
                      setTtsPlaying(false);
                      URL.revokeObjectURL(url);
                      if (ttsUrlRef.current === url) ttsUrlRef.current = null;
                    };
                    audio.onerror = () => {
                      setTtsPlaying(false);
                      toast.error("音频播放失败");
                      URL.revokeObjectURL(url);
                      if (ttsUrlRef.current === url) ttsUrlRef.current = null;
                    };
                    await audio.play();
                    setTtsPlaying(true);
                  } catch (error: any) {
                    ttsAudioRef.current?.pause();
                    ttsAudioRef.current = null;
                    if (ttsUrlRef.current) {
                      URL.revokeObjectURL(ttsUrlRef.current);
                      ttsUrlRef.current = null;
                    }
                    setTtsPlaying(false);
                    toast.error(error?.message || "语音播放失败");
                  } finally {
                    setTtsLoading(false);
                  }
                }}
                type="button"
                title={ttsLoading ? "正在生成语音" : ttsPlaying ? "停止朗读" : "朗读"}
                className="lingxia-msg-footer-action"
                data-state={ttsLoading ? "loading" : ttsPlaying ? "active" : "idle"}
                disabled={ttsLoading}
              >
                {ttsLoading ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : ttsPlaying ? (
                  <Square aria-hidden="true" />
                ) : (
                  <Volume2 aria-hidden="true" />
                )}
              </button>
              {onFeedback ? (
                <>
                  <button
                    onClick={submitPositiveFeedback}
                    type="button"
                    title={feedback?.rating === "positive" ? "撤销有帮助反馈" : "有帮助"}
                    aria-pressed={feedback?.rating === "positive"}
                    disabled={feedbackPending}
                    className="lingxia-msg-footer-action"
                    data-feedback="positive"
                    data-state={feedback?.rating === "positive" ? "selected" : "idle"}
                  >
                    <ThumbsUp aria-hidden="true" />
                  </button>
                  <button
                    onClick={openNegativeFeedback}
                    type="button"
                    title={feedback?.rating === "negative" ? "补充反馈" : "没有帮助"}
                    aria-pressed={feedback?.rating === "negative"}
                    disabled={feedbackPending}
                    className="lingxia-msg-footer-action"
                    data-feedback="negative"
                    data-state={feedback?.rating === "negative" ? "selected" : "idle"}
                  >
                    <ThumbsDown aria-hidden="true" />
                  </button>
                </>
              ) : null}
              {onDelete && (
                <button
                  onClick={onDelete}
                  type="button"
                  title="删除此消息"
                  className="lingxia-msg-footer-action"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              )}
          </div>
        )}
      </div>
      <Dialog open={feedbackDialogOpen} onOpenChange={setFeedbackDialogOpen}>
        <DialogContent className="lingxia-feedback-dialog sm:max-w-md">
          <DialogHeader>
            <DialogTitle>这条回复哪里可以改进？</DialogTitle>
            <DialogDescription>可多选，也可以直接关闭。不会提交对话原文。</DialogDescription>
          </DialogHeader>
          <div className="lingxia-feedback-reasons" aria-label="反馈原因">
            {MESSAGE_FEEDBACK_REASON_CODES.map((reason) => (
              <button
                key={reason}
                type="button"
                aria-pressed={feedbackReasonDraft.includes(reason)}
                className="lingxia-feedback-reason"
                data-selected={feedbackReasonDraft.includes(reason) ? "true" : "false"}
                onClick={() => toggleFeedbackReason(reason)}
              >
                {MESSAGE_FEEDBACK_REASON_LABELS[reason]}
              </button>
            ))}
          </div>
          <textarea
            value={feedbackCommentDraft}
            onChange={(event) => setFeedbackCommentDraft(event.target.value.slice(0, 500))}
            maxLength={500}
            rows={3}
            className="lingxia-feedback-comment"
            placeholder="补充说明（可选）"
            aria-label="补充说明"
          />
          <div className="lingxia-feedback-comment-count">{feedbackCommentDraft.length}/500</div>
          <DialogFooter className="sm:justify-between">
            {feedback?.rating === "negative" ? (
              <button
                type="button"
                className="lingxia-feedback-clear"
                disabled={feedbackPending}
                onClick={() => {
                  void onFeedback?.(null);
                  setFeedbackDialogOpen(false);
                }}
              >
                撤销反馈
              </button>
            ) : <span />}
            <div className="flex items-center gap-2">
              <button type="button" className="lingxia-feedback-later" onClick={() => setFeedbackDialogOpen(false)}>暂不补充</button>
              <button type="button" className="lingxia-feedback-submit" disabled={feedbackPending} onClick={saveNegativeFeedbackDetails}>提交反馈</button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const ChatMessage = memo(ChatMessageInner, (prev, next) => {
  return (
    prev.messageId === next.messageId &&
    prev.adoptId === next.adoptId &&
    prev.role === next.role &&
    prev.text === next.text &&
    prev.status === next.status &&
    prev.isLast === next.isLast &&
    prev.isPlaceholder === next.isPlaceholder &&
    prev.streaming === next.streaming &&
    prev.displayName === next.displayName &&
    prev.modelId === next.modelId &&
    prev.timeLabel === next.timeLabel &&
    JSON.stringify(prev.attachments || []) === JSON.stringify(next.attachments || []) &&
    JSON.stringify(prev.knowledgeSources || []) === JSON.stringify(next.knowledgeSources || []) &&
    prev.showToolCalls === next.showToolCalls &&
    prev.processingDurationMs === next.processingDurationMs &&
    toolCallsRenderSignature(prev.toolCalls) === toolCallsRenderSignature(next.toolCalls) &&
    messageEventsRenderSignature(prev.messageEvents) === messageEventsRenderSignature(next.messageEvents) &&
    agentTasksRenderSignature(prev.agentTasks) === agentTasksRenderSignature(next.agentTasks) &&
    prev.onOpenAgentArtifact === next.onOpenAgentArtifact &&
    prev.onResumeExpert === next.onResumeExpert &&
    prev.onCancelExpert === next.onCancelExpert &&
    prev.onRetryExpert === next.onRetryExpert &&
    prev.onCaptureKnowledge === next.onCaptureKnowledge &&
    prev.onOpenKnowledgeSource === next.onOpenKnowledgeSource &&
    prev.onContextMemoryFeedback === next.onContextMemoryFeedback &&
    prev.onLoadContextMemoryPreviews === next.onLoadContextMemoryPreviews &&
    JSON.stringify(prev.jiuwenPermission || null) === JSON.stringify(next.jiuwenPermission || null) &&
    prev.usage?.input === next.usage?.input &&
    prev.usage?.output === next.usage?.output &&
    prev.contextPercent === next.contextPercent
    && JSON.stringify(prev.feedback || null) === JSON.stringify(next.feedback || null)
    && prev.feedbackPending === next.feedbackPending
  );
});
