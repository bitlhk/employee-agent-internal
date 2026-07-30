type AssistantHistoryMessage = {
  role?: string;
  text?: string;
  toolCalls?: unknown[];
  knowledgeSources?: unknown[];
};

function hasItems(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

export function mergeCachedAssistantMetadata<T extends AssistantHistoryMessage>(
  historyMessages: T[],
  cachedMessages: T[],
  textKey: (message: T) => string,
): T[] {
  const cachedAssistants = cachedMessages
    .filter((message) => message.role === "assistant" && (
      hasItems(message.toolCalls) || hasItems(message.knowledgeSources)
    ))
    .reverse();
  if (!cachedAssistants.length) return historyMessages;

  const used = new Set<number>();
  const next = [...historyMessages];
  for (let messageIndex = next.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = next[messageIndex];
    if (message.role !== "assistant") continue;
    const key = textKey(message);
    if (!key) continue;
    const matchIndex = cachedAssistants.findIndex((candidate, index) => (
      !used.has(index) && textKey(candidate) === key
    ));
    if (matchIndex < 0) continue;
    used.add(matchIndex);
    const cached = cachedAssistants[matchIndex];
    const mergeTools = !hasItems(message.toolCalls) && hasItems(cached.toolCalls);
    const mergeSources = !hasItems(message.knowledgeSources) && hasItems(cached.knowledgeSources);
    if (!mergeTools && !mergeSources) continue;
    next[messageIndex] = {
      ...message,
      ...(mergeTools ? { toolCalls: cached.toolCalls } : {}),
      ...(mergeSources ? { knowledgeSources: cached.knowledgeSources } : {}),
    };
  }
  return next;
}
