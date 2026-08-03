export type AgentTaskLifecycleState =
  | "queued"
  | "running"
  | "waiting_user"
  | "completed"
  | "failed"
  | "cancelled";

export function normalizeAgentTaskLifecycle(input: {
  status?: unknown;
  interactionStatus?: unknown;
}): AgentTaskLifecycleState {
  if (String(input.interactionStatus || "").trim().toLowerCase() === "pending") return "waiting_user";
  switch (String(input.status || "").trim().toLowerCase()) {
    case "pending": return "queued";
    case "running": return "running";
    case "succeeded":
    case "done": return "completed";
    case "cancelled":
    case "canceled": return "cancelled";
    default: return "failed";
  }
}

export function canRetryAgentTask(input: {
  status?: unknown;
  interactionStatus?: unknown;
}): boolean {
  const lifecycle = normalizeAgentTaskLifecycle(input);
  return lifecycle === "failed" || lifecycle === "cancelled";
}
