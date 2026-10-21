import { type ChatKnowledgeSource, type ChatMessageAttachment, type JiuwenPermissionRequestCard, type MessageEventEntry, type ToolCallEntry } from "@/components/ChatMessage";
import { type TaskReceiptBundleV1 } from "@shared/context-evidence";

export function toolCallsSignature(toolCalls?: ToolCallEntry[]) {
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

export function normalizeIncomingToolName(chunk: any): string {
  const fn = chunk?.function && typeof chunk.function === "object" ? chunk.function : {};
  const raw = chunk?.name ?? chunk?.toolName ?? chunk?.tool_name ?? chunk?.tool ?? fn?.name;
  const value = String(raw || "").trim();
  return value || "tool";
}

export type LxMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timeLabel: string;
  status?: string;
  usage?: { input: number; output: number };
  model?: string;
  contextWindow?: number;
  contextPercent?: number;
  selectedSkillIds?: string[];
  selectedSkillId?: string;
  agentTaskIds?: string[];
  attachments?: ChatMessageAttachment[];
  knowledgeSources?: ChatKnowledgeSource[];
  receiptBundle?: TaskReceiptBundleV1;
  toolCalls?: import("@/components/ChatMessage").ToolCallEntry[];
  messageEvents?: MessageEventEntry[];
  processingDurationMs?: number;
  jiuwenPermission?: JiuwenPermissionRequestCard;
  // 2026-04-29 批次 2 A3：截断恢复状态（仅 assistant 用）
  recovering?: boolean;
  recovered?: boolean;
  recoveryFailed?: boolean;
  partialText?: string;            // 截断时已显示的内容（恢复失败时保留）
};

export function hasPendingJiuwenPermissionMessage(message?: LxMsg | null): boolean {
  return Boolean(
    message?.role === "assistant" &&
    message.jiuwenPermission?.requestId &&
    message.jiuwenPermission.state === "pending"
  );
}

export function toolCallToMessageEvent(tool: ToolCallEntry): MessageEventEntry {
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

export function normalizeMessageToolEvents(message: LxMsg): LxMsg {
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
