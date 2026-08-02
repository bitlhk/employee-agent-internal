function pickFirstString(obj: any, keys: string[]): string {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function finiteNumber(value: unknown): number | undefined {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

export function normalizeJiuwenUsageSummary(
  delta: any
): { usage: Record<string, number>; model?: string } | null {
  const usage =
    delta?.usage && typeof delta.usage === "object" ? delta.usage : null;
  if (!usage) return null;

  const input = finiteNumber(
    usage.input_tokens ??
      usage.input ??
      usage.inputTokens ??
      usage.prompt_tokens
  );
  const output = finiteNumber(
    usage.output_tokens ??
      usage.output ??
      usage.outputTokens ??
      usage.completion_tokens
  );
  const total = finiteNumber(
    usage.total_tokens ?? usage.total ?? usage.totalTokens
  );
  const contextWindow = finiteNumber(
    delta?.context_window_tokens ??
      usage.context_window_tokens ??
      usage.contextWindow
  );
  const contextPercent = finiteNumber(
    delta?.usage_percent ?? usage.usage_percent ?? usage.contextPercent
  );

  if (
    input == null &&
    output == null &&
    total == null &&
    contextWindow == null &&
    contextPercent == null
  ) {
    return null;
  }

  return {
    usage: {
      input: input ?? 0,
      output: output ?? 0,
      ...(total != null ? { total } : {}),
      ...(contextWindow != null ? { contextWindow } : {}),
      ...(contextPercent != null ? { contextPercent } : {}),
    },
    model:
      typeof delta?.model === "string" && delta.model.trim()
        ? delta.model.trim()
        : undefined,
  };
}

export function normalizeJiuwenToolPayload(
  eventType: string,
  delta: any
): {
  isResult: boolean;
  callId: string;
  toolName: string;
  argumentsPayload: unknown;
  resultPayload: unknown;
  isError: boolean;
} | null {
  if (eventType !== "chat.tool_call" && eventType !== "chat.tool_result") {
    return null;
  }
  const isResult = eventType === "chat.tool_result";
  const key = isResult ? "tool_result" : "tool_call";
  const nested =
    delta?.[key] && typeof delta[key] === "object" ? delta[key] : delta;
  const fn =
    nested?.function && typeof nested.function === "object"
      ? nested.function
      : {};
  const toolName =
    pickFirstString(nested, ["name", "toolName", "tool_name", "tool"]) ||
    pickFirstString(fn, ["name"]);
  if (!toolName) return null;
  return {
    isResult,
    callId:
      pickFirstString(nested, [
        "id",
        "tool_call_id",
        "toolCallId",
        "call_id",
      ]) || pickFirstString(delta, ["tool_call_id", "toolCallId", "id"]),
    toolName,
    argumentsPayload:
      nested.arguments ??
      nested.args ??
      fn.arguments ??
      delta?.arguments ??
      delta?.args ??
      null,
    resultPayload:
      nested.result ??
      nested.content ??
      nested.output ??
      delta?.result ??
      delta?.content ??
      null,
    isError: Boolean(
      nested.is_error ||
        nested.isError ||
        nested.error ||
        nested.status === "failed" ||
        delta?.error
    ),
  };
}

export function stringifyJiuwenToolPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
