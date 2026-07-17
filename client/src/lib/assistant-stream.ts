export type AssistantStreamMessage = {
  id?: string;
  role: string;
  text?: string;
  status?: string;
};

export type AssistantTextChunkMode = "delta" | "snapshot";

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
