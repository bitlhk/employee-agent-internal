import { classifyPermissionRisk } from "./permission-risk";

export type JiuwenPermissionRequest = {
  requestId: string;
  source: string;
  kind: "permission" | "question";
  title: string;
  question: string;
  command?: string;
  toolName?: string;
  options: Array<{ label: string; description?: string; value?: string }>;
  questions?: JiuwenInteractionQuestion[];
  riskLevel?: "low" | "medium" | "high";
  reasonCode?: string;
  reasonText?: string;
  allowAlways?: boolean;
};

export type JiuwenInteractionQuestion = {
  header: string;
  question: string;
  options: Array<{ label: string; description?: string; value?: string }>;
  multiSelect: boolean;
};

export type JiuwenInteractionAnswer = {
  selectedOptions: string[];
  customInput: string;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringifyPayload(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isJiuwenHumanApprovalEvent(eventType: string, delta: unknown): boolean {
  const normalizedEventType = String(eventType || "").toLowerCase();
  if (normalizedEventType === "chat.tool_call" || normalizedEventType === "chat.tool_result") return false;
  if (normalizedEventType === "chat.ask_user_question") return true;
  const payload = objectValue(delta);
  const source = String(payload.source || "").trim().toLowerCase();
  return source === "permission_interrupt"
    || source === "confirm_interrupt"
    || source === "ask_user_interrupt";
}

export function summarizeJiuwenApprovalEvent(eventType: string, delta: unknown): string {
  const payload = stringifyPayload(delta);
  const trimmedPayload = payload.length > 800 ? `${payload.slice(0, 800)}...` : payload;
  return `JiuwenSwarm 运行时请求人工确认，EA 当前未接入原生确认回传。event=${eventType}; payload=${trimmedPayload}`;
}

function normalizeChoiceOptions(
  rawOptions: unknown,
  fallback: Array<{ label: string; description?: string; value?: string }> = [],
): Array<{ label: string; description?: string; value?: string }> {
  if (!Array.isArray(rawOptions)) return fallback;
  const options = rawOptions
    .slice(0, 12)
    .map((item) => {
      if (typeof item === "string") return { label: item.slice(0, 160), value: item.slice(0, 160) };
      const option = objectValue(item);
      const label = String(option.label || option.value || "").trim().slice(0, 160);
      if (!label) return null;
      const description = String(option.description || "").trim().slice(0, 360);
      const value = String(option.value || label).trim().slice(0, 160);
      return { label, value, ...(description ? { description } : {}) };
    })
    .filter((item): item is { label: string; description?: string; value: string } => item !== null);
  return options.length > 0 ? options : fallback;
}

function permissionOptions(rawOptions: unknown): Array<{ label: string; description?: string; value?: string }> {
  return normalizeChoiceOptions(rawOptions, [
    { label: "本次允许", value: "本次允许", description: "仅本次允许执行" },
    { label: "拒绝", value: "拒绝", description: "拒绝本次执行" },
  ]);
}

function normalizeInteractionQuestions(rawQuestions: unknown): JiuwenInteractionQuestion[] {
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions
    .slice(0, 8)
    .map((item) => {
      const question = objectValue(item);
      const text = String(question.question || question.message || "").trim().slice(0, 600);
      if (!text) return null;
      return {
        header: String(question.header || "请确认").trim().slice(0, 120) || "请确认",
        question: text,
        options: normalizeChoiceOptions(question.options),
        multiSelect: question.multi_select === true || question.multiSelect === true,
      };
    })
    .filter((item): item is JiuwenInteractionQuestion => item !== null);
}

function extractCommandFromQuestion(question: string): string {
  const fencedJson = question.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fencedJson) {
    try {
      const parsed = objectValue(JSON.parse(fencedJson));
      const command = String(parsed.command || parsed.cmd || "").trim();
      if (command) return command;
    } catch {}
  }
  const fenced = question.match(/```\s*([\s\S]*?)```/)?.[1]?.trim();
  if (fenced && fenced.length <= 2000) return fenced;
  const inline = question.match(/工具\s*`?([^`\s]+)`?\s*需要授权/)?.[1];
  return inline ? `tool: ${inline}` : "";
}

export function normalizeJiuwenPermissionRequest(
  eventType: string,
  delta: unknown,
  fallbackRequestId: string,
): JiuwenPermissionRequest | null {
  if (!isJiuwenHumanApprovalEvent(eventType, delta)) return null;
  const payload = objectValue(delta);
  const source = String(payload.source || "").trim()
    || (String(eventType).toLowerCase() === "chat.ask_user_question" ? "ask_user_interrupt" : "");
  if (source && !["permission_interrupt", "confirm_interrupt", "ask_user_interrupt", "ask_tool"].includes(source)) return null;
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const firstQuestion = objectValue(questions.find((item) => item && typeof item === "object"));
  const requestId = String(
    payload.request_id || payload.requestId || payload.id
    || firstQuestion.request_id || firstQuestion.id || fallbackRequestId,
  ).trim();
  if (!requestId) return null;
  const question = String(firstQuestion.question || payload.question || payload.message || payload.query || "").trim();
  const kind = source === "ask_user_interrupt" || source === "ask_tool" ? "question" : "permission";
  const interactionQuestions = kind === "question" ? normalizeInteractionQuestions(payload.questions) : [];
  const titleFallback = kind === "question" ? "需要补充信息" : "权限确认";
  const title = String(firstQuestion.header || payload.header || titleFallback).trim() || titleFallback;
  const command = extractCommandFromQuestion(question || stringifyPayload(delta));
  const toolName = String(payload.tool_name || payload.toolName || firstQuestion.tool_name || "").trim()
    || (command.startsWith("tool: ") ? command.slice(6).trim() : "");
  const options = kind === "question"
    ? normalizeChoiceOptions(firstQuestion.options || payload.options)
    : permissionOptions(firstQuestion.options || payload.options);
  const risk = kind === "permission" ? classifyPermissionRisk({ toolName, command, options }) : null;
  return {
    requestId,
    source: source || "permission_interrupt",
    kind,
    title,
    question: question || (kind === "question" ? "请补充必要信息后继续。" : "JiuwenSwarm 请求授权后继续执行。"),
    ...(command ? { command } : {}),
    ...(toolName ? { toolName } : {}),
    options,
    ...(interactionQuestions.length > 0 ? { questions: interactionQuestions } : {}),
    ...(risk || {}),
  };
}
