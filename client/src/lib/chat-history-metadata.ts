import { extractContextReceipts } from "./context-receipt";

type AssistantHistoryMessage = {
  role?: string;
  text?: string;
  toolCalls?: unknown[];
  knowledgeSources?: unknown[];
  receiptBundle?: unknown;
};

type AssistantToolCall = {
  id?: string;
  name?: string;
  result?: string;
  [key: string]: unknown;
};

function hasItems(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function hasTrustedContextReceipt(tool: AssistantToolCall): boolean {
  return (
    extractContextReceipts([
      {
        name: String(tool.name || ""),
        result: typeof tool.result === "string" ? tool.result : undefined,
      },
    ]).length > 0
  );
}

export function mergeCanonicalAssistantToolCalls<T extends AssistantToolCall>(
  canonicalToolCalls: T[],
  streamedToolCalls: T[]
): T[] {
  return canonicalToolCalls.map(canonical => {
    const streamed =
      streamedToolCalls.find(candidate =>
        Boolean(canonical.id && candidate.id === canonical.id)
      ) ||
      streamedToolCalls.find(candidate =>
        Boolean(canonical.name && candidate.name === canonical.name)
      );
    if (!streamed) return canonical;
    if (
      !hasTrustedContextReceipt(streamed) ||
      hasTrustedContextReceipt(canonical)
    ) {
      return canonical;
    }
    return { ...canonical, result: streamed.result };
  });
}

export function mergeCachedAssistantMetadata<T extends AssistantHistoryMessage>(
  historyMessages: T[],
  cachedMessages: T[],
  textKey: (message: T) => string
): T[] {
  const cachedAssistants = cachedMessages
    .filter(
      message =>
        message.role === "assistant" &&
        (hasItems(message.toolCalls) ||
          hasItems(message.knowledgeSources) ||
          Boolean(message.receiptBundle))
    )
    .reverse();
  if (!cachedAssistants.length) return historyMessages;

  const used = new Set<number>();
  const next = [...historyMessages];
  for (
    let messageIndex = next.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = next[messageIndex];
    if (message.role !== "assistant") continue;
    const key = textKey(message);
    if (!key) continue;
    const matchIndex = cachedAssistants.findIndex(
      (candidate, index) => !used.has(index) && textKey(candidate) === key
    );
    if (matchIndex < 0) continue;
    used.add(matchIndex);
    const cached = cachedAssistants[matchIndex];
    const mergeTools =
      !hasItems(message.toolCalls) && hasItems(cached.toolCalls);
    const mergeSources =
      !hasItems(message.knowledgeSources) && hasItems(cached.knowledgeSources);
    const mergeReceiptBundle =
      !message.receiptBundle && Boolean(cached.receiptBundle);
    if (!mergeTools && !mergeSources && !mergeReceiptBundle) continue;
    next[messageIndex] = {
      ...message,
      ...(mergeTools ? { toolCalls: cached.toolCalls } : {}),
      ...(mergeSources ? { knowledgeSources: cached.knowledgeSources } : {}),
      ...(mergeReceiptBundle ? { receiptBundle: cached.receiptBundle } : {}),
    };
  }
  return next;
}
