const DEFAULT_USAGE_TIME_ZONE = "Asia/Shanghai";

export type CanonicalUsageEvent = {
  key: string;
  adoptId: string;
  ts: string;
  userId: number;
  sessionId: string;
};

const usageDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: process.env.EA_USAGE_TIME_ZONE || DEFAULT_USAGE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function usageDateKey(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return usageDateFormatter.format(date);
}

export function parseJiuwenUsageRequest(raw: unknown): CanonicalUsageEvent | null {
  const event = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!event || (event.event !== "chat_stream_request" && event.event !== "gateway_chat_request")) {
    return null;
  }

  const adoptId = String(event.adoptId || "").trim();
  const ts = String(event.ts || "").trim();
  if (!adoptId || !usageDateKey(ts)) return null;

  const clientRunId = String(event.clientRunId || "").trim();
  const requestId = String(event.requestId || "").trim();
  const sessionId = String(event.sessionId || "").trim();
  const requestIdentity = clientRunId || requestId || [sessionId, ts].join("|");

  return {
    // Enterprise bootstrap fallback can emit both event names for one user turn.
    key: ["jiuwen-request", adoptId, requestIdentity].join("|"),
    adoptId,
    ts,
    userId: Number(event.userId || 0),
    sessionId,
  };
}
