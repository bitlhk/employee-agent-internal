export type AssistantStreamMessage = {
  id?: string;
  role: string;
  text?: string;
  status?: string;
};

export type AssistantTextChunkMode = "delta" | "snapshot";

export type RuntimeRunDescriptor = {
  runId: string;
  requestId: string;
  sessionId: string;
};

function normalizeRuntimeIdentifier(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) return "";
  return normalized;
}

export function parseRuntimeRunDescriptor(chunk: unknown): RuntimeRunDescriptor | null {
  if (!chunk || typeof chunk !== "object") return null;
  const raw = (chunk as { __run?: unknown }).__run;
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const requestId = normalizeRuntimeIdentifier(candidate.requestId);
  const sessionId = normalizeRuntimeIdentifier(candidate.sessionId);
  if (!requestId || !sessionId) return null;
  return {
    runId: normalizeRuntimeIdentifier(candidate.runId) || requestId,
    requestId,
    sessionId,
  };
}

export function mergeAssistantStreamText(
  currentText: string,
  incomingText: string,
  mode: AssistantTextChunkMode = "delta",
): string {
  const current = String(currentText || "");
  const incoming = String(incomingText || "");
  if (!incoming) return current;
  return mode === "snapshot" ? incoming : current + incoming;
}

export function applyAssistantFinalSnapshot<T extends AssistantStreamMessage>(
  messages: T[],
  assistantMessageId: string,
  finalText: string,
): T[] {
  if (!assistantMessageId || typeof finalText !== "string") return messages;
  const index = messages.findIndex((message) => (
    message.id === assistantMessageId && message.role === "assistant"
  ));
  if (index < 0) return messages;
  const current = messages[index];
  if (current.text === finalText && current.status === undefined) return messages;
  const next = [...messages];
  next[index] = { ...current, text: finalText, status: undefined };
  return next;
}
